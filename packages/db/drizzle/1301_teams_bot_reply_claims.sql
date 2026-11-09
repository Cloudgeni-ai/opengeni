-- deployment-mode: rolling
-- Microsoft Teams messages answered by the bot itself (help, link, unlink and
-- the onboarding, reminder and notice replies), claimed once across API
-- replicas. Teams redelivers an activity after a slow or failed (5xx)
-- response, to any replica. These replies don't go through the inbox, so a
-- replica sends one only after claiming the activity here, and a redelivered
-- activity isn't answered twice.
--
-- Rows are content-free: a SHA-256 of the tenant, conversation and activity
-- id, a random claim token and the claim time. An organization that hasn't
-- connected Opengeni has no account or workspace yet, so the policy can't be
-- organization-scoped. A row grants no authority; it only suppresses a
-- repeated reply. Claims older than a day are removed as new replies are
-- sent. A new table only, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';

CREATE TABLE teams_bot_reply_claims (
  scope_hash text PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  claim_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_bot_reply_claims_claimed_at_idx ON teams_bot_reply_claims (claimed_at);
ALTER TABLE teams_bot_reply_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_reply_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE teams_bot_reply_claims FROM PUBLIC;
CREATE POLICY teams_reply_claims ON teams_bot_reply_claims USING (true) WITH CHECK (true);

COMMENT ON TABLE teams_bot_reply_claims IS 'Teams activities the bot answered itself, keyed by a hash of tenant, conversation and activity id.';

DO $teams_bot_reply_claims_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_reply_claims TO opengeni_app;
  END IF;
END
$teams_bot_reply_claims_grants$;
