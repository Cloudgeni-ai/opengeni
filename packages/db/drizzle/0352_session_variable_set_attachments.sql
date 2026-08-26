-- deployment-mode: maintenance
-- Activate ordered, FK-backed session Variable Set attachments. Runtime
-- injection now consumes the complete ordered selection, so every API/control/
-- turn worker must be stopped before this cutover and no pre-0352 image may
-- restart afterwards.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_variable_set_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0352 session Variable Set attachments require an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0352 session Variable Set attachments received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0352 session Variable Set attachments received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0352 session Variable Set attachments require all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_variable_set_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspace_variable_sets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE;
LOCK TABLE turn_personal_resource_attachment_receipts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE turn_personal_resource_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rig_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspace_session_activity_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_command_receipts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE sessions
  ADD COLUMN variable_set_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
DO $session_variable_set_backfill_workspace_fences$
DECLARE
  workspace_id_value uuid;
BEGIN
  FOR workspace_id_value IN
    SELECT DISTINCT session_value.workspace_id
    FROM sessions session_value
    ORDER BY session_value.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
  END LOOP;
END
$session_variable_set_backfill_workspace_fences$;
UPDATE sessions
SET variable_set_ids = CASE
  WHEN variable_set_id IS NULL THEN '[]'::jsonb
  ELSE jsonb_build_array(variable_set_id::text)
END;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

-- A maintenance drain prevents a mixed fleet during the DDL, while this
-- restrictive policy prevents an old API/control/turn worker from rejoining
-- afterwards. Current standalone connections use the PgBouncer-supported
-- application_name startup receipt; injected/embedded handles stamp the
-- transaction-local GUC in setRlsContext. Pre-0352 binaries carry neither.
CREATE FUNCTION opengeni_private.session_variable_set_attachments_protocol_v1_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('opengeni.session_variable_set_attachments_v1', true) = '1'
    OR current_setting('application_name', true) =
      'opengeni-lossless-v1-session-variable-sets-v1'
  THEN
    RETURN true;
  END IF;
  RAISE EXCEPTION
    'session Variable Set attachments require an OpenGeni 0352-or-newer runtime'
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL ON FUNCTION
  opengeni_private.session_variable_set_attachments_protocol_v1_active()
FROM PUBLIC;

DO $session_variable_set_protocol_grants$
DECLARE
  configured_role text;
BEGIN
  FOR configured_role IN
    SELECT role_value.rolname
    FROM jsonb_array_elements_text(
      current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value
      ON role_value.rolname = configured.value
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.session_variable_set_attachments_protocol_v1_active() TO %I',
      configured_role
    );
  END LOOP;
END
$session_variable_set_protocol_grants$;

SELECT set_config('opengeni.session_variable_set_attachments_v1', '1', true);

