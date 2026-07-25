-- deployment-mode: rolling
-- Expand phase: persist deployment policy and add nullable lineage columns.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "nested_agent_depth_configuration" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "max_nested_agent_depth" integer NOT NULL,
  "policy_source" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "nested_agent_depth_configuration_singleton_check" CHECK ("singleton"),
  CONSTRAINT "nested_agent_depth_configuration_max_check"
    CHECK ("max_nested_agent_depth" >= 0 AND "max_nested_agent_depth" <= 2147483647),
  CONSTRAINT "nested_agent_depth_configuration_source_check"
    CHECK ("policy_source" IN ('deployment', 'default'))
);

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT SELECT ON %I."nested_agent_depth_configuration" TO opengeni_app', current_schema());
  END IF;
END $grants$;

INSERT INTO "nested_agent_depth_configuration" (
  "singleton", "max_nested_agent_depth", "policy_source"
) VALUES (
  true,
  coalesce(nullif(current_setting('opengeni.max_nested_agent_depth', true), ''), '3')::integer,
  coalesce(nullif(current_setting('opengeni.nested_agent_depth_policy_source', true), ''), 'default')
) ON CONFLICT ("singleton") DO NOTHING;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "root_session_id" uuid,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth" integer,
  ADD COLUMN IF NOT EXISTS "max_nested_agent_depth_override" integer,
  ADD COLUMN IF NOT EXISTS "effective_max_nested_agent_depth" integer,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_source" text,
  ADD COLUMN IF NOT EXISTS "nested_agent_depth_policy_session_id" uuid;

RESET statement_timeout;
RESET lock_timeout;
