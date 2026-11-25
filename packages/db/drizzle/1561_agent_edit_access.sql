-- deployment-mode: rolling
-- Who can edit a shared agent (docs/agents.md, "Who can edit"):
--
-- - edit_access: `creator_and_admins` (whoever made it, or an admin of its
--   workspace, the rule until now) or `everyone` (anyone in its workspace who
--   can start chats there). Only meaningful on a shared agent; an Only me
--   agent is only ever its owner's. Changing who can use or edit an agent,
--   and deleting it, stay with its creator and admins either way.
--
-- Existing agents keep today's rule through the column default. New agents
-- are written with `everyone` by this release. Rolling: the previous release
-- never reads or writes the column and its inserts get the default, which
-- is its own rule. No backfill. Values are validated by the API; any other
-- value reads as `creator_and_admins`.
SET LOCAL lock_timeout = '5s';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS edit_access text NOT NULL DEFAULT 'creator_and_admins';