-- Migration 0176 admitted the then-current createDb application_name as a
-- lossless-content writer. The 0352 startup receipt rotates that name, so keep
-- both generations lossless-aware while the sessions protocol gate separately
-- rejects the old generation.
CREATE OR REPLACE FUNCTION opengeni_private.fence_legacy_lossless_content_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('opengeni.lossless_content_writer', true) = '1'
    OR current_setting('application_name', true) IN (
      'opengeni-lossless-v1',
      'opengeni-lossless-v1-session-variable-sets-v1'
    )
  THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'sessions' THEN
      IF NEW.initial_message IS DISTINCT FROM OLD.initial_message
        AND NEW.initial_message_codec_version IS NOT DISTINCT FROM OLD.initial_message_codec_version THEN
        NEW.initial_message_codec_version := NULL;
      END IF;
    WHEN 'session_realtime_entries' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'knowledge_memories' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
    WHEN 'session_turns' THEN
      IF NEW.prompt IS DISTINCT FROM OLD.prompt
        AND NEW.prompt_codec_version IS NOT DISTINCT FROM OLD.prompt_codec_version THEN
        NEW.prompt_codec_version := NULL;
      END IF;
    WHEN 'session_system_updates' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_system_update_outbox' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_events' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'host_export_outbox' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'host_export_consumers' THEN
      IF NEW.last_error IS DISTINCT FROM OLD.last_error
        AND NEW.last_error_codec_version IS NOT DISTINCT FROM OLD.last_error_codec_version THEN
        NEW.last_error_codec_version := NULL;
      END IF;
    WHEN 'agent_run_states' THEN
      IF NEW.serialized_run_state IS DISTINCT FROM OLD.serialized_run_state
        AND NEW.serialized_run_state_codec_version IS NOT DISTINCT FROM OLD.serialized_run_state_codec_version THEN
        NEW.serialized_run_state_codec_version := NULL;
      END IF;
      IF NEW.pending_approvals IS DISTINCT FROM OLD.pending_approvals
        AND NEW.pending_approvals_codec_version IS NOT DISTINCT FROM OLD.pending_approvals_codec_version THEN
        NEW.pending_approvals_codec_version := NULL;
      END IF;
    WHEN 'session_history_items' THEN
      IF NEW.item IS DISTINCT FROM OLD.item
        AND NEW.item_codec_version IS NOT DISTINCT FROM OLD.item_codec_version THEN
        NEW.item_codec_version := NULL;
      END IF;
    WHEN 'session_pending_tool_calls' THEN
      IF NEW.call_item IS DISTINCT FROM OLD.call_item
        AND NEW.call_item_codec_version IS NOT DISTINCT FROM OLD.call_item_codec_version THEN
        NEW.call_item_codec_version := NULL;
      END IF;
      IF NEW.result_item IS DISTINCT FROM OLD.result_item
        AND NEW.result_item_codec_version IS NOT DISTINCT FROM OLD.result_item_codec_version THEN
        NEW.result_item_codec_version := NULL;
      END IF;
    WHEN 'sandbox_session_envelopes' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
    WHEN 'session_recordings' THEN
      IF NEW.reason IS DISTINCT FROM OLD.reason
        AND NEW.reason_codec_version IS NOT DISTINCT FROM OLD.reason_codec_version THEN
        NEW.reason_codec_version := NULL;
      END IF;
    WHEN 'host_export_dead_letters' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
      IF NEW.envelope #> '{event,payload}' IS DISTINCT FROM OLD.envelope #> '{event,payload}'
        AND NEW.event_payload_codec_version IS NOT DISTINCT FROM OLD.event_payload_codec_version THEN
        NEW.event_payload_codec_version := NULL;
      END IF;
    WHEN 'audit_events' THEN
      IF NEW.metadata IS DISTINCT FROM OLD.metadata
        AND NEW.metadata_codec_version IS NOT DISTINCT FROM OLD.metadata_codec_version THEN
        NEW.metadata_codec_version := NULL;
      END IF;
    WHEN 'rig_changes' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
      IF NEW.verification IS DISTINCT FROM OLD.verification
        AND NEW.verification_codec_version IS NOT DISTINCT FROM OLD.verification_codec_version THEN
        NEW.verification_codec_version := NULL;
      END IF;
    WHEN 'transcription_recordings' THEN
      IF NEW.transcript_text IS DISTINCT FROM OLD.transcript_text
        AND NEW.transcript_text_codec_version IS NOT DISTINCT FROM OLD.transcript_text_codec_version THEN
        NEW.transcript_text_codec_version := NULL;
      END IF;
    WHEN 'transcription_recording_segments' THEN
      IF NEW.transcript_text IS DISTINCT FROM OLD.transcript_text
        AND NEW.transcript_text_codec_version IS NOT DISTINCT FROM OLD.transcript_text_codec_version THEN
        NEW.transcript_text_codec_version := NULL;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported lossless-content fence table: %', TG_TABLE_NAME;
  END CASE;
  RETURN NEW;
END
$function$;

CREATE POLICY sessions_variable_set_attachments_protocol_v1
ON sessions
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (opengeni_private.session_variable_set_attachments_protocol_v1_active())
WITH CHECK (opengeni_private.session_variable_set_attachments_protocol_v1_active());

CREATE TABLE session_variable_set_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  variable_set_id uuid NOT NULL REFERENCES workspace_variable_sets(id) ON DELETE CASCADE,
  position integer NOT NULL,
  session_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_variable_set_attachments_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT session_variable_set_attachments_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT session_variable_set_attachments_position_check
    CHECK (position >= 0 AND position < 25),
  CONSTRAINT session_variable_set_attachments_status_check
    CHECK (session_status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering',
      'waiting_capacity', 'failed', 'cancelled'
    )),
  CONSTRAINT session_variable_set_attachments_session_position_uq
    UNIQUE (workspace_id, session_id, position),
  CONSTRAINT session_variable_set_attachments_session_set_uq
    UNIQUE (workspace_id, session_id, variable_set_id)
);

CREATE INDEX session_variable_set_attachments_set_sessions_idx
  ON session_variable_set_attachments (
    variable_set_id, session_status, workspace_id, session_id
  );

INSERT INTO session_variable_set_attachments (
  account_id, workspace_id, session_id, variable_set_id, position, session_status
)
SELECT account_id, workspace_id, id, variable_set_id, 0, status
FROM sessions
WHERE variable_set_id IS NOT NULL;

CREATE OR REPLACE FUNCTION normalize_session_variable_set_selection()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
  selected_count integer;
  distinct_count integer;
  last_id uuid;
