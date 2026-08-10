-- deployment-mode: rolling
-- Exchange short-lived Slack identity-link bearers for durable, token-free,
-- subject-bound access-request state. Runtime may update request lifecycle rows
-- through CAS, but operation receipts are append-only and neither table grants
-- runtime DELETE.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "slack_user_link_access_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "token_digest" text NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "subject_label" text,
  "status" text NOT NULL DEFAULT 'prepared',
  "version" integer NOT NULL DEFAULT 1,
  "expires_at" timestamptz NOT NULL,
  "requested_at" timestamptz,
  "decided_at" timestamptz,
  "decision_by_subject_id" text,
  "approved_role" text,
  "approved_permissions" jsonb,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_user_link_access_requests_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_user_link_access_requests_identity_check"
    CHECK (
      length("token_digest") = 64
      AND "token_digest" ~ '^[0-9a-f]{64}$'
      AND length("slack_team_id") BETWEEN 1 AND 64
      AND length("slack_user_id") BETWEEN 1 AND 64
      AND length("subject_id") BETWEEN 1 AND 512
      AND ("subject_label" IS NULL OR length("subject_label") BETWEEN 1 AND 512)
      AND "version" > 0
    ),
  CONSTRAINT "slack_user_link_access_requests_status_check"
    CHECK (
      "status" IN ('prepared', 'pending', 'completed', 'denied', 'cancelled', 'expired')
    ),
  CONSTRAINT "slack_user_link_access_requests_lifecycle_check"
    CHECK (
      (
        "status" = 'prepared'
        AND "requested_at" IS NULL
        AND "decided_at" IS NULL
        AND "completed_at" IS NULL
      )
      OR (
        "status" = 'pending'
        AND "requested_at" IS NOT NULL
        AND "decided_at" IS NULL
        AND "completed_at" IS NULL
      )
      OR ("status" = 'completed' AND "completed_at" IS NOT NULL)
      OR (
        "status" IN ('denied', 'cancelled', 'expired')
        AND "decided_at" IS NOT NULL
        AND "completed_at" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "slack_user_link_access_requests_token_digest_uq"
  ON "slack_user_link_access_requests" ("token_digest");
CREATE UNIQUE INDEX "slack_user_link_access_requests_active_principal_uq"
  ON "slack_user_link_access_requests"
    ("workspace_id", "connection_id", "slack_user_id", "subject_id")
  WHERE "status" IN ('prepared', 'pending');
CREATE INDEX "slack_user_link_access_requests_workspace_pending_idx"
  ON "slack_user_link_access_requests"
    ("workspace_id", "status", "expires_at", "created_at");
CREATE INDEX "slack_user_link_access_requests_subject_idx"
  ON "slack_user_link_access_requests" ("workspace_id", "subject_id", "id");

CREATE TABLE "slack_user_link_access_request_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL
    REFERENCES "slack_user_link_access_requests"("id") ON DELETE CASCADE,
  "actor_subject_id" text NOT NULL,
  "operation" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "expected_version" integer NOT NULL,
  "result_version" integer NOT NULL,
  "result_status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_user_link_access_request_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_user_link_access_request_operations_identity_check"
    CHECK (
      length("actor_subject_id") BETWEEN 1 AND 512
      AND length("idempotency_key") BETWEEN 1 AND 200
      AND "idempotency_key" = btrim("idempotency_key")
      AND length("request_digest") = 64
      AND "request_digest" ~ '^[0-9a-f]{64}$'
      AND "expected_version" > 0
      AND "result_version" = "expected_version" + 1
      AND "operation" IN ('request', 'cancel', 'approve', 'deny')
      AND "result_status" IN ('pending', 'completed', 'denied', 'cancelled')
    )
);

CREATE UNIQUE INDEX "slack_user_link_access_request_operations_idempotency_uq"
  ON "slack_user_link_access_request_operations"
    ("request_id", "actor_subject_id", "operation", "idempotency_key");
CREATE UNIQUE INDEX "slack_user_link_access_request_operations_result_version_uq"
  ON "slack_user_link_access_request_operations" ("request_id", "result_version");

ALTER TABLE "slack_user_link_access_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_link_access_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_link_access_request_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_link_access_request_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "slack_user_link_access_requests"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "slack_user_link_access_request_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

REVOKE ALL ON TABLE "slack_user_link_access_requests" FROM PUBLIC;
REVOKE ALL ON TABLE "slack_user_link_access_request_operations" FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "slack_user_link_access_requests" TO "opengeni_app";
    GRANT SELECT, INSERT ON TABLE "slack_user_link_access_request_operations" TO "opengeni_app";
  END IF;
END
$runtime_grants$;

COMMENT ON TABLE "slack_user_link_access_requests" IS
  'Token-free, subject-bound lifecycle for signed Slack identity-link workspace access.';
COMMENT ON TABLE "slack_user_link_access_request_operations" IS
  'Append-only CAS and idempotency receipts for Slack identity-link access decisions.';