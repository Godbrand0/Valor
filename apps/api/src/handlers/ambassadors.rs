//! Ambassadors: campus/event reps with a short code and a link. A code is just an alias
//! for the ambassador's referrer wallet, so signups flow through the normal referral
//! path (`credit_referral`) and are only recorded for GoodDollar-verified players.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;

use crate::handlers::admin::verify_admin_token;
use crate::utils::{is_valid_wallet, normalize_wallet};
use crate::AppState;

fn valid_code(c: &str) -> bool {
    (3..=24).contains(&c.len()) && c.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

/// Wallet behind an active ambassador code, or None (also None for a plain wallet).
pub async fn resolve_code(db: &PgPool, raw: &str) -> Option<String> {
    let code = raw.trim().to_lowercase();
    if !valid_code(&code) { return None; }
    sqlx::query_scalar("SELECT wallet_address FROM ambassadors WHERE code = $1 AND active")
        .bind(code).fetch_optional(db).await.ok().flatten()
}

pub async fn is_ambassador(db: &PgPool, wallet: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM ambassadors WHERE wallet_address = $1 AND active)")
        .bind(wallet).fetch_one(db).await.unwrap_or(false)
}

// GET /ambassadors/:code: lets onboarding show "Invited by X" for a code.
pub async fn get_public(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let code = path.into_inner().to_lowercase();
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT name, location FROM ambassadors WHERE code = $1 AND active",
    ).bind(&code).fetch_optional(&state.db).await.ok().flatten();
    match row {
        Some((name, location)) => HttpResponse::Ok().json(json!({"code": code, "name": name, "location": location})),
        None => HttpResponse::NotFound().json(json!({"error": "Unknown code"})),
    }
}

// GET /admin/ambassadors
pub async fn admin_list(req: HttpRequest, state: web::Data<AppState>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    // Every referrals row is a verified player (recorded only after the whitelist
    // check), so the count is "verified players brought in".
    let rows: Vec<(String, String, String, String, bool, i64, i64)> = sqlx::query_as(
        "SELECT a.code, a.wallet_address, a.name, a.location, a.active,
                COUNT(r.referred_wallet) FILTER (WHERE r.status <> 'fraud_blocked'),
                COUNT(r.referred_wallet) FILTER (WHERE r.status <> 'fraud_blocked' AND r.created_at > now() - interval '7 days')
         FROM ambassadors a
         LEFT JOIN referrals r ON r.referrer_wallet = a.wallet_address
         GROUP BY a.code ORDER BY 6 DESC, a.created_at",
    ).fetch_all(&state.db).await.unwrap_or_default();
    let list: Vec<_> = rows.iter().map(|(code, wallet, name, location, active, total, week)| json!({
        "code": code, "wallet": wallet, "name": name, "location": location,
        "active": active, "verified": total, "last_7d": week,
    })).collect();
    HttpResponse::Ok().json(json!({"ambassadors": list}))
}

#[derive(Deserialize)]
pub struct CreateAmbassador {
    pub code: String,
    pub name: String,
    #[serde(default)]
    pub location: String,
    /// The ambassador's player: their username OR their wallet address. A wallet is
    /// accepted because the username is optional at signup, so a brand-new player
    /// often has none yet and could not be found by name at all.
    pub username: String,
}

// POST /admin/ambassadors
pub async fn admin_create(req: HttpRequest, state: web::Data<AppState>, body: web::Json<CreateAmbassador>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let code = body.code.trim().to_lowercase();
    if !valid_code(&code) {
        return HttpResponse::BadRequest().json(json!({"error": "Code must be 3-24 chars: lowercase letters, digits, dashes"}));
    }
    let name = body.name.trim();
    if name.is_empty() || name.len() > 60 {
        return HttpResponse::BadRequest().json(json!({"error": "Name must be 1-60 characters"}));
    }
    let who = body.username.trim();
    let wallet: Option<String> = if is_valid_wallet(who) {
        sqlx::query_scalar("SELECT wallet_address FROM players WHERE wallet_address = $1")
            .bind(normalize_wallet(who)).fetch_optional(&state.db).await.ok().flatten()
    } else {
        sqlx::query_scalar("SELECT wallet_address FROM players WHERE LOWER(username) = LOWER($1) LIMIT 1")
            .bind(who).fetch_optional(&state.db).await.ok().flatten()
    };
    let Some(wallet) = wallet else {
        return HttpResponse::NotFound().json(json!({"error": "No player with that username or wallet. They must finish signing up (create their character) first."}));
    };
    match sqlx::query("INSERT INTO ambassadors (code, wallet_address, name, location) VALUES ($1, $2, $3, $4)")
        .bind(&code).bind(normalize_wallet(&wallet)).bind(name).bind(body.location.trim())
        .execute(&state.db).await
    {
        Ok(_) => HttpResponse::Ok().json(json!({"ok": true, "code": code})),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            HttpResponse::Conflict().json(json!({"error": "That code is taken, or this player is already an ambassador"}))
        }
        Err(e) => {
            tracing::error!("ambassador create failed: {}", e);
            HttpResponse::InternalServerError().json(json!({"error": "Database error"}))
        }
    }
}

#[derive(Deserialize)]
pub struct SetActive { pub active: bool }

// POST /admin/ambassadors/:code/active
pub async fn admin_set_active(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>, body: web::Json<SetActive>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let _ = sqlx::query("UPDATE ambassadors SET active = $2 WHERE code = $1")
        .bind(path.into_inner().to_lowercase()).bind(body.active).execute(&state.db).await;
    HttpResponse::Ok().json(json!({"ok": true}))
}