BEGIN
  IF TG_OP = 'INSERT'
    AND NEW.variable_set_ids = '[]'::jsonb
    AND NEW.variable_set_id IS NOT NULL
  THEN
    NEW.variable_set_ids := jsonb_build_array(NEW.variable_set_id::text);
  ELSIF TG_OP = 'UPDATE'
    AND NEW.variable_set_ids IS NOT DISTINCT FROM OLD.variable_set_ids
    AND NEW.variable_set_id IS DISTINCT FROM OLD.variable_set_id
  THEN
    NEW.variable_set_ids := CASE
      WHEN NEW.variable_set_id IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(NEW.variable_set_id::text)
    END;
  END IF;

  IF jsonb_typeof(NEW.variable_set_ids) <> 'array' THEN
    RAISE EXCEPTION 'variable_set_ids must be a JSON array' USING ERRCODE = '23514';
  END IF;
  selected_count := jsonb_array_length(NEW.variable_set_ids);
  IF selected_count > 25 THEN
    RAISE EXCEPTION 'variable_set_ids exceeds 25 entries' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.variable_set_ids) item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
      OR (item.value #>> '{}') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'variable_set_ids must contain UUID strings' USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT value) INTO distinct_count
  FROM jsonb_array_elements_text(NEW.variable_set_ids) selected(value);
  IF distinct_count <> selected_count THEN
    RAISE EXCEPTION 'variable_set_ids must not contain duplicates' USING ERRCODE = '23514';
  END IF;
  SELECT value::uuid INTO last_id
  FROM jsonb_array_elements_text(NEW.variable_set_ids) WITH ORDINALITY selected(value, position)
  ORDER BY position DESC
  LIMIT 1;
  IF NEW.variable_set_id IS DISTINCT FROM last_id THEN
    RAISE EXCEPTION 'variable_set_id must match the last variable_set_ids entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$body$;

CREATE OR REPLACE FUNCTION sync_session_variable_set_attachments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  EXECUTE pg_catalog.format(
    'DELETE FROM %I.session_variable_set_attachments
     WHERE workspace_id = $1 AND session_id = $2',
    TG_TABLE_SCHEMA
  ) USING NEW.workspace_id, NEW.id;
  EXECUTE pg_catalog.format(
    'INSERT INTO %I.session_variable_set_attachments (
       account_id, workspace_id, session_id, variable_set_id, position, session_status
     )
     SELECT $1, $2, $3, selected.value::uuid,
       selected.position::integer - 1, $5
     FROM pg_catalog.jsonb_array_elements_text($4)
       WITH ORDINALITY selected(value, position)',
    TG_TABLE_SCHEMA
  ) USING NEW.account_id, NEW.workspace_id, NEW.id, NEW.variable_set_ids, NEW.status;
  RETURN NEW;
END
$body$;

CREATE OR REPLACE FUNCTION sync_session_variable_set_attachment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  EXECUTE pg_catalog.format(
    'UPDATE %I.session_variable_set_attachments
     SET session_status = $1
     WHERE workspace_id = $2 AND session_id = $3
       AND session_status IS DISTINCT FROM $1',
    TG_TABLE_SCHEMA
  ) USING NEW.status, NEW.workspace_id, NEW.id;
  RETURN NEW;
END
$body$;

CREATE OR REPLACE FUNCTION guard_variable_set_session_attachments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE
  attachment_count integer := 0;
  previous_account text := current_setting('opengeni.account_id', true);
  previous_workspace text := current_setting('opengeni.workspace_id', true);
  previous_subject text := current_setting('opengeni.subject_id', true);
BEGIN
  PERFORM set_config('opengeni.account_id', OLD.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', '', true);
  PERFORM set_config('opengeni.subject_id', '', true);
  EXECUTE format(
    'SELECT count(*)::integer
     FROM %I.session_variable_set_attachments
     WHERE variable_set_id = $1',
    TG_TABLE_SCHEMA
  ) INTO attachment_count USING OLD.id;
  IF attachment_count > 0 THEN
    RAISE EXCEPTION 'variable set remains attached to % sessions', attachment_count
      USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
  RAISE;
END
$body$;

CREATE TRIGGER sessions_variable_set_selection_normalize
BEFORE INSERT OR UPDATE OF variable_set_ids, variable_set_id ON sessions
FOR EACH ROW EXECUTE FUNCTION normalize_session_variable_set_selection();

CREATE TRIGGER sessions_variable_set_attachments_sync
AFTER INSERT OR UPDATE OF variable_set_ids, variable_set_id ON sessions
FOR EACH ROW EXECUTE FUNCTION sync_session_variable_set_attachments();

CREATE TRIGGER sessions_variable_set_attachment_status_sync
AFTER UPDATE OF status ON sessions
FOR EACH ROW EXECUTE FUNCTION sync_session_variable_set_attachment_status();

CREATE TRIGGER workspace_variable_sets_session_attachment_guard
BEFORE DELETE ON workspace_variable_sets
FOR EACH ROW EXECUTE FUNCTION guard_variable_set_session_attachments();

REVOKE ALL ON FUNCTION normalize_session_variable_set_selection() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_session_variable_set_attachments() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_session_variable_set_attachment_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_variable_set_session_attachments() FROM PUBLIC;

ALTER TABLE session_variable_set_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_variable_set_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON session_variable_set_attachments
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    OR opengeni_private.variable_set_authority_capability_active('write')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    OR opengeni_private.variable_set_authority_capability_active('write')
  );
CREATE POLICY session_visibility_isolation
  ON session_variable_set_attachments AS RESTRICTIVE
  USING (
    session_reference_visible(account_id, workspace_id, session_id)
    OR opengeni_private.variable_set_authority_capability_active('write')
  )
  WITH CHECK (
    session_reference_visible(account_id, workspace_id, session_id)
    OR opengeni_private.variable_set_authority_capability_active('write')
  );

-- A restart/fork with runtime setup is one database transaction. The original
-- fork function still owns destination creation, history copy, receipt, and
-- source quiescence. This helper configures only that fresh singleton
-- destination before the outer function can commit, so no caller can observe
-- a fork that is missing its selected Rig or explicit Variable Sets.
CREATE FUNCTION opengeni_private.configure_fork_session_runtime(
  p_account_id uuid,
  p_workspace_id uuid,
  p_source_session_id uuid,
  p_destination_session_id uuid,
  p_actor_subject_id text,
  p_variable_set_ids jsonb,
  p_rig_id uuid,
  p_rig_version_id uuid,
  p_configuration_digest text
) RETURNS TABLE (
  runtime_event_id uuid,
  runtime_event_sequence integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  destination_session sessions%ROWTYPE;
  runtime_marker jsonb;
  selected_count integer;
  selected_last uuid;
  destination_activity_revision bigint;
  previous_gate_state text := current_setting('opengeni.session_activity_gate_state', true);
  previous_gate_workspace text := current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'fork runtime configuration authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_source_session_id IS NULL OR p_destination_session_id IS NULL
    OR p_actor_subject_id IS NULL OR p_variable_set_ids IS NULL
    OR p_configuration_digest !~ '^[0-9a-f]{64}$'
    OR nullif(previous_gate_state, '') IS NOT NULL
    OR nullif(previous_gate_workspace, '') IS NOT NULL
  THEN
    RAISE EXCEPTION 'fork runtime configuration request is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM acquire_session_tenancy_fence(p_workspace_id);
  SELECT session_value.* INTO destination_session
  FROM sessions session_value
  WHERE session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.id = p_destination_session_id
  FOR UPDATE;
  IF NOT FOUND
    OR destination_session.forked_from_session_id IS DISTINCT FROM p_source_session_id
    OR destination_session.owner_subject_id IS DISTINCT FROM p_actor_subject_id
  THEN
    RAISE EXCEPTION 'fork runtime destination is unavailable'
      USING ERRCODE = '42501';
  END IF;

  runtime_marker := destination_session.metadata -> 'forkRuntimeConfiguration';
  IF runtime_marker IS NOT NULL THEN
    IF runtime_marker ->> 'digest' IS DISTINCT FROM p_configuration_digest THEN
      RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
    END IF;
    runtime_event_id := nullif(runtime_marker ->> 'eventId', '')::uuid;
    runtime_event_sequence := (runtime_marker ->> 'eventSequence')::integer;
    IF runtime_event_id IS NULL OR runtime_event_sequence IS NULL THEN
      RAISE EXCEPTION 'fork runtime configuration marker is incomplete'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  IF destination_session.status <> 'idle'
    OR destination_session.active_turn_id IS NOT NULL
    OR destination_session.active_sandbox_id IS NOT NULL
    OR destination_session.sandbox_group_id IS DISTINCT FROM destination_session.id
  THEN
    RAISE EXCEPTION 'fork runtime destination is not fresh and quiescent'
      USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_variable_set_ids) <> 'array' THEN
    RAISE EXCEPTION 'fork runtime Variable Set ids must be an array'
      USING ERRCODE = '22023';
  END IF;
  selected_count := jsonb_array_length(p_variable_set_ids);
  IF selected_count > 25
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_variable_set_ids) item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
        OR (item.value #>> '{}') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    OR selected_count <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(p_variable_set_ids) selected(value)
    )
  THEN
    RAISE EXCEPTION 'fork runtime Variable Set selection is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF selected_count <> (
    SELECT count(*)
    FROM workspace_variable_sets variable_set
    JOIN jsonb_array_elements_text(p_variable_set_ids) selected(value)
      ON selected.value::uuid = variable_set.id
    WHERE variable_set.account_id = p_account_id
      AND variable_set.status = 'active'
  ) THEN
    RAISE EXCEPTION 'fork runtime Variable Set selection is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT selected.value::uuid INTO selected_last
  FROM jsonb_array_elements_text(p_variable_set_ids)
    WITH ORDINALITY selected(value, position)
  ORDER BY selected.position DESC
  LIMIT 1;

  IF (p_rig_id IS NULL) <> (p_rig_version_id IS NULL)
    OR (
      p_rig_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM rig_versions rig_version
        WHERE rig_version.account_id = p_account_id
          AND rig_version.rig_id = p_rig_id
          AND rig_version.id = p_rig_version_id
          AND rig_version.active
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
            ) default_set(value)
            WHERE NOT EXISTS (
              SELECT 1
              FROM workspace_variable_sets variable_set
              WHERE variable_set.account_id = p_account_id
                AND variable_set.id = default_set.value::uuid
                AND variable_set.status = 'active'
            )
          )
      )
    )
  THEN
    RAISE EXCEPTION 'fork runtime Rig selection is unavailable'
      USING ERRCODE = '42501';
  END IF;

  runtime_event_id := gen_random_uuid();
  runtime_event_sequence := destination_session.last_sequence + 1;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', p_workspace_id::text, true);
  UPDATE sessions session_value SET
    variable_set_ids = p_variable_set_ids,
    variable_set_id = selected_last,
    rig_id = p_rig_id,
    rig_version_id = p_rig_version_id,
    metadata = session_value.metadata || jsonb_build_object(
      'forkRuntimeConfiguration', jsonb_build_object(
        'digest', p_configuration_digest,
        'eventId', runtime_event_id,
        'eventSequence', runtime_event_sequence,
        'variableSetIds', p_variable_set_ids,
        'rigId', p_rig_id,
        'rigVersionId', p_rig_version_id
      )
    ),
    last_sequence = runtime_event_sequence,
    updated_at = clock_timestamp()
  WHERE session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.id = p_destination_session_id;

  INSERT INTO session_events (
    id, account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  ) VALUES (
    runtime_event_id, p_account_id, p_workspace_id, p_destination_session_id,
    runtime_event_sequence, 'session.runtime.configured', jsonb_build_object(
      'sourceSessionId', p_source_session_id,
      'variableSetIds', p_variable_set_ids,
      'rigId', p_rig_id,
      'rigVersionId', p_rig_version_id,
      'collisionPolicy', 'later_selected_set_wins'
    ), clock_timestamp()
  );
  INSERT INTO audit_events (
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, p_actor_subject_id,
    'session.runtime.configured', 'session', p_destination_session_id::text,
    jsonb_build_object(
      'sourceSessionId', p_source_session_id,
      'variableSetIds', p_variable_set_ids,
      'rigId', p_rig_id,
      'rigVersionId', p_rig_version_id,
      'collisionPolicy', 'later_selected_set_wins'
    ), 1
  );

  PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = p_workspace_id
  RETURNING counter.revision INTO destination_activity_revision;
  IF destination_activity_revision IS NULL THEN
    RAISE EXCEPTION 'fork runtime destination activity counter is unavailable'
      USING ERRCODE = '23514';
  END IF;
  UPDATE sessions session_value SET
    activity_revision = destination_activity_revision,
    activity_revision_pending_xid = NULL
  WHERE session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.id = p_destination_session_id
    AND session_value.activity_revision_pending_xid = pg_current_xact_id()::text::bigint;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fork runtime destination activity was not finalized'
      USING ERRCODE = '23514';
  END IF;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;
  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.session_activity_gate_state', coalesce(previous_gate_state, ''), true
  );
  PERFORM set_config(
    'opengeni.session_activity_gate_workspace_id',
    coalesce(previous_gate_workspace, ''), true
  );
  RAISE;
END
$body$;

CREATE FUNCTION opengeni_private.read_fork_session_runtime(
  p_account_id uuid,
  p_workspace_id uuid,
  p_source_session_id uuid,
  p_destination_session_id uuid,
  p_actor_subject_id text,
  p_configuration_digest text
) RETURNS TABLE (
  runtime_event_id uuid,
  runtime_event_sequence integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  runtime_marker jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_configuration_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'fork runtime replay authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  SELECT session_value.metadata -> 'forkRuntimeConfiguration'
  INTO runtime_marker
  FROM sessions session_value
  WHERE session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.id = p_destination_session_id
    AND session_value.forked_from_session_id = p_source_session_id
    AND session_value.owner_subject_id = p_actor_subject_id;
  IF runtime_marker IS NULL THEN
    RAISE EXCEPTION 'fork runtime configuration marker is unavailable'
      USING ERRCODE = '23514';
  END IF;
  IF runtime_marker ->> 'digest' IS DISTINCT FROM p_configuration_digest THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  runtime_event_id := nullif(runtime_marker ->> 'eventId', '')::uuid;
  runtime_event_sequence := (runtime_marker ->> 'eventSequence')::integer;
  IF runtime_event_id IS NULL OR runtime_event_sequence IS NULL THEN
    RAISE EXCEPTION 'fork runtime configuration marker is incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEXT;
END
$body$;

CREATE FUNCTION fork_session_content_with_runtime(
  p_account_id uuid,
  p_source_workspace_id uuid,
  p_source_session_id uuid,
  p_actor_subject_id text,
  p_destination_workspace_id uuid,
  p_destination_visibility text,
  p_workspace_shared_acknowledged boolean,
  p_operation_key text,
  p_canonical_request_hash text,
  p_activation_version integer,
  p_variable_set_ids jsonb,
  p_rig_id uuid,
  p_rig_version_id uuid,
  p_configuration_digest text
) RETURNS TABLE (
  operation_id uuid,
  event_id uuid,
  event_sequence integer,
  session_id uuid,
  workspace_id uuid,
  visibility text,
  authority_epoch integer,
  copied_history_item_count integer,
  replay boolean,
  runtime_event_id uuid,
  runtime_event_sequence integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  SELECT fork_result.operation_id, fork_result.event_id, fork_result.event_sequence,
    fork_result.session_id, fork_result.workspace_id, fork_result.visibility,
    fork_result.authority_epoch, fork_result.copied_history_item_count, fork_result.replay
  INTO operation_id, event_id, event_sequence, session_id, workspace_id, visibility,
    authority_epoch, copied_history_item_count, replay
  FROM fork_session_content(
    p_account_id, p_source_workspace_id, p_source_session_id, p_actor_subject_id,
    p_destination_workspace_id, p_destination_visibility,
    p_workspace_shared_acknowledged, p_operation_key, p_canonical_request_hash,
    p_activation_version
  ) fork_result;
  IF session_id IS NULL THEN
    RAISE EXCEPTION 'session fork returned no destination' USING ERRCODE = '23514';
  END IF;
  SELECT configured.runtime_event_id, configured.runtime_event_sequence
  INTO runtime_event_id, runtime_event_sequence
  FROM opengeni_private.configure_fork_session_runtime(
    p_account_id, p_source_workspace_id, p_source_session_id, session_id,
    p_actor_subject_id, p_variable_set_ids, p_rig_id, p_rig_version_id,
    p_configuration_digest
  ) configured;
  RETURN NEXT;
END
$body$;

CREATE FUNCTION replay_applied_session_fork_with_runtime(
  p_account_id uuid,
  p_source_workspace_id uuid,
  p_source_session_id uuid,
  p_actor_subject_id text,
  p_destination_workspace_id uuid,
  p_destination_visibility text,
  p_workspace_shared_acknowledged boolean,
  p_operation_key text,
  p_canonical_request_hash text,
  p_activation_version integer,
  p_configuration_digest text
) RETURNS TABLE (
  operation_id uuid,
  event_id uuid,
  event_sequence integer,
  session_id uuid,
  workspace_id uuid,
  visibility text,
  authority_epoch integer,
  copied_history_item_count integer,
  replay boolean,
  runtime_event_id uuid,
  runtime_event_sequence integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  SELECT fork_result.operation_id, fork_result.event_id, fork_result.event_sequence,
    fork_result.session_id, fork_result.workspace_id, fork_result.visibility,
    fork_result.authority_epoch, fork_result.copied_history_item_count, fork_result.replay
  INTO operation_id, event_id, event_sequence, session_id, workspace_id, visibility,
    authority_epoch, copied_history_item_count, replay
  FROM replay_applied_session_fork(
    p_account_id, p_source_workspace_id, p_source_session_id, p_actor_subject_id,
    p_destination_workspace_id, p_destination_visibility,
    p_workspace_shared_acknowledged, p_operation_key, p_canonical_request_hash,
    p_activation_version
  ) fork_result;
  IF session_id IS NULL THEN
    RETURN;
  END IF;
  SELECT configured.runtime_event_id, configured.runtime_event_sequence
  INTO runtime_event_id, runtime_event_sequence
  FROM opengeni_private.read_fork_session_runtime(
    p_account_id, p_source_workspace_id, p_source_session_id, session_id,
    p_actor_subject_id, p_configuration_digest
  ) configured;
  RETURN NEXT;
END
$body$;

DO $fork_runtime_search_path_and_grants$
DECLARE
  data_schema text := current_schema();
  application_role text;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.configure_fork_session_runtime('
      || 'uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.read_fork_session_runtime('
      || 'uuid,uuid,uuid,uuid,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fork_session_content_with_runtime('
      || 'uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,jsonb,uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.replay_applied_session_fork_with_runtime('
      || 'uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  FOR application_role IN
    SELECT role_value.rolname
    FROM jsonb_array_elements_text(
      current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value
      ON role_value.rolname = configured.value
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.fork_session_content_with_runtime('
        || 'uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,jsonb,uuid,uuid,text) '
        || 'TO %I',
      data_schema, application_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.replay_applied_session_fork_with_runtime('
        || 'uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,text) '
        || 'TO %I',
      data_schema, application_role
    );
  END LOOP;
END
$fork_runtime_search_path_and_grants$;

REVOKE ALL ON FUNCTION opengeni_private.configure_fork_session_runtime(
  uuid, uuid, uuid, uuid, text, jsonb, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.read_fork_session_runtime(
  uuid, uuid, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION fork_session_content_with_runtime(
  uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer,
  jsonb, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION replay_applied_session_fork_with_runtime(
  uuid, uuid, uuid, text, uuid, text, boolean, text, text, integer, text
) FROM PUBLIC;

-- The accepted-turn personal-resource closure must include every explicit
-- user-scoped Variable Set, not only the legacy final alias. Patch the exact
-- drained function source so the established grant/receipt protocol remains
-- byte-for-byte unchanged outside this ordered-selection extension.
ALTER TABLE turn_personal_resource_attachment_receipts
  DROP CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk;
ALTER TABLE turn_personal_resource_attachment_receipts
  ADD CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk CHECK (
    octet_length(initiating_human_subject_id) BETWEEN 1 AND 512
    AND membership_authorization_revision > 0
    AND session_authority_epoch > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND shared_output_warning_version = 1
    AND resource_count BETWEEN 1 AND 52
    AND (session_visibility <> 'workspace_shared' OR shared_output_acknowledged IS TRUE)
  );
ALTER TABLE turn_personal_resource_snapshots
  DROP CONSTRAINT turn_personal_resource_snapshots_generation_chk;
ALTER TABLE turn_personal_resource_snapshots
  ADD CONSTRAINT turn_personal_resource_snapshots_generation_chk CHECK (
    membership_authorization_revision > 0
    AND authority_generation > 0
    AND grant_generation > 0
    AND cardinality(selection_sources) BETWEEN 1 AND 50
  );

ALTER TABLE session_variable_set_attachments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_sets NO FORCE ROW LEVEL SECURITY;
DO $extend_atomic_attachment_function_for_session_sets$
DECLARE
  data_schema text := current_schema();
  function_source text;
  prior_source text;
BEGIN
  SELECT procedure_value.prosrc INTO STRICT function_source
  FROM pg_proc procedure_value
  JOIN pg_namespace namespace_value ON namespace_value.oid = procedure_value.pronamespace
  WHERE namespace_value.nspname = data_schema
    AND procedure_value.oid = (
      pg_catalog.format(
        '%I.accept_turn_personal_resource_attachment(uuid,uuid,uuid,uuid,text,integer,boolean,integer)',
        data_schema
      )::regprocedure
    );

  prior_source := function_source;
  function_source := replace(function_source,
    $old$  PERFORM 1 FROM workspace_variable_sets variable_set
  WHERE variable_set.id = session_row.variable_set_id
    AND variable_set.account_id = p_account_id
  FOR SHARE;$old$,
    $new$  PERFORM variable_set.id
  FROM session_variable_set_attachments attachment
  JOIN workspace_variable_sets variable_set
    ON variable_set.id = attachment.variable_set_id
   AND variable_set.account_id = p_account_id
  WHERE attachment.account_id = p_account_id
    AND attachment.workspace_id = p_workspace_id
    AND attachment.session_id = p_session_id
  ORDER BY attachment.position
  FOR SHARE OF variable_set;$new$
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0352 could not extend the personal-resource attachment lock set'
      USING ERRCODE = '55000';
  END IF;

  prior_source := function_source;
  function_source := replace(function_source,
    $old$    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = session_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'$old$,
    $new$    FROM session_variable_set_attachments attachment
    JOIN workspace_variable_sets variable_set
      ON variable_set.id = attachment.variable_set_id
     AND variable_set.account_id = p_account_id
     AND variable_set.authority_scope = 'user'
    WHERE attachment.account_id = p_account_id
      AND attachment.workspace_id = p_workspace_id
      AND attachment.session_id = p_session_id$new$
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0352 could not extend the personal-resource attachment closure'
      USING ERRCODE = '55000';
  END IF;
  function_source := replace(
    function_source,
    '''session_variable_set''::text AS selection_source',
    '''session_variable_set:'' || attachment.position::text AS selection_source'
  );
  function_source := replace(function_source, 'IF selected_count > 28 THEN',
    'IF selected_count > 52 THEN');
  IF function_source NOT LIKE '%IF selected_count > 52 THEN%'
    OR function_source LIKE '%IF selected_count > 28 THEN%'
  THEN
    RAISE EXCEPTION '0352 could not update the personal-resource attachment bound'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION %I.accept_turn_personal_resource_attachment('
      || 'p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, '
      || 'p_mode text, p_expected_authority_epoch integer, '
      || 'p_workspace_shared_acknowledged boolean, '
      || 'p_shared_output_warning_version integer) '
      || 'RETURNS TABLE (grant_mode text, grant_context text, resource_count integer, '
      || 'resource_kinds text[], shared_output_warning_version integer, replay boolean) '
      || 'LANGUAGE plpgsql SECURITY DEFINER '
      || 'SET search_path TO pg_catalog, %I, pg_temp AS %L',
    data_schema, data_schema, function_source
  );
END
$extend_atomic_attachment_function_for_session_sets$;
ALTER TABLE workspace_variable_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE session_variable_set_attachments FORCE ROW LEVEL SECURITY;

-- Scheduled attempts freeze every explicit set generation. Extend the existing
-- attempt oracle to consume the new plural accepted snapshot while retaining
-- the legacy singular fallback for pre-0344 runs.
DO $extend_scheduled_variable_set_generation_oracle$
DECLARE
  data_schema text := current_schema();
  function_oid regprocedure;
  function_source text;
  prior_source text;
BEGIN
  function_oid := pg_catalog.to_regprocedure(
    pg_catalog.format(
      '%I.scheduled_variable_set_expected_generation_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)',
      data_schema
    )
  );
  IF function_oid IS NULL THEN
    -- Some focused legacy-migration tests deliberately apply a sparse suffix
    -- that predates the scheduled-attempt oracle. There is nothing to extend
    -- in that shape; full migration chains always have the function here.
    RETURN;
  END IF;

  SELECT procedure_value.prosrc INTO STRICT function_source
  FROM pg_proc procedure_value
  JOIN pg_namespace namespace_value ON namespace_value.oid = procedure_value.pronamespace
  WHERE namespace_value.nspname = data_schema
    AND procedure_value.oid = function_oid;

  prior_source := function_source;
  function_source := replace(
    function_source,
    'session_value.variable_set_id, session_value.rig_id,',
    'session_value.variable_set_ids, session_value.variable_set_id, session_value.rig_id,'
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0352 could not extend the scheduled session selection snapshot'
      USING ERRCODE = '55000';
  END IF;

  prior_source := function_source;
  function_source := replace(function_source,
    $old$    SELECT (run_snapshot -> 'targetSessionExecution' ->> 'variableSetGeneration')::bigint
    WHERE run_snapshot -> 'targetSessionExecution' <> 'null'::jsonb
      AND run_snapshot -> 'targetSessionExecution' ->> 'variableSetId' = p_variable_set_id::text$old$,
    $new$    SELECT (item ->> 'generation')::bigint
    FROM jsonb_array_elements(coalesce(
      run_snapshot -> 'targetSessionExecution' -> 'variableSets', '[]'::jsonb
    )) item
    WHERE item ->> 'id' = p_variable_set_id::text
    UNION ALL
    SELECT (run_snapshot -> 'targetSessionExecution' ->> 'variableSetGeneration')::bigint
    WHERE run_snapshot -> 'targetSessionExecution' <> 'null'::jsonb
      AND jsonb_array_length(coalesce(
        run_snapshot -> 'targetSessionExecution' -> 'variableSets', '[]'::jsonb
      )) = 0
      AND run_snapshot -> 'targetSessionExecution' ->> 'variableSetId' = p_variable_set_id::text$new$
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0352 could not extend the scheduled accepted generation lookup'
      USING ERRCODE = '55000';
  END IF;

  prior_source := function_source;
  function_source := replace(
    function_source,
    'IF session_row.variable_set_id IS DISTINCT FROM p_variable_set_id',
    'IF NOT coalesce(session_row.variable_set_ids, ''[]''::jsonb) ? p_variable_set_id::text'
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0352 could not extend the scheduled exact-session selection check'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION %I.scheduled_variable_set_expected_generation_for_attempt('
      || 'p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, '
      || 'p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid) '
      || 'RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER '
      || 'SET search_path TO pg_catalog, %I, pg_temp AS %L',
    data_schema, data_schema, function_source
  );
END
$extend_scheduled_variable_set_generation_oracle$;

DO $grants$
DECLARE
  data_schema text := current_schema();
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
  application_role text;
BEGIN
  FOR application_role IN
    SELECT roles.role_name
    FROM jsonb_array_elements_text(configured_roles) roles(role_name)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = roles.role_name
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.session_variable_set_attachments FROM %I',
      data_schema,
      application_role
    );
  END LOOP;
END
$grants$;

COMMENT ON COLUMN sessions.variable_set_ids IS
  'Ordered low-to-high precedence Variable Set ids; the final entry is mirrored in legacy variable_set_id.';
COMMENT ON TABLE session_variable_set_attachments IS
  'FK-backed lifecycle-only projection of ordered session Variable Set selection; values never appear here.';
