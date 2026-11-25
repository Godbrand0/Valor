//! Mirrors ValorMarketplace events into the game's database.
//!
//! The game reads a player's items from `inventory`, not from the chain. Most
//! item moves go through the API, which writes `inventory` itself — but some
//! happen ONLY on chain, and without this the game never hears about them:
//!
//!   - `ResalePurchased`: player-to-player resale. Buyers send it from their own
//!     wallet; the API is not involved. Without this a buyer paid for an item
//!     that never appeared in their inventory, and the seller kept using what
//!     they had sold.
//!   - `ItemPurchased` / `ItemGifted` made directly on the contract (not through
//!     the relay), e.g. G$ `transferAndCall`.
//!
//! Correctness, not just best effort:
//!   - Event topics are computed from their signatures, never hard-coded. (The
//!     previous listener's hard-coded `ItemPurchased` hash was wrong, so it never
//!     matched a single event.)
//!   - Progress is saved in `chain_cursors`, so a restart resumes where it left
//!     off instead of looking back 50 blocks and skipping the rest.
//!   - Every event is claimed in `chain_events_processed` before it is applied,
//!     so re-scanning a block can never apply a sale twice; a failure releases
//!     the claim and stops the cursor there, to be retried.
//!   - Relay purchases are already in `inventory` by the time their event is
//!     seen; supply is only decremented when the listener itself adds the item,
//!     so nothing is counted twice.

use std::str::FromStr;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use ethers::{
    contract::abigen,
    providers::{Http, Middleware, Provider},
    types::{Address, BlockNumber, Filter, Log, ValueOrArray, H256, U256},
    utils::{format_units, keccak256},
};
use rust_decimal::Decimal;
use sqlx::PgPool;

use crate::services::chain_id::ChainId;

abigen!(
    ListenerMarketplace,
    r#"[
        function items() external view returns (address)
    ]"#
);
abigen!(
    ListenerItems,
    r#"[
        function balanceOf(address account, uint256 id) external view returns (uint256)
    ]"#
);

const CURSOR: &str = "valor_marketplace";
/// Blocks per `eth_getLogs` call — public RPCs cap the range.
const CHUNK: u64 = 2_000;
/// How far back a first-ever run starts when EVENT_LISTENER_START_BLOCK is unset
/// (~5.5 hours of Celo's 1s blocks). Set the env var to backfill further.
const FIRST_RUN_LOOKBACK: u64 = 20_000;
const POLL_SECS: u64 = 15;
/// Stay this many blocks behind the tip (~12s on Celo). A relay purchase or
/// gift writes `inventory` itself right after its transaction confirms; lagging
/// lets that write land first, so the listener sees the item already granted
/// and doesn't count it a second time.
const SAFE_LAG: u64 = 12;

pub const SIG_ITEM_PURCHASED: &str = "ItemPurchased(address,uint256,uint256)";
pub const SIG_RESALE_PURCHASED: &str = "ResalePurchased(uint256,address,address,uint256,uint256,uint256)";
pub const SIG_ITEM_GIFTED: &str = "ItemGifted(address,address,uint256,uint256)";

pub fn topic(sig: &str) -> H256 {
    H256::from(keccak256(sig.as_bytes()))
}

// ── Pure decoding (unit-tested) ───────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum MarketEvent {
    /// Shop purchase. topics: [sig, buyer, itemId]; data: price
    Purchased { buyer: String, item: u64, price_wei: U256 },
    /// Gift. topics: [sig, payer, recipient, itemId]; data: price
    Gifted { payer: String, recipient: String, item: u64, price_wei: U256 },
    /// Resale. topics: [sig, resaleId, buyer]; data: seller, itemId, price, fee
    Resold { buyer: String, seller: String, item: u64, price_wei: U256, fee_wei: U256 },
}

fn addr_from_word(word: &[u8]) -> String {
    format!("0x{}", hex::encode(&word[12..32]))
}

fn word(data: &[u8], i: usize) -> Result<&[u8]> {
    data.get(i * 32..(i + 1) * 32).ok_or_else(|| anyhow!("log data too short"))
}

fn small_id(v: U256) -> Result<u64> {
    if v > U256::from(u64::MAX) { return Err(anyhow!("item id out of range")); }
    Ok(v.as_u64())
}

