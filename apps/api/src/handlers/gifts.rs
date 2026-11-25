//! Gifting: one player buys a Market item for another.
//!
//!   POST /items/{id}/gift                buy `id` for someone else
//!   GET  /players/{wallet}/gifts         gifts received (newest first) + unseen count
//!   POST /players/{wallet}/gifts/seen    mark received gifts as unwrapped
//!
//! On-chain items go through `ValorMarketplace.giftWithPermit`: the sender signs
//! a G$ permit (who pays, how much) AND an EIP-712 `Gift` naming the recipient,
//! so the relay that submits it can't redirect the gift. Off-chain items (ammo,
//! attachments) move no G$, exactly like buying them; the sender's session token
//! proves who is giving.
//!
//! Delivery is instant — no accept step. The recipient gets a bell notification
//! and phone push, and an "unwrap" card the next time they open the app.

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use ethers::types::Address;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::models::item::Item;
use crate::services::push::notify;
use crate::utils::{display_name, is_valid_wallet, normalize_wallet};
use crate::AppState;

/// Longest note a sender can attach.
const MAX_MESSAGE_CHARS: usize = 140;

#[derive(Deserialize)]
pub struct GiftRequest {
    pub wallet_address: String,
    /// The recipient's wallet (the client resolves a username to it first).
    pub recipient: String,
    #[serde(default)]
    pub message: String,
    /// On-chain items only: the G$ permit and the EIP-712 Gift signature.
    pub deadline: Option<u64>,
    pub v: Option<u8>,
    pub r: Option<String>,
    pub s: Option<String>,
    pub gift_sig: Option<String>,
}

/// Why a gift can't be sent, before anything is signed or spent. Pure, so the
/// rules are tested without a database.
pub fn gift_problem(sender: &str, recipient: &str, recipient_exists: bool, recipient_owns: bool) -> Option<&'static str> {
    if sender == recipient { return Some("You can't gift an item to yourself"); }
    if !recipient_exists { return Some("No player with that wallet"); }
    if recipient_owns { return Some("They already own this item"); }
    None
}

/// Trim and cap the note; strip control characters so it renders safely.
pub fn clean_message(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(MAX_MESSAGE_CHARS).collect()
}

