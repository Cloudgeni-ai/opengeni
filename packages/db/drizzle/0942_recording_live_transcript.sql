-- deployment-mode: rolling
-- A live transcript while recording. The recorder streams each track to a
-- live speech model and saves the finished stretches of text here, so every
-- device viewing the meeting sees them. The text is a preview: it is removed
-- once the recording's first transcript is ready. Each track also keeps which
-- live model it streamed to and how much audio, for the cost estimate.
ALTER TABLE recording_tracks
  ADD COLUMN live_provider_id text,
  ADD COLUMN live_model text,
  ADD COLUMN live_streamed_milliseconds integer NOT NULL DEFAULT 0,
  ADD COLUMN live_cost_usd_micros bigint;

CREATE TABLE recording_live_segments (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  track_number integer NOT NULL,
  segment_number integer NOT NULL,
  start_milliseconds integer NOT NULL,
  end_milliseconds integer NOT NULL,
  text text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, track_number, segment_number),
  CONSTRAINT recording_live_segments_track_fk FOREIGN KEY (workspace_id, recording_id, track_number)
    REFERENCES recording_tracks(workspace_id, recording_id, track_number) ON DELETE CASCADE,
  CONSTRAINT recording_live_segments_values_chk CHECK (
    segment_number >= 0
    AND start_milliseconds >= 0
    AND end_milliseconds >= start_milliseconds
    AND octet_length(text) <= 65536
  )
);
CREATE INDEX recording_live_segments_sequence_idx
  ON recording_live_segments (workspace_id, recording_id, sequence);

-- Visible exactly where its recording is, like the other recording tables.
ALTER TABLE recording_live_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_live_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON recording_live_segments
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_live_segments.workspace_id
        AND parent.id = recording_live_segments.recording_id
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_live_segments.workspace_id
        AND parent.id = recording_live_segments.recording_id
    )
  );

DO $recording_live_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recording_live_segments TO opengeni_app;
  END IF;
END
$recording_live_grants$;
