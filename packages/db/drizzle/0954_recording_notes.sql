-- deployment-mode: rolling
-- Notes on a meeting, as Markdown. Two per recording: the notepad, what
-- people jot down while it is recorded, and the notes, the meeting's
-- written-up summary, decisions and action items, which a person or an
-- agent writes afterwards. Anyone who can see the meeting can read and edit
-- them, like its title and speakers. Each save bumps the revision, so a save
-- made against an older revision is refused instead of overwriting.
CREATE TABLE recording_notes (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by_subject_id text NOT NULL,
  updated_by_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, kind),
  CONSTRAINT recording_notes_recording_fk FOREIGN KEY (workspace_id, recording_id)
    REFERENCES recordings(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_notes_kind_chk CHECK (kind IN ('notepad', 'notes')),
  CONSTRAINT recording_notes_values_chk CHECK (
    octet_length(body) <= 262144
    AND revision >= 1
    AND octet_length(updated_by_subject_id) BETWEEN 1 AND 1024
  )
);
CREATE INDEX recording_notes_workspace_idx ON recording_notes (workspace_id, recording_id);

-- Visible exactly where its recording is, like the other recording tables.
ALTER TABLE recording_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON recording_notes
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_notes.workspace_id
        AND parent.id = recording_notes.recording_id
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM recordings parent
      WHERE parent.workspace_id = recording_notes.workspace_id
        AND parent.id = recording_notes.recording_id
    )
  );

DO $recording_notes_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recording_notes TO opengeni_app;
  END IF;
END
$recording_notes_grants$;

-- Saving the notes is an event webhooks and automations can follow. Old
-- binaries never write it, so the wider check is safe before they are gone.
ALTER TABLE recording_events DROP CONSTRAINT recording_events_type_chk;
ALTER TABLE recording_events ADD CONSTRAINT recording_events_type_chk CHECK (type IN (
  'recording.started', 'recording.finished', 'recording.transcript.ready',
  'recording.transcript.failed', 'recording.transcript.current_changed',
  'recording.speakers.updated', 'recording.notes.updated', 'recording.deleted'
)) NOT VALID;
ALTER TABLE recording_events VALIDATE CONSTRAINT recording_events_type_chk;
