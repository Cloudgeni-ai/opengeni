-- deployment-mode: rolling
-- Project profiles. A project (a `channels` row) already has a description;
-- it now may also carry an avatar, the same display metadata a chat has
-- (1008): one emoji, icon or letters on a hue, or a workspace image. It is
-- shown to people in the sidebar instead of the folder icon and never reaches
-- a model's context. The column is nullable and additive: a previous binary
-- never names it, and its inserts leave it NULL.
SET LOCAL lock_timeout = '5s';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS avatar jsonb;
-- Every existing row is NULL, so the bound is added NOT VALID: it holds for
-- every new write without scanning the table under its lock.
ALTER TABLE channels ADD CONSTRAINT channels_avatar_bounds
  CHECK (avatar IS NULL OR (jsonb_typeof(avatar) = 'object' AND octet_length(avatar::text) <= 1024))
  NOT VALID;

-- The sidebar now shows a project's avatar and its description, so a change
-- to either must reach every open session list, as a rename does. Recreate
-- the list hint trigger over the shown columns; an older binary only receives
-- more hints, which it already handles.
DROP TRIGGER IF EXISTS channels_list_update ON channels;
CREATE TRIGGER channels_list_update
  AFTER UPDATE OF name, description, avatar, pinned, sort_order ON channels
  FOR EACH ROW
  WHEN (
    old.name IS DISTINCT FROM new.name
    OR old.description IS DISTINCT FROM new.description
    OR old.avatar IS DISTINCT FROM new.avatar
    OR old.pinned IS DISTINCT FROM new.pinned
    OR old.sort_order IS DISTINCT FROM new.sort_order
  )
  EXECUTE FUNCTION notify_session_list_change();
