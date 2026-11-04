-- deployment-mode: rolling
-- Who turned an MCP server on in a workspace. A member (connections:write)
-- removes a custom MCP server they added themselves; one an admin or another
-- person turned on, or one with no recorded installer, is removed only by
-- integration admins (capabilities:manage). The person whose enable creates
-- or changes an installation is recorded; turning one off keeps the column.
--
-- Rolling: the column is nullable and additive, and existing rows get NULL,
-- which counts as installed by an admin. The previous release never reads it,
-- leaves it NULL on the rows it creates (which only keeps them with admins)
-- and leaves it unchanged on the rows it updates.
SET LOCAL lock_timeout = '5s';

ALTER TABLE capability_installations ADD COLUMN IF NOT EXISTS installed_by_subject_id text;
