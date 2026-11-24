//! In-app notifications — the feed behind the bell in the top bar.
//!
//! Events are stored (`record`); states ("your daily G$ is ready", "the seasonal
//! campaign is live", "new in the shop") are derived when the feed is read, in
//! `handlers::notifications`. See migrations/add_notifications.sql.

use rust_decimal::Decimal;
use sqlx::PgPool;

/// Store one notification. `wallet` None = a broadcast every player sees.
/// `dedupe_key` makes it idempotent (a retried event never shows twice).
/// Best-effort: a failure is logged and never fails whatever triggered it.
pub async fn record(
    db: &PgPool,
    wallet: Option<&str>,
    kind: &str,
    title: &str,
    body: &str,
    url: Option<&str>,
    dedupe_key: Option<&str>,
) {
    let result = sqlx::query(
        "INSERT INTO notifications (wallet_address, kind, title, body, url, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (dedupe_key) DO NOTHING",
    )
    .bind(wallet.map(|w| w.to_lowercase()))
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(url)
    .bind(dedupe_key)
    .execute(db)
    .await;
    if let Err(e) = result {
        tracing::warn!("failed to record notification ({:?} {}): {}", wallet, kind, e);
    }
}

/// `12.5000` → `12.5`, `3.00` → `3`.
pub fn fmt_g(amount: Decimal) -> String {
    amount.abs().normalize().to_string()
}

fn short_wallet(w: &str) -> String {
    if w.len() > 10 { format!("{}…{}", &w[..6], &w[w.len() - 4..]) } else { w.to_string() }
}

/// What a G$ ledger entry means to the player, as a notification:
/// (kind, title, body, url). None = not worth a notification (in-game spend,
/// fees, stakes — the player is looking at those as they happen).
pub fn for_ledger(category: &str, amount: Decimal) -> Option<(&'static str, String, String, &'static str)> {
    let g = fmt_g(amount);
    let (kind, title, body, url) = match category {
        "battle_reward" => ("money", format!("+{g} G$ earned"), "Battle reward paid to your wallet.".to_string(), "/profile"),
        "season_reward" => ("money", format!("+{g} G$ season prize"), "Your seasonal campaign prize has been paid.".to_string(), "/profile"),
        "referral_reward" => ("money", format!("+{g} G$ referral reward"), "Someone you invited joined Valor.".to_string(), "/profile"),
        "referral_campaign_reward" => ("money", format!("+{g} G$ campaign reward"), "Your referral campaign reward has been paid.".to_string(), "/profile"),
        "duel_payout" => ("money", format!("+{g} G$ duel winnings"), "Your duel was settled in your favour.".to_string(), "/multiplayer"),
        "duel_refund" => ("transaction", format!("+{g} G$ stake refunded"), "Your duel stake was refunded.".to_string(), "/multiplayer"),
        "challenge_reward" => ("money", format!("+{g} G$ challenge reward"), "A challenge reward has been paid to you.".to_string(), "/profile"),
        "ubi_claim" => ("transaction", format!("Daily claim: +{g} G$"), "Your daily G$ claim went through.".to_string(), "/profile"),
        "marketplace_purchase" => ("transaction", "Purchase complete".to_string(), format!("{g} G$ spent in the Market."), "/marketplace"),
        "marketplace_gift" => ("transaction", "Gift sent".to_string(), format!("{g} G$ — your gift has been delivered."), "/marketplace"),
        "transfer_out" => ("transaction", format!("Sent {g} G$"), "Your transfer went through.".to_string(), "/profile"),
        _ => return None,
    };
    Some((kind, title, body, url))
}

/// Notifications for one ledger entry: the player's own, plus — for a transfer
/// to another wallet — a "you received" for the recipient.
pub async fn record_for_ledger(
    db: &PgPool,
    wallet: &str,
    category: &str,
    amount: Decimal,
    tx_hash: Option<&str>,
    counterparty: Option<&str>,
) {
    if let Some((kind, title, mut body, url)) = for_ledger(category, amount) {
        if category == "transfer_out" {
            if let Some(to) = counterparty { body = format!("Sent to {}.", short_wallet(to)); }
        }
        let key = tx_hash.map(|h| format!("ledger:{category}:{wallet}:{h}"));
        record(db, Some(wallet), kind, &title, &body, Some(url), key.as_deref()).await;
    }
    if category == "transfer_out" {
        if let Some(to) = counterparty {
            // Name the sender the way the rest of the app does, if they're a player.
            let from = crate::utils::display_name(db, wallet).await.unwrap_or_else(|| short_wallet(wallet));
            let key = tx_hash.map(|h| format!("ledger:received:{to}:{h}"));
            record(
                db, Some(to), "money",
                &format!("+{} G$ received", fmt_g(amount)),
                &format!("{from} sent you G$."),
                Some("/profile"), key.as_deref(),
            ).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn money_in_and_completed_transactions_notify_but_spend_and_fees_do_not() {
        let a = Decimal::from_str("12.5000").unwrap();
        assert_eq!(for_ledger("battle_reward", a).unwrap().1, "+12.5 G$ earned");
        assert_eq!(for_ledger("marketplace_purchase", a).unwrap().0, "transaction");
        assert!(for_ledger("withdraw_fee", a).is_none());
        assert!(for_ledger("survival_rearm", a).is_none());
        assert!(for_ledger("duel_stake", a).is_none());
    }

    #[test]
    fn amounts_print_without_trailing_zeros() {
        assert_eq!(fmt_g(Decimal::from_str("3.00").unwrap()), "3");
        assert_eq!(fmt_g(Decimal::from_str("-0.250").unwrap()), "0.25");
    }
}
