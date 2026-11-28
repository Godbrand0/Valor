-- On-chain event sync (services/event_listener.rs).
--
-- The game reads items from `inventory`, but some item moves happen only on
-- chain — above all player-to-player RESALE, which buyers send from their own
-- wallets and the API never sees. The listener follows the marketplace's events
-- and mirrors them into `inventory` (and the G$ ledger).
--
-- chain_cursors: the last block fully processed, so a restart resumes where it
-- stopped instead of skipping whatever happened while it was down.
--
-- chain_events_processed: every event handled, by (tx_hash, log_index), so
-- re-scanning a block never applies the same sale twice. A row is claimed
-- before its effects are written and removed again if they fail.

CREATE TABLE IF NOT EXISTS chain_cursors (
  name        TEXT PRIMARY KEY,
  last_block  BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_events_processed (
  tx_hash       TEXT   NOT NULL,
  log_index     BIGINT NOT NULL,
  event         TEXT   NOT NULL,
  block_number  BIGINT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
