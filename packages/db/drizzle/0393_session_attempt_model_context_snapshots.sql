-- deployment-mode: rolling
-- Persist the exact model-visible instruction/tool/skill prefix captured at
-- provider request time so the session Debug inspector can show what the
-- agent saw, including token estimates. Content-bearing on purpose; session
-- readers already see raw event payloads.

CREATE TABLE "session_attempt_model_context_snapshots" (
  "attempt_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "request_index" integer NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "session_attempt_model_context_snapshots_attempt_owner_fk"
    FOREIGN KEY ("account_id", "workspace_id", "session_id", "turn_id", "attempt_id")
    REFERENCES "session_turn_attempts" ("account_id", "workspace_id", "session_id", "turn_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "session_attempt_model_context_snapshots_request_index_check"
    CHECK ("request_index" > 0 AND "execution_generation" > 0),
  CONSTRAINT "session_attempt_model_context_snapshots_size_check"
    CHECK (octet_length("snapshot"::text) BETWEEN 2 AND 16777216),
  CONSTRAINT "session_attempt_model_context_snapshots_identity_check"
    CHECK (
      jsonb_typeof("snapshot") = 'object'
      AND "snapshot" ?& ARRAY[
        'version', 'capturedAt', 'source', 'requestIndex', 'instructions',
        'layers', 'tools', 'skills', 'tokens'
      ]::text[]
      AND ("snapshot"->>'version')::integer = 1
      AND "snapshot"->>'source' = 'model_request'
      AND jsonb_typeof("snapshot"->'layers') = 'array'
      AND jsonb_typeof("snapshot"->'tools') = 'array'
      AND jsonb_typeof("snapshot"->'skills') = 'array'
    )
);

CREATE INDEX "session_attempt_model_context_snapshots_session_idx"
  ON "session_attempt_model_context_snapshots" ("workspace_id", "session_id", "captured_at" DESC);

ALTER TABLE "session_attempt_model_context_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_model_context_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_attempt_model_context_snapshots"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.session_attempt_model_context_snapshots FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.session_attempt_model_context_snapshots TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;