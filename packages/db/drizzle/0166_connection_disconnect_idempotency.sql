-- deployment-mode: rolling
-- Bind a subject-owned connection disconnect to one caller-frozen generation
-- and operation key. Exact retries converge only while the produced generation
-- remains current; reconnecting permanently fences delayed old requests.

CREATE TABLE "connection_disconnect_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "expected_version" integer NOT NULL,
  "result_version" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "connection_disconnect_operations_subject_key_uq"
    UNIQUE ("workspace_id", "subject_id", "idempotency_key"),
  CONSTRAINT "connection_disconnect_operations_connection_generation_uq"
    UNIQUE ("workspace_id", "connection_id", "expected_version"),
  CONSTRAINT "connection_disconnect_operations_identity_check"
    CHECK (
      length("subject_id") BETWEEN 1 AND 512
      AND length("idempotency_key") BETWEEN 1 AND 200
      AND "idempotency_key" = btrim("idempotency_key")
      AND "expected_version" > 0
      AND "result_version" = "expected_version" + 1
    )
);

ALTER TABLE "connection_disconnect_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_disconnect_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_subject_isolation ON "connection_disconnect_operations"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE "connection_disconnect_operations" FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "connection_disconnect_operations" TO opengeni_app;
  END IF;
END
$$;