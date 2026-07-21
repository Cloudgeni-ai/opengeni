-- deployment-mode: rolling
-- Online scan phase. VALIDATE uses SHARE UPDATE EXCLUSIVE, which permits
-- ordinary reads and writes, and carries no earlier ACCESS EXCLUSIVE operation.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_root_session_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_depth_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_effective_nested_agent_depth_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_source_not_null";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_depth_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_source_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_session_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_override_check";

RESET statement_timeout;
RESET lock_timeout;
