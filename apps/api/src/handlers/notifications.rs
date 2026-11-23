//! The notification bell's feed.
//!
//!   GET  /players/{wallet}/notifications       newest first, with an unread count
//!   POST /players/{wallet}/notifications/seen  mark everything up to now as read
//!
//! Both require the player's session token: the feed shows money received and
//! purchases, which are nobody else's business.
//!
//! The feed is stored events (services::notifications::record — chat, money,
//! transactions, friends, duels) merged with STATES derived at read time, which
//! can't go stale or be missed by a cron:
//!   - the daily G$ claim is ready
//!   - a seasonal campaign is live
//!   - something new dropped in the Market (added in the last week)

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::utils::normalize_wallet;
use crate::AppState;

/// How many items the bell shows.
const FEED_LIMIT: i64 = 50;
/// How long a new Market item counts as a fresh drop.
const NEW_DROP_DAYS: i64 = 7;

#[derive(Serialize, Clone)]
pub struct FeedItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub unread: bool,
}

#[derive(sqlx::FromRow)]
struct StoredRow {
    id: Uuid,
    kind: String,
    title: String,
    body: String,
    url: Option<String>,
    created_at: DateTime<Utc>,
}

pub async fn list(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }
    let db = &state.db;
    let now = Utc::now();

    let seen_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT seen_at FROM notification_reads WHERE wallet_address = $1",
    )
    .bind(&wallet)
    .fetch_optional(db)
    .await
    .unwrap_or(None);

    let mut items: Vec<FeedItem> = Vec::new();

    // Stored events: this player's own, plus broadcasts.
    let stored: Vec<StoredRow> = sqlx::query_as(
        "SELECT id, kind, title, body, url, created_at FROM notifications
         WHERE wallet_address = $1 OR wallet_address IS NULL
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(&wallet)
    .bind(FEED_LIMIT)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for r in stored {
        items.push(FeedItem {
            id: r.id.to_string(), kind: r.kind, title: r.title, body: r.body, url: r.url,
            created_at: r.created_at, unread: false,
        });
    }

    // Daily G$ claim ready — "new" from the moment it became claimable. A player
    // who has never claimed has had it ready since they signed up, not since
    // "now" — using `now` here would make the item permanently unread, since
    // every poll would push its created_at past the last seen_at.
    let last_claim: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT last_claimed_at FROM daily_claims WHERE wallet_address = $1",
    )
    .bind(&wallet)
    .fetch_optional(db)
    .await
    .unwrap_or(None);
    let ready_at = match last_claim {
        Some(t) => Some(t + Duration::hours(24)),
        None => sqlx::query_scalar("SELECT created_at FROM players WHERE wallet_address = $1")
            .bind(&wallet)
            .fetch_optional(db)
            .await
            .unwrap_or(None),
    };
    if ready_at.map_or(true, |t| now >= t) {
        let at = ready_at.unwrap_or(now);
        items.push(FeedItem {
            id: format!("claim:daily:{}", at.timestamp()),
            kind: "claim".into(),
            title: "Your daily G$ is ready".into(),
            body: "Claim it now — it's free, once a day.".into(),
            url: Some("/".into()),
            created_at: at,
            unread: false,
        });
    }

    // Seasonal campaigns that are live right now.
    let live: Vec<(Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, name, starts_at, ends_at FROM seasons
         WHERE starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY starts_at DESC LIMIT 3",
    )
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for (id, name, starts_at, ends_at) in live {
        let body = match ends_at {
            Some(end) => {
                let hours = (end - now).num_hours();
                if hours >= 1 { format!("Live now — {hours}h left to get on the board.") }
                else { "Live now — closing within the hour.".to_string() }
            }
            None => "Live now — get on the board.".to_string(),
        };
        items.push(FeedItem {
            id: format!("campaign:{id}"),
            kind: "campaign".into(),
            title: format!("{name} is live"),
            body,
            url: Some("/seasonal".into()),
            created_at: starts_at,
            unread: false,
        });
    }

    // Fresh Market drops still on sale.
    let drops: Vec<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, name, rarity, created_at FROM items
         WHERE created_at > now() - make_interval(days => $1)
           AND (sale_ends_at IS NULL OR sale_ends_at > now())
           AND (remaining_supply IS NULL OR remaining_supply > 0)
         ORDER BY created_at DESC LIMIT 5",
    )
    .bind(NEW_DROP_DAYS as i32)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    for (id, name, rarity, created_at) in drops {
        items.push(FeedItem {
            id: format!("drop:{id}"),
            kind: "drop".into(),
            title: format!("New drop: {name}"),
            body: format!("A {rarity} item just landed in the Market."),
            url: Some("/marketplace".into()),
            created_at,
            unread: false,
        });
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items.truncate(FEED_LIMIT as usize);
    for it in items.iter_mut() {
        it.unread = seen_at.map_or(true, |s| it.created_at > s);
    }
    let unread = items.iter().filter(|i| i.unread).count();

    HttpResponse::Ok().json(json!({ "items": items, "unread": unread }))
}

pub async fn mark_seen(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }
    let result = sqlx::query(
        "INSERT INTO notification_reads (wallet_address, seen_at) VALUES ($1, now())
         ON CONFLICT (wallet_address) DO UPDATE SET seen_at = now()",
    )
    .bind(&wallet)
    .execute(&state.db)
    .await;
    match result {
        Ok(_) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => {
            tracing::error!("mark notifications seen failed for {}: {}", wallet, e);
            HttpResponse::InternalServerError().json(json!({ "error": "Could not update notifications" }))
        }
    }
}
