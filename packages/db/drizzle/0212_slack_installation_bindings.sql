-- deployment-mode: rolling
-- Add a durable Slack-team routing authority. Existing verified rows are
-- classified without deleting credentials: one exact tenant/principal becomes
-- active, while conflicting legacy rows are quarantined and fail closed.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "slack_installation_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_team_name" text NOT NULL,
  "bot_id" text NOT NULL,
  "bot_user_id" text NOT NULL,
  "bot_display_name" text NOT NULL,
  "state" text NOT NULL,
  "quarantine_reason" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_by_subject_id" text,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_installation_bindings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_installation_bindings_connection_uq" UNIQUE ("connection_id"),
  CONSTRAINT "slack_installation_bindings_state_check"
    CHECK ("state" IN ('active', 'quarantined')),
  CONSTRAINT "slack_installation_bindings_quarantine_check"
    CHECK (
      ("state" = 'active' AND "quarantine_reason" IS NULL)
      OR ("state" = 'quarantined' AND length(btrim("quarantine_reason")) > 0)
    ),
  CONSTRAINT "slack_installation_bindings_identity_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_team_name") BETWEEN 1 AND 256
      AND octet_length("bot_id") BETWEEN 1 AND 64
      AND octet_length("bot_user_id") BETWEEN 1 AND 64
      AND "bot_display_name" = 'OpenGeni'
    ),
  CONSTRAINT "slack_installation_bindings_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "slack_installation_bindings_active_team_uq"
  ON "slack_installation_bindings" ("slack_team_id")
  WHERE "state" = 'active';
CREATE INDEX "slack_installation_bindings_workspace_state_idx"
  ON "slack_installation_bindings" ("workspace_id", "state", "updated_at");

ALTER TABLE "slack_installation_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_installation_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "slack_installation_bindings"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

WITH base AS (
  SELECT
    C.id AS connection_id,
    C.account_id,
    C.workspace_id,
    C.metadata->>'slackTeamId' AS slack_team_id,
    C.metadata->>'slackTeamName' AS slack_team_name,
    C.metadata->>'botId' AS bot_id,
    C.metadata->>'botUserId' AS bot_user_id,
    C.metadata->>'botDisplayName' AS bot_display_name,
    C.created_by_subject_id,
    C.updated_by_subject_id,
    C.created_at,
    C.updated_at
  FROM "connections" C
  WHERE C.subject_id IS NULL
    AND C.provider_domain = 'slack.com'
    AND C.kind = 'app_install'
    AND C.verified_install_at IS NOT NULL
    AND C.verified_install_version = C.version
    AND C.metadata->>'credentialRole' = 'opengeni_slack_bot'
    AND octet_length(C.metadata->>'slackTeamId') BETWEEN 1 AND 64
    AND octet_length(C.metadata->>'slackTeamName') BETWEEN 1 AND 256
    AND octet_length(C.metadata->>'botId') BETWEEN 1 AND 64
    AND octet_length(C.metadata->>'botUserId') BETWEEN 1 AND 64
    AND C.metadata->>'botDisplayName' = 'OpenGeni'
), classified AS (
  SELECT
    slack_team_id,
    count(DISTINCT (account_id, workspace_id, bot_id, bot_user_id)) AS principal_count
  FROM base
  GROUP BY slack_team_id
), eligible AS (
  SELECT
    B.*,
    C.principal_count,
    row_number() OVER (
      PARTITION BY B.slack_team_id
      ORDER BY B.created_at DESC, B.connection_id DESC
    ) AS canonical_rank
  FROM base B
  JOIN classified C USING (slack_team_id)
)
INSERT INTO "slack_installation_bindings" (
  account_id, workspace_id, connection_id, slack_team_id, slack_team_name,
  bot_id, bot_user_id, bot_display_name, state, quarantine_reason,
  created_by_subject_id, updated_by_subject_id, created_at, updated_at
)
SELECT
  account_id,
  workspace_id,
  connection_id,
  slack_team_id,
  slack_team_name,
  bot_id,
  bot_user_id,
  bot_display_name,
  CASE WHEN principal_count = 1 THEN 'active' ELSE 'quarantined' END,
  CASE WHEN principal_count = 1 THEN NULL ELSE 'legacy_conflicting_installations' END,
  created_by_subject_id,
  updated_by_subject_id,
  created_at,
  updated_at
