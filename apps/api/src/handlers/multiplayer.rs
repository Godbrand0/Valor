//! Multiplayer lobby — `GET /multiplayer/live`.
//!
//! One read-only, public snapshot of "what's happening right now" for the lobby
//! page: who is online, which Face-Offs are live (with the duel id spectators
//! watch them by), and which co-op parties are open to join.
//!
//! Nothing here is new state. It joins three registries that already exist:
//!   - presence: `chat_hub` (every signed-in client keeps `/ws/chat` open from
//!     the app layout, so a wallet in the hub is a wallet that is online);
//!   - live matches: `arena_server`'s room map (spectating was already "anyone
//!     with the link", so listing those links reveals nothing new);
//!   - parties: `coop_server`'s party map, where only a party its host marked
//!     PUBLIC ever exposes its join code. Private parties stay invite-only: their
//!     members show as "in a party", nothing more.
//!
//! Public on purpose (no auth): it is the same kind of read as a leaderboard and
//! is what lets the page show live links to anyone. It never returns anything a
//! profile page doesn't already show (name, rank, class).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use actix_web::{web, HttpResponse};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::services::{arena_server, chat_hub, coop_server, fraud_blocklist};
use crate::utils::normalize_wallet;
use crate::AppState;

/// Cap on the online list. The lobby shows "N online" from the full count, and
/// lists the most useful people first (joinable, then fighting, then idle).
const MAX_LISTED: usize = 100;

/// How long to wait on either game actor before answering without it. Both
/// answer inline from in-memory maps, so this only matters if one is wedged.
const ACTOR_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(sqlx::FromRow)]
struct PersonRow {
    wallet: String,
    username: Option<String>,
    character_name: String,
    character_class: Option<String>,
    rank: String,
}

async fn ask<T>(send: impl FnOnce(oneshot::Sender<T>) -> bool) -> Option<T> {
    let (tx, rx) = oneshot::channel();
    if !send(tx) {
        return None;
    }
    tokio::time::timeout(ACTOR_TIMEOUT, rx).await.ok()?.ok()
}

