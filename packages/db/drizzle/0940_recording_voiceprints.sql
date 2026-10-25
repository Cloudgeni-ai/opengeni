-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the check covers three columns this same statement adds, so every existing row is null and passes, and recording_people holds a directory of names per workspace, so validating it under the same lock is instant
-- Opt-in voice recognition for meeting recordings. A workspace turns it on
-- in settings.recordings.voiceprints; people then agree, one by one, to have
-- their voice remembered (members for themselves, someone attesting for a
-- person outside the workspace). Only numbers are stored, never audio.
ALTER TABLE recording_people
  ADD COLUMN voice_consent text,
  ADD COLUMN voice_consent_by_subject_id text,
  ADD COLUMN voice_consented_at timestamptz,
  ADD CONSTRAINT recording_people_voice_consent_chk CHECK (
    (voice_consent IS NULL AND voice_consent_by_subject_id IS NULL AND voice_consented_at IS NULL)
    OR (
      voice_consent IN ('self', 'attested')
      AND octet_length(voice_consent_by_subject_id) BETWEEN 1 AND 1024
      AND voice_consented_at IS NOT NULL
    )
  );

-- A remembered voice: the running mean of a person's confirmed speaker
-- vectors, kept apart per kind of audio (close microphone, call audio, a
-- room) and per speaker model, since vectors from different models or very
-- different audio do not compare well.
CREATE TABLE recording_voiceprints (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  person_id uuid NOT NULL,
  channel text NOT NULL,
  model text NOT NULL,
  embedding real[] NOT NULL,
  speech_milliseconds bigint NOT NULL DEFAULT 0,
  sample_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, person_id, channel, model),
  CONSTRAINT recording_voiceprints_person_fk FOREIGN KEY (workspace_id, person_id)
    REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_voiceprints_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT recording_voiceprints_values_chk CHECK (
    channel IN ('microphone', 'call', 'room')
    AND octet_length(model) BETWEEN 1 AND 128
    AND cardinality(embedding) BETWEEN 1 AND 1024
    AND speech_milliseconds >= 0
    AND sample_count >= 0
  )
);

-- Each diarized speaker's voice vector in a version, kept only while the
-- workspace recognizes voices. Confirming who a speaker is teaches that
-- person's voiceprint from it. Deleted with the version.
CREATE TABLE recording_speaker_voices (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_id uuid NOT NULL,
  speaker_label text NOT NULL,
  channel text NOT NULL,
  model text NOT NULL,
  embedding real[] NOT NULL,
  speech_milliseconds integer NOT NULL,
  -- Whose voiceprint this voice taught, so renaming the speaker can take it
  -- back out.
  learned_person_id uuid,
  PRIMARY KEY (version_id, speaker_label),
  CONSTRAINT recording_speaker_voices_version_fk FOREIGN KEY (workspace_id, recording_id, version_id)
    REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_speaker_voices_values_chk CHECK (
    octet_length(speaker_label) BETWEEN 1 AND 128
    AND channel IN ('microphone', 'call', 'room')
    AND octet_length(model) BETWEEN 1 AND 128
    AND cardinality(embedding) BETWEEN 1 AND 1024
    AND speech_milliseconds >= 0
  )
);
CREATE INDEX recording_speaker_voices_recording_idx
  ON recording_speaker_voices (workspace_id, recording_id);

-- "Not them": a voice suggestion someone turned down. The person is not
-- suggested again for a similar voice in the same recording, including in
-- later transcript versions.
CREATE TABLE recording_voice_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  person_id uuid NOT NULL,
  model text NOT NULL,
  embedding real[] NOT NULL,
  rejected_by_subject_id text NOT NULL,
  rejected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recording_voice_rejections_recording_fk FOREIGN KEY (workspace_id, recording_id)
    REFERENCES recordings(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_voice_rejections_person_fk FOREIGN KEY (workspace_id, person_id)
    REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_voice_rejections_values_chk CHECK (
    octet_length(model) BETWEEN 1 AND 128
    AND cardinality(embedding) BETWEEN 1 AND 1024
    AND octet_length(rejected_by_subject_id) BETWEEN 1 AND 1024
  )
);
CREATE INDEX recording_voice_rejections_recording_idx
  ON recording_voice_rejections (workspace_id, recording_id, person_id);

-- Workspace-scoped like recording_people, not per recording: the API never
-- returns these vectors, and turning recognition off must forget every one,
-- including those from recordings the person turning it off cannot see.
DO $recording_voice_policies$
DECLARE
  voice_table text;
BEGIN
  FOREACH voice_table IN ARRAY ARRAY[
    'recording_voiceprints', 'recording_speaker_voices', 'recording_voice_rejections'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', voice_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', voice_table);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
        || 'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
        || 'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      voice_table
    );
  END LOOP;
END
$recording_voice_policies$;

DO $recording_voice_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      recording_voiceprints, recording_speaker_voices, recording_voice_rejections
    TO opengeni_app;
  END IF;
END
$recording_voice_grants$;
