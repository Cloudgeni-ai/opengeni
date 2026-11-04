-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: only tool choices for personal logins saved outside the login's own workspace move; each workspace holds at most 2048 choices
-- A personal login's tool choices (Allow, Ask, Block) belong to the login and
-- follow it between workspaces (docs/design/ownership-and-reach.md, rule 10).
-- They are kept once, in the workspace the login was connected from, and a
-- turn in another workspace reads them from there.
--
-- Before, a choice was kept in the workspace where it was made, so the same
-- login could carry different choices in different workspaces. Those copies
-- merge into the login's own workspace here. Where they disagree on the same
-- connector, tool and action, the strictest choice wins (Block, then Ask,
-- then Allow), so nobody is asked less than they chose anywhere; on a tie the
-- most recent wins. A merged choice gets a new version.
--
-- Workspace logins and credential-free servers are untouched.
--
-- The previous release reads only the session workspace's choices, so during
-- the rollout a moved choice can be missing in another workspace; that only
-- asks where it would have allowed. A choice the previous release saves away
-- from home during the rollout is ignored afterwards, and asked again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The migration principal is bound by FORCE ROW LEVEL SECURITY and has no
-- tenant settings, so both tables are owner-visible only for this
-- transaction. The application role stays policy-bound.
ALTER TABLE "connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "connector_action_policies" NO FORCE ROW LEVEL SECURITY;

-- 1. Where the login's own workspace already has the choice, it takes the
--    strictest of all copies.
WITH personal AS (
  SELECT choice.id, choice.account_id, choice.workspace_id,
         login.workspace_id AS home_workspace_id, choice.connection_id,
         choice.server_id, choice.tool_name, choice.action_name, choice.policy,
         choice.updated_by_subject_id, choice.updated_at
  FROM connector_action_policies choice
  JOIN connections login
    ON login.account_id = choice.account_id
   AND login.id::text = choice.connection_id
  WHERE login.subject_id IS NOT NULL
), ranked AS (
  SELECT personal.*,
         row_number() OVER scope_order AS rank,
         bool_or(workspace_id <> home_workspace_id) OVER scope AS moving
  FROM personal
  WINDOW scope AS (
           PARTITION BY account_id, home_workspace_id, connection_id, server_id,
                        tool_name, action_name),
         scope_order AS (
           PARTITION BY account_id, home_workspace_id, connection_id, server_id,
                        tool_name, action_name
           ORDER BY CASE policy WHEN 'block' THEN 3 WHEN 'ask' THEN 2 ELSE 1 END DESC,
                    updated_at DESC, id)
)
UPDATE connector_action_policies home
SET policy = winner.policy,
    version = home.version + 1,
    updated_by_subject_id = winner.updated_by_subject_id,
    updated_at = now()
FROM ranked winner
WHERE winner.rank = 1
  AND winner.moving
  AND home.account_id = winner.account_id
  AND home.workspace_id = winner.home_workspace_id
  AND home.connection_id = winner.connection_id
  AND home.server_id = winner.server_id
  AND home.tool_name = winner.tool_name
  AND home.action_name = winner.action_name
  AND home.policy IS DISTINCT FROM winner.policy;

-- 2. Where it doesn't, the strictest copy moves there.
WITH personal AS (
  SELECT choice.id, choice.account_id, choice.workspace_id,
         login.workspace_id AS home_workspace_id, choice.connection_id,
         choice.server_id, choice.tool_name, choice.action_name, choice.policy,
         choice.updated_at
  FROM connector_action_policies choice
  JOIN connections login
    ON login.account_id = choice.account_id
   AND login.id::text = choice.connection_id
  WHERE login.subject_id IS NOT NULL
), ranked AS (
  SELECT personal.*,
         row_number() OVER (
           PARTITION BY account_id, home_workspace_id, connection_id, server_id,
                        tool_name, action_name
           ORDER BY CASE policy WHEN 'block' THEN 3 WHEN 'ask' THEN 2 ELSE 1 END DESC,
                    updated_at DESC, id) AS rank
  FROM personal
)
UPDATE connector_action_policies moved
SET workspace_id = winner.home_workspace_id,
    version = moved.version + 1,
    updated_at = now()
FROM ranked winner
WHERE winner.rank = 1
  AND winner.workspace_id <> winner.home_workspace_id
  AND moved.id = winner.id
  AND NOT EXISTS (
    SELECT 1 FROM connector_action_policies home
    WHERE home.account_id = winner.account_id
      AND home.workspace_id = winner.home_workspace_id
      AND home.connection_id = winner.connection_id
      AND home.server_id = winner.server_id
      AND home.tool_name = winner.tool_name
      AND home.action_name = winner.action_name);

-- 3. Every copy left away from the login's own workspace is now merged.
DELETE FROM connector_action_policies choice
USING connections login
WHERE login.account_id = choice.account_id
  AND login.id::text = choice.connection_id
  AND login.subject_id IS NOT NULL
  AND choice.workspace_id <> login.workspace_id;

ALTER TABLE "connector_action_policies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