pub async fn live(state: web::Data<AppState>) -> HttpResponse {
    let online: Vec<String> = chat_hub::online_wallets(&state.chat_hub)
        .into_iter()
        .map(|w| normalize_wallet(&w))
        .filter(|w| !fraud_blocklist::is_blocked_str(w))
        .collect();

    let matches: Vec<arena_server::LiveMatch> = ask(|reply| {
        state.arena_server.tx.send(arena_server::ServerMsg::LiveSnapshot { reply }).is_ok()
    }).await.unwrap_or_default().into_iter().filter(|m| {
        !m.wallets.iter().any(|w| fraud_blocklist::is_blocked_str(&normalize_wallet(w)))
    }).collect();

    let parties: Vec<coop_server::LiveParty> = ask(|reply| {
        state.coop_server.tx.send(coop_server::ServerMsg::LiveSnapshot { reply }).is_ok()
    }).await.unwrap_or_default().into_iter().filter(|p| {
        !fraud_blocklist::is_blocked_str(&normalize_wallet(&p.host_wallet))
            && !p.members.iter().any(|w| fraud_blocklist::is_blocked_str(&normalize_wallet(w)))
    }).collect();

    // Everyone we need a name for, in one query.
    let mut wallets: HashSet<String> = online.iter().cloned().collect();
    for m in &matches {
        for w in &m.wallets { wallets.insert(normalize_wallet(w)); }
    }
    for p in &parties {
        for w in &p.members { wallets.insert(normalize_wallet(w)); }
    }
    let wallet_list: Vec<String> = wallets.into_iter().collect();

    let rows: Vec<PersonRow> = if wallet_list.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT wallet_address AS wallet, username, character_name, character_class, rank
             FROM players WHERE LOWER(wallet_address) = ANY($1)",
        )
        .bind(&wallet_list)
        .fetch_all(&state.db)
        .await
        .unwrap_or_else(|e| {
            tracing::error!("multiplayer/live: player lookup failed: {}", e);
            Vec::new()
        })
    };
    let people: HashMap<String, Value> = rows.into_iter().map(|p| {
        let w = normalize_wallet(&p.wallet);
        (w.clone(), json!({
            "wallet": w,
            "username": p.username,
            "name": p.character_name,
            "class": p.character_class,
            "rank": p.rank,
        }))
    }).collect();
    let person = |w: &str| -> Value {
        let w = normalize_wallet(w);
        people.get(&w).cloned().unwrap_or_else(|| json!({ "wallet": w, "username": null, "name": "Unknown", "class": null, "rank": null }))
    };

    // What each wallet is doing, for the status chips on the online list.
    let mut in_match: HashMap<String, String> = HashMap::new();
    for m in &matches {
        for w in &m.wallets { in_match.insert(normalize_wallet(w), m.duel_id.to_string()); }
    }
    let mut in_party: HashMap<String, &coop_server::LiveParty> = HashMap::new();
    for p in &parties {
        for w in &p.members { in_party.insert(normalize_wallet(w), p); }
    }

    // Who counts as online: anyone with the app open (the chat hub) PLUS anyone
    // in a live Face-Off or a co-op party. Full-screen game pages (co-op lives at
    // /endless/coop, outside the app layout) don't hold the chat socket, so a
    // player mid-run used to vanish from the list while their party showed them.
    let mut present: Vec<String> = online.clone();
    let mut seen: HashSet<String> = online.iter().cloned().collect();
    for w in in_match.keys().chain(in_party.keys()) {
        if seen.insert(w.clone()) { present.push(w.clone()); }
    }

    // Only registered players are listed (a hub entry with no player row is a
    // half-finished signup).
    let mut listed: Vec<(u8, Value)> = present.iter().filter(|w| people.contains_key(*w)).map(|w| {
        let mut v = person(w);
        let obj = v.as_object_mut().expect("person is an object");
        let rank_order: u8;
        if let Some(duel_id) = in_match.get(w) {
            obj.insert("status".into(), json!("in_match"));
            obj.insert("duel_id".into(), json!(duel_id));
            rank_order = 1;
        } else if let Some(p) = in_party.get(w) {
            let joinable = p.public && !p.started && p.members.len() < p.max_size;
            obj.insert("status".into(), json!(if p.started { "in_party_run" } else { "in_party_lobby" }));
            obj.insert("party_code".into(), json!(p.code));
            obj.insert("party_joinable".into(), json!(joinable));
            rank_order = if joinable { 0 } else { 2 };
        } else {
            obj.insert("status".into(), json!("online"));
            rank_order = 3;
        }
        (rank_order, v)
    }).collect();
    listed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| {
        let n = |v: &Value| v["username"].as_str().or(v["name"].as_str()).unwrap_or("").to_lowercase();
        n(&a.1).cmp(&n(&b.1))
    }));
    let online_count = listed.len();
    let players: Vec<Value> = listed.into_iter().take(MAX_LISTED).map(|(_, v)| v).collect();

    let live_matches: Vec<Value> = matches.iter().map(|m| json!({
        "duel_id": m.duel_id,
        "elapsed_secs": m.elapsed_secs,
        "paused": m.paused,
        "players": m.wallets.iter().map(|w| person(w)).collect::<Vec<_>>(),
    })).collect();

    let open_parties: Vec<Value> = parties.iter().filter(|p| p.public).map(|p| json!({
        "code": p.code,
        "host": person(&p.host_wallet),
        "members": p.members.iter().map(|w| person(w)).collect::<Vec<_>>(),
        "started": p.started,
        "size": p.members.len(),
        "max_size": p.max_size,
        "joinable": !p.started && p.members.len() < p.max_size,
    })).collect();

    HttpResponse::Ok().json(json!({
        "online_count": online_count,
        "players": players,
        "matches": live_matches,
        "parties": open_parties,
    }))
}
