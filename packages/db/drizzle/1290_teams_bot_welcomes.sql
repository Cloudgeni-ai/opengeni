-- deployment-mode: rolling
-- Microsoft Teams welcomes on a personal install, claimed once across API
-- replicas. Teams can deliver the same install more than once, as both a
-- conversationUpdate and an installationUpdate and again after a failed or
-- slow response, and to any replica. A replica sends the welcome (or the
-- Connect your organization card) only after claiming the chat here.
--
-- Rows are content-free: a SHA-256 of the tenant and conversation, a random
-- claim token and the claim time. An organization that hasn't connected
-- Opengeni has no account or workspace yet, so the policy can't be
-- organization-scoped. A row grants no authority; it only suppresses a
-- repeated welcome. A new table only, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';

CREATE TABLE teams_bot_welcomes (
  scope_hash text PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  claim_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE teams_bot_welcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_welcomes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE teams_bot_welcomes FROM PUBLIC;
CREATE POLICY teams_welcome_claims ON teams_bot_welcomes USING (true) WITH CHECK (true);

COMMENT ON TABLE teams_bot_welcomes IS 'Teams personal chats recently welcomed on install, keyed by a hash of tenant and conversation.';

DO $teams_bot_welcomes_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_welcomes TO opengeni_app;
  END IF;
END
$teams_bot_welcomes_grants$;