pub fn decode(topics: &[H256], data: &[u8]) -> Result<MarketEvent> {
    let sig = topics.first().ok_or_else(|| anyhow!("log has no topics"))?;
    if *sig == topic(SIG_ITEM_PURCHASED) {
        if topics.len() < 3 { return Err(anyhow!("ItemPurchased: expected 3 topics")); }
        Ok(MarketEvent::Purchased {
            buyer: addr_from_word(topics[1].as_bytes()),
            item: small_id(U256::from_big_endian(topics[2].as_bytes()))?,
            price_wei: U256::from_big_endian(word(data, 0)?),
        })
    } else if *sig == topic(SIG_ITEM_GIFTED) {
        if topics.len() < 4 { return Err(anyhow!("ItemGifted: expected 4 topics")); }
        Ok(MarketEvent::Gifted {
            payer: addr_from_word(topics[1].as_bytes()),
            recipient: addr_from_word(topics[2].as_bytes()),
            item: small_id(U256::from_big_endian(topics[3].as_bytes()))?,
            price_wei: U256::from_big_endian(word(data, 0)?),
        })
    } else if *sig == topic(SIG_RESALE_PURCHASED) {
        if topics.len() < 3 { return Err(anyhow!("ResalePurchased: expected 3 topics")); }
        Ok(MarketEvent::Resold {
            buyer: addr_from_word(topics[2].as_bytes()),
            seller: addr_from_word(word(data, 0)?),
            item: small_id(U256::from_big_endian(word(data, 1)?))?,
            price_wei: U256::from_big_endian(word(data, 2)?),
            fee_wei: U256::from_big_endian(word(data, 3)?),
        })
    } else {
        Err(anyhow!("not a marketplace event we follow"))
    }
}

/// 18-decimal wei → whole G$ as a Decimal, for the ledger.
pub fn wei_to_g(wei: U256) -> Decimal {
    format_units(wei, 18).ok().and_then(|s| Decimal::from_str(&s).ok()).unwrap_or_default().normalize()
}

// ── Listener ──────────────────────────────────────────────────────────────────

pub struct EventListener {
    provider: Arc<Provider<Http>>,
    marketplace_address: Address,
    db: PgPool,
}

impl EventListener {
    pub fn from_env(db: PgPool) -> Option<Self> {
        let marketplace_address = std::env::var("MARKETPLACE_CONTRACT").ok()?.parse::<Address>().ok()?;
        let rpc_url = std::env::var("CELO_RPC_URL").unwrap_or_else(|_| "https://forno.celo.org".into());
        let provider = Provider::<Http>::try_from(rpc_url.as_str()).ok()?;
        Some(Self { provider: Arc::new(provider), marketplace_address, db })
    }

    pub fn spawn(self) {
        tokio::spawn(async move {
            tracing::info!("Event listener started for marketplace {:?}", self.marketplace_address);
            let mut items: Option<ListenerItems<Provider<Http>>> = None;
            loop {
                if items.is_none() {
                    let market = ListenerMarketplace::new(self.marketplace_address, self.provider.clone());
                    match market.items().call().await {
                        Ok(addr) => items = Some(ListenerItems::new(addr, self.provider.clone())),
                        Err(e) => tracing::error!("Event listener: can't read marketplace.items(): {}", e),
                    }
                }
                if let Some(items) = items.as_ref() {
                    match self.poll_once(items).await {
                        Ok(n) if n > 0 => tracing::info!("Event listener: applied {} marketplace events", n),
                        Err(e) => tracing::error!("Event listener error: {}", e),
                        _ => {}
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(POLL_SECS)).await;
            }
        });
    }

    async fn poll_once(&self, items: &ListenerItems<Provider<Http>>) -> Result<usize> {
        let latest = self.provider.get_block_number().await?.as_u64().saturating_sub(SAFE_LAG);
        let saved: Option<i64> = sqlx::query_scalar("SELECT last_block FROM chain_cursors WHERE name = $1")
            .bind(CURSOR).fetch_optional(&self.db).await?;
        let mut from = match saved {
            Some(b) => b as u64 + 1,
            None => std::env::var("EVENT_LISTENER_START_BLOCK").ok().and_then(|v| v.parse().ok())
                .unwrap_or_else(|| latest.saturating_sub(FIRST_RUN_LOOKBACK)),
        };
        let topics = vec![topic(SIG_ITEM_PURCHASED), topic(SIG_RESALE_PURCHASED), topic(SIG_ITEM_GIFTED)];
        let mut applied = 0;

        while from <= latest {
            let to = (from + CHUNK - 1).min(latest);
            let filter = Filter::new()
                .address(self.marketplace_address)
                .topic0(ValueOrArray::Array(topics.iter().map(|t| Some(*t)).collect()))
                .from_block(BlockNumber::Number(from.into()))
                .to_block(BlockNumber::Number(to.into()));
            let mut logs: Vec<Log> = self.provider.get_logs(&filter).await?;
            logs.sort_by_key(|l| (l.block_number.map(|b| b.as_u64()), l.log_index.map(|i| i.as_u64())));

            for log in &logs {
                match self.apply(log, items).await {
                    Ok(true) => applied += 1,
                    Ok(false) => {}
                    Err(e) => {
                        // Stop just before this block; it is retried next poll.
                        let block = log.block_number.map(|b| b.as_u64()).unwrap_or(from);
                        tracing::error!("Event listener: failed at block {} ({:?}): {}", block, log.transaction_hash, e);
                        self.save_cursor(block.saturating_sub(1)).await?;
                        return Ok(applied);
                    }
                }
            }
            self.save_cursor(to).await?;
            from = to + 1;
        }
        Ok(applied)
    }

    async fn save_cursor(&self, block: u64) -> Result<()> {
        sqlx::query(
            "INSERT INTO chain_cursors (name, last_block) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()",
        )
        .bind(CURSOR).bind(block as i64).execute(&self.db).await?;
        Ok(())
    }

    /// Apply one log. Ok(false) = already applied (or not ours).
    async fn apply(&self, log: &Log, items: &ListenerItems<Provider<Http>>) -> Result<bool> {
        let event = match decode(&log.topics, &log.data) {
            Ok(e) => e,
            Err(e) => { tracing::warn!("Event listener: skipping undecodable log {:?}: {}", log.transaction_hash, e); return Ok(false); }
        };
        let tx = format!("{:?}", log.transaction_hash.ok_or_else(|| anyhow!("log without tx hash"))?);
        let log_index = log.log_index.ok_or_else(|| anyhow!("log without index"))?.as_u64() as i64;
        let block = log.block_number.map(|b| b.as_u64() as i64).unwrap_or(0);
        let name = match &event { MarketEvent::Purchased { .. } => "ItemPurchased", MarketEvent::Gifted { .. } => "ItemGifted", MarketEvent::Resold { .. } => "ResalePurchased" };

        // Claim it. Already claimed = already applied.
        let claimed = sqlx::query(
            "INSERT INTO chain_events_processed (tx_hash, log_index, event, block_number) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING",
        )
        .bind(&tx).bind(log_index).bind(name).bind(block)
        .execute(&self.db).await?.rows_affected();
        if claimed == 0 { return Ok(false); }

        let result = self.apply_effects(&event, &tx, items).await;
        if result.is_err() {
            let _ = sqlx::query("DELETE FROM chain_events_processed WHERE tx_hash = $1 AND log_index = $2")
                .bind(&tx).bind(log_index).execute(&self.db).await;
        }
        result.map(|_| true)
    }

    async fn item_uuid(&self, on_chain_id: u64) -> Result<Option<uuid::Uuid>> {
        Ok(sqlx::query_scalar("SELECT id FROM items WHERE on_chain_id = $1")
            .bind(on_chain_id as i16).fetch_optional(&self.db).await?)
    }

    /// Adds the item to `wallet`'s inventory; true if it wasn't there already.
    /// A wallet with no Valor player (a buyer straight on the contract who never
    /// signed up) is skipped: `inventory` requires a player row, and failing here
    /// would stall the listener on that block forever.
    async fn grant(&self, wallet: &str, item: uuid::Uuid) -> Result<bool> {
        let is_player: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM players WHERE wallet_address = $1)")
            .bind(wallet).fetch_one(&self.db).await?;
        if !is_player {
            tracing::info!("Event listener: {} isn't a Valor player — item {} not added to any inventory", wallet, item);
            return Ok(false);
        }
        Ok(sqlx::query(
            "INSERT INTO inventory (wallet_address, item_id, equipped, acquired_at)
             VALUES ($1, $2, false, now()) ON CONFLICT (wallet_address, item_id) DO NOTHING",
        )
        .bind(wallet).bind(item).execute(&self.db).await?.rows_affected() == 1)
    }

    async fn decrement_supply(&self, item: uuid::Uuid) -> Result<()> {
        sqlx::query("UPDATE items SET remaining_supply = GREATEST(0, remaining_supply - 1) WHERE id = $1 AND remaining_supply IS NOT NULL")
            .bind(item).execute(&self.db).await?;
        Ok(())
    }

