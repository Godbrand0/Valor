//! Player groups: communities (a university, a gaming crowd) with their own join link
//! and their own slice of the season board.
//!
//! Membership is permanent identity (see add_player_groups.sql). A group board is the
//! ordinary season board filtered to a group's members, so there is no second scoring
//! system to drift from the real one: the score is `endless_progress.wave - 1`, ranked
//! by waves completed with ties broken by who reached the wave first, exactly as in
//! `seasons::season_board`.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::handlers::admin::verify_admin_token;
use crate::utils::{is_valid_wallet, normalize_wallet};
use crate::AppState;

#[derive(FromRow)]
struct GroupRow {
    id: Uuid,
    slug: String,
    name: String,
    description: String,
}

fn valid_slug(s: &str) -> bool {
    (2..=40).contains(&s.len())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

async fn find_group(db: &sqlx::PgPool, slug: &str) -> Option<GroupRow> {
    sqlx::query_as::<_, GroupRow>(
        "SELECT id, slug, name, description FROM player_groups
         WHERE LOWER(slug) = LOWER($1) AND active",
    )
    .bind(slug)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

async fn member_count(db: &sqlx::PgPool, group_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM group_members WHERE group_id = $1")
        .bind(group_id)
        .fetch_one(db)
        .await
        .unwrap_or(0)
}

// ── GET /groups ───────────────────────────────────────────────────────────────
// Public: every active community, for the picker on Profile and the groups page.
//
// Each group carries its SCORE for the current season: the waves its members have
// completed, added up. That is the same number the season board ranks players by,
// so a group's score is just its members' board scores summed, never a second
// scoring system. Sorted by score, so the list doubles as a ranking of groups.
pub async fn list_public(state: web::Data<AppState>) -> HttpResponse {
    let season = pick_season(&state.db, None).await;
    let season_id = season.as_ref().map(|(id, _)| *id);
    let rows: Vec<(String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT g.slug, g.name, g.description,
                COUNT(m.wallet_address),
                COUNT(e.wallet_address) FILTER (WHERE e.wave > 1),
                COALESCE(SUM(GREATEST(e.wave - 1, 0)), 0)::BIGINT
         FROM player_groups g
         LEFT JOIN group_members m ON m.group_id = g.id
         LEFT JOIN endless_progress e ON e.wallet_address = m.wallet_address AND e.season_id = $1
         WHERE g.active
         GROUP BY g.id
         ORDER BY 6 DESC, 4 DESC, g.created_at",
    )
    .bind(season_id)
    .fetch_all(&state.db).await.unwrap_or_default();
    let groups: Vec<_> = rows.iter().map(|(slug, name, description, n, playing, score)| json!({
        "slug": slug, "name": name, "description": description, "members": n,
        "playing": playing, "score": score,
    })).collect();
    HttpResponse::Ok().json(json!({
        "groups": groups,
        "season": season.map(|(id, name)| json!({"id": id, "name": name})),
    }))
}

// ── GET /groups/:slug ──────────────────────────────────────────────────────────
// Public: what the join page shows before anyone signs in.
pub async fn get_group(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let Some(g) = find_group(&state.db, &path.into_inner()).await else {
        return HttpResponse::NotFound().json(json!({"error": "Group not found"}));
    };
    let members = member_count(&state.db, g.id).await;
    HttpResponse::Ok().json(json!({
        "slug": g.slug, "name": g.name, "description": g.description, "members": members,
    }))
}

// ── GET /players/:wallet/group ─────────────────────────────────────────────────
pub async fn get_my_group(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    let row: Option<GroupRow> = sqlx::query_as(
        "SELECT g.id, g.slug, g.name, g.description
         FROM group_members m JOIN player_groups g ON g.id = m.group_id
         WHERE m.wallet_address = $1",
    )
    .bind(&wallet)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    match row {
        Some(g) => HttpResponse::Ok().json(json!({"group": {"slug": g.slug, "name": g.name}})),
        None => HttpResponse::Ok().json(json!({"group": null})),
    }
}

#[derive(Deserialize)]
pub struct JoinRequest {
    pub slug: String,
}

// ── POST /players/:wallet/group ────────────────────────────────────────────────
// Player-authed. Joining the group you are already in succeeds (so a re-click or a
// retry is harmless). Switching groups requires leaving first: a prize board is only
// honest if a player cannot hop to whichever group is winning.
pub async fn join(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    body: web::Json<JoinRequest>,
) -> HttpResponse {
    let raw = path.into_inner();
    if !is_valid_wallet(&raw) {
        return HttpResponse::BadRequest().json(json!({"error": "Invalid wallet address"}));
    }
    let wallet = normalize_wallet(&raw);
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }

    let Some(g) = find_group(&state.db, &body.slug).await else {
        return HttpResponse::NotFound().json(json!({"error": "Group not found"}));
    };

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT group_id FROM group_members WHERE wallet_address = $1",
    )
    .bind(&wallet)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    match existing {
        Some(id) if id == g.id => {
            return HttpResponse::Ok().json(json!({"ok": true, "group": {"slug": g.slug, "name": g.name}}));
        }
        Some(_) => {
            return HttpResponse::Conflict()
                .json(json!({"error": "You are already in a group. Leave it first to join another."}));
        }
        None => {}
    }

    match sqlx::query(
        "INSERT INTO group_members (wallet_address, group_id) VALUES ($1, $2)
         ON CONFLICT (wallet_address) DO NOTHING",
    )
    .bind(&wallet)
    .bind(g.id)
    .execute(&state.db)
    .await
    {
        Ok(_) => HttpResponse::Ok().json(json!({"ok": true, "group": {"slug": g.slug, "name": g.name}})),
        Err(e) => {
            tracing::error!("group join failed: {}", e);
            HttpResponse::InternalServerError().json(json!({"error": "Database error"}))
        }
    }
}

