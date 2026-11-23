-- In-app notifications (the bell in the top bar).
--
-- One row per thing that happened to a player: a chat message, money received, a
-- purchase or transfer completed, a friend or duel event. `wallet_address` NULL is
-- a broadcast that every player sees (a campaign going live, a new shop drop).
--
-- Things that are STATES rather than events ("your daily G$ is ready to claim",
-- "the seasonal campaign is live") are not stored — the list endpoint derives them
-- at read time, so they can never go stale or be missed by a cron.
--
-- Read state is one watermark per wallet: everything newer than `seen_at` is
-- unread. Opening the bell moves it to now. Cheap, and works for broadcasts too.

CREATE TABLE IF NOT EXISTS notifications (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address TEXT,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  url            TEXT,
  -- Optional idempotency key, so a retried event never notifies twice.
  dedupe_key     TEXT UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_wallet_idx
  ON notifications (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_broadcast_idx
  ON notifications (created_at DESC) WHERE wallet_address IS NULL;

CREATE TABLE IF NOT EXISTS notification_reads (
  wallet_address TEXT PRIMARY KEY,
  seen_at        TIMESTAMPTZ NOT NULL
);

-- When an item was added to the shop, so a fresh drop can be announced. Existing
-- items are back-dated so the whole catalogue doesn't announce itself as new.
ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE items SET created_at = '2026-01-01T00:00:00Z' WHERE created_at IS NULL;
ALTER TABLE items ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE items ALTER COLUMN created_at SET NOT NULL;
