-- Per-wallet withdrawal-fee discounts.
--
-- A wallet here pays `bps` instead of the standard withdrawal fee on the first
-- `remaining_wei` G$ it withdraws; anything beyond that pays the standard rate.
-- `remaining_wei` is drawn down by each transfer-out that uses it, so the
-- discount is an allowance that runs out, not a permanent rate.
--
-- Seeded ONCE (this file is recorded in _schema_migrations and not re-run) from
-- the paid prizes of seasons restricted to the LAUTECH group, i.e. the Break Out
-- Lautech winners and exactly what each of them was paid. It deliberately does
-- not follow later LAUTECH seasons: extending the discount is an explicit insert.
--
-- Needs player_groups, seasons.payout_group_id and season_payouts, all of which
-- are created earlier in the migration order.

CREATE TABLE IF NOT EXISTS withdraw_fee_discounts (
  wallet_address TEXT          PRIMARY KEY,
  bps            INTEGER       NOT NULL CHECK (bps BETWEEN 0 AND 10000),
  remaining_wei  NUMERIC(40,0) NOT NULL CHECK (remaining_wei >= 0),
  reason         TEXT          NOT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

INSERT INTO withdraw_fee_discounts (wallet_address, bps, remaining_wei, reason)
SELECT LOWER(sp.wallet_address),
       1000,                                            -- 10%
       SUM(sp.amount_g)::numeric * 1000000000000000000, -- G$ -> wei (18 decimals)
       'Break Out Lautech prize'
FROM season_payouts sp
JOIN seasons s        ON s.id = sp.season_id
JOIN player_groups g  ON g.id = s.payout_group_id
WHERE LOWER(g.slug) = 'lautech'
  AND sp.status = 'paid'
GROUP BY LOWER(sp.wallet_address)
ON CONFLICT (wallet_address) DO NOTHING;
