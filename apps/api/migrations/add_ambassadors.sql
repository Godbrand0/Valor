-- Ambassadors: a named, located alias for a referrer wallet. A code resolves to the
-- wallet, so the existing referral system (anti-fraud, counting, campaign payouts)
-- does all the work. The ambassador must already be a verified player (a player row
-- cannot exist without passing the GoodDollar whitelist at onboarding).
CREATE TABLE IF NOT EXISTS ambassadors (
    code           TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    location       TEXT NOT NULL DEFAULT '',
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
