-- deployment-mode: maintenance
-- Causally ordered SiteAuth health evidence. Browser runs remain independent;
-- only the newest-started terminal evidence may change the shared projection.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SEQUENCE "auth_runs_health_sequence_seq" AS bigint;

ALTER TABLE "auth_runs"
  ADD COLUMN "purpose" text NOT NULL DEFAULT 'authenticate',
  ADD COLUMN "health_sequence" bigint NOT NULL
    DEFAULT nextval('auth_runs_health_sequence_seq'::regclass);

ALTER SEQUENCE "auth_runs_health_sequence_seq"
  OWNED BY "auth_runs"."health_sequence";

-- The volatile default gives legacy rows values, but physical row order is not
-- causal. Re-rank the bounded pre-cutover history before admitting writers.
WITH ordered AS (
  SELECT
    "id",
    row_number() OVER (ORDER BY "created_at", "id")::bigint AS "health_sequence"
  FROM "auth_runs"
)
UPDATE "auth_runs" AS run
SET "health_sequence" = ordered."health_sequence"
FROM ordered
WHERE run."id" = ordered."id";

SELECT setval(
  'auth_runs_health_sequence_seq'::regclass,
  greatest(coalesce((SELECT max("health_sequence") FROM "auth_runs"), 0), 1),
  coalesce((SELECT max("health_sequence") FROM "auth_runs"), 0) > 0
);

ALTER TABLE "auth_runs"
  ADD CONSTRAINT "auth_runs_health_evidence_check" CHECK (
    "purpose" IN ('authenticate', 'health_check', 'repair')
    AND "health_sequence" > 0
  );

ALTER TABLE "site_auth_connections"
  ADD COLUMN "last_checked_at" timestamptz,
  ADD COLUMN "next_check_at" timestamptz,
  ADD COLUMN "health_sequence" bigint NOT NULL DEFAULT 0;

-- Existing successful verification is preserved. Existing terminal failures,
-- which the old writer failed to project, become repair evidence now.
WITH latest AS (
  SELECT DISTINCT ON (run."site_auth_connection_id")
    run."site_auth_connection_id",
    run."id",
    run."state",
    run."purpose",
    run."health_sequence",
    run."verified_url",
    run."failure_code",
    run."settled_at"
  FROM "auth_runs" AS run
  WHERE run."state" IN ('verified', 'failed')
    AND run."settled_at" IS NOT NULL
  ORDER BY run."site_auth_connection_id", run."health_sequence" DESC
)
UPDATE "site_auth_connections" AS connection
SET
  "verification_state" = CASE
    WHEN latest."state" = 'verified' THEN 'verified'
    WHEN latest."purpose" = 'repair' THEN 'failed'
    ELSE 'needs_repair'
  END,
  "last_verified_at" = CASE
    WHEN latest."state" = 'verified' THEN latest."settled_at"
    ELSE connection."last_verified_at"
  END,
  "last_verified_url" = CASE
    WHEN latest."state" = 'verified' THEN latest."verified_url"
    ELSE connection."last_verified_url"
  END,
  "repair_code" = CASE
    WHEN latest."state" = 'verified' THEN NULL
    ELSE latest."failure_code"
  END,
  "last_checked_at" = latest."settled_at",
  "health_sequence" = latest."health_sequence"
FROM latest
WHERE connection."id" = latest."site_auth_connection_id";

UPDATE "site_auth_connections"
SET
  "next_check_at" = CASE
    WHEN "status" = 'active' AND "health_policy"->>'mode' = 'maintained'
      THEN CASE
        WHEN "last_checked_at" IS NULL THEN now()
        ELSE "last_checked_at"
          + ((("health_policy"->>'intervalSeconds')::bigint) * interval '1 second')
      END
    ELSE NULL
  END,
  "version" = "version" + 1,
  "updated_at" = now();

ALTER TABLE "site_auth_connections"
  ADD CONSTRAINT "site_auth_connections_health_check" CHECK (
    (
      (
        "health_sequence" = 0
        AND "last_checked_at" IS NULL
      ) OR (
        "health_sequence" > 0
        AND "last_checked_at" IS NOT NULL
      )
    ) AND (
      (
        "status" = 'active'
        AND "health_policy"->>'mode' = 'maintained'
        AND "next_check_at" IS NOT NULL
      ) OR (
        NOT ("status" = 'active' AND "health_policy"->>'mode' = 'maintained')
        AND "next_check_at" IS NULL
      )
    )
  );

CREATE INDEX "site_auth_connections_health_maintenance_idx"
  ON "site_auth_connections" ("workspace_id", "next_check_at", "id");

REVOKE ALL ON SEQUENCE "auth_runs_health_sequence_seq" FROM PUBLIC;
DO $browser_auth_health_role_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %I.auth_runs_health_sequence_seq TO opengeni_app',
      current_schema()
    );
  END IF;
END
$browser_auth_health_role_grants$;
