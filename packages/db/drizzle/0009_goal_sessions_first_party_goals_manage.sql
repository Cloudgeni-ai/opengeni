-- Goal-bearing sessions must always hold goals:manage in their first-party
-- MCP permission set. A session created with a goal plus an explicit
-- first_party_mcp_permissions list lacking goals:manage never sees the goal
-- tools (goal_complete/goal_pause/goal_set/goal_update) on its delegated
-- token, so the agent cannot stop its own goal and the continuation loop
-- runs until an operator intervenes. Session creation now unions
-- goals:manage into explicit lists for goal-bearing sessions; this backfills
-- the rows created before that fix.
--
-- The backfill is scoped to sessions with a non-completed goal and an
-- explicit permission list missing goals:manage, and is idempotent. NULL
-- permission lists (the default worker set) already include goals:manage at
-- token-signing time and are left untouched.
--
-- Migrations run as the table owner, which FORCE ROW LEVEL SECURITY would
-- otherwise subject to the workspace-scoped policies (matching zero rows
-- here, where no workspace GUCs are set). NO FORCE only affects the owner -
-- the app role stays policy-bound throughout - and FORCE is restored within
-- the same implicit transaction that runs this file.
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_goals" NO FORCE ROW LEVEL SECURITY;
UPDATE "sessions" s
SET "first_party_mcp_permissions" = s."first_party_mcp_permissions" || '["goals:manage"]'::jsonb
WHERE s."first_party_mcp_permissions" IS NOT NULL
  AND jsonb_typeof(s."first_party_mcp_permissions") = 'array'
  AND NOT s."first_party_mcp_permissions" @> '"goals:manage"'::jsonb
  AND EXISTS (
    SELECT 1 FROM "session_goals" g
    WHERE g."workspace_id" = s."workspace_id"
      AND g."session_id" = s."id"
      AND g."status" <> 'completed'
  );
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_goals" FORCE ROW LEVEL SECURITY;
