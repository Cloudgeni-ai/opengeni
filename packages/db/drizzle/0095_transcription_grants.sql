-- deployment-mode: rolling
-- Durable, RLS-scoped browser-direct transcription admission and reconciliation.
-- This stores no credentials, audio, transcript text, or raw provider payload.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "transcription_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "request_id" text NOT NULL,
  "provider" text NOT NULL,
  "provider_project_id" text NOT NULL,
  "endpoint" text NOT NULL,
  "provider_session_id" text,
  "status" text NOT NULL DEFAULT 'reserved',
  "reserved_duration_seconds" bigint NOT NULL,
  "reserved_cost_micros" bigint NOT NULL,
  "reported_duration_seconds" bigint NOT NULL DEFAULT 0,
  "reported_cost_micros" bigint NOT NULL DEFAULT 0,
  "client_secret_expires_at" timestamptz,
  "active_expires_at" timestamptz NOT NULL,
  "issued_at" timestamptz,
  "settled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "transcription_grants_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "transcription_grants_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "transcription_grants_status_check"
    CHECK ("status" IN (
      'reserved','active','completed','cancelled','error','provider_closed',
      'replaced','expired','provider_rejected'
    )),
  CONSTRAINT "transcription_grants_reservation_check"
    CHECK (
      "reserved_duration_seconds" > 0 AND "reserved_cost_micros" > 0
      AND "reported_duration_seconds" >= 0 AND "reported_cost_micros" >= 0
    )
);

CREATE UNIQUE INDEX "transcription_grants_request_uq"
  ON "transcription_grants" ("workspace_id", "subject_id", "request_id");
CREATE UNIQUE INDEX "transcription_grants_one_active_session_uq"
  ON "transcription_grants" ("workspace_id", "session_id")
  WHERE "status" IN ('reserved','active');
CREATE INDEX "transcription_grants_workspace_status_idx"
  ON "transcription_grants" ("workspace_id", "status", "active_expires_at");
CREATE INDEX "transcription_grants_subject_created_idx"
  ON "transcription_grants" ("workspace_id", "subject_id", "created_at");

ALTER TABLE "transcription_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcription_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "transcription_grants_workspace_isolation" ON "transcription_grants"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.transcription_grants TO opengeni_app',
      target_schema
    );
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;