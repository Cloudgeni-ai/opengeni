-- deployment-mode: rolling
-- Group routes use personal=false/channel_id=NULL, which older binaries refuse.
-- No existing route or session changes audience. New routes start inactive unless
-- the authenticated ingress has verified the complete group membership.
SET LOCAL lock_timeout = '5s';
ALTER TABLE teams_bot_routes ADD COLUMN group_audience jsonb;
ALTER TABLE teams_bot_routes ADD COLUMN group_active boolean NOT NULL DEFAULT false;
ALTER TABLE teams_bot_routes ADD CONSTRAINT teams_bot_routes_group_audience_check
  CHECK (group_audience IS NULL OR
    (NOT personal AND channel_id IS NULL AND thread_id IS NULL
      AND jsonb_typeof(group_audience) = 'array'
      AND jsonb_array_length(group_audience) BETWEEN 1 AND 250)) NOT VALID;
ALTER TABLE teams_bot_installations ADD COLUMN group_revision bigint NOT NULL DEFAULT 0;
