-- deployment-mode: rolling
-- Rebased after the current main migration ledger.
-- Durable per-session ownership for the temporary normal -> realtime -> normal mode.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "session_realtime_modes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "owner_subject_id" text NOT NULL,
  "browser_instance_id" text NOT NULL,
  "owner_key_hash" text NOT NULL,
  "model" text NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "connection_epoch" integer DEFAULT 1 NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "last_heartbeat_at" timestamptz NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "ended_at" timestamptz,
  "end_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "session_realtime_modes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_modes_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_modes_state_check"
    CHECK ("state" IN ('active', 'ended')),
  CONSTRAINT "session_realtime_modes_model_check"
    CHECK ("model" = 'gpt-live-1-boulder-alpha'),
  CONSTRAINT "session_realtime_modes_end_reason_check"
    CHECK ("end_reason" IS NULL OR "end_reason" IN ('user_stop', 'browser_unload', 'lease_expired')),
  CONSTRAINT "session_realtime_modes_version_check" CHECK ("version" >= 1),
  CONSTRAINT "session_realtime_modes_epoch_check" CHECK ("connection_epoch" >= 1),
  CONSTRAINT "session_realtime_modes_owner_subject_check"
    CHECK (octet_length("owner_subject_id") BETWEEN 1 AND 1024),
  CONSTRAINT "session_realtime_modes_browser_instance_check"
    CHECK (octet_length("browser_instance_id") BETWEEN 1 AND 256),
  CONSTRAINT "session_realtime_modes_owner_key_hash_check"
    CHECK ("owner_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_realtime_modes_lease_check"
    CHECK ("lease_expires_at" > "last_heartbeat_at"),
  CONSTRAINT "session_realtime_modes_terminal_check"
    CHECK (
      ("state" = 'active' AND "ended_at" IS NULL AND "end_reason" IS NULL)
      OR
      ("state" = 'ended' AND "ended_at" IS NOT NULL AND "end_reason" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "session_realtime_modes_operation_uq"
  ON "session_realtime_modes" ("workspace_id", "session_id", "operation_id");

CREATE UNIQUE INDEX "session_realtime_modes_one_active_uq"
  ON "session_realtime_modes" ("workspace_id", "session_id")
  WHERE "state" = 'active';

CREATE INDEX "session_realtime_modes_active_lease_idx"
  ON "session_realtime_modes" ("lease_expires_at", "workspace_id", "session_id")
  WHERE "state" = 'active';

ALTER TABLE "session_realtime_modes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_realtime_modes" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "session_realtime_modes"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_realtime_modes TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;