// ── DELETE /players/:wallet/group ──────────────────────────────────────────────
pub async fn leave(req: HttpRequest, state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let wallet = normalize_wallet(&path.into_inner());
    if let Err(resp) = crate::auth::verify_player_token(&req, &wallet) { return resp; }
    match sqlx::query("DELETE FROM group_members WHERE wallet_address = $1")
        .bind(&wallet)
        .execute(&state.db)
        .await
    {
        Ok(_) => HttpResponse::Ok().json(json!({"ok": true})),
        Err(e) => {
            tracing::error!("group leave failed: {}", e);
            HttpResponse::InternalServerError().json(json!({"error": "Database error"}))
        }
    }
}

#[derive(Deserialize)]
pub struct BoardQuery {
    pub season_id: Option<Uuid>,
    pub limit: Option<i64>,
}

#[derive(FromRow)]
struct BoardRow {
    wallet_address: String,
    username: Option<String>,
    waves: i32,
    joined_at: chrono::DateTime<chrono::Utc>,
}

/// The season a group's numbers are counted in: the one asked for, else the same
/// season the public Season board shows (live now, else the latest).
async fn pick_season(db: &sqlx::PgPool, season_id: Option<Uuid>) -> Option<(Uuid, String)> {
    match season_id {
        Some(id) => sqlx::query_as("SELECT id, name FROM seasons WHERE id = $1")
            .bind(id).fetch_optional(db).await.ok().flatten(),
        None => sqlx::query_as(
            "SELECT id, name FROM seasons
             ORDER BY (starts_at <= now() AND (ends_at IS NULL OR ends_at >= now())) DESC,
                      starts_at DESC
             LIMIT 1",
        ).fetch_optional(db).await.ok().flatten(),
    }
}

async fn group_board(db: &sqlx::PgPool, g: &GroupRow, q: &BoardQuery) -> serde_json::Value {
    let season = pick_season(db, q.season_id).await;
    let Some((season_id, season_name)) = season else {
        return json!({"group": {"slug": g.slug, "name": g.name}, "season": null, "entries": []});
    };

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows: Vec<BoardRow> = sqlx::query_as(
        "SELECT e.wallet_address, p.username, (e.wave - 1) AS waves, m.joined_at
         FROM endless_progress e
         JOIN group_members m ON m.wallet_address = e.wallet_address AND m.group_id = $2
         LEFT JOIN players p ON p.wallet_address = e.wallet_address
         WHERE e.season_id = $1 AND e.wave > 1
         ORDER BY e.wave DESC, e.reached_at ASC
         LIMIT $3",
    )
    .bind(season_id).bind(g.id).bind(limit)
    .fetch_all(db).await.unwrap_or_default();

    let entries: Vec<_> = rows.iter().enumerate().map(|(i, r)| json!({
        "rank": i + 1,
        "wallet_address": r.wallet_address,
        "username": r.username,
        "waves": r.waves,
        "joined_at": r.joined_at.to_rfc3339(),
    })).collect();

    json!({
        "group": {"slug": g.slug, "name": g.name},
        "season": {"id": season_id, "name": season_name},
        "entries": entries,
    })
}

