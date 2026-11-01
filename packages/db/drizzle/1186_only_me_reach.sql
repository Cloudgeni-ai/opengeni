-- deployment-mode: rolling
-- A person's Only me meetings and files work where they turned them on
-- (docs/design/ownership-and-reach.md: a new Only me thing starts in the
-- workspace where it was added, plus its owner's Personal workspace).
--
-- recordings.reach_workspace_ids and files.reach_workspace_ids list the
-- owner's other workspaces of the organization where their Only me meeting or
-- file also works, besides the workspace that stores it and their Personal
-- workspace. NULL means every workspace: a meeting reaches every workspace the
-- owner belongs to, and a file every workspace of the organization, which is
-- how each worked so far, so existing rows keep exactly the reach they have.
-- New rows start with an empty list. Shared (workspace) meetings and files
-- never leave their workspace and ignore it.
--
-- Adds nullable columns, then defaults for new rows: all catalog-only. Older
-- binaries never read the columns, and a meeting or file they create during
-- the rollout gets the narrow default.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS reach_workspace_ids uuid[];
ALTER TABLE recordings ALTER COLUMN reach_workspace_ids SET DEFAULT '{}'::uuid[];

ALTER TABLE files ADD COLUMN IF NOT EXISTS reach_workspace_ids uuid[];
ALTER TABLE files ALTER COLUMN reach_workspace_ids SET DEFAULT '{}'::uuid[];
