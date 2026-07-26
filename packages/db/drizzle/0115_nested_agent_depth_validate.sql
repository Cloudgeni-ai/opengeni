-- deployment-mode: rolling
-- The lineage checks were validated in 0113. Only the two composite foreign
-- keys remain to be scanned here, outside the ACCESS EXCLUSIVE finalization.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_root_session_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_policy_session_fk";

RESET statement_timeout;
RESET lock_timeout;