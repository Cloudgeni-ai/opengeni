-- deployment-mode: rolling
-- An Only me meeting works where its owner turned it on
-- (docs/design/ownership-and-reach.md: a new Only me thing starts in the
-- workspace where it was added, plus its owner's Personal workspace).
--
-- recordings.reach_workspace_ids lists the owner's other workspaces of the
-- organization where their Only me meeting also works, besides the workspace
-- that stores it and their Personal workspace. NULL means every workspace the
-- owner belongs to, which is how every existing meeting worked, so existing
-- meetings keep exactly the reach they have. New meetings start with an empty
-- list. Shared (workspace) meetings never leave their workspace and ignore it.
--
-- Adds a nullable column, then a default for new rows: both are catalog-only.
-- Older binaries never read the column, and a meeting they create during the
-- rollout gets the narrow default.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS reach_workspace_ids uuid[];
ALTER TABLE recordings ALTER COLUMN reach_workspace_ids SET DEFAULT '{}'::uuid[];
