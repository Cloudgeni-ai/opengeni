-- deployment-mode: maintenance
-- Canonical Codemode authority boundary. Application processes are upgraded as
-- one exact release; the legacy counter name is removed rather than dual-read.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "session_turns"
  RENAME COLUMN "toolspace_call_count" TO "codemode_call_count";

CREATE TABLE "session_attempt_tool_catalogs" (
  "attempt_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "catalog_version" integer NOT NULL,
  "generation" integer NOT NULL,
  "digest" text NOT NULL,
  "catalog" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "session_attempt_tool_catalogs_attempt_owner_fk"
    FOREIGN KEY ("account_id", "workspace_id", "session_id", "turn_id", "attempt_id")
    REFERENCES "session_turn_attempts"(
      "account_id", "workspace_id", "session_id", "turn_id", "id"
    ) ON DELETE CASCADE,
  CONSTRAINT "session_attempt_tool_catalogs_version_check"
    CHECK ("catalog_version" = 1 AND "generation" > 0 AND "execution_generation" > 0),
  CONSTRAINT "session_attempt_tool_catalogs_digest_check"
    CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_attempt_tool_catalogs_size_check"
    CHECK (octet_length("catalog"::text) BETWEEN 2 AND 16777216),
  CONSTRAINT "session_attempt_tool_catalogs_catalog_identity_check"
    CHECK (
      jsonb_typeof("catalog") = 'object'
      AND "catalog" ?& ARRAY[
        'version', 'accountId', 'workspaceId', 'sessionId', 'turnId',
        'attemptId', 'executionGeneration', 'generation', 'createdAt',
        'digest', 'entries'
      ]::text[]
      AND "catalog"->>'accountId' = "account_id"::text
      AND "catalog"->>'workspaceId' = "workspace_id"::text
      AND "catalog"->>'sessionId' = "session_id"::text
      AND "catalog"->>'turnId' = "turn_id"::text
      AND "catalog"->>'attemptId' = "attempt_id"::text
      AND ("catalog"->>'executionGeneration')::integer = "execution_generation"
      AND ("catalog"->>'version')::integer = "catalog_version"
      AND ("catalog"->>'generation')::integer = "generation"
      AND "catalog"->>'digest' = "digest"
      AND jsonb_typeof("catalog"->'entries') = 'array'
      AND jsonb_array_length("catalog"->'entries') <= 4096
    )
);

CREATE INDEX "session_attempt_tool_catalogs_session_turn_idx"
  ON "session_attempt_tool_catalogs" ("workspace_id", "session_id", "turn_id");

CREATE UNIQUE INDEX "session_attempt_tool_catalogs_exact_authority_digest_uidx"
  ON "session_attempt_tool_catalogs" (
    "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
    "execution_generation", "digest"
  );

CREATE TABLE "session_attempt_codemode_calls" (
  "operation_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "catalog_digest" text NOT NULL,
  "request_digest" text NOT NULL,
  "server_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "arguments" jsonb NOT NULL,
  "caller_subject_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "claim_id" uuid,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz,
  "execution_started_at" timestamptz,
  "claim_expires_at" timestamptz,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_attempt_codemode_calls_catalog_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation", "catalog_digest"
    )
    REFERENCES "session_attempt_tool_catalogs"(
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation", "digest"
    ) ON DELETE CASCADE,
  CONSTRAINT "session_attempt_codemode_calls_generation_check"
    CHECK ("execution_generation" > 0),
  CONSTRAINT "session_attempt_codemode_calls_digests_check"
    CHECK (
      "catalog_digest" ~ '^[0-9a-f]{64}$'
      AND "request_digest" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "session_attempt_codemode_calls_identity_check"
    CHECK (
      octet_length("server_id") BETWEEN 1 AND 256
      AND octet_length("tool_name") BETWEEN 1 AND 512
      AND octet_length("caller_subject_id") BETWEEN 1 AND 1024
    ),
  CONSTRAINT "session_attempt_codemode_calls_arguments_size_check"
    CHECK (
      jsonb_typeof("arguments") = 'object'
      AND octet_length("arguments"::text) BETWEEN 2 AND 4194304
    ),
  CONSTRAINT "session_attempt_codemode_calls_result_size_check"
    CHECK (
      "result" IS NULL OR (
        jsonb_typeof("result") = 'object'
        AND octet_length("result"::text) BETWEEN 2 AND 16777216
      )
    ),
  CONSTRAINT "session_attempt_codemode_calls_lifecycle_check"
    CHECK (
      (
        "state" = 'queued'
        AND "claim_id" IS NULL
        AND "claimed_at" IS NULL
        AND "execution_started_at" IS NULL
        AND "claim_expires_at" IS NULL
        AND "completed_at" IS NULL
        AND "result" IS NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'running'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NULL
        AND "result" IS NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'completed'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "execution_started_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NOT NULL
        AND "error_code" IS NULL
        AND "error_message" IS NULL
      ) OR (
        "state" = 'failed'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      ) OR (
        "state" = 'outcome_unknown'
        AND "claim_id" IS NOT NULL
        AND "claimed_at" IS NOT NULL
        AND "execution_started_at" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      ) OR (
        "state" = 'cancelled'
        AND "claim_id" IS NULL
        AND "claimed_at" IS NULL
        AND "execution_started_at" IS NULL
        AND "claim_expires_at" IS NULL
        AND "completed_at" IS NOT NULL
        AND "result" IS NULL
        AND "error_code" IS NOT NULL
        AND "error_message" IS NOT NULL
      )
    )
);

CREATE INDEX "session_attempt_codemode_calls_session_turn_idx"
  ON "session_attempt_codemode_calls" (
    "workspace_id", "session_id", "turn_id", "created_at"
  );

CREATE INDEX "session_attempt_codemode_calls_active_attempt_idx"
  ON "session_attempt_codemode_calls" ("workspace_id", "attempt_id", "state")
  WHERE "state" IN ('queued', 'running');

ALTER TABLE "session_attempt_tool_catalogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_tool_catalogs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_attempt_tool_catalogs"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "session_attempt_codemode_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_codemode_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_attempt_codemode_calls"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.session_attempt_tool_catalogs FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.session_attempt_tool_catalogs TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.session_attempt_codemode_calls FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.session_attempt_codemode_calls TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
