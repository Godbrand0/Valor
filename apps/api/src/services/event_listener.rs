use anyhow::{anyhow, Result};
use ethers::{
    abi::AbiParser,
    providers::{Http, Middleware, Provider},
    types::{Address, BlockNumber, Filter, Log, H256, U256},
};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::str::FromStr;

use crate::handlers::ledger::{insert_ledger_entry, wei_to_g};
use crate::services::chain_id::ChainId;

// ItemPurchased(address indexed buyer, uint256 indexed itemId, uint256 price)
const ITEM_PURCHASED_SIG: &str = "0xb36e9bde73c83cdc2a8be05c3ea4d4a4a5c0a2d22d826dbab3c56d7db42f1b8d";
// ResalePurchased(uint256 indexed resaleId, address indexed buyer, address seller, uint256 itemId, uint256 price, uint256 fee)
const RESALE_PURCHASED_SIG: &str = "0x99788b12da28130f658dbcf1a3f19c47c0caaf0d1c4885dcaeec7ec708ec1ee7";

/// Listens for `ItemPurchased` and `ResalePurchased` events from ValorMarketplace
/// and writes the authoritative inventory/ledger rows to Postgres — the frontend
/// talks to the contract directly for both purchase and resale, so this is the
/// only place either one is recorded off-chain.
///
/// Runs as a background Tokio task with 30-second polling. Idempotent — the
/// inventory upsert uses ON CONFLICT DO NOTHING, and a resale's two ledger
/// writes are each guarded by a check for an existing row with the same
/// tx_hash + category, so re-processing a block (e.g. after a restart) is safe.
pub struct EventListener {
    provider:             Provider<Http>,
    marketplace_address:  Address,
    db:                   PgPool,
}

impl EventListener {
    pub fn from_env(db: PgPool) -> Option<Self> {
        let marketplace_str = std::env::var("MARKETPLACE_CONTRACT").ok()?;
        let marketplace_address = marketplace_str.parse::<Address>().ok()?;
        let rpc_url = std::env::var("CELO_RPC_URL")
            .unwrap_or_else(|_| "https://forno.celo.org".into());
        let provider = Provider::<Http>::try_from(rpc_url.as_str()).ok()?;

        Some(Self { provider, marketplace_address, db })
    }