pub async fn gift_item(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
    body: web::Json<GiftRequest>,
) -> HttpResponse {
    let item_id = path.into_inner();
    if !is_valid_wallet(&body.wallet_address) || !is_valid_wallet(&body.recipient) {
        return HttpResponse::BadRequest().json(json!({"error": "Invalid wallet address"}));
    }
    let sender = normalize_wallet(&body.wallet_address);
    let recipient = normalize_wallet(&body.recipient);
    let message = clean_message(&body.message);

    let item: Item = match sqlx::query_as::<_, Item>("SELECT * FROM items WHERE id = $1")
        .bind(item_id).fetch_optional(&state.db).await
    {
        Ok(Some(i)) => i,
        Ok(None) => return HttpResponse::NotFound().json(json!({"error": "Item not found"})),
        Err(_) => return HttpResponse::InternalServerError().json(json!({"error": "Database error"})),
    };
    if item.remaining_supply.is_some_and(|r| r <= 0) {
        return HttpResponse::Conflict().json(json!({"error": "Item sold out"}));
    }
    if item.sale_ends_at.is_some_and(|t| t <= Utc::now()) {
        return HttpResponse::Conflict().json(json!({"error": "This item is no longer on sale"}));
    }

    let recipient_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM players WHERE wallet_address = $1)")
        .bind(&recipient).fetch_one(&state.db).await.unwrap_or(false);
    let recipient_owns: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM inventory WHERE wallet_address = $1 AND item_id = $2)",
    )
    .bind(&recipient).bind(item_id).fetch_one(&state.db).await.unwrap_or(false);
    if let Some(why) = gift_problem(&sender, &recipient, recipient_exists, recipient_owns) {
        return HttpResponse::BadRequest().json(json!({"error": why}));
    }

    let tx_hash = if let Some(on_chain_id) = item.on_chain_id {
        let (Some(deadline), Some(v), Some(r), Some(s), Some(gift_sig)) =
            (body.deadline, body.v, body.r.as_deref(), body.s.as_deref(), body.gift_sig.as_deref())
        else {
            return HttpResponse::BadRequest().json(json!({"error": "A gift needs your signed payment and gift approval"}));
        };
        let (Ok(payer), Ok(to)) = (sender.parse::<Address>(), recipient.parse::<Address>()) else {
            return HttpResponse::BadRequest().json(json!({"error": "Invalid wallet address"}));
        };
        let Some(chain) = state.chain.as_ref() else {
            return HttpResponse::ServiceUnavailable().json(json!({"error": "Chain relay not available"}));
        };
        if !chain.gifting_live().await {
            return HttpResponse::ServiceUnavailable().json(json!({
                "error": "Gifting this item isn't live yet — nothing was charged.",
                "code": "GIFTING_NOT_LIVE",
            }));
        }
        if !chain.relay_can_pay().await {
            return HttpResponse::ServiceUnavailable().json(json!({
                "error": "Valor can't process gifts right now — our relay is out of gas. You have not been charged.",
                "code": crate::services::chain::RELAY_OUT_OF_GAS,
            }));
        }
        match chain.gift_item_for(payer, to, on_chain_id as u64, deadline, v, r, s, gift_sig).await {
            Ok(hash) => format!("{:?}", hash),
            Err(e) => {
                tracing::warn!("gift relay failed {} -> {} item {}: {}", sender, recipient, item_id, e);
                if crate::services::chain::is_out_of_gas(&e) {
                    return HttpResponse::ServiceUnavailable().json(json!({
                        "error": "Valor's relay ran out of gas mid-gift. You have not been charged.",
                        "code": crate::services::chain::RELAY_OUT_OF_GAS,
                    }));
                }
                return HttpResponse::BadRequest().json(json!({"error": e}));
            }
        }
    } else {
        // Off-chain item: no G$ moves (same as buying one), so the session
        // token is what proves the sender is who they say.
        if let Err(resp) = crate::auth::verify_player_token(&req, &sender) { return resp; }
        format!("offchain-gift-{}", Uuid::new_v4())
    };

    // Deliver: the item is theirs now, exactly as if they'd bought it. The
    // earlier sold-out/owns checks were only a fast-path rejection — this is
    // what actually closes the race (shared with the purchase path so a
    // future fix only has to happen once). By this point an on-chain item's
    // G$ has already moved, so losing this race means the sender was charged
    // for nothing — logged loudly since there's no way to reverse that
    // transfer from here.
    if crate::handlers::items::deliver_item(&state.db, &recipient, item_id, item.remaining_supply.is_some()).await.is_err() {
        tracing::error!(
            "gift delivery lost a race: {} -> {} item {} tx={} — needs a manual refund",
            sender, recipient, item_id, tx_hash,
        );
        return HttpResponse::Conflict().json(json!({
            "error": "Your gift could not be delivered (sold out or already owned). Contact support for a refund.",
        }));
    }

    // `gifts.tx_hash` records a real on-chain hash or nothing — never the
    // fabricated `offchain-gift-<uuid>` placeholder used for g_ledger below,
    // so a lookup against this column can't mistake it for a real tx.
    let gift_tx_hash = item.on_chain_id.is_some().then(|| tx_hash.as_str());
    let gift_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO gifts (item_id, from_wallet, to_wallet, message, tx_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(item_id).bind(&sender).bind(&recipient).bind(&message).bind(gift_tx_hash)
    .fetch_one(&state.db).await.ok();

    crate::handlers::ledger::insert_ledger_entry(
        &state.db, &sender, "marketplace_gift", item.price_g, Some(&tx_hash), Some(&recipient),
        crate::services::chain_id::ChainId::Celo,
    ).await;

    // GiftUnwrap mounts globally and polls for unseen gifts on its own — no
    // page reads a `?gifts=1` param, so linking straight to /profile is all
    // this needs; the unwrap card pops the moment the page loads either way.
    let from_name = display_name(&state.db, &sender).await.unwrap_or_else(|| "A friend".into());
    notify(&state, recipient.clone(), "gift", format!("{from_name} sent you a gift: {} 🎁", item.name), "/profile");

    if item.on_chain_id.is_some() {
        if let Some(chain) = state.chain.as_ref().cloned() {
            tokio::spawn(async move {
                if let Err(e) = chain.sweep_revenue_to_pool().await {
                    tracing::warn!("marketplace revenue sweep after gift failed: {}", e);
                }
            });
        }
    }

    tracing::info!("Gift confirmed: item={} {} -> {} tx={}", item_id, sender, recipient, tx_hash);
    HttpResponse::Ok().json(json!({
        "success": true, "gift_id": gift_id, "item_id": item_id, "recipient": recipient, "tx_hash": tx_hash,
    }))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ReceivedGift {
    pub id: Uuid,
    pub item_id: Uuid,
    pub item_name: String,
    pub item_rarity: String,
    pub item_image_url: String,
    pub from_wallet: String,
    pub from_name: Option<String>,
    pub message: String,
    pub created_at: DateTime<Utc>,
    pub seen: bool,
}

pub async fn list_received(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }
    let gifts: Vec<ReceivedGift> = sqlx::query_as(
        "SELECT g.id, g.item_id, i.name AS item_name, i.rarity AS item_rarity, i.image_url AS item_image_url,
                g.from_wallet, COALESCE(NULLIF(p.username, ''), p.character_name) AS from_name,
                g.message, g.created_at, (g.seen_at IS NOT NULL) AS seen
         FROM gifts g
         JOIN items i ON i.id = g.item_id
         LEFT JOIN players p ON p.wallet_address = g.from_wallet
         WHERE g.to_wallet = $1
         ORDER BY g.created_at DESC LIMIT 50",
    )
    .bind(&wallet).fetch_all(&state.db).await.unwrap_or_default();
    let unseen = gifts.iter().filter(|g| !g.seen).count();
    HttpResponse::Ok().json(json!({ "gifts": gifts, "unseen": unseen }))
}

pub async fn mark_seen(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }
    let _ = sqlx::query("UPDATE gifts SET seen_at = now() WHERE to_wallet = $1 AND seen_at IS NULL")
        .bind(&wallet).execute(&state.db).await;
    HttpResponse::Ok().json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gift_rules() {
        assert_eq!(gift_problem("0xa", "0xa", true, false), Some("You can't gift an item to yourself"));
        assert_eq!(gift_problem("0xa", "0xb", false, false), Some("No player with that wallet"));
        assert_eq!(gift_problem("0xa", "0xb", true, true), Some("They already own this item"));
        assert_eq!(gift_problem("0xa", "0xb", true, false), None);
    }

    #[test]
    fn notes_are_trimmed_capped_and_stripped_of_control_characters() {
        assert_eq!(clean_message("  happy birthday\n "), "happy birthday");
        assert_eq!(clean_message("a\u{0007}b"), "ab");
        assert_eq!(clean_message(&"x".repeat(500)).chars().count(), MAX_MESSAGE_CHARS);
    }
}
