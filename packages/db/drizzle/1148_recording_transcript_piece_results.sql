-- deployment-mode: rolling
-- A meeting transcript is asked for one piece of one track at a time, and a
-- provider bills each request. When the worker is lost after a piece came
-- back (a deploy replacing the pod, a crash during our own diarization),
-- the retry used to ask and pay again. Each piece's result is now kept with
-- its version until the version completes or fails, keyed by what was
-- asked (model, options, the piece and the audio's hash), so a retry reuses
-- it. Rows are removed with the version's completion or failure and cascade
-- with the version.
--
-- New table only: the previous release never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE recording_transcript_piece_results (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_id uuid NOT NULL,
  track_number integer NOT NULL,
  piece_index integer NOT NULL,
  request_key text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recording_transcript_piece_results_pkey
    PRIMARY KEY (version_id, track_number, piece_index),
  CONSTRAINT recording_transcript_piece_results_version_fk
    FOREIGN KEY (workspace_id, recording_id, version_id)
    REFERENCES recording_transcript_versions (workspace_id, recording_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_transcript_piece_results_values_chk CHECK (
    track_number >= 0
    AND piece_index >= 0
    AND request_key ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(result) = 'object'
  )
);
CREATE INDEX recording_transcript_piece_results_version_idx
  ON recording_transcript_piece_results (workspace_id, recording_id, version_id);

ALTER TABLE recording_transcript_piece_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_transcript_piece_results FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE recording_transcript_piece_results FROM PUBLIC;
CREATE POLICY workspace_isolation ON recording_transcript_piece_results
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $recording_piece_result_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recording_transcript_piece_results TO opengeni_app;
  END IF;
END
$recording_piece_result_grants$;
