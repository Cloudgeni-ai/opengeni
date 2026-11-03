-- deployment-mode: rolling
-- A meeting's audio is kept as one compact file per track (Opus at
-- 16 kbit/s in MP4) instead of its uploaded pieces plus a prepared copy at
-- the source's rate. Once that file is stored, the worker deletes the
-- track's uploaded pieces and stamps chunk_objects_deleted_at, so a re-run
-- builds from the kept file instead of from pieces that are gone. The chunk
-- rows stay: they still place the track on the recording's timeline.
--
-- opengeni_private.list_uncompacted_recording_tracks_v1(limit, kept suffix)
-- lists, across every workspace, finished meetings' audio tracks that a
-- worker already prepared but that are not compact yet: the prepared file's
-- key does not end in the kept format's suffix, or uploaded pieces are still
-- stored beside it. Meetings being captured, transcribed, deleted or past
-- their audio retention are left alone. Identity only, like
-- list_due_recording_retention_v1; the worker acts on each as its owner.
--
-- Rolling: the previous release never reads or writes the new column. Its
-- worker could still try to rebuild an old-format file from deleted pieces
-- during the rollout; that attempt fails and is retried by the new worker.
-- Runtime EXECUTE is withheld for one release (runtime-posture
-- DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release rejects a runtime
-- grant on a definer it does not know. Until a later migration grants it,
-- existing meetings stay as they are and new ones are kept compact.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE recording_tracks ADD COLUMN chunk_objects_deleted_at timestamptz;

CREATE FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(
  p_limit integer, p_kept_suffix text
) RETURNS TABLE(
  account_id uuid, workspace_id uuid, recording_id uuid, owner_subject_id text,
  track_number integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $uncompacted_tracks$
  SELECT recording.account_id, recording.workspace_id, recording.id,
    recording.owner_subject_id, track.track_number
  FROM recordings recording
  JOIN recording_tracks track
    ON track.workspace_id = recording.workspace_id
    AND track.recording_id = recording.id
  WHERE coalesce(pg_catalog.length(p_kept_suffix), 0) BETWEEN 1 AND 64
    AND recording.purpose = 'meeting'
    AND recording.state IN ('ready', 'failed')
    AND recording.audio_deleted_at IS NULL
    AND track.kind = 'audio'
    AND track.prepared_object_key IS NOT NULL
    AND (
      pg_catalog.right(track.prepared_object_key, pg_catalog.length(p_kept_suffix))
        <> p_kept_suffix
      OR (
        track.chunk_objects_deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM recording_chunks chunk
          WHERE chunk.workspace_id = track.workspace_id
            AND chunk.recording_id = track.recording_id
            AND chunk.track_number = track.track_number
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM recording_transcript_versions version
      WHERE version.workspace_id = recording.workspace_id
        AND version.recording_id = recording.id
        AND version.state IN ('queued', 'processing')
    )
  ORDER BY recording.started_at DESC, recording.id, track.track_number
  LIMIT greatest(1, least(coalesce(p_limit, 20), 200));
$uncompacted_tracks$;

REVOKE ALL ON FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(integer, text) FROM PUBLIC;

DO $uncompacted_tracks_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_uncompacted_recording_tracks_v1(integer, text) SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END $uncompacted_tracks_search_path$;
