-- deployment-mode: rolling
-- Recording retention. A workspace may keep a meeting's audio, or the whole
-- meeting, for a set number of days after it was recorded
-- (settings.recordings.retention.audioDays and .transcriptDays). When the
-- audio period passes, the worker stamps audio_deleted_at, deletes the
-- audio objects, then drops the chunk rows and prepared-audio pointers; the
-- transcript stays, but nothing can be played or transcribed again. A
-- stamped meeting that still has either is offered again, so an
-- interrupted pass finishes later. When the transcript period passes, the worker deletes
-- the meeting as a person deleting it would.
--
-- opengeni_private.list_due_recording_retention_v1 is the cross-workspace
-- inventory for that sweep: identity only, SECURITY DEFINER, owned by the
-- tables' owner and never PUBLIC. As 0937 explains, the previous release
-- rejects a runtime EXECUTE grant on a definer it doesn't know, so this
-- migration grants nothing; the sweep skips its pass until a later
-- migration grants EXECUTE. FORCE RLS binds the definer too: recordings
-- and recording_transcript_versions already carry owner-only policies
-- (0939), and recording_tracks and recording_chunks get the same here;
-- workspaces is not FORCE RLS. The runtime role is never the owner.
ALTER TABLE recordings ADD COLUMN audio_deleted_at timestamptz;

DO $recording_retention_owner_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['recording_tracks', 'recording_chunks'] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY recording_maintenance_owner ON %1$I '
        || 'USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass)) '
        || 'WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass))',
      table_name
    );
  END LOOP;
END $recording_retention_owner_policies$;

CREATE FUNCTION opengeni_private.list_due_recording_retention_v1(p_limit integer)
RETURNS TABLE (
  kind text,
  account_id uuid,
  workspace_id uuid,
  recording_id uuid,
  owner_subject_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $list_due_recording_retention$
  WITH retention AS (
    SELECT workspace.id AS workspace_id,
      CASE WHEN pg_catalog.jsonb_typeof(workspace.settings #> '{recordings,retention,audioDays}') = 'number'
        THEN least(greatest(floor((workspace.settings #>> '{recordings,retention,audioDays}')::numeric), 0), 36500)::integer
      END AS audio_days,
      CASE WHEN pg_catalog.jsonb_typeof(workspace.settings #> '{recordings,retention,transcriptDays}') = 'number'
        THEN least(greatest(floor((workspace.settings #>> '{recordings,retention,transcriptDays}')::numeric), 1), 36500)::integer
      END AS transcript_days
    FROM workspaces workspace
    WHERE pg_catalog.jsonb_typeof(workspace.settings #> '{recordings,retention}') = 'object'
  )
  (
    SELECT 'recording', recording.account_id, recording.workspace_id, recording.id,
      recording.owner_subject_id
    FROM retention
    JOIN recordings recording ON recording.workspace_id = retention.workspace_id
    WHERE retention.transcript_days IS NOT NULL
      AND recording.purpose = 'meeting'
      AND recording.state IN ('ready', 'failed')
      AND coalesce(recording.capture_ended_at, recording.started_at)
        < pg_catalog.now() - pg_catalog.make_interval(days => retention.transcript_days)
    ORDER BY recording.started_at, recording.id
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  )
  UNION ALL
  (
    SELECT 'audio', recording.account_id, recording.workspace_id, recording.id,
      recording.owner_subject_id
    FROM retention
    JOIN recordings recording ON recording.workspace_id = retention.workspace_id
    WHERE retention.audio_days IS NOT NULL
      AND recording.purpose = 'meeting'
      AND recording.state IN ('ready', 'failed')
      AND (
        (
          recording.audio_deleted_at IS NULL
          AND coalesce(recording.capture_ended_at, recording.started_at)
            < pg_catalog.now() - pg_catalog.make_interval(days => retention.audio_days)
          AND NOT EXISTS (
            SELECT 1 FROM recording_transcript_versions version
            WHERE version.workspace_id = recording.workspace_id
              AND version.recording_id = recording.id
              AND version.state IN ('queued', 'processing')
          )
        )
        -- Stamped, but the worker stopped before every object was gone.
        OR (
          recording.audio_deleted_at IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM recording_chunks chunk
              WHERE chunk.workspace_id = recording.workspace_id
                AND chunk.recording_id = recording.id
            )
            OR EXISTS (
              SELECT 1 FROM recording_tracks track
              WHERE track.workspace_id = recording.workspace_id
                AND track.recording_id = recording.id
                AND track.prepared_object_key IS NOT NULL
            )
          )
        )
      )
    ORDER BY recording.started_at, recording.id
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  );
$list_due_recording_retention$;
REVOKE ALL ON FUNCTION opengeni_private.list_due_recording_retention_v1(integer) FROM PUBLIC;
