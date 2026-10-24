-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: recording_tracks holds a few rows per recording and recordings are new, so validating in this file is instant.
-- Browser recordings move onto the recordings resource. An agent's browser
-- recording becomes a recording whose purpose is "browser", with one video
-- track from the browser tab. Its one chunk is the frame bundle the browser
-- host uploads; the worker encodes it into the track's prepared MP4, beside
-- an action log. Meeting lists keep showing meetings only.
-- error_code and error_message say why a browser recording's video could
-- not be made.
ALTER TABLE recordings
  ADD COLUMN purpose text NOT NULL DEFAULT 'meeting',
  ADD COLUMN error_code text,
  ADD COLUMN error_message text;
ALTER TABLE recordings ADD CONSTRAINT recordings_purpose_chk
  CHECK (
    purpose IN ('meeting', 'browser')
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 128)
    AND (error_message IS NULL OR octet_length(error_message) BETWEEN 1 AND 2048)
  ) NOT VALID;
ALTER TABLE recordings VALIDATE CONSTRAINT recordings_purpose_chk;

-- A prepared file's digest, so it can be copied elsewhere with its integrity
-- checked, and a video track's picture size and frame count.
ALTER TABLE recording_tracks
  ADD COLUMN prepared_sha256 text,
  ADD COLUMN video_width integer,
  ADD COLUMN video_height integer,
  ADD COLUMN video_frame_count integer;

ALTER TABLE recording_tracks DROP CONSTRAINT recording_tracks_kind_chk;
ALTER TABLE recording_tracks ADD CONSTRAINT recording_tracks_kind_chk
  CHECK (kind IN ('audio', 'video')) NOT VALID;
ALTER TABLE recording_tracks VALIDATE CONSTRAINT recording_tracks_kind_chk;

ALTER TABLE recording_tracks DROP CONSTRAINT recording_tracks_source_chk;
ALTER TABLE recording_tracks ADD CONSTRAINT recording_tracks_source_chk
  CHECK (source IN ('microphone', 'system', 'mixed', 'upload', 'browser_tab')) NOT VALID;
ALTER TABLE recording_tracks VALIDATE CONSTRAINT recording_tracks_source_chk;

ALTER TABLE recording_tracks ADD CONSTRAINT recording_tracks_video_chk CHECK (
  (prepared_sha256 IS NULL OR prepared_sha256 ~ '^[0-9a-f]{64}$')
  AND (video_width IS NULL OR video_width BETWEEN 1 AND 100000)
  AND (video_height IS NULL OR video_height BETWEEN 1 AND 100000)
  AND (video_frame_count IS NULL OR video_frame_count >= 1)
  AND (kind = 'video' OR (video_width IS NULL AND video_height IS NULL AND video_frame_count IS NULL))
) NOT VALID;
ALTER TABLE recording_tracks VALIDATE CONSTRAINT recording_tracks_video_chk;