FROM eligible
WHERE principal_count > 1 OR canonical_rank = 1;

DO $binding_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.inspect_slack_installation_binding(
      p_team_id text,
      p_bot_id text,
      p_bot_user_id text
    )
    RETURNS TABLE (outcome text, connection_id uuid, connection_version integer)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      context_account_id uuid := NULLIF(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id uuid := NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid;
      active_binding record;
    BEGIN
      IF context_account_id IS NULL OR context_workspace_id IS NULL THEN
        RAISE EXCEPTION 'Slack installation binding inspection requires tenant context';
      END IF;
      IF octet_length(p_team_id) NOT BETWEEN 1 AND 64
        OR octet_length(p_bot_id) NOT BETWEEN 1 AND 64
        OR octet_length(p_bot_user_id) NOT BETWEEN 1 AND 64
      THEN
        RAISE EXCEPTION 'invalid Slack installation principal';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended('opengeni:slack-install:' || p_team_id, 0));

      IF EXISTS (
        SELECT 1 FROM %1$I.slack_installation_bindings B
        WHERE B.slack_team_id = p_team_id AND B.state = 'quarantined'
      ) THEN
        RETURN QUERY SELECT 'legacy_quarantine'::text, NULL::uuid, NULL::integer;
        RETURN;
      END IF;

      SELECT B.*, C.version AS current_connection_version
      INTO active_binding
      FROM %1$I.slack_installation_bindings B
      JOIN %1$I.connections C ON C.id = B.connection_id
      WHERE B.slack_team_id = p_team_id AND B.state = 'active';

      IF active_binding IS NULL THEN
        RETURN QUERY SELECT 'available'::text, NULL::uuid, NULL::integer;
      ELSIF active_binding.account_id IS DISTINCT FROM context_account_id
        OR active_binding.workspace_id IS DISTINCT FROM context_workspace_id
      THEN
        RETURN QUERY SELECT 'conflicting_workspace'::text, NULL::uuid, NULL::integer;
      ELSIF active_binding.bot_id IS DISTINCT FROM p_bot_id
        OR active_binding.bot_user_id IS DISTINCT FROM p_bot_user_id
      THEN
        RETURN QUERY SELECT 'conflicting_principal'::text, NULL::uuid, NULL::integer;
      ELSE
        RETURN QUERY SELECT
          'same_binding'::text,
          active_binding.connection_id,
          active_binding.current_connection_version;
      END IF;
    END
    $function$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.sync_slack_installation_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      existing_binding record;
      team_id text := NEW.metadata->>'slackTeamId';
      team_name text := NEW.metadata->>'slackTeamName';
      bot_id_value text := NEW.metadata->>'botId';
      bot_user_id_value text := NEW.metadata->>'botUserId';
      is_verified_bot boolean :=
        NEW.subject_id IS NULL
        AND NEW.provider_domain = 'slack.com'
        AND NEW.kind = 'app_install'
        AND NEW.verified_install_at IS NOT NULL
        AND NEW.verified_install_version = NEW.version
        AND NEW.metadata->>'credentialRole' = 'opengeni_slack_bot';
    BEGIN
      SELECT * INTO existing_binding
      FROM %1$I.slack_installation_bindings B
      WHERE B.connection_id = NEW.id;

      -- Composite `IS NOT NULL` is false when any nullable field is null. Use
      -- the SELECT result flag so active bindings with a null quarantine reason
      -- still take the existing-binding path on reinstall and safe updates.
      IF FOUND THEN
        IF team_id IS DISTINCT FROM existing_binding.slack_team_id
          OR bot_id_value IS DISTINCT FROM existing_binding.bot_id
          OR bot_user_id_value IS DISTINCT FROM existing_binding.bot_user_id
          OR NEW.account_id IS DISTINCT FROM existing_binding.account_id
          OR NEW.workspace_id IS DISTINCT FROM existing_binding.workspace_id
        THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: bound Slack identity and tenant are immutable';
        END IF;
        IF is_verified_bot AND NEW.status = 'active' THEN
          UPDATE %1$I.slack_installation_bindings B
          SET slack_team_name = team_name,
              bot_display_name = NEW.metadata->>'botDisplayName',
              version = B.version + 1,
              updated_by_subject_id = NEW.updated_by_subject_id,
              updated_at = now()
          WHERE B.id = existing_binding.id;
        END IF;
        RETURN NEW;
      END IF;

      IF NOT is_verified_bot OR NEW.status <> 'active' THEN
        RETURN NEW;
      END IF;
      IF octet_length(team_id) NOT BETWEEN 1 AND 64
        OR octet_length(team_name) NOT BETWEEN 1 AND 256
        OR octet_length(bot_id_value) NOT BETWEEN 1 AND 64
        OR octet_length(bot_user_id_value) NOT BETWEEN 1 AND 64
        OR NEW.metadata->>'botDisplayName' IS DISTINCT FROM 'OpenGeni'
      THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: invalid verified Slack identity';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended('opengeni:slack-install:' || team_id, 0));
      IF EXISTS (
        SELECT 1 FROM %1$I.slack_installation_bindings B
        WHERE B.slack_team_id = team_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'OPENGENI_SLACK_BINDING_CONFLICT: Slack team already bound or quarantined';
      END IF;

      INSERT INTO %1$I.slack_installation_bindings (
        account_id, workspace_id, connection_id, slack_team_id, slack_team_name,
        bot_id, bot_user_id, bot_display_name, state,
        created_by_subject_id, updated_by_subject_id
      ) VALUES (
        NEW.account_id, NEW.workspace_id, NEW.id, team_id, team_name,
        bot_id_value, bot_user_id_value, 'OpenGeni', 'active',
        NEW.created_by_subject_id, NEW.updated_by_subject_id
      );
      RETURN NEW;
    END
    $function$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.resolve_slack_installation(p_team_id text)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      connection_id uuid,
      bot_id text,
      bot_user_id text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT B.account_id, B.workspace_id, B.connection_id, B.bot_id, B.bot_user_id
      FROM %1$I.slack_installation_bindings B
      JOIN %1$I.connections C ON C.id = B.connection_id
      WHERE B.slack_team_id = p_team_id
        AND B.state = 'active'
        AND C.account_id = B.account_id
        AND C.workspace_id = B.workspace_id
        AND C.status = 'active'
        AND C.subject_id IS NULL
        AND C.provider_domain = 'slack.com'
        AND C.kind = 'app_install'
        AND C.verified_install_at IS NOT NULL
        AND C.verified_install_version = C.version
        AND C.metadata->>'credentialRole' = 'opengeni_slack_bot'
        AND C.metadata->>'slackTeamId' = B.slack_team_id
        AND C.metadata->>'botId' = B.bot_id
        AND C.metadata->>'botUserId' = B.bot_user_id
      LIMIT 1
    $function$
  $ddl$, data_schema);
END
$binding_functions$;

REVOKE ALL ON FUNCTION opengeni_private.inspect_slack_installation_binding(text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.sync_slack_installation_binding()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_installation(text)
  FROM PUBLIC;

CREATE TRIGGER connections_sync_slack_installation_binding
  AFTER INSERT OR UPDATE OF
    account_id, workspace_id, subject_id, provider_domain, kind, status,
    granted_scopes, metadata, version, verified_install_at, verified_install_version
  ON "connections"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.sync_slack_installation_binding();

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.slack_installation_bindings TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.inspect_slack_installation_binding(text, text, text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_slack_installation(text)
      TO opengeni_app;
  END IF;
END
$grants$;

COMMENT ON TABLE "slack_installation_bindings" IS
  'Secret-free Slack team to OpenGeni account/workspace routing authority; conflicts are quarantined, never guessed.';