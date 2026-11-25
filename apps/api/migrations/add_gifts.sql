-- Gifts: one player buys a Market item for another.
--
-- The item itself lands in the recipient's `inventory` like any purchase; this
-- table is the record of WHO gave it, with their note, so the recipient gets an
-- "unwrap" moment (unseen gifts, `seen_at` NULL) and both sides have a history.
-- The G$ side is in g_ledger as `marketplace_gift` on the sender.

CREATE TABLE IF NOT EXISTS gifts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id      UUID NOT NULL REFERENCES items(id),
  from_wallet  TEXT NOT NULL,
  to_wallet    TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at      TIMESTAMPTZ,
  CHECK (from_wallet <> to_wallet)
);

CREATE INDEX IF NOT EXISTS gifts_to_idx   ON gifts (to_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS gifts_from_idx ON gifts (from_wallet, created_at DESC);
