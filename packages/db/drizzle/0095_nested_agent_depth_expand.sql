-- deployment-mode: rolling
-- Expand phase: add only nullable session columns and persist the
-- deployment fallback. The single sessions ALTER is metadata-only and uses a
-- bounded lock; no table scan or backfill shares its transaction.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "nested_agent_depth_configuration" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "max_nested_agent_depth" integer NOT NULL,
  "policy_source" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "nested_agent_depth_configuration_singleton_check"
    CHECK ("singleton"),
  CONSTRAINT "nested_agent_depth_configuration_max_check"
    CHECK ("max_nested_agent_depth" >= 0),
  CONSTRAINT "nested_agent_depth_configuration_source_check"
    CHECK ("policy_source" IN ('deployment', 'default'))
);

-- migrate.ts sets both session GUCs before applying files. COALESCE keeps
-- direct migration-body tests and third-party runners safely on product default.
INSERT INTO "nested_agent_depth_configuration" (
  "singleton", "max_nested_agent_depth", "policy_source"
) VALUES (
  true,
  coalesce(nullif(current_setting('opengeni.max_nested_agent_depth', true), ''), '3')::integer,
  coalesce(
    nullif(current_setting('opengeni.nested_agent_depth_policy_source', true), ''),
    'default'
  )
) ON CONFLICT ("singleton") DO UPDATE
SET "max_nested_agent_depth" = excluded."max_nested_agent_depth",
    "policy_source" = excluded."policy_source",
    "updated_at" = now();

DO $configuration_grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON %I."nested_agent_depth_configuration" FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT ON %I."nested_agent_depth_configuration" TO opengeni_app',
      target_schema
    );
  END IF;
END $configuration_grants$;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "root_session_id" uuid,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth" integer,
  ADD COLUMN IF NOT EXISTS "max_nested_agent_depth_override" integer,
  ADD COLUMN IF NOT EXISTS "effective_max_nested_agent_depth" integer,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_source" text,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_session_id" uuid;

RESET statement_timeout;
RESET lock_timeout;
