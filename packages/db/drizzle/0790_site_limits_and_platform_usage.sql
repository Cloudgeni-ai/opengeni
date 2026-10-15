-- deployment-mode: rolling
-- Site limits by access mode and Site platform usage (docs/published-sites.md).
--
-- 1. Limit profiles move to the new model in 0791 (kept apart so this
--    migration takes no lock on site_publications).
-- 2. site_runtime_conversations.budget_key: the Site-wide usage windows a
--    conversation counts in. `*` (every existing row) is the Site's budgets
--    for viewers outside the workspace; workspace members' conversations
--    count in `*members`, so they never use up the Site's budgets.
-- 3. Platform usage, metered apart from model spend: one workspace-owned row
--    per workspace (this month's gateway requests, Site SQL rows and the
--    Site SQL plus Site Data storage level), and three deployment-global
--    tables for the Opengeni-wide monthly brake: per-month totals in eight
--    shards (spreads row contention), absolute per-workspace storage levels, and
--    the brake state per month. The global tables hold counters only, no
--    tenant content. They are FORCE RLS with a single lane policy: a
--    transaction sees them only after setting `opengeni.site_platform_lane`
--    (the hostname-lane pattern of 0782), so ordinary tenant transactions
--    never touch them by accident. Writers lock a workspace row before a
--    shard row.
-- 4. site_viewer_sessions.view_as: the owner's "View as visitor" preview role.
-- New tables and additive columns (no rewrite).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Acquire the workspace FK lock before any session table lock, matching writers.
-- Store absolute levels per workspace so writes do not contend on global shards;
-- deletion cascades so a removed workspace cannot leave stale global storage.
CREATE TABLE site_platform_storage (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_runtime_conversations ADD COLUMN budget_key text NOT NULL DEFAULT '*';
-- Old pods reserve viewer-day, Site-day and Site-month. New writers explicitly mark
-- the four-window protocol; defaults stay false for old pods during rollout.
ALTER TABLE site_runtime_conversations ADD COLUMN reservation_windows_complete boolean NOT NULL DEFAULT false;
-- Server-verified viewer identity for live invitation checks at tool execution.
ALTER TABLE site_runtime_conversations ADD COLUMN viewer_email text;
ALTER TABLE site_runtime_conversations
  ADD CONSTRAINT site_runtime_conversations_budget_key_check
  CHECK (budget_key IN ('*', '*members')) NOT VALID;

-- "View as visitor": the role a workspace member previews the Site as on
-- this viewer session. The API applies it only to see less.
ALTER TABLE site_viewer_sessions ADD COLUMN view_as text;
ALTER TABLE site_viewer_sessions
  ADD CONSTRAINT site_viewer_sessions_view_as_check
  CHECK (view_as IS NULL OR view_as IN ('invited', 'public')) NOT VALID;

-- This month's platform usage of one workspace. Counters restart when
-- period_start moves to a new month; storage_bytes is the latest level (Site
-- SQL plus Site Data of all the workspace's Sites) and storage_peak_bytes
-- its highest level this month. charged_micros and shadow_micros are what
-- credits mode charged and shadow mode would have charged this month.
CREATE TABLE site_platform_usage (
  workspace_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  sql_rows_read bigint NOT NULL DEFAULT 0 CHECK (sql_rows_read >= 0),
  sql_rows_written bigint NOT NULL DEFAULT 0 CHECK (sql_rows_written >= 0),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  storage_peak_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_peak_bytes >= 0),
  charged_micros bigint NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
  shadow_micros bigint NOT NULL DEFAULT 0 CHECK (shadow_micros >= 0),
  charge_seq integer NOT NULL DEFAULT 0 CHECK (charge_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_platform_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

-- Opengeni-wide totals per UTC month, in eight shards (a hash of the
-- workspace id picks one) so concurrent writers rarely meet on one row.
CREATE TABLE site_platform_totals (
  period_start date NOT NULL,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 7),
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  sql_rows_read bigint NOT NULL DEFAULT 0 CHECK (sql_rows_read >= 0),
  sql_rows_written bigint NOT NULL DEFAULT 0 CHECK (sql_rows_written >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period_start, shard)
);

-- The monthly brake. The API engages it automatically at the configured
-- limit (unless an operator lifted it this month) and records when the alert
-- threshold was crossed; operators engage or lift it with
-- scripts/operator/site-platform-brake.ts.
CREATE TABLE site_platform_brake (
  period_start date PRIMARY KEY,
  alerted_at timestamptz,
  engaged_at timestamptz,
  engaged_by text CHECK (engaged_by IS NULL OR engaged_by IN ('auto', 'operator')),
  engaged_reason text CHECK (engaged_reason IS NULL OR char_length(engaged_reason) <= 2000),
  lifted_at timestamptz,
  lifted_by text CHECK (lifted_by IS NULL OR char_length(lifted_by) BETWEEN 1 AND 300),
  lift_reason text CHECK (lift_reason IS NULL OR char_length(lift_reason) <= 2000),
  last_estimate_micros bigint NOT NULL DEFAULT 0 CHECK (last_estimate_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $rls$
DECLARE
  platform_table text;
BEGIN
  ALTER TABLE site_platform_usage ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_platform_usage FORCE ROW LEVEL SECURITY;
  CREATE POLICY workspace_isolation ON site_platform_usage
    USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
    WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
  REVOKE ALL ON TABLE site_platform_usage FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE site_platform_usage TO opengeni_app;
  END IF;
  FOREACH platform_table IN ARRAY ARRAY[
    'site_platform_totals', 'site_platform_storage', 'site_platform_brake'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', platform_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', platform_table);
    EXECUTE format(
      'CREATE POLICY site_platform_lane ON %I '
      'USING (pg_catalog.current_setting(''opengeni.site_platform_lane'', true) = ''on'') '
      'WITH CHECK (pg_catalog.current_setting(''opengeni.site_platform_lane'', true) = ''on'')',
      platform_table
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', platform_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO opengeni_app', platform_table);
    END IF;
  END LOOP;
END
$rls$;