// ── GET /groups/:slug/board ────────────────────────────────────────────────────
pub async fn board(state: web::Data<AppState>, path: web::Path<String>, q: web::Query<BoardQuery>) -> HttpResponse {
    let Some(g) = find_group(&state.db, &path.into_inner()).await else {
        return HttpResponse::NotFound().json(json!({"error": "Group not found"}));
    };
    HttpResponse::Ok().json(group_board(&state.db, &g, &q).await)
}

#[derive(Deserialize)]
pub struct MembersQuery {
    pub season_id: Option<Uuid>,
}

#[derive(FromRow)]
struct MemberRow {
    wallet_address: String,
    username: Option<String>,
    character_name: Option<String>,
    character_class: Option<String>,
    rank: Option<String>,
    prestige_level: Option<i32>,
    xp: Option<i32>,
    waves: i32,
    joined_at: chrono::DateTime<chrono::Utc>,
}

/// Most members a group page lists. Far above any group today; it only stops one
/// huge community from turning the page into a multi-megabyte response.
const MEMBERS_LIMIT: i64 = 1000;

// ── GET /groups/:slug/members ──────────────────────────────────────────────────
// Public: the group page. Everyone in the group, with each member's season score and
// the group's total. Members who joined from a link but have not made a character
// yet are listed too (no name, no rank), because they ARE in the group and leaving
// them out would make the member count and the list disagree.
pub async fn members(state: web::Data<AppState>, path: web::Path<String>, q: web::Query<MembersQuery>) -> HttpResponse {
    let Some(g) = find_group(&state.db, &path.into_inner()).await else {
        return HttpResponse::NotFound().json(json!({"error": "Group not found"}));
    };
    let season = pick_season(&state.db, q.season_id).await;
    let season_id = season.as_ref().map(|(id, _)| *id);

    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.wallet_address, p.username, p.character_name, p.character_class,
                p.rank, p.prestige_level, p.xp,
                COALESCE(GREATEST(e.wave - 1, 0), 0) AS waves, m.joined_at
         FROM group_members m
         LEFT JOIN players p ON p.wallet_address = m.wallet_address
         LEFT JOIN endless_progress e ON e.wallet_address = m.wallet_address AND e.season_id = $2
         WHERE m.group_id = $1
         ORDER BY waves DESC, e.reached_at ASC NULLS LAST, p.xp DESC NULLS LAST, m.joined_at ASC
         LIMIT $3",
    )
    .bind(g.id).bind(season_id).bind(MEMBERS_LIMIT)
    .fetch_all(&state.db).await.unwrap_or_default();

    let total = member_count(&state.db, g.id).await;
    // Summed in SQL over EVERY member, so the score is right even past the list limit.
    let (score, playing): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(GREATEST(e.wave - 1, 0)), 0)::BIGINT,
                COUNT(*) FILTER (WHERE e.wave > 1)
         FROM group_members m
         JOIN endless_progress e ON e.wallet_address = m.wallet_address AND e.season_id = $2
         WHERE m.group_id = $1",
    )
    .bind(g.id).bind(season_id)
    .fetch_one(&state.db).await.unwrap_or((0, 0));

    let list: Vec<_> = rows.iter().map(|r| json!({
        "wallet_address": r.wallet_address,
        "username": r.username,
        "character_name": r.character_name,
        "character_class": r.character_class,
        "rank": r.rank,
        "prestige_level": r.prestige_level,
        "xp": r.xp,
        "waves": r.waves,
        "joined_at": r.joined_at.to_rfc3339(),
    })).collect();

    HttpResponse::Ok().json(json!({
        "group": {"slug": g.slug, "name": g.name, "description": g.description},
        "season": season.map(|(id, name)| json!({"id": id, "name": name})),
        "totals": {"members": total, "playing": playing, "score": score},
        "members": list,
    }))
}

// ── Admin ──────────────────────────────────────────────────────────────────────

// GET /admin/groups
pub async fn admin_list(req: HttpRequest, state: web::Data<AppState>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let rows: Vec<(Uuid, String, String, bool, i64)> = sqlx::query_as(
        "SELECT g.id, g.slug, g.name, g.active, COUNT(m.wallet_address)
         FROM player_groups g LEFT JOIN group_members m ON m.group_id = g.id
         GROUP BY g.id ORDER BY g.created_at",
    )
    .fetch_all(&state.db).await.unwrap_or_default();
    let groups: Vec<_> = rows.iter().map(|(id, slug, name, active, n)| json!({
        "id": id, "slug": slug, "name": name, "active": active, "members": n,
    })).collect();
    HttpResponse::Ok().json(json!({"groups": groups}))
}

