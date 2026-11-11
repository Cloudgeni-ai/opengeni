-- deployment-mode: rolling
-- An organization's owners and admins choose whether members may connect
-- their own machines (Only me machines) to it (docs/design/ownership-and-reach.md:
-- "who may add" per kind). On, the default, keeps today's behavior for every
-- organization. Off: only the organization's owners and admins connect new
-- machines of their own; machines already connected keep working, and
-- workspace and organization machines keep their own rules.
--
-- The previous release names its columns when it reads and writes these
-- preferences, so it ignores the new column and leaves it unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_privacy_preferences
  ADD COLUMN members_connect_own_machines boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN organization_privacy_preferences.members_connect_own_machines IS 'Whether members may connect new machines of their own (Only me machines). Off: only owners and admins can; machines already connected keep working.';
