-- deployment-mode: rolling
-- Occasional update messages about Slack agents.
--
-- One settings row per Slack installation (HOME tenancy, like slack_agents)
-- holds the organization admin's switch and the "channel posts only" choice.
-- Per person: what was sent and when, so the monthly limit, the one welcome
-- and the one dormant reminder hold across processes and retries. Every send
-- is recorded with a deterministic operation id before it goes out.
--
-- Only new tables and one new routine, so an older binary keeps working
-- unchanged.
--
-- The update sweeper finds the installations that send update messages with
-- list_due_slack_agent_update_installations_v1: SECURITY DEFINER, ids only,
-- never PUBLIC, created WITHOUT runtime EXECUTE. The previous release rejects
-- a runtime grant on a definer it doesn't know, so a follow-up rolling
-- migration grants it once this binary is the previous release (as 0946 and
-- 0950 did). Until then the sweeper finds nothing and sends nothing; the
-- admin's preview works regardless.
CREATE TABLE slack_agent_update_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  updates_enabled boolean NOT NULL DEFAULT false,
  channel_posts_only boolean NOT NULL DEFAULT false,
  updates_enabled_at timestamptz,
  updated_by_subject_id text,
  sweep_holder uuid,
  sweep_lease_until timestamptz,
  last_swept_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_update_settings_connection_uq UNIQUE (connection_id),
  CONSTRAINT slack_agent_update_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_update_settings_bounds_check CHECK (
    (updated_by_subject_id IS NULL OR octet_length(updated_by_subject_id) BETWEEN 1 AND 1024)
    AND version > 0
  )
);
CREATE INDEX slack_agent_update_settings_account_idx ON slack_agent_update_settings (account_id);

ALTER TABLE slack_agent_update_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_update_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_update_settings FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_update_settings
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_update_settings IS 'Per Slack installation: whether Opengeni sends update messages about Slack agents, set by an organization admin.';

-- The inventory runs as the table owner, and FORCE ROW LEVEL SECURITY applies
-- to the owner too, so it reads through this owner-only policy: enabled
-- installations, visible to the owner role alone (the runtime role never
-- matches it).
CREATE POLICY slack_agent_update_settings_sweep_inventory ON slack_agent_update_settings
  FOR SELECT
  USING (
    updates_enabled
    AND NOT channel_posts_only
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'slack_agent_update_settings'::regclass
    )
  );

DO $sweep_inventory$
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_due_slack_agent_update_installations_v1(p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, connection_id uuid, updates_enabled_at timestamptz)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT settings.account_id, settings.workspace_id, settings.connection_id, settings.updates_enabled_at
      FROM %1$I.slack_agent_update_settings settings
      WHERE settings.updates_enabled AND NOT settings.channel_posts_only
        AND (settings.sweep_lease_until IS NULL OR settings.sweep_lease_until <= pg_catalog.now())
      ORDER BY settings.last_swept_at ASC NULLS FIRST, settings.connection_id
      LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
    $body$
  $definition$, current_schema());
END
$sweep_inventory$;
REVOKE ALL ON FUNCTION opengeni_private.list_due_slack_agent_update_installations_v1(integer) FROM PUBLIC;

CREATE TABLE slack_agent_update_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  tz text,
  tz_offset integer,
  profile_state text,
  profile_checked_at timestamptz,
  last_sent_at timestamptz,
  last_kind text,
  welcome_sent_at timestamptz,
  dormant_sent_at timestamptz,
  announced_agent_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_update_recipients_user_uq UNIQUE (connection_id, slack_user_id),
  CONSTRAINT slack_agent_update_recipients_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_update_recipients_bounds_check CHECK (
    octet_length(slack_user_id) BETWEEN 1 AND 64
    AND (tz IS NULL OR octet_length(tz) BETWEEN 1 AND 128)
    AND (tz_offset IS NULL OR tz_offset BETWEEN -86400 AND 86400)
    AND (profile_state IS NULL OR profile_state IN ('eligible', 'guest', 'external', 'deactivated', 'bot'))
    AND (last_kind IS NULL OR last_kind IN ('welcome', 'update', 'dormant'))
    AND cardinality(announced_agent_ids) <= 1000
  )
);

ALTER TABLE slack_agent_update_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_update_recipients FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_update_recipients FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_update_recipients
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_update_recipients IS 'Per Slack person: cached Slack profile facts and which update messages they were sent.';

CREATE TABLE slack_agent_update_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  operation_id uuid NOT NULL,
  agent_ids uuid[] NOT NULL DEFAULT '{}',
  text text NOT NULL,
  blocks jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  slack_channel_id text,
  slack_message_ts text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT slack_agent_update_deliveries_dedupe_uq UNIQUE (connection_id, dedupe_key),
  CONSTRAINT slack_agent_update_deliveries_operation_uq UNIQUE (operation_id),
  CONSTRAINT slack_agent_update_deliveries_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_update_deliveries_bounds_check CHECK (
    octet_length(slack_user_id) BETWEEN 1 AND 64
    AND kind IN ('welcome', 'update', 'dormant')
    AND octet_length(dedupe_key) BETWEEN 1 AND 256
    AND cardinality(agent_ids) <= 1000
    AND char_length(text) <= 4000
    AND jsonb_typeof(blocks) = 'array'
    AND pg_column_size(blocks) <= 16384
    AND state IN ('pending', 'sent', 'failed')
    AND attempts >= 0
    AND (slack_channel_id IS NULL OR octet_length(slack_channel_id) BETWEEN 1 AND 64)
    AND (slack_message_ts IS NULL OR octet_length(slack_message_ts) BETWEEN 1 AND 64)
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 128)
  )
);
CREATE INDEX slack_agent_update_deliveries_pending_idx
  ON slack_agent_update_deliveries (connection_id, next_attempt_at)
  WHERE state = 'pending';

ALTER TABLE slack_agent_update_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_update_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_update_deliveries FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_update_deliveries
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_update_deliveries IS 'Each update message about Slack agents: what went to whom, under a deterministic Slack post operation id.';

DO $slack_agent_updates_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_update_settings TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_update_recipients TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_update_deliveries TO opengeni_app;
  END IF;
END
$slack_agent_updates_grants$;
