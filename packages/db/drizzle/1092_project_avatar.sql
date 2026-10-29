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