#[derive(Deserialize)]
pub struct CreateGroup {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

// POST /admin/groups: a new community = a row, no redeploy.
pub async fn admin_create(req: HttpRequest, state: web::Data<AppState>, body: web::Json<CreateGroup>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let slug = body.slug.trim().to_lowercase();
    let name = body.name.trim();
    if !valid_slug(&slug) {
        return HttpResponse::BadRequest()
            .json(json!({"error": "Slug must be 2-40 chars: lowercase letters, digits, dashes"}));
    }
    if name.is_empty() || name.len() > 60 {
        return HttpResponse::BadRequest().json(json!({"error": "Name must be 1-60 characters"}));
    }
    match sqlx::query("INSERT INTO player_groups (slug, name, description) VALUES ($1, $2, $3)")
        .bind(&slug).bind(name).bind(body.description.trim())
        .execute(&state.db).await
    {
        Ok(_) => HttpResponse::Ok().json(json!({"ok": true, "slug": slug})),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            HttpResponse::Conflict().json(json!({"error": "That slug is taken"}))
        }
        Err(e) => {
            tracing::error!("group create failed: {}", e);
            HttpResponse::InternalServerError().json(json!({"error": "Database error"}))
        }
    }
}

// ── GET /admin/groups/seasons ──────────────────────────────────────────────────
// Seasons with the group (if any) their prize is restricted to, for the admin screen.
pub async fn admin_seasons(req: HttpRequest, state: web::Data<AppState>) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let rows: Vec<(Uuid, String, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>, i64, String, Option<String>)> =
        sqlx::query_as(
            "SELECT s.id, s.name, s.starts_at, s.ends_at, s.prize_pool_g, s.payout_status, g.name
             FROM seasons s LEFT JOIN player_groups g ON g.id = s.payout_group_id
             ORDER BY s.starts_at DESC",
        )
        .fetch_all(&state.db).await.unwrap_or_default();
    let seasons: Vec<_> = rows.iter().map(|(id, name, st, en, pool, status, grp)| json!({
        "id": id, "name": name,
        "starts_at": st.to_rfc3339(), "ends_at": en.map(|e| e.to_rfc3339()),
        "prize_pool_g": pool, "payout_status": status, "payout_group": grp,
    })).collect();
    HttpResponse::Ok().json(json!({"seasons": seasons}))
}

#[derive(Deserialize)]
pub struct PayoutGroupRequest {
    /// Group slug to restrict the prize to, or null/omitted to pay the overall board.
    pub slug: Option<String>,
}

// ── POST /admin/seasons/:id/payout-group ───────────────────────────────────────
// Restrict a season's prize to one group's members (or clear it). Refused once the
// winners are committed, because changing who is eligible after payout rows exist
// would silently disagree with what was already paid.
pub async fn set_payout_group(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
    body: web::Json<PayoutGroupRequest>,
) -> HttpResponse {
    if let Err(resp) = verify_admin_token(&req) { return resp; }
    let season_id = path.into_inner();

    let committed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM season_payouts WHERE season_id = $1")
        .bind(season_id).fetch_one(&state.db).await.unwrap_or(0);
    if committed > 0 {
        return HttpResponse::Conflict()
            .json(json!({"error": "Winners are already committed for this season; it can no longer be changed."}));
    }

    let group_id: Option<Uuid> = match body.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(slug) => match find_group(&state.db, slug).await {
            Some(g) => Some(g.id),
            None => return HttpResponse::NotFound().json(json!({"error": "Group not found"})),
        },
        None => None,
    };

    match sqlx::query("UPDATE seasons SET payout_group_id = $1 WHERE id = $2")
        .bind(group_id).bind(season_id)
        .execute(&state.db).await
    {
        Ok(r) if r.rows_affected() == 1 => HttpResponse::Ok().json(json!({"ok": true})),
        Ok(_) => HttpResponse::NotFound().json(json!({"error": "Season not found"})),
        Err(e) => {
            tracing::error!("set payout group failed: {}", e);
            HttpResponse::InternalServerError().json(json!({"error": "Database error"}))
        }
    }
}
