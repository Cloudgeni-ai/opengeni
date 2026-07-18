-- deployment-mode: rolling
-- OPE-53 online referential scan phase. These validations permit ordinary DML
-- and are isolated from the fast ACCESS EXCLUSIVE contract transaction.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_parent_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_root_session_fk";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_workspace_policy_session_fk";

RESET statement_timeout;
RESET lock_timeout;