-- deployment-mode: rolling
-- Recordings: captured conversations (meetings, interviews, site walks) with
-- audio tracks uploaded straight to object storage, versioned transcripts,
-- speaker assignments and a recording event log. New tables only, owned by
-- new code; the webhook event-type checks widen to the recording events.

CREATE TABLE recordings (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  visibility text NOT NULL DEFAULT 'user_private',
  title text NOT NULL,
  state text NOT NULL DEFAULT 'capturing',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  capture_ended_at timestamptz,
  duration_milliseconds integer NOT NULL DEFAULT 0,
  external_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  transcription jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recordings_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT recordings_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT recordings_visibility_chk CHECK (visibility IN ('user_private', 'workspace_shared')),
  -- `deleting`: hidden from every read while a workflow removes its media,
  -- then its rows.
  CONSTRAINT recordings_state_chk
    CHECK (state IN ('capturing', 'processing', 'ready', 'failed', 'deleting')),
  CONSTRAINT recordings_values_chk CHECK (
    octet_length(owner_subject_id) BETWEEN 1 AND 1024
    AND char_length(title) BETWEEN 1 AND 300
    AND duration_milliseconds >= 0
    AND (external_ref IS NULL OR octet_length(external_ref) BETWEEN 1 AND 512)
    AND jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 16384
    AND jsonb_typeof(transcription) = 'object'
    AND octet_length(transcription::text) <= 16384
    AND (state = 'capturing') = (capture_ended_at IS NULL)
  )
);
CREATE INDEX recordings_started_idx ON recordings (workspace_id, started_at DESC, id);
CREATE INDEX recordings_external_ref_idx ON recordings (workspace_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- One media stream: the microphone, the computer's audio, or one mixed or
-- uploaded stream. Video and screen tracks are later kinds of the same row.
CREATE TABLE recording_tracks (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  track_number integer NOT NULL,
  kind text NOT NULL DEFAULT 'audio',
  source text NOT NULL,
  mime_type text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  duration_milliseconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (recording_id, track_number),
  CONSTRAINT recording_tracks_workspace_uq UNIQUE (workspace_id, recording_id, track_number),
  CONSTRAINT recording_tracks_recording_fk FOREIGN KEY (workspace_id, recording_id)
    REFERENCES recordings(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_tracks_kind_chk CHECK (kind IN ('audio')),
  CONSTRAINT recording_tracks_source_chk CHECK (source IN ('microphone', 'system', 'mixed', 'upload')),
  CONSTRAINT recording_tracks_values_chk CHECK (
    track_number BETWEEN 0 AND 7
    AND octet_length(mime_type) BETWEEN 1 AND 128
    AND chunk_count >= 0
    AND total_bytes >= 0
    AND duration_milliseconds >= 0
  )
);

-- Clients upload each chunk straight to object storage with a presigned URL
-- bound to its SHA-256, then confirm it. Chunks of one track concatenate into
-- the track's media file.
CREATE TABLE recording_chunks (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  track_number integer NOT NULL,
  chunk_number integer NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  start_milliseconds integer NOT NULL,
  duration_milliseconds integer NOT NULL,
  object_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  uploaded_at timestamptz,
  PRIMARY KEY (recording_id, track_number, chunk_number),
  CONSTRAINT recording_chunks_object_key_uq UNIQUE (object_key),
  CONSTRAINT recording_chunks_track_fk FOREIGN KEY (workspace_id, recording_id, track_number)
    REFERENCES recording_tracks(workspace_id, recording_id, track_number) ON DELETE CASCADE,
  CONSTRAINT recording_chunks_values_chk CHECK (
    chunk_number BETWEEN 0 AND 100000
    AND byte_length > 0
    AND sha256 ~ '^[0-9a-f]{64}$'
    AND start_milliseconds >= 0
    AND duration_milliseconds >= 0
    AND octet_length(object_key) BETWEEN 1 AND 1024
    AND (
      (state = 'pending' AND uploaded_at IS NULL)
      OR (state = 'uploaded' AND uploaded_at IS NOT NULL)
    )
  )
);

-- One transcription run over the recording's audio. Versions are immutable
-- once complete; exactly one complete version is current.
CREATE TABLE recording_transcript_versions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_number integer NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued',
  is_current boolean NOT NULL DEFAULT false,
  languages text[] NOT NULL DEFAULT '{}',
  diarized boolean NOT NULL DEFAULT false,
  audio_milliseconds integer NOT NULL DEFAULT 0,
  segment_count integer NOT NULL DEFAULT 0,
  requested_by_subject_id text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  processing_owner uuid,
  processing_started_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT recording_transcript_versions_workspace_uq UNIQUE (workspace_id, recording_id, id),
  CONSTRAINT recording_transcript_versions_number_uq UNIQUE (recording_id, version_number),
  CONSTRAINT recording_transcript_versions_recording_fk FOREIGN KEY (workspace_id, recording_id)
    REFERENCES recordings(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_transcript_versions_state_chk
    CHECK (state IN ('queued', 'processing', 'complete', 'failed')),
  CONSTRAINT recording_transcript_versions_values_chk CHECK (
    version_number >= 1
    AND octet_length(provider_id) BETWEEN 1 AND 128
    AND octet_length(model) BETWEEN 1 AND 128
    AND jsonb_typeof(options) = 'object'
    AND octet_length(options::text) <= 16384
    AND cardinality(languages) <= 16
    AND audio_milliseconds >= 0
    AND segment_count >= 0
    AND attempt_count >= 0
    AND octet_length(requested_by_subject_id) BETWEEN 1 AND 1024
    AND (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 128)
    AND (processing_owner IS NULL) = (processing_started_at IS NULL)
    AND (NOT is_current OR state = 'complete')
    AND ((state IN ('complete', 'failed')) = (completed_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX recording_transcript_versions_current_uq
  ON recording_transcript_versions (recording_id) WHERE is_current;

-- A stretch of speech in one version. `speaker_label` is the anonymous label
-- the model or the track produced inside this version.
CREATE TABLE recording_transcript_segments (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_id uuid NOT NULL,
  segment_index integer NOT NULL,
  start_milliseconds integer NOT NULL,
  end_milliseconds integer NOT NULL,
  track_number integer,
  speaker_label text,
  text text NOT NULL,
  words jsonb,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (version_id, segment_index),
  CONSTRAINT recording_transcript_segments_version_fk FOREIGN KEY (workspace_id, recording_id, version_id)
    REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_transcript_segments_values_chk CHECK (
    segment_index >= 0
    AND start_milliseconds >= 0
    AND end_milliseconds >= start_milliseconds
    AND (track_number IS NULL OR track_number BETWEEN 0 AND 7)
    AND (speaker_label IS NULL OR octet_length(speaker_label) BETWEEN 1 AND 128)
    AND octet_length(text) <= 65536
    AND (words IS NULL OR jsonb_typeof(words) = 'array')
  )
);
CREATE INDEX recording_transcript_segments_search_idx
  ON recording_transcript_segments USING gin (search);
CREATE INDEX recording_transcript_segments_recording_idx
  ON recording_transcript_segments (workspace_id, recording_id);

-- Speakers who appear in a workspace's recordings: members or external
-- contacts. Products may key their own contacts with `external_ref`.
CREATE TABLE recording_people (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  display_name text NOT NULL,
  member_subject_id text,
  email text,
  external_ref text,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recording_people_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT recording_people_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT recording_people_values_chk CHECK (
    char_length(btrim(display_name)) BETWEEN 1 AND 200
    AND (member_subject_id IS NULL OR octet_length(member_subject_id) BETWEEN 1 AND 1024)
    AND (email IS NULL OR octet_length(email) BETWEEN 3 AND 320)
    AND (external_ref IS NULL OR octet_length(external_ref) BETWEEN 1 AND 512)
    AND octet_length(created_by_subject_id) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX recording_people_member_uq
  ON recording_people (workspace_id, member_subject_id) WHERE member_subject_id IS NOT NULL;
CREATE UNIQUE INDEX recording_people_external_ref_uq
  ON recording_people (workspace_id, external_ref) WHERE external_ref IS NOT NULL;

-- Who a version's speaker label is: a person in the directory, or a plain
-- name. `source` says whether a person confirmed it, voice matching
-- suggested it, or it carried over from an earlier version.
CREATE TABLE recording_speaker_assignments (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_id uuid NOT NULL,
  speaker_label text NOT NULL,
  person_id uuid,
  display_name text,
  source text NOT NULL,
  confidence real,
  assigned_by_subject_id text,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, speaker_label),
  CONSTRAINT recording_speaker_assignments_version_fk FOREIGN KEY (workspace_id, recording_id, version_id)
    REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_speaker_assignments_person_fk FOREIGN KEY (workspace_id, person_id)
    REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_speaker_assignments_source_chk
    CHECK (source IN ('confirmed', 'suggested', 'carried_over', 'track')),
  CONSTRAINT recording_speaker_assignments_values_chk CHECK (
    octet_length(speaker_label) BETWEEN 1 AND 128
    AND (person_id IS NOT NULL OR display_name IS NOT NULL)
    AND (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 200)
    AND (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
    AND (assigned_by_subject_id IS NULL OR octet_length(assigned_by_subject_id) BETWEEN 1 AND 1024)
  )
);
CREATE INDEX recording_speaker_assignments_person_idx
  ON recording_speaker_assignments (workspace_id, person_id) WHERE person_id IS NOT NULL;

-- A human moving one segment to another label (splitting a label that
-- covered two people). Layered on the immutable version.
CREATE TABLE recording_segment_speaker_overrides (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  version_id uuid NOT NULL,
  segment_index integer NOT NULL,
  speaker_label text NOT NULL,
  assigned_by_subject_id text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, segment_index),
  CONSTRAINT recording_segment_speaker_overrides_version_fk FOREIGN KEY (workspace_id, recording_id, version_id)
    REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE,
  CONSTRAINT recording_segment_speaker_overrides_values_chk CHECK (
    segment_index >= 0
    AND octet_length(speaker_label) BETWEEN 1 AND 128
    AND octet_length(assigned_by_subject_id) BETWEEN 1 AND 1024
  )
);

-- Append-only recording lifecycle facts. They outlive the recording (a
-- deletion is itself an event) and feed webhooks and, later, automations.
-- Payloads carry ids and metadata, never audio or transcript text.
CREATE TABLE recording_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  visibility text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recording_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT recording_events_visibility_chk CHECK (visibility IN ('user_private', 'workspace_shared')),
  CONSTRAINT recording_events_type_chk CHECK (type IN (
    'recording.finished', 'recording.transcript.ready', 'recording.transcript.failed',
    'recording.deleted'
  )),
  CONSTRAINT recording_events_values_chk CHECK (
    octet_length(owner_subject_id) BETWEEN 1 AND 1024
    AND jsonb_typeof(data) = 'object'
    AND octet_length(data::text) <= 16384
  )
);
CREATE INDEX recording_events_workspace_idx ON recording_events (workspace_id, occurred_at, id);
CREATE INDEX recording_events_recording_idx ON recording_events (workspace_id, recording_id);

-- Recording events fan out to workspace webhooks as the inserting role, like
-- session events. The payload carries ids and states only, never a title,
-- audio or transcript text.
CREATE FUNCTION opengeni_private.enqueue_recording_event_workspace_webhooks_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $enqueue_recording_event_workspace_webhooks$
BEGIN
  BEGIN
    INSERT INTO workspace_webhook_deliveries (account_id, workspace_id, webhook_id, event_id, event_type, payload)
    SELECT webhook.account_id, webhook.workspace_id, webhook.id, NEW.id, NEW.type,
      jsonb_build_object(
        'id', NEW.id, 'type', NEW.type, 'lane', 'workspace', 'workspaceId', NEW.workspace_id,
        'workspace', jsonb_build_object('id', workspace.id, 'externalSource', workspace.external_source,
          'externalId', workspace.external_id),
        'occurredAt', to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'data', NEW.data
      )
    FROM workspace_webhooks webhook
    JOIN workspaces workspace ON workspace.id = NEW.workspace_id AND workspace.account_id = NEW.account_id
    WHERE webhook.account_id = NEW.account_id AND webhook.workspace_id = NEW.workspace_id
      AND webhook.enabled AND NEW.type = ANY(webhook.event_types)
    ON CONFLICT (webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'recording webhook enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$enqueue_recording_event_workspace_webhooks$;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_recording_event_workspace_webhooks_v1() FROM PUBLIC;

CREATE TRIGGER recording_events_workspace_webhook_enqueue_v1
AFTER INSERT ON recording_events
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enqueue_recording_event_workspace_webhooks_v1();

-- The organization lane cannot be read from a workspace transaction, so it
-- keeps its one owner-run fan-out. Its body gains a branch for recording
-- events; the session-event branch is unchanged from 0546.
CREATE OR REPLACE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $enqueue$
DECLARE previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  BEGIN
    IF NEW.account_id IS NULL OR NEW.workspace_id IS NULL
      OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
      OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
      OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND account_id = NEW.account_id)
      OR get_workspace_kind(NEW.account_id, NEW.workspace_id) <> 'shared'
    THEN RETURN NULL; END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
    IF EXISTS (SELECT 1 FROM organization_memberships
      WHERE account_id = NEW.account_id AND personal_workspace_id = NEW.workspace_id)
    THEN
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
      RETURN NULL;
    END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
    IF TG_TABLE_NAME = 'recording_events' THEN
      INSERT INTO organization_webhook_deliveries(account_id, workspace_id, webhook_id, event_id, event_type, payload)
        SELECT webhook.account_id, NEW.workspace_id, webhook.id, NEW.id, NEW.type,
          jsonb_build_object(
            'id', NEW.id, 'type', NEW.type, 'lane', 'organization', 'workspaceId', NEW.workspace_id,
            'workspace', jsonb_build_object('id', workspace.id, 'externalSource', workspace.external_source,
              'externalId', workspace.external_id),
            'occurredAt', to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'data', NEW.data
          )
        FROM (
          SELECT registration.* FROM organization_webhooks registration
          WHERE registration.account_id = NEW.account_id AND registration.enabled
            AND NEW.type = ANY(registration.event_types)
          ORDER BY registration.created_at, registration.id LIMIT 10
        ) webhook
        JOIN workspaces workspace ON workspace.id = NEW.workspace_id AND workspace.account_id = webhook.account_id
        WHERE webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source
        ON CONFLICT(webhook_id, event_id) DO NOTHING;
      RETURN NULL;
    END IF;
    INSERT INTO organization_webhook_deliveries(account_id, workspace_id, webhook_id, event_id, event_type, payload)
      SELECT webhook.account_id, NEW.workspace_id, webhook.id, NEW.id, NEW.type,
        opengeni_private.integration_webhook_payload_v1(
          NEW.account_id, NEW.workspace_id, NEW.id, NEW.type, NEW.session_id,
          NEW.turn_id, NEW.sequence, NEW.occurred_at, NEW.payload, 'organization')
      FROM (
        SELECT registration.* FROM organization_webhooks registration
        WHERE registration.account_id = NEW.account_id AND registration.enabled
          AND NEW.type = ANY(registration.event_types)
        ORDER BY registration.created_at, registration.id LIMIT 10
      ) webhook
      JOIN workspaces workspace ON workspace.id = NEW.workspace_id AND workspace.account_id = webhook.account_id
      WHERE webhook.account_id = NEW.account_id AND webhook.enabled AND NEW.type = ANY(webhook.event_types)
        AND (webhook.workspace_filter IS NULL
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source)
      ON CONFLICT(webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
    RAISE WARNING 'organization webhook enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $enqueue$;

CREATE TRIGGER recording_events_organization_webhook_enqueue_v1
AFTER INSERT ON recording_events
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();

-- CREATE OR REPLACE resets SET clauses; pin both search paths as 0546 did.
DO $recording_webhook_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'enqueue_recording_event_workspace_webhooks_v1()',
    'enqueue_organization_webhook_deliveries_v1()'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $recording_webhook_search_paths$;

ALTER TABLE workspace_webhooks DROP CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 16 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'usage.threshold_reached','usage.exhausted','usage.period_reset',
    'recording.finished','recording.transcript.ready','recording.transcript.failed',
    'recording.deleted'
  ]::text[]
) NOT VALID;
ALTER TABLE organization_webhooks DROP CONSTRAINT organization_webhooks_event_types_chk;
ALTER TABLE organization_webhooks ADD CONSTRAINT organization_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 16 AND event_types <@ ARRAY[
    'turn.completed', 'turn.failed', 'turn.cancelled', 'session.status.changed',
    'session.requiresAction', 'session.humanInput.requested',
    'session.notification.posted', 'session.notification.withdrawn',
    'recording.finished','recording.transcript.ready','recording.transcript.failed',
    'recording.deleted'
  ]::text[]
) NOT VALID;

-- Row-level security. A recording is visible inside its workspace when it is
-- shared, or to its owner when it is private ("Only me"); everything recorded
-- under it follows the recording.
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON recordings
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (visibility = 'workspace_shared' OR owner_subject_id = opengeni_private.current_subject_id())
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (visibility = 'workspace_shared' OR owner_subject_id = opengeni_private.current_subject_id())
  );

DO $recording_child_policies$
DECLARE
  child text;
BEGIN
  FOREACH child IN ARRAY ARRAY[
    'recording_tracks', 'recording_chunks', 'recording_transcript_versions',
    'recording_transcript_segments', 'recording_speaker_assignments',
    'recording_segment_speaker_overrides'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', child);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', child);
    EXECUTE format($policy$
      CREATE POLICY workspace_isolation ON %I
      USING (
        opengeni_private.workspace_rls_visible(account_id, workspace_id)
        AND EXISTS (
          SELECT 1 FROM recordings parent
          WHERE parent.workspace_id = %I.workspace_id AND parent.id = %I.recording_id
        )
      )
      WITH CHECK (
        opengeni_private.workspace_rls_visible(account_id, workspace_id)
        AND EXISTS (
          SELECT 1 FROM recordings parent
          WHERE parent.workspace_id = %I.workspace_id AND parent.id = %I.recording_id
        )
      )
    $policy$, child, child, child, child, child);
  END LOOP;
END
$recording_child_policies$;

ALTER TABLE recording_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_people FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON recording_people
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE recording_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON recording_events
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (visibility = 'workspace_shared' OR owner_subject_id = opengeni_private.current_subject_id())
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (visibility = 'workspace_shared' OR owner_subject_id = opengeni_private.current_subject_id())
  );

DO $recording_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      recordings, recording_tracks, recording_chunks, recording_transcript_versions,
      recording_transcript_segments, recording_people, recording_speaker_assignments,
      recording_segment_speaker_overrides
    TO opengeni_app;
    GRANT SELECT, INSERT ON recording_events TO opengeni_app;
  END IF;
END
$recording_grants$;