    async fn apply_effects(&self, event: &MarketEvent, tx: &str, items: &ListenerItems<Provider<Http>>) -> Result<()> {
        match event {
            MarketEvent::Purchased { buyer, item, price_wei } => {
                let Some(uuid) = self.item_uuid(*item).await? else {
                    tracing::warn!("ItemPurchased for unknown on_chain_id {}", item);
                    return Ok(());
                };
                // A relay purchase is already in inventory (and ledgered) by now;
                // only a purchase made straight on the contract adds anything.
                if self.grant(buyer, uuid).await? {
                    self.decrement_supply(uuid).await?;
                    crate::handlers::ledger::insert_ledger_entry(
                        &self.db, buyer, "marketplace_purchase", wei_to_g(*price_wei), Some(tx), None, ChainId::Celo,
                    ).await;
                    tracing::info!("Event listener: {} bought item {} directly on chain", buyer, uuid);
                }
            }
            MarketEvent::Gifted { recipient, item, .. } => {
                let Some(uuid) = self.item_uuid(*item).await? else { return Ok(()); };
                if self.grant(recipient, uuid).await? {
                    self.decrement_supply(uuid).await?;
                    tracing::info!("Event listener: {} received gifted item {} directly on chain", recipient, uuid);
                }
            }
            MarketEvent::Resold { buyer, seller, item, price_wei, fee_wei } => {
                let Some(uuid) = self.item_uuid(*item).await? else {
                    tracing::warn!("ResalePurchased for unknown on_chain_id {}", item);
                    return Ok(());
                };
                self.grant(buyer, uuid).await?;
                // The seller may hold more than one copy: only drop the item from
                // their game inventory once they hold none on chain. (An error here
                // fails the event, so it is retried rather than guessed.)
                let seller_addr: Address = seller.parse()?;
                let left = items.balance_of(seller_addr, U256::from(*item)).call().await?;
                if left.is_zero() {
                    sqlx::query("DELETE FROM inventory WHERE wallet_address = $1 AND item_id = $2")
                        .bind(seller).bind(uuid).execute(&self.db).await?;
                }
                let price = wei_to_g(*price_wei);
                let earned = wei_to_g(price_wei.saturating_sub(*fee_wei));
                crate::handlers::ledger::insert_ledger_entry(
                    &self.db, buyer, "resale_purchase", price, Some(tx), Some(seller), ChainId::Celo,
                ).await;
                crate::handlers::ledger::insert_ledger_entry(
                    &self.db, seller, "resale_sale", earned, Some(tx), Some(buyer), ChainId::Celo,
                ).await;
                tracing::info!("Event listener: resale of item {} {} -> {} for {} G$", uuid, seller, buyer, price);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w_addr(a: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[12..].copy_from_slice(&hex::decode(a.trim_start_matches("0x")).unwrap());
        out
    }
    fn w_u(v: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        U256::from(v).to_big_endian(&mut out);
        out
    }

    #[test]
    fn topics_match_the_contract_event_signatures() {
        // keccak256 of each signature, as `cast keccak` prints it.
        assert_eq!(format!("{:?}", topic(SIG_ITEM_PURCHASED)), "0x1452773cf753d0d7c71ed9990f7c7e2bdde4a2d08d187b3647953877e400488d");
        assert_eq!(format!("{:?}", topic(SIG_RESALE_PURCHASED)), "0x99788b12da28130f658dbcf1a3f19c47c0caaf0d1c4885dcaeec7ec708ec1ee7");
        assert_eq!(format!("{:?}", topic(SIG_ITEM_GIFTED)), "0x0a8bea01579472f1ca9e13927474a7f2c3e47ca94369ddc095bfb8db5fcbfca1");
    }

    #[test]
    fn decodes_a_resale_with_the_seller_and_item_from_data() {
        let buyer = "0x00000000000000000000000000000000000000b2";
        let seller = "0x00000000000000000000000000000000000000c3";
        let topics = vec![topic(SIG_RESALE_PURCHASED), H256::from(w_u(42)), H256::from(w_addr(buyer))];
        let data = [w_addr(seller), w_u(7), w_u(100), w_u(5)].concat();
        assert_eq!(decode(&topics, &data).unwrap(), MarketEvent::Resold {
            buyer: buyer.into(), seller: seller.into(), item: 7,
            price_wei: U256::from(100), fee_wei: U256::from(5),
        });
    }

    #[test]
    fn decodes_purchase_and_gift_and_ignores_others() {
        let a = "0x00000000000000000000000000000000000000a1";
        let b = "0x00000000000000000000000000000000000000b2";
        let p = decode(&[topic(SIG_ITEM_PURCHASED), H256::from(w_addr(a)), H256::from(w_u(3))], &w_u(9)).unwrap();
        assert_eq!(p, MarketEvent::Purchased { buyer: a.into(), item: 3, price_wei: U256::from(9) });
        let g = decode(&[topic(SIG_ITEM_GIFTED), H256::from(w_addr(a)), H256::from(w_addr(b)), H256::from(w_u(4))], &w_u(9)).unwrap();
        assert_eq!(g, MarketEvent::Gifted { payer: a.into(), recipient: b.into(), item: 4, price_wei: U256::from(9) });
        assert!(decode(&[topic("Something(uint256)")], &[]).is_err());
        assert!(decode(&[topic(SIG_RESALE_PURCHASED), H256::zero(), H256::zero()], &w_u(1)).is_err(), "short data must not decode");
    }

    #[test]
    fn wei_converts_to_whole_g() {
        assert_eq!(wei_to_g(U256::from_dec_str("12500000000000000000").unwrap()).to_string(), "12.5");
        assert_eq!(wei_to_g(U256::zero()).to_string(), "0");
    }
}
