-- deployment-mode: rolling
-- Owners and admins can turn Personal workspaces off for their organization.
-- Off means people no longer see or start new work in their Personal
-- workspace; the workspace itself stays, because it anchors the person's own
-- machines, browsers and vaults, and their existing chats there stay readable.
-- A missing row, and the default, mean on: the behavior before this column.
-- The previous release never reads the column and inserts take the default.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "organization_privacy_preferences"
  ADD COLUMN "personal_workspaces_enabled" boolean NOT NULL DEFAULT true;
