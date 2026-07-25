-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '30min';
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_depth_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_source_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_policy_snapshot_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_nested_agent_override_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_root_session_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_policy_session_fk";
RESET statement_timeout;
RESET lock_timeout;