    /// Spawns the event listener as a background task.
    pub fn spawn(self) {
        tokio::spawn(async move {
            tracing::info!("Event listener started for marketplace {:?}", self.marketplace_address);
            let mut last_block: u64 = 0;

            loop {
                match self.poll_once(&mut last_block).await {
                    Ok(n) if n > 0 => tracing::info!("Event listener: processed {} marketplace events", n),
                    Err(e) => tracing::error!("Event listener error: {}", e),
                    _ => {}
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            }
        });
    }

    async fn poll_once(&self, last_block: &mut u64) -> Result<usize> {
        let latest = self.provider.get_block_number().await?.as_u64();

        // On first run start from 50 blocks back; otherwise continue from last seen
        let from_block = if *last_block == 0 {
            latest.saturating_sub(50)
        } else {
            *last_block + 1
        };

        if from_block > latest {
            return Ok(0);
        }

        let item_purchased_sig: H256 = ITEM_PURCHASED_SIG.parse().map_err(|_| anyhow!("bad event sig"))?;
        let resale_purchased_sig: H256 = RESALE_PURCHASED_SIG.parse().map_err(|_| anyhow!("bad event sig"))?;

        let filter = Filter::new()
            .address(self.marketplace_address)
            .topic0(vec![item_purchased_sig, resale_purchased_sig])
            .from_block(BlockNumber::Number(from_block.into()))
            .to_block(BlockNumber::Number(latest.into()));

        let logs: Vec<Log> = self.provider.get_logs(&filter).await?;
        let count = logs.len();

        for log in &logs {
            let sig = log.topics.first().copied().unwrap_or_default();
            let result = if sig == resale_purchased_sig {
                self.process_resale_log(log).await
            } else {
                self.process_log(log).await
            };
            if let Err(e) = result {
                tracing::error!("Failed to process marketplace log: {}", e);
            }
        }

        *last_block = latest;
        Ok(count)
    }

    async fn process_log(&self, log: &Log) -> Result<()> {
        // topics[1] = buyer (indexed address, left-padded to 32 bytes)
        // topics[2] = itemId (indexed uint256)
        if log.topics.len() < 3 {
            return Err(anyhow!("Unexpected topic count: {}", log.topics.len()));
        }

        // Derive buyer address from last 20 bytes of topics[1]
        let buyer_bytes = &log.topics[1].as_bytes()[12..];
        let buyer = format!("0x{}", hex::encode(buyer_bytes));

        // Item ID = topics[2] interpreted as U256
        let item_on_chain_id = U256::from_big_endian(log.topics[2].as_bytes()).as_u64();

        // Resolve on_chain_id → Supabase item UUID
        let item_row: Option<(uuid::Uuid,)> = sqlx::query_as(
            "SELECT id FROM items WHERE on_chain_id = $1",
        )
        .bind(item_on_chain_id as i32)
        .fetch_optional(&self.db)
        .await?;

        let Some((item_uuid,)) = item_row else {
            tracing::warn!("ItemPurchased event for unknown on_chain_id: {}", item_on_chain_id);
            return Ok(());
        };

        // Upsert inventory — ON CONFLICT DO NOTHING makes this idempotent
        let now = chrono::Utc::now();
        sqlx::query(
            "INSERT INTO inventory (wallet_address, item_id, equipped, acquired_at)
             VALUES ($1, $2, false, $3)
             ON CONFLICT (wallet_address, item_id) DO NOTHING",
        )
        .bind(&buyer)
        .bind(item_uuid)
        .bind(now)
        .execute(&self.db)
        .await?;

        // Decrement remaining_supply if limited
        sqlx::query(
            "UPDATE items
             SET remaining_supply = remaining_supply - 1
             WHERE on_chain_id = $1 AND remaining_supply IS NOT NULL AND remaining_supply > 0",
        )
        .bind(item_on_chain_id as i32)
        .execute(&self.db)
        .await?;

        tracing::info!(
            "Inventory: {} acquired item on_chain_id={} ({})",
            buyer, item_on_chain_id, item_uuid
        );

        Ok(())
    }

    /// `ResalePurchased(uint256 indexed resaleId, address indexed buyer, address seller,
    /// uint256 itemId, uint256 price, uint256 fee)` — the only place a resale sale is
    /// recorded off-chain. Moves the item between inventory rows (the on-chain transfer
    /// already happened; this just mirrors it) and writes a ledger row for each side,
    /// which is also what puts "sold"/"bought on resale" in the notification bell.
    async fn process_resale_log(&self, log: &Log) -> Result<()> {
        // topics[1] = resaleId (indexed uint256), topics[2] = buyer (indexed address)
        if log.topics.len() < 3 {
            return Err(anyhow!("Unexpected topic count: {}", log.topics.len()));
        }
        // Non-indexed data, in order: seller(address), itemId(uint256), price(uint256), fee(uint256)
        if log.data.len() < 128 {
            return Err(anyhow!("Unexpected data length: {}", log.data.len()));
        }
        let Some(tx_hash) = log.transaction_hash else {
            return Err(anyhow!("resale log missing transaction hash"));
        };
        let tx_hash = format!("{:?}", tx_hash);

        let buyer = format!("0x{}", hex::encode(&log.topics[2].as_bytes()[12..]));
        let seller = format!("0x{}", hex::encode(&log.data[12..32]));
        let item_on_chain_id = U256::from_big_endian(&log.data[32..64]).as_u64();
        let price = U256::from_big_endian(&log.data[64..96]);
        let fee = U256::from_big_endian(&log.data[96..128]);

        let item_row: Option<(uuid::Uuid,)> = sqlx::query_as(
            "SELECT id FROM items WHERE on_chain_id = $1",
        )
        .bind(item_on_chain_id as i32)
        .fetch_optional(&self.db)
        .await?;

        let Some((item_uuid,)) = item_row else {
            tracing::warn!("ResalePurchased event for unknown on_chain_id: {}", item_on_chain_id);
            return Ok(());
        };

        // Mirror the on-chain transfer: drop it from the seller's inventory,
        // grant it to the buyer. Both idempotent on their own — a repeat DELETE
        // is a no-op, and ON CONFLICT DO NOTHING covers a repeat INSERT.
        sqlx::query("DELETE FROM inventory WHERE wallet_address = $1 AND item_id = $2")
            .bind(&seller)
            .bind(item_uuid)
            .execute(&self.db)
            .await?;

        let now = chrono::Utc::now();
        sqlx::query(
            "INSERT INTO inventory (wallet_address, item_id, equipped, acquired_at)
             VALUES ($1, $2, false, $3)
             ON CONFLICT (wallet_address, item_id) DO NOTHING",
        )
        .bind(&buyer)
        .bind(item_uuid)
        .bind(now)
        .execute(&self.db)
        .await?;

        let price_g = wei_to_g(price);
        let fee_g = wei_to_g(fee);
        let to_seller_g = price_g - fee_g;

        self.insert_resale_ledger_row(&buyer, "marketplace_resale_buy", price_g, &tx_hash, Some(&seller)).await?;
        self.insert_resale_ledger_row(&seller, "marketplace_resale_sell", to_seller_g, &tx_hash, Some(&buyer)).await?;

        tracing::info!(
            "Resale: {} bought item on_chain_id={} from {} for {} G$ ({} fee)",
            buyer, item_on_chain_id, seller, price_g, fee_g,
        );

        Ok(())
    }

    /// One ledger row, skipped if this exact (wallet, category, tx_hash) is already
    /// there — guards both halves of a resale sale against the 50-block re-scan on
    /// every listener restart re-writing them.
    async fn insert_resale_ledger_row(
        &self,
        wallet: &str,
        category: &str,
        amount: Decimal,
        tx_hash: &str,
        counterparty: Option<&str>,
    ) -> Result<()> {
        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM g_ledger WHERE wallet_address = $1 AND category = $2 AND tx_hash = $3)",
        )
        .bind(wallet)
        .bind(category)
        .bind(tx_hash)
        .fetch_one(&self.db)
        .await?;
        if already {
            return Ok(());
        }
        insert_ledger_entry(&self.db, wallet, category, amount, Some(tx_hash), counterparty, ChainId::Celo).await;
        Ok(())
    }
}
