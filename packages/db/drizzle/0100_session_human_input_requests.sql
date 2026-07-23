-- deployment-mode: rolling
-- Durable, host-neutral structured human input. The OpenAI Agents SDK approval
-- interruption is an internal freeze primitive only; this table owns the
-- distinct request/response protocol and its idempotent settlement state. Its
-- strong attempt-owner index is installed online by migration 0099.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS "session_human_input_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "turn_generation" integer NOT NULL,
  "creation_attempt_id" uuid NOT NULL,
  "tool_call_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "questions" jsonb NOT NULL,
  "allow_skip" boolean NOT NULL DEFAULT false,
  "response" jsonb,
  "responded_by" text,
  "responded_at" timestamptz,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_human_input_requests_creation_attempt_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "session_id", "turn_id", "creation_attempt_id"
    )
    REFERENCES "session_turn_attempts" (
      "account_id", "workspace_id", "session_id", "turn_id", "id"
    )
    ON DELETE CASCADE,
  CONSTRAINT "session_human_input_requests_status_check"
    CHECK ("status" IN ('pending','answered','skipped','expired','cancelled')),
  CONSTRAINT "session_human_input_requests_generation_check"
    CHECK ("turn_generation" > 0),
  CONSTRAINT "session_human_input_requests_tool_call_bytes_check"
    CHECK (octet_length("tool_call_id") BETWEEN 1 AND 1024),
  CONSTRAINT "session_human_input_requests_questions_bytes_check"
    CHECK (octet_length("questions"::text) <= 49152),
  CONSTRAINT "session_human_input_requests_response_bytes_check"
    CHECK ("response" IS NULL OR octet_length("response"::text) <= 49152),
  CONSTRAINT "session_human_input_requests_actor_bytes_check"
    CHECK ("responded_by" IS NULL OR octet_length("responded_by") <= 1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_human_input_requests_tool_call_uq"
  ON "session_human_input_requests" (
    "workspace_id", "session_id", "turn_id", "tool_call_id"
  );
CREATE INDEX IF NOT EXISTS "session_human_input_requests_pending_session_idx"
  ON "session_human_input_requests" ("workspace_id", "session_id", "created_at", "id")
  WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "session_human_input_requests_pending_expiry_idx"
  ON "session_human_input_requests" ("expires_at", "id")
  WHERE "status" = 'pending' AND "expires_at" IS NOT NULL;

ALTER TABLE "session_human_input_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_human_input_requests" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'session_human_input_requests'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_human_input_requests";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "session_human_input_requests"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_human_input_requests TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;
