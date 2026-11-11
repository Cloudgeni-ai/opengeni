-- deployment-mode: rolling
-- Limits on the onboarding replies the Microsoft Teams bot sends, mostly to
-- people whose organization hasn't connected Opengeni (Connect your
-- organization cards, reminders and notices), counted across every API
-- replica. Any Microsoft
-- tenant can message a Store app, so these replies are bounded per person,
-- per tenant and across the deployment; counting them per replica let each
-- replica answer up to the whole limit.
--
-- Rows are content-free: a SHA-256 of what is counted (a budget and a person,
-- a tenant or the whole deployment), the start of its window (its first
-- reply), how many replies were sent in it and when the last one was. An
-- organization that hasn't connected Opengeni has no account or workspace
-- yet, so the policy can't be organization-scoped. A row grants no authority;
-- it only withholds a reply. Rows whose window began and last reply was days
-- ago are removed as replies are sent.
-- A new table only, so the previous release is unaffected.
SET LOCAL lock_timeout = '5s';

CREATE TABLE teams_bot_onboarding_limits (
  scope_hash text PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  -- '-infinity' until the first reply starts the window.
  window_start timestamptz NOT NULL DEFAULT '-infinity',
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  last_at timestamptz
);
CREATE INDEX teams_bot_onboarding_limits_window_idx ON teams_bot_onboarding_limits (window_start);
ALTER TABLE teams_bot_onboarding_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_onboarding_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE teams_bot_onboarding_limits FROM PUBLIC;
CREATE POLICY teams_onboarding_limits ON teams_bot_onboarding_limits USING (true) WITH CHECK (true);

COMMENT ON TABLE teams_bot_onboarding_limits IS 'Counts of Teams onboarding replies per window, keyed by a hash of the budget and what is counted.';

DO $teams_bot_onboarding_limits_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_onboarding_limits TO opengeni_app;
  END IF;
END
$teams_bot_onboarding_limits_grants$;
