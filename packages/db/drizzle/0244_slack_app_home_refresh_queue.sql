-- deployment-mode: rolling
-- Durable, coalesced, per-user Slack App Home refreshes. Signed Events API
-- ingress records only bounded provider identifiers and acknowledges before
-- host authorization, task projection, or Slack views.publish network work.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "slack_app_home_refreshes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "provider_view_hash" text,
  "desired_revision" integer NOT NULL DEFAULT 1,
  "processed_revision" integer NOT NULL DEFAULT 0,
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "retry_at" timestamptz,
  "last_error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_app_home_refreshes_connection_user_uq"
    UNIQUE ("connection_id", "slack_user_id"),
  CONSTRAINT "slack_app_home_refreshes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_app_home_refreshes_bounds_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_user_id") BETWEEN 1 AND 64
      AND octet_length("provider_event_id") BETWEEN 1 AND 256
      AND ("provider_view_hash" IS NULL
        OR octet_length("provider_view_hash") BETWEEN 1 AND 256)
      AND ("last_error_code" IS NULL
        OR octet_length("last_error_code") BETWEEN 1 AND 128)
    ),
  CONSTRAINT "slack_app_home_refreshes_revisions_check"
    CHECK (
      "desired_revision" > 0
      AND "processed_revision" >= 0
      AND "processed_revision" <= "desired_revision"
      AND "attempt_count" >= 0
    ),
  CONSTRAINT "slack_app_home_refreshes_claim_check"
    CHECK (("claim_holder_id" IS NULL) = ("claim_expires_at" IS NULL))
);

CREATE INDEX "slack_app_home_refreshes_pending_idx"
  ON "slack_app_home_refreshes" ("retry_at", "updated_at", "id")
  WHERE "processed_revision" < "desired_revision";

ALTER TABLE "slack_app_home_refreshes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_app_home_refreshes" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "slack_app_home_refreshes"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_app_home_refresh(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.slack_app_home_refreshes
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack App Home claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT refresh.id
        FROM %1$I.slack_app_home_refreshes refresh
        WHERE refresh.processed_revision < refresh.desired_revision
          AND (refresh.retry_at IS NULL OR refresh.retry_at <= now())
          AND (refresh.claim_holder_id IS NULL OR refresh.claim_expires_at <= now())
        ORDER BY refresh.retry_at NULLS FIRST, refresh.updated_at, refresh.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_app_home_refreshes refresh
      SET claim_holder_id = p_holder,
          claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          retry_at = NULL,
          attempt_count = refresh.attempt_count + 1,
          updated_at = now()
      FROM candidate
      WHERE refresh.id = candidate.id
      RETURNING refresh.*;
    END
    $function$
  $ddl$, data_schema);
END
$privileged_functions$;

REVOKE ALL ON FUNCTION opengeni_private.claim_slack_app_home_refresh(uuid, integer) FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_app_home_refreshes" TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_slack_app_home_refresh(uuid, integer)
      TO opengeni_app;
  END IF;
END
$runtime_grants$;

RESET statement_timeout;
RESET lock_timeout;