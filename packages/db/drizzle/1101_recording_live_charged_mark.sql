-- deployment-mode: rolling
-- How far a track's live transcript audio is charged in credits. Each save of
-- live text charges from this mark to the track's stored streamed total and
-- moves the mark only once the charge is durable, so a failed charge is
-- charged again by the next save instead of being lost. A nullable column
-- without default or check is a catalog-only change; the previous release
-- never reads or writes it, and null means nothing was charged yet (charging
-- starts at the streamed total the first charged save finds).
SET LOCAL lock_timeout = '5s';

ALTER TABLE recording_tracks
  ADD COLUMN IF NOT EXISTS live_charged_milliseconds integer;
COMMENT ON COLUMN recording_tracks.live_charged_milliseconds IS
  'Streamed live transcript audio already charged in credits, in milliseconds. Null when none was charged.';
