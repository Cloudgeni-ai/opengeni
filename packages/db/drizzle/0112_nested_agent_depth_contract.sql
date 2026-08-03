-- deployment-mode: rolling
-- Prove the expanded lineage columns before the final metadata-only contract.
-- Every check is deliberately NOT VALID here so the additions take only the
-- short catalog lock; the bounded validation scan is isolated in 0113.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_root_not_null_check"
  CHECK ("root_session_id" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_not_null_check"
  CHECK ("nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_effective_max_not_null_check"
  CHECK ("effective_max_nested_agent_depth" IS NOT NULL) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_not_null_check"
  CHECK ("nested_agent_depth_policy_source" IS NOT NULL) NOT VALID;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_depth_check"
  CHECK ("nested_agent_depth" >= 0 AND "nested_agent_depth" <= 2147483647
    AND "effective_max_nested_agent_depth" >= 0
    AND "effective_max_nested_agent_depth" <= 2147483647
    AND ("max_nested_agent_depth_override" IS NULL
      OR "max_nested_agent_depth_override" BETWEEN 0 AND 2147483647)) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_source_check"
  CHECK ("nested_agent_depth_policy_source" IN ('session', 'workspace', 'deployment', 'default')) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_policy_snapshot_check"
  CHECK (("nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" IS NOT NULL)
    OR ("nested_agent_depth_policy_source" <> 'session'
      AND "nested_agent_depth_policy_session_id" IS NULL
      AND "max_nested_agent_depth_override" IS NULL)) NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_nested_agent_override_check"
  CHECK ("max_nested_agent_depth_override" IS NULL
    OR ("nested_agent_depth_policy_source" = 'session'
      AND "nested_agent_depth_policy_session_id" = "id"
      AND "effective_max_nested_agent_depth" = "max_nested_agent_depth_override")) NOT VALID;

RESET statement_timeout;
RESET lock_timeout;