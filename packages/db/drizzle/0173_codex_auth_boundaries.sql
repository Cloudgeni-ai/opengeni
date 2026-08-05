-- deployment-mode: maintenance

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Reject mixed-version writers before locking, then repeat after the locks to
-- close the connect-before-lock race. The deployment must keep API and workers
-- stopped until the new application version is active.
DO $codex_boundaries_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Codex authentication boundaries activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_boundaries_writer_drain_before_lock$;

LOCK TABLE "codex_subscription_credentials" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session_history_items" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "agent_run_states" IN ACCESS EXCLUSIVE MODE;

DO $codex_boundaries_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Codex authentication boundaries activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$codex_boundaries_writer_drain_after_lock$;

-- One optional workspace credential for ChatGPT connected Apps. This pointer is
-- intentionally separate from inference rotation and starts unset.
CREATE UNIQUE INDEX "codex_subscription_credentials_workspace_account_id_idx"
  ON "codex_subscription_credentials" ("workspace_id", "account_id", "id");

CREATE TABLE "codex_apps_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credential_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "designated_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "codex_apps_settings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "codex_apps_settings_credential_scope_fk"
    FOREIGN KEY ("workspace_id", "account_id", "credential_id")
    REFERENCES "codex_subscription_credentials"("workspace_id", "account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "codex_apps_settings_designation_shape_chk" CHECK (
    "version" > 0 AND (
      ("credential_id" IS NULL AND "designated_at" IS NULL)
      OR
      ("credential_id" IS NOT NULL AND "designated_at" IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX "codex_apps_settings_workspace_idx"
  ON "codex_apps_settings" ("workspace_id");

ALTER TABLE "codex_apps_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_apps_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "codex_apps_settings"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Remove the false credential/history relation and the obsolete
-- connector-aware inference cache. Provider rejection receipts remain.
ALTER TABLE "session_history_items"
  DROP COLUMN "producer_codex_credential_id";
ALTER TABLE "agent_run_states"
  DROP COLUMN "frozen_codex_credential_id";
ALTER TABLE "codex_subscription_credentials"
  DROP COLUMN "connector_namespaces",
  DROP COLUMN "connectors_checked_at";

DO $$
DECLARE
  target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.codex_apps_settings TO opengeni_app',
      target_schema
    );
  END IF;
END $$;
