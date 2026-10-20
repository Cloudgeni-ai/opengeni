-- deployment-mode: rolling
-- Agents released before the workspace-root fix (#4355) reported `/` when a
-- service manager started them there, and chats attached then saved it as
-- their working directory. It outlived the agent fix, so attachments, tool
-- results and generated images still failed in those chats on a read-only
-- root. Windows services report their launch directory under the system
-- directory in the same way. Clear exactly those saved values so the
-- machine's reported root applies again; every other value is kept.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Migrations run as the NOSUPERUSER/NOBYPASSRLS table owner. Temporarily let
-- that owner see the rows; application roles remain policy-bound. The table
-- lock taken here already excludes runtime writers, so (as in 0763 and 0793)
-- do not acquire workspace advisory fences after it; restore the exact fence
-- trigger before commit.
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" DISABLE TRIGGER session_tenancy_workspace_fence;

UPDATE "sessions"
SET "working_dir" = NULL
WHERE "working_dir" = '/'
  OR "working_dir" ~* '^[A-Za-z]:[\\/]windows[\\/]system32[\\/]?$';

ALTER TABLE "sessions" ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
