-- deployment-mode: rolling
-- Constraint expand phase. NOT VALID makes every addition metadata-only;
-- the scans run later without carrying these ACCESS EXCLUSIVE locks.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_root_session_not_null"
  CHECK ("root_session_id" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_not_null"
  CHECK ("nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_effective_nested_agent_depth_not_null"
  CHECK ("effective_max_nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_not_null"
  CHECK ("nested_agent_depth_policy_source" IS NOT NULL) NOT VALID;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_check"
  CHECK (
    "nested_agent_depth" >= 0
    AND "effective_max_nested_agent_depth" >= 0
    AND ("max_nested_agent_depth_override" IS NULL
      OR "max_nested_agent_depth_override" >= 0)
  ) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_check"
  CHECK ("nested_agent_depth_policy_source" IN ('session', 'workspace', 'deployment', 'default'))
  NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_session_check"
  CHECK (
    ("nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" IS NOT NULL)
    OR ("nested_agent_depth_policy_source" <> 'session'
      AND "nested_agent_depth_policy_session_id" IS NULL
      AND "max_nested_agent_depth_override" IS NULL)
  ) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_override_check"
  CHECK (
    "max_nested_agent_depth_override" IS NULL
    OR (
      "nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" = "id"
      AND "effective_max_nested_agent_depth" = "max_nested_agent_depth_override"
    )
  ) NOT VALID;

RESET statement_timeout;
RESET lock_timeout;
