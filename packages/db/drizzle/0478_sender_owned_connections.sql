-- deployment-mode: maintenance
-- Sender-owned connection execution. Stop all old API and worker processes.
-- Historical grant receipts remain audit evidence, never execution authority.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'sender-owned connection migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

-- Replace ownership restrictions with setup preferences. Existing installations
-- and credentials retain their selected ownership; this changes catalog setup only.
ALTER TABLE capability_catalog_items NO FORCE ROW LEVEL SECURITY;
UPDATE capability_catalog_items
SET metadata = (metadata - 'connectionOwnership') || jsonb_build_object(
  'defaultConnectionOwnership', CASE
    WHEN endpoint_url = 'https://gmailmcp.googleapis.com/mcp/v1' THEN 'personal'
    WHEN endpoint_url = 'https://mcp.slack.com/mcp' THEN 'workspace'
    ELSE coalesce(metadata ->> 'defaultConnectionOwnership', 'workspace') END)
WHERE metadata ? 'connectionOwnership';
UPDATE capability_catalog_items
SET metadata = jsonb_set(metadata, '{oauthProfile}',
  ((metadata -> 'oauthProfile') - 'allowedOwnership') || jsonb_build_object(
    'defaultOwnership', CASE
      WHEN metadata #> '{oauthProfile,allowedOwnership}' = '["personal"]'::jsonb THEN 'personal'
      ELSE 'workspace' END))
WHERE jsonb_typeof(metadata -> 'oauthProfile') = 'object'
  AND metadata -> 'oauthProfile' ? 'allowedOwnership';
ALTER TABLE capability_catalog_items FORCE ROW LEVEL SECURITY;

-- Execution identity is immutable, separate from the mutable task configuration
-- digest. Preserve existing accepted-run evidence during this maintenance step.
ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
CREATE TEMP TABLE sender_schedule_bindings_before ON COMMIT DROP AS
  SELECT id, authority_revision, execution_digest FROM scheduled_tasks;
ALTER TABLE scheduled_tasks ADD COLUMN owner_subject_id text
  CHECK (owner_subject_id IS NULL OR length(btrim(owner_subject_id)) BETWEEN 1 AND 1024);
DO $owner_digest$
DECLARE signature text; definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'scheduled_task_execution_state(scheduled_tasks)',
    'scheduled_task_execution_digest(scheduled_tasks)',
    'set_scheduled_task_execution_digest()',
    'fence_scheduled_task_personal_resource_execution_update()',
    'fence_scheduled_task_connection_authority_execution_update()'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF strpos(definition, '''execution_digest''') = 0 THEN
      RAISE EXCEPTION 'scheduled task digest definition changed: %', signature;
    END IF;
    EXECUTE replace(definition, '''execution_digest''', '''execution_digest'', ''owner_subject_id''');
  END LOOP;
END
$owner_digest$;
ALTER TABLE scheduled_task_revision_authorities NO FORCE ROW LEVEL SECURITY;
-- Backfills obey the same workspace mutation fence as application writers.
-- The owner posture above makes every affected workspace visible under RLS.
DO $schedule_fences$
DECLARE workspace_value uuid;
BEGIN
  FOR workspace_value IN SELECT DISTINCT workspace_id FROM scheduled_tasks ORDER BY workspace_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('session-tenancy:' || workspace_value::text, 0));
  END LOOP;
END
$schedule_fences$;
-- Only non-executable ownership/status fields change here. Retain the exact
-- stored digest even when an older additive migration left new nullable keys.
ALTER TABLE scheduled_tasks DISABLE TRIGGER zz_scheduled_task_execution_digest;
UPDATE scheduled_tasks task SET owner_subject_id = coalesce(
  (SELECT authority.subject_id FROM scheduled_task_revision_authorities authority
    WHERE authority.task_id = task.id AND authority.account_id = task.account_id
      AND authority.workspace_id = task.workspace_id
      AND authority.task_authority_revision = task.authority_revision),
  CASE WHEN task.created_by_kind = 'subject'
    AND NOT (task.created_by_context ?| ARRAY['via','viaTruncated','provenanceError','backfill'])
    THEN task.created_by_subject_id END
) WHERE task.action ->> 'kind' = 'agent_turn';
ALTER TABLE scheduled_task_revision_authorities FORCE ROW LEVEL SECURITY;
-- Do not keep firing old personal work when its human owner cannot be proven.
-- Preserve its instructions and historical selections for an owner to recreate.
UPDATE scheduled_tasks SET status = 'paused'
WHERE action ->> 'kind' = 'agent_turn' AND owner_subject_id IS NULL
  AND status = 'active' AND personal_connection_delegations <> '[]'::jsonb;
ALTER TABLE scheduled_tasks ENABLE TRIGGER zz_scheduled_task_execution_digest;
DO $owner_binding_check$
BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_tasks task JOIN sender_schedule_bindings_before prior ON prior.id = task.id
    WHERE task.authority_revision IS DISTINCT FROM prior.authority_revision
      OR task.execution_digest IS DISTINCT FROM prior.execution_digest) THEN
    RAISE EXCEPTION 'schedule ownership backfill changed accepted execution bindings';
  END IF;
END
$owner_binding_check$;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
CREATE FUNCTION opengeni_private.guard_scheduled_task_owner()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE expected_owner text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id THEN
      RAISE EXCEPTION 'schedule owner is immutable; copy the schedule to use another account'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    expected_owner := CASE WHEN NEW.action ->> 'kind' = 'agent_turn'
      THEN nullif(current_setting('opengeni.initiating_human_subject_id', true), '') END;
    IF NEW.owner_subject_id IS DISTINCT FROM expected_owner THEN
      RAISE EXCEPTION 'schedule owner differs from verified creator' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_task_owner() FROM PUBLIC;
CREATE TRIGGER scheduled_task_owner_immutable BEFORE INSERT OR UPDATE ON scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_task_owner();

CREATE FUNCTION opengeni_private.guard_scheduled_run_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE expected_owner text;
BEGIN
  IF NEW.action_kind <> 'agent_turn' THEN RETURN NEW; END IF;
  SELECT task.owner_subject_id INTO STRICT expected_owner FROM scheduled_tasks task
  WHERE task.id = NEW.task_id AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id FOR SHARE;
  IF NEW.accepted_execution_snapshot ->> 'causalHumanSubjectId' IS DISTINCT FROM expected_owner
    OR NEW.accepted_execution_snapshot #>> '{task,ownerSubjectId}' IS DISTINCT FROM expected_owner
  THEN RAISE EXCEPTION 'scheduled run differs from immutable execution owner' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_run_owner() FROM PUBLIC;
CREATE TRIGGER scheduled_run_owner_matches BEFORE INSERT ON scheduled_task_runs
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_run_owner();

-- Only migration-owned capture/resolution routines can call this helper.
-- Restore the caller context after the scoped read; exceptions roll back the
-- PL/pgSQL block, including its transaction-local context changes.
CREATE FUNCTION opengeni_private.read_sender_connection(
  p_account_id uuid, p_origin_workspace_id uuid, p_connection_id uuid, p_owner_subject_id text
) RETURNS SETOF connections
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $body$
DECLARE
  prior_workspace text := current_setting('opengeni.workspace_id', true);
  prior_subject text := current_setting('opengeni.subject_id', true);
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_origin_workspace_id IS NULL
  THEN RAISE EXCEPTION 'connection account scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.workspace_id', p_origin_workspace_id::text, true);
  PERFORM set_config('opengeni.subject_id', coalesce(p_owner_subject_id, ''), true);
  RETURN QUERY SELECT c.* FROM connections c
  WHERE c.id = p_connection_id AND c.account_id = p_account_id
    AND c.workspace_id = p_origin_workspace_id
    AND c.origin_workspace_id = p_origin_workspace_id
    AND c.subject_id IS NOT DISTINCT FROM p_owner_subject_id
  FOR SHARE;
  PERFORM set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
  PERFORM set_config('opengeni.subject_id', coalesce(prior_subject, ''), true);
EXCEPTION WHEN OTHERS THEN RAISE;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.read_sender_connection(uuid,uuid,uuid,text) FROM PUBLIC;


-- Older snapshots remain readable audit facts. The resolver below refuses
-- their provenance; only new sender snapshots authorize execution.
ALTER TABLE turn_connection_authority_snapshots
DROP CONSTRAINT turn_connection_authority_grant_check,
ADD CONSTRAINT "turn_connection_authority_grant_check" CHECK (
    ("authority_scope" = 'user'
      AND "authority_source" = 'user_delegation'
      AND "owner_subject_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
      AND "membership_authorization_revision" > 0
      AND "authority_id" IS NOT NULL AND "authority_generation" > 0
      AND "grant_id" IS NOT NULL AND "grant_generation" > 0
      AND "grant_mode" IN ('once', 'session', 'always')
      AND "grant_context" IN ('user_private', 'workspace_shared')
      AND (("grant_mode" = 'always' AND "grant_session_id" IS NULL
          AND "grant_authority_epoch" IS NULL)
        OR ("grant_mode" IN ('once', 'session') AND "grant_session_id" = "session_id"
          AND "grant_authority_epoch" > 0)))
    OR ("authority_scope" = 'workspace'
      AND "authority_source" IN ('explicit_workspace', 'legacy_workspace_omission')
      AND "owner_subject_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
      AND "membership_authorization_revision" IS NULL
      AND "authority_id" IS NULL AND "authority_generation" IS NULL
      AND "grant_id" IS NULL AND "grant_generation" IS NULL
      AND "grant_mode" IS NULL AND "grant_context" IS NULL
      AND "grant_session_id" IS NULL AND "grant_authority_epoch" IS NULL)
    OR ("authority_scope" = 'legacy_user'
      AND "authority_source" = 'legacy_user_compatibility'
      AND "owner_subject_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NULL
      AND "membership_authorization_revision" IS NULL
      AND "authority_id" IS NULL AND "authority_generation" IS NULL
      AND "grant_id" IS NULL AND "grant_generation" IS NULL
      AND "grant_mode" IS NULL AND "grant_context" IS NULL
      AND "grant_session_id" IS NULL AND "grant_authority_epoch" IS NULL)

    OR (authority_scope = 'user' AND authority_source = 'sender'
      AND owner_subject_id IS NOT NULL AND owner_organization_membership_id IS NOT NULL
      AND membership_authorization_revision IS NOT NULL AND membership_authorization_revision > 0
      AND authority_id IS NOT NULL AND authority_generation IS NOT NULL AND authority_generation > 0
      AND grant_id IS NULL AND grant_generation IS NULL AND grant_mode IS NULL
      AND grant_context IS NULL AND grant_session_id IS NULL AND grant_authority_epoch IS NULL)
  );

DO $sender_capture$
BEGIN
  EXECUTE format($definition$
CREATE OR REPLACE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, public, pg_temp
AS $body$
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  session_row sessions%%ROWTYPE;
  item jsonb;
  connection_row connections%%ROWTYPE;
  membership_row organization_memberships%%ROWTYPE;
  authority_row organization_user_resource_authorities%%ROWTYPE;
  canonical jsonb;
  existing_digest bytea;
  existing_snapshot jsonb;
  initiating_subject text;
  verified_causal_subject text := coalesce(
    nullif(current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(current_setting('opengeni.subject_id', true), '')
  );
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.personal_connection_delegations IS NOT DISTINCT FROM OLD.personal_connection_delegations
    THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NEW;
    END IF;
    IF NEW.status <> 'queued' OR EXISTS (
      SELECT 1 FROM session_turn_attempts attempt
      WHERE attempt.turn_id = NEW.id AND attempt.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'accepted connection authority cannot change after claim'
        USING ERRCODE = '42501';
    END IF;
    DELETE FROM turn_connection_authority_snapshots snapshot
    WHERE snapshot.turn_id = NEW.id AND snapshot.workspace_id = NEW.workspace_id;
  END IF;
  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  WHERE session_value.id = NEW.session_id
    AND session_value.account_id = NEW.account_id
    AND session_value.workspace_id = NEW.workspace_id
  FOR SHARE;
  initiating_subject := coalesce(
    nullif(btrim(NEW.initiating_human_subject_id), ''),
    CASE WHEN NEW.initiator_kind = 'subject'
      THEN nullif(btrim(NEW.initiator_subject_id), '') END
  );

  FOR item IN
    SELECT value FROM jsonb_array_elements(NEW.personal_connection_delegations)
  LOOP
    IF item ? 'userDelegation' THEN
      RAISE EXCEPTION 'connection grants are retired; refresh the client' USING ERRCODE = '22023';
    END IF;
    -- Social uses a distinct store. It is not activated here and must never
    -- smuggle the common connection-authority envelope past this boundary.
    IF item ->> 'connectionType' = 'social' THEN
      CONTINUE;
    END IF;
    IF nullif(item ->> 'serverId', '') IS NULL
      OR octet_length(item ->> 'serverId') > 256
      OR nullif(item ->> 'connectionId', '') IS NULL
    THEN
      RAISE EXCEPTION 'invalid accepted connection selection' USING ERRCODE = '22023';
    END IF;
    IF initiating_subject IS NULL OR verified_causal_subject IS DISTINCT FROM initiating_subject THEN
      RAISE EXCEPTION 'accepted connection authority causal human is unverified' USING ERRCODE = '42501';
    END IF;
    SELECT connection_value.* INTO connection_row
    FROM opengeni_private.read_sender_connection(
      NEW.account_id, nullif(item ->> 'originWorkspaceId', '')::uuid,
      (item ->> 'connectionId')::uuid, initiating_subject
    ) connection_value;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'accepted connection selection is unavailable'
        USING ERRCODE = '42501';
    END IF;

    IF connection_row.authority_scope <> 'user' THEN
      RAISE EXCEPTION 'accepted personal connection scope is unavailable'
        USING ERRCODE = '42501';
    END IF;
    IF initiating_subject IS NULL OR connection_row.subject_id IS DISTINCT FROM initiating_subject
      OR connection_row.status <> 'active'
      OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(item ->> 'providerDomain')
      OR (item ? 'kind' AND connection_row.kind IS DISTINCT FROM item ->> 'kind')
    THEN
      RAISE EXCEPTION 'accepted personal connection identity is unavailable'
        USING ERRCODE = '42501';
    END IF;
    IF verified_causal_subject IS DISTINCT FROM initiating_subject THEN
      RAISE EXCEPTION 'accepted connection authority causal human is unverified'
        USING ERRCODE = '42501';
    END IF;

    SELECT membership.* INTO STRICT membership_row
    FROM organization_memberships membership
    WHERE membership.id = connection_row.owner_organization_membership_id
      AND membership.account_id = NEW.account_id
      AND membership.subject_id = initiating_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
    FOR SHARE;
    IF membership_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = NEW.account_id
          AND workspace_membership.workspace_id = NEW.workspace_id
          AND workspace_membership.subject_id = initiating_subject
      )
    THEN
      RAISE EXCEPTION 'personal connection owner lacks target workspace access'
        USING ERRCODE = '42501';
    END IF;

    SELECT authority.* INTO STRICT authority_row
    FROM organization_user_resource_authorities authority
    WHERE authority.id = connection_row.authority_id
      AND authority.account_id = NEW.account_id
      AND authority.organization_membership_id = membership_row.id
      AND authority.resource_kind = 'connection'
      AND authority.resource_id = connection_row.id
      AND authority.origin_workspace_id = connection_row.origin_workspace_id
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
    FOR SHARE;

    IF nullif(item ->> 'originWorkspaceId', '')::uuid
      IS DISTINCT FROM connection_row.origin_workspace_id
    THEN
      RAISE EXCEPTION 'accepted connection origin is not server-resolved'
        USING ERRCODE = '42501';
    END IF;

    canonical := jsonb_build_object(
      'organizationId', NEW.account_id,
      'originWorkspaceId', connection_row.origin_workspace_id,
      'targetWorkspaceId', NEW.workspace_id,
      'targetSessionId', NEW.session_id,
      'targetSessionVisibility', session_row.visibility,
      'targetSessionAuthorityEpoch', session_row.authority_epoch,
      'acceptedWork', jsonb_build_object('kind', 'turn', 'turnId', NEW.id),
      'connectionId', connection_row.id,
      'connectionGeneration', connection_row.authority_generation,
      'connectionStatus', 'active',
      'providerDomain', lower(connection_row.provider_domain),
      'connectionKind', connection_row.kind,
      'scope', 'user',
      'ownerSubjectId', initiating_subject,
      'ownerOrganizationMembershipId', membership_row.id,
      'ownerMembershipAuthorizationRevision', membership_row.authorization_revision,
      'authoritySource', 'sender',
      'selectionSources', jsonb_build_array('mcp:' || (item ->> 'serverId')),
      'userDelegation', NULL
    );

    SELECT snapshot.snapshot_digest, snapshot.canonical_snapshot
    INTO existing_digest, existing_snapshot
    FROM turn_connection_authority_snapshots snapshot
    WHERE snapshot.turn_id = NEW.id AND snapshot.server_id = item ->> 'serverId';
    IF FOUND THEN
      IF existing_snapshot IS DISTINCT FROM canonical
        OR existing_digest IS DISTINCT FROM digest(convert_to(canonical::text, 'UTF8'), 'sha256')
      THEN
        RAISE EXCEPTION 'accepted connection authority changed across recovery'
          USING ERRCODE = '42501';
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO turn_connection_authority_snapshots (
      account_id, workspace_id, session_id, turn_id, server_id,
      connection_id, connection_generation, origin_workspace_id,
      provider_domain, connection_kind, authority_scope, authority_source, owner_subject_id,
      owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, grant_id, grant_generation,
      grant_mode, grant_context, grant_session_id, grant_authority_epoch,
      session_visibility, session_authority_epoch, canonical_snapshot, snapshot_digest
    ) VALUES (
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.id, item ->> 'serverId',
      connection_row.id, connection_row.authority_generation,
      connection_row.origin_workspace_id, lower(connection_row.provider_domain),
      connection_row.kind, 'user', 'sender', initiating_subject, membership_row.id,
      membership_row.authorization_revision, authority_row.id, authority_row.generation,
      NULL, NULL, NULL, NULL, NULL, NULL,
      session_row.visibility, session_row.authority_epoch, canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256')
    );
  END LOOP;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE;
END
$body$
$definition$, current_schema());
END
$sender_capture$;
REVOKE ALL ON FUNCTION opengeni_private.capture_accepted_turn_connection_authorities() FROM PUBLIC;

DROP TRIGGER accepted_turn_connection_authority_capture ON session_turns;
CREATE TRIGGER accepted_turn_connection_authority_capture
  AFTER INSERT OR UPDATE OF personal_connection_delegations ON session_turns
  FOR EACH ROW WHEN (NEW.scheduled_task_run_id IS NULL)
  EXECUTE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities();
DROP FUNCTION opengeni_private.capture_accepted_turn_connection_authorities_0264();

CREATE OR REPLACE FUNCTION resolve_accepted_connection_use(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_physical_request_id uuid,
  p_use_phase text, p_server_id text, p_connection_id uuid,
  p_provider_domain text, p_connection_kind text, p_subject_scope text,
  p_owner_subject_id text DEFAULT NULL
) RETURNS TABLE (
  authorization_status text, denial_reason text, resolved_connection_id uuid,
  connection_generation bigint, origin_workspace_id uuid,
  resolved_connection_kind text, authority_scope text, owner_subject_id text,
  authority_id uuid, grant_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
#variable_conflict use_column
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  prior record;
  connection_row record;
  snapshot record;
  session_row record;
  turn_row record;
  audit_initiator_kind text;
  audit_initiator_subject text;
  audit_initiating_human text;
  audit_authority_epoch integer;
  audit_authority_visibility text;
  audit_owner_membership uuid;
  request_digest bytea;
  has_prior boolean := false;
  reason text;
  scheduled_run_id uuid;
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_execution_generation <= 0
    OR p_use_phase NOT IN ('credential_resolution', 'provider_request')
    OR nullif(btrim(p_server_id), '') IS NULL OR octet_length(p_server_id) > 256
  THEN RAISE EXCEPTION 'connection use scope mismatch' USING ERRCODE = '42501';
  END IF;
  request_digest := digest(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'sessionId', p_session_id, 'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'usePhase', p_use_phase,
    'serverId', p_server_id, 'connectionId', p_connection_id,
    'providerDomain', lower(p_provider_domain), 'connectionKind', p_connection_kind,
    'subjectScope', p_subject_scope, 'ownerSubjectId', p_owner_subject_id
  )::text, 'UTF8'), 'sha256');

  -- Canonical lifecycle lock prefix: control -> workspace -> session -> turn -> attempt.
  PERFORM 1 FROM workspace_inference_controls control_row
  WHERE control_row.account_id = p_account_id AND control_row.workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM workspaces workspace_value
    WHERE workspace_value.account_id = p_account_id AND workspace_value.id = p_workspace_id
    FOR KEY SHARE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    SELECT session_value.* INTO session_row FROM sessions session_value
    WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
    FOR NO KEY UPDATE;
    IF NOT FOUND OR session_row.active_turn_id IS DISTINCT FROM p_turn_id
      OR session_row.status = 'cancelled'
    THEN reason := 'session_identity_changed'; END IF;
    -- Attribution evidence (0280): captured from the row this same
    -- transaction locked, NULL when the fence never loaded it.
    audit_authority_epoch := session_row.authority_epoch;
    audit_authority_visibility := session_row.visibility;
    audit_owner_membership := session_row.owner_organization_membership_id;
  END IF;
  IF reason IS NULL THEN
    SELECT turn_value.* INTO turn_row FROM session_turns turn_value
    WHERE turn_value.id = p_turn_id AND turn_value.account_id = p_account_id
      AND turn_value.workspace_id = p_workspace_id AND turn_value.session_id = p_session_id
      AND turn_value.active_attempt_id = p_attempt_id
      AND turn_value.execution_generation = p_execution_generation
      AND turn_value.status = 'running'
    FOR UPDATE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
    -- Causal-initiator evidence (0280): the frozen turn identity, recorded
    -- verbatim (a pre-0096 sentinel stays the sentinel), NULL when the turn
    -- fence never matched a row.
    audit_initiator_kind := turn_row.initiator_kind;
    audit_initiator_subject := turn_row.initiator_subject_id;
    audit_initiating_human := turn_row.initiating_human_subject_id;
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turn_attempts attempt
    WHERE attempt.id = p_attempt_id AND attempt.account_id = p_account_id
      AND attempt.workspace_id = p_workspace_id AND attempt.session_id = p_session_id
      AND attempt.turn_id = p_turn_id
      AND attempt.execution_generation = p_execution_generation
      AND attempt.state IN ('claimed', 'running')
      AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
      AND attempt.authority_visibility = session_row.visibility
      AND attempt.authority_epoch = session_row.authority_epoch
      AND attempt.authority_owner_organization_membership_id
        IS NOT DISTINCT FROM session_row.owner_organization_membership_id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.session_id = p_session_id
        AND interruption.attempt_id = p_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    ) THEN reason := 'session_identity_changed'; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_physical_request_id::text, 0));
  SELECT EXISTS (SELECT 1 FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id) INTO has_prior;
  -- Only dereference `prior` inside the guarded branch: PL/pgSQL evaluates
  -- both operands of `has_prior AND prior.<field>`, and an unassigned record
  -- raises instead of yielding NULL.
  IF has_prior THEN
    SELECT audit.* INTO STRICT prior FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id;
    IF prior.request_digest IS DISTINCT FROM request_digest THEN
      RAISE EXCEPTION 'physical connection request id was reused for different work'
        USING ERRCODE = '23505';
    END IF;
    IF reason IS NULL AND prior.outcome = 'denied' THEN
      authorization_status := prior.outcome; denial_reason := prior.denial_reason;
      RETURN NEXT; PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN;
    END IF;
  END IF;

  IF reason IS NULL THEN
    SELECT authority_snapshot.* INTO snapshot
    FROM turn_connection_authority_snapshots authority_snapshot
    WHERE authority_snapshot.turn_id = p_turn_id
      AND authority_snapshot.server_id = p_server_id
      AND authority_snapshot.account_id = p_account_id
      AND authority_snapshot.workspace_id = p_workspace_id
      AND authority_snapshot.session_id = p_session_id;
    IF FOUND THEN
      scheduled_run_id := CASE
        WHEN snapshot.canonical_snapshot -> 'acceptedWork' ->> 'kind' = 'scheduled_task'
        THEN nullif(snapshot.canonical_snapshot -> 'acceptedWork' ->> 'runId', '')::uuid
        ELSE NULL END;
      SELECT connection_value.* INTO connection_row
      FROM opengeni_private.read_sender_connection(
        p_account_id, snapshot.origin_workspace_id, snapshot.connection_id, snapshot.owner_subject_id
      ) connection_value;
      IF snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'), 'sha256'
      ) THEN reason := 'accepted_snapshot_digest_changed';
      ELSIF NOT FOUND THEN reason := 'connection_missing';
      ELSIF snapshot.authority_source IS DISTINCT FROM 'sender'
        OR snapshot.authority_scope IS DISTINCT FROM 'user'
        OR p_subject_scope IS DISTINCT FROM 'subject'
        OR p_connection_id IS DISTINCT FROM snapshot.connection_id
        OR lower(p_provider_domain) IS DISTINCT FROM snapshot.provider_domain
        OR (p_connection_kind IS NOT NULL
          AND p_connection_kind IS DISTINCT FROM snapshot.connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'user'
        OR connection_row.subject_id IS DISTINCT FROM snapshot.owner_subject_id
        OR connection_row.owner_organization_membership_id
          IS DISTINCT FROM snapshot.owner_organization_membership_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM snapshot.origin_workspace_id
      THEN reason := 'connection_owner_changed';
      ELSIF connection_row.authority_generation IS DISTINCT FROM snapshot.connection_generation
      THEN reason := 'connection_generation_changed';
      ELSIF session_row.visibility IS DISTINCT FROM snapshot.session_visibility
        OR session_row.authority_epoch IS DISTINCT FROM snapshot.session_authority_epoch
      THEN reason := 'session_authority_epoch_changed';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = p_account_id
          AND membership.subject_id = snapshot.owner_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot.owner_subject_id
          ))
      ) THEN reason := 'owner_membership_inactive';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id AND authority.account_id = p_account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = 'connection'
          AND authority.resource_id = snapshot.connection_id
          AND authority.origin_workspace_id = snapshot.origin_workspace_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
      ) THEN reason := 'authority_status_inactive';
      END IF;
      resolved_connection_id := snapshot.connection_id;
      connection_generation := snapshot.connection_generation;
      origin_workspace_id := snapshot.origin_workspace_id;
      resolved_connection_kind := snapshot.connection_kind;
      authority_scope := snapshot.authority_scope;
      owner_subject_id := snapshot.owner_subject_id;
      authority_id := snapshot.authority_id;
      grant_id := snapshot.grant_id;
    ELSIF p_subject_scope = 'workspace' THEN
      -- Workspace lane (0279): a workspace-owned connection is ambient shared
      -- workspace capability, never frozen on the turn, so it is validated
      -- against the live row inside the same canonical lifecycle fences and
      -- recorded in the same idempotent audit facts. A frozen per-turn
      -- personal snapshot for this server takes the snapshot lane above and
      -- therefore denies a workspace-scope request outright (fail closed).
      SELECT connection_value.* INTO connection_row
      FROM opengeni_private.read_sender_connection(p_account_id, p_workspace_id, p_connection_id, NULL) connection_value;
      IF p_connection_id IS NULL OR NOT FOUND THEN reason := 'connection_missing';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'workspace'
        OR p_owner_subject_id IS NOT NULL
        OR connection_row.workspace_id IS DISTINCT FROM p_workspace_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM p_workspace_id
        OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(p_provider_domain)
        OR (p_connection_kind IS NOT NULL
          AND connection_row.kind IS DISTINCT FROM p_connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSE
        resolved_connection_id := connection_row.id;
        connection_generation := connection_row.authority_generation;
        origin_workspace_id := connection_row.origin_workspace_id;
        resolved_connection_kind := connection_row.kind;
        authority_scope := 'workspace';
      END IF;
    ELSE
      reason := 'accepted_attempt_authority_required';
    END IF;
  END IF;

  authorization_status := CASE WHEN reason IS NULL THEN 'authorized' ELSE 'denied' END;
  denial_reason := reason;
  IF NOT has_prior THEN
    INSERT INTO connection_use_audit_facts (
      physical_request_id, use_phase, request_digest, account_id, workspace_id,
      session_id, turn_id, attempt_id, execution_generation, server_id,
      connection_id, connection_generation, authority_scope, owner_subject_id,
      authority_id, grant_id, outcome, denial_reason,
      initiator_kind, initiator_subject_id, initiating_human_subject_id,
      authority_epoch, authority_visibility,
      authority_owner_organization_membership_id
    ) VALUES (
      p_physical_request_id, p_use_phase, request_digest, p_account_id,
      p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
      p_execution_generation, p_server_id, resolved_connection_id,
      connection_generation, authority_scope, owner_subject_id, authority_id,
      grant_id, authorization_status, denial_reason,
      audit_initiator_kind, audit_initiator_subject, audit_initiating_human,
      audit_authority_epoch, audit_authority_visibility, audit_owner_membership
    ) ON CONFLICT (physical_request_id) DO NOTHING;
  END IF;
  RETURN NEXT;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true);
EXCEPTION WHEN OTHERS THEN RAISE;
END
$body$;


-- Connection ownership does not depend on the private-conversation product.
CREATE FUNCTION list_owned_connection_accounts(p_account_id uuid, p_workspace_id uuid)
RETURNS TABLE(connection_id uuid, origin_workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN RAISE EXCEPTION 'connection account scope mismatch' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT a.resource_id, a.origin_workspace_id
  FROM organization_user_resource_authorities a
  JOIN organization_memberships m ON m.id = a.organization_membership_id AND m.account_id = a.account_id
  WHERE a.account_id = p_account_id AND a.resource_kind = 'connection'
    AND m.subject_id = caller_subject AND m.status = 'active' AND m.revoked_at IS NULL
    AND a.status = 'active' AND a.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p_workspace_id AND w.account_id = p_account_id
      AND (m.personal_workspace_id = w.id OR EXISTS (
        SELECT 1 FROM workspace_memberships wm WHERE wm.account_id = p_account_id
          AND wm.workspace_id = w.id AND wm.subject_id = caller_subject)))
  ORDER BY a.resource_id;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true);
EXCEPTION WHEN OTHERS THEN RAISE;
END
$body$;
REVOKE ALL ON FUNCTION list_owned_connection_accounts(uuid, uuid) FROM PUBLIC;

-- Each occurrence captures current sender-owned accounts once. Historical
-- grant columns remain readable audit evidence; new rows never populate them.
ALTER TABLE scheduled_task_run_connection_authority_snapshots
  ALTER COLUMN grant_id DROP NOT NULL,
  ALTER COLUMN grant_generation DROP NOT NULL,
  ALTER COLUMN grant_mode DROP NOT NULL,
  ALTER COLUMN grant_context DROP NOT NULL,
  DROP CONSTRAINT scheduled_run_connection_authority_shape_chk,
  ADD CONSTRAINT scheduled_run_connection_authority_shape_chk CHECK (
    task_authority_revision > 0 AND execution_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(server_id) BETWEEN 1 AND 256 AND connection_generation > 0
    AND (selected_kind IS NULL OR selected_kind IN ('oauth2','api_key','app_install','delegated'))
    AND (connection_type IS NULL OR connection_type IN ('mcp','atlassian','github_personal'))
    AND membership_authorization_revision > 0 AND authority_generation > 0
    AND session_visibility IN ('user_private','workspace_shared')
    AND cardinality(selection_sources) > 0
    AND (
      (canonical_snapshot ->> 'authoritySource' = 'sender'
        AND grant_id IS NULL AND grant_generation IS NULL AND grant_mode IS NULL
        AND grant_context IS NULL AND grant_session_id IS NULL AND grant_authority_epoch IS NULL)
      OR (canonical_snapshot ->> 'authoritySource' IS DISTINCT FROM 'sender'
        AND grant_id IS NOT NULL AND grant_generation > 0
        AND grant_mode IN ('once','session','always') AND grant_context = session_visibility)
    )
  );

CREATE OR REPLACE FUNCTION admit_scheduled_task_run_connection_authorities()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  prior_subject text := current_setting('opengeni.subject_id', true);
  item jsonb;
  connection_row connections%ROWTYPE;
  membership_row organization_memberships%ROWTYPE;
  authority_row organization_user_resource_authorities%ROWTYPE;
  target_row sessions%ROWTYPE;
  owner_subject text;
  target_id uuid;
  canonical jsonb;
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF NEW.action_kind <> 'agent_turn' THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NEW; END IF;
  SELECT task.owner_subject_id INTO STRICT owner_subject FROM scheduled_tasks task
  WHERE task.id = NEW.task_id AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id FOR SHARE;
  IF NEW.accepted_execution_snapshot ->> 'causalHumanSubjectId' IS DISTINCT FROM owner_subject
  THEN RAISE EXCEPTION 'scheduled account owner changed' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.subject_id', coalesce(owner_subject, ''), true);
  target_id := nullif(NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'sessionId','')::uuid;
  IF target_id IS NOT NULL THEN
    SELECT value.* INTO STRICT target_row FROM sessions value
    WHERE value.id = target_id AND value.account_id = NEW.account_id
      AND value.workspace_id = NEW.workspace_id FOR SHARE;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(
    NEW.accepted_execution_snapshot -> 'personalConnectionDelegations'
  ) ORDER BY value ->> 'connectionId', value ->> 'serverId'
  LOOP
    IF item ? 'userDelegation' OR owner_subject IS NULL
      OR item ->> 'ownerSubjectId' IS DISTINCT FROM owner_subject
    THEN RAISE EXCEPTION 'scheduled account selection differs from its owner' USING ERRCODE = '42501'; END IF;
    -- Social credentials have their own existing owner-scoped store/resolver.
    IF item ->> 'connectionType' = 'social' THEN CONTINUE; END IF;
    SELECT value.* INTO connection_row FROM opengeni_private.read_sender_connection(
      NEW.account_id, nullif(item ->> 'originWorkspaceId','')::uuid,
      (item ->> 'connectionId')::uuid, owner_subject
    ) value;
    IF NOT FOUND OR connection_row.authority_scope <> 'user'
      OR connection_row.subject_id IS DISTINCT FROM owner_subject
      OR connection_row.status <> 'active'
      OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(item ->> 'providerDomain')
      OR (item ? 'kind' AND item ->> 'kind' IS DISTINCT FROM connection_row.kind)
    THEN RAISE EXCEPTION 'scheduled connection is unavailable' USING ERRCODE = '42501'; END IF;
    SELECT value.* INTO STRICT membership_row FROM organization_memberships value
    WHERE value.id = connection_row.owner_organization_membership_id
      AND value.account_id = NEW.account_id AND value.subject_id = owner_subject
      AND value.status = 'active' AND value.revoked_at IS NULL FOR SHARE;
    IF membership_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id
      AND NOT EXISTS (SELECT 1 FROM workspace_memberships value
        WHERE value.account_id = NEW.account_id AND value.workspace_id = NEW.workspace_id
          AND value.subject_id = owner_subject)
    THEN RAISE EXCEPTION 'scheduled account owner lacks workspace access' USING ERRCODE = '42501'; END IF;
    SELECT value.* INTO STRICT authority_row FROM organization_user_resource_authorities value
    WHERE value.id = connection_row.authority_id AND value.account_id = NEW.account_id
      AND value.organization_membership_id = membership_row.id
      AND value.resource_kind = 'connection' AND value.resource_id = connection_row.id
      AND value.origin_workspace_id = connection_row.origin_workspace_id
      AND value.status = 'active' AND value.revoked_at IS NULL FOR SHARE;
    canonical := jsonb_build_object(
      'authoritySource','sender', 'runId',NEW.id, 'taskId',NEW.task_id,
      'taskAuthorityRevision',NEW.task_authority_revision,'executionDigest',NEW.task_execution_digest,
      'organizationId',NEW.account_id,'workspaceId',NEW.workspace_id,
      'serverId',item ->> 'serverId','connectionId',connection_row.id,
      'connectionGeneration',connection_row.authority_generation,
      'originWorkspaceId',connection_row.origin_workspace_id,
      'providerDomain',lower(connection_row.provider_domain),'connectionKind',connection_row.kind,
      'ownerSubjectId',owner_subject,'ownerOrganizationMembershipId',membership_row.id,
      'membershipAuthorizationRevision',membership_row.authorization_revision,
      'authorityId',authority_row.id,'authorityGeneration',authority_row.generation,
      'targetSessionId',target_id,'sessionVisibility',coalesce(target_row.visibility,'workspace_shared'),
      'sessionAuthorityEpoch',target_row.authority_epoch,
      'selection',item
    );
    INSERT INTO scheduled_task_run_connection_authority_snapshots (
      run_id,task_id,task_authority_revision,account_id,workspace_id,execution_digest,
      server_id,connection_id,connection_generation,origin_workspace_id,provider_domain,
      connection_kind,selected_kind,connection_type,owner_subject_id,
      owner_organization_membership_id,membership_authorization_revision,authority_id,authority_generation,
      target_session_id,session_visibility,session_authority_epoch,selection_sources,
      canonical_snapshot,snapshot_digest
    ) VALUES (
      NEW.id,NEW.task_id,NEW.task_authority_revision,NEW.account_id,NEW.workspace_id,NEW.task_execution_digest,
      item ->> 'serverId',connection_row.id,connection_row.authority_generation,connection_row.origin_workspace_id,
      lower(connection_row.provider_domain),connection_row.kind,item ->> 'kind',item ->> 'connectionType',owner_subject,
      membership_row.id,membership_row.authorization_revision,authority_row.id,authority_row.generation,
      target_id,coalesce(target_row.visibility,'workspace_shared'),target_row.authority_epoch,
      ARRAY['mcp:' || (item ->> 'serverId')],canonical,digest(convert_to(canonical::text,'UTF8'),'sha256')
    );
  END LOOP;
  PERFORM set_config('opengeni.subject_id', coalesce(prior_subject, ''), true);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION admit_scheduled_agent_run_execution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_membership_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  task_row record;
  target_row record;
  latest_started record;
  task_snapshot jsonb;
  target_snapshot jsonb;
  expected_target_session_id uuid;
  connection_subject text;
  connection_subject_count integer;
  personal_resource_subject text;
  personal_resource_subject_count integer;
  revision_authority_subject text;
  revision_authority_membership_id uuid;
  revision_authority_membership_revision bigint;
  accepted_causal_subject text;
  generated_variable_set record;
  generated_rig record;
  generated_rig_version record;
  expected_rig_default_variable_sets jsonb;
  generated_slack record;
  workspace_settings jsonb;
  deployment_depth record;
  expected_depth integer;
  expected_depth_source text;
  expected_compaction_mode text;
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = NEW.task_id
    AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR UPDATE;
  IF task_row.status <> 'active'
    OR task_row.deleted_at IS NOT NULL
    OR NEW.action_kind IS DISTINCT FROM task_row.action ->> 'kind'
  THEN RAISE EXCEPTION 'scheduled run action or task lifecycle changed during admission'
    USING ERRCODE = '42501'; END IF;
  IF NEW.action_kind <> 'agent_turn' THEN
    IF NEW.accepted_execution_snapshot IS NOT NULL
      OR NEW.accepted_execution_digest IS NOT NULL
    THEN RAISE EXCEPTION 'non-agent scheduled run cannot carry agent execution truth'
      USING ERRCODE = '42501'; END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
  END IF;
  task_snapshot := NEW.accepted_execution_snapshot -> 'task';
  IF task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
    OR NEW.accepted_execution_snapshot ->> 'version' IS DISTINCT FROM '1'
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'id' IS DISTINCT FROM NEW.task_id::text
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'accountId'
      IS DISTINCT FROM NEW.account_id::text
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'workspaceId'
      IS DISTINCT FROM NEW.workspace_id::text
    OR (NEW.accepted_execution_snapshot -> 'task' ->> 'authorityRevision')::bigint
      IS DISTINCT FROM NEW.task_authority_revision
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'executionDigest'
      IS DISTINCT FROM NEW.task_execution_digest
    OR NEW.accepted_execution_snapshot -> 'task' ->> 'status' IS DISTINCT FROM 'active'
    OR NEW.accepted_execution_snapshot -> 'task' -> 'action' ->> 'kind'
      IS DISTINCT FROM 'agent_turn'
    OR task_snapshot -> 'schedule' IS DISTINCT FROM task_row.schedule
    OR task_snapshot ->> 'temporalScheduleId' IS DISTINCT FROM task_row.temporal_schedule_id
    OR task_snapshot ->> 'runMode' IS DISTINCT FROM task_row.run_mode
    OR task_snapshot ->> 'overlapPolicy' IS DISTINCT FROM task_row.overlap_policy
    OR task_snapshot -> 'action' IS DISTINCT FROM task_row.action
    OR task_snapshot -> 'agentConfig' IS DISTINCT FROM task_row.agent_config
    OR task_snapshot ->> 'createdBy' IS NULL
    OR task_snapshot -> 'createdBy' ->> 'kind' IS DISTINCT FROM task_row.created_by_kind
    OR task_snapshot -> 'createdBy' ->> 'subjectId'
      IS DISTINCT FROM task_row.created_by_subject_id
    OR task_snapshot -> 'createdByContext' IS DISTINCT FROM task_row.created_by_context
    OR task_snapshot -> 'metadata' IS DISTINCT FROM task_row.metadata
    OR nullif(task_snapshot ->> 'variableSetId', '')::uuid
      IS DISTINCT FROM task_row.variable_set_id
    OR nullif(task_snapshot ->> 'environmentId', '')::uuid
      IS DISTINCT FROM task_row.variable_set_id
    OR nullif(task_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM task_row.rig_id
    OR (
      task_row.run_mode = 'existing_session'
      AND (
        nullif(task_snapshot ->> 'targetSessionId', '')::uuid
          IS DISTINCT FROM task_row.reusable_session_id
        OR nullif(task_snapshot ->> 'reusableSessionId', '')::uuid IS NOT NULL
      )
    )
    OR (
      task_row.run_mode <> 'existing_session'
      AND (
        nullif(task_snapshot ->> 'reusableSessionId', '')::uuid
          IS DISTINCT FROM task_row.reusable_session_id
        OR nullif(task_snapshot ->> 'targetSessionId', '')::uuid IS NOT NULL
      )
    )
    OR NEW.accepted_execution_snapshot -> 'xaiProviderAccountAuthoritySnapshot'
      IS DISTINCT FROM task_row.xai_provider_account_authority_snapshot
  THEN
    RAISE EXCEPTION 'scheduled agent run accepted execution changed during admission'
      USING ERRCODE = '40001';
  END IF;

  SELECT min(selected ->> 'ownerSubjectId'),
      count(DISTINCT selected ->> 'ownerSubjectId')::integer
    INTO connection_subject, connection_subject_count
  FROM jsonb_array_elements(NEW.accepted_execution_snapshot -> 'personalConnectionDelegations') selected
  WHERE nullif(btrim(selected ->> 'ownerSubjectId'), '') IS NOT NULL;
  SELECT min(authority.initiating_human_subject_id),
      count(DISTINCT authority.initiating_human_subject_id)::integer
    INTO personal_resource_subject, personal_resource_subject_count
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = NEW.task_authority_revision
    AND authority.account_id = NEW.account_id
    AND authority.workspace_id = NEW.workspace_id;
  SELECT authority.subject_id, authority.organization_membership_id,
      authority.membership_authorization_revision
    INTO revision_authority_subject, revision_authority_membership_id,
      revision_authority_membership_revision
  FROM scheduled_task_revision_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = NEW.task_authority_revision
    AND authority.account_id = NEW.account_id
    AND authority.workspace_id = NEW.workspace_id;
  IF connection_subject_count > 1
    OR personal_resource_subject_count > 1
    OR NEW.accepted_execution_snapshot ->> 'connectionAuthoritySubjectId'
      IS DISTINCT FROM connection_subject
    OR NEW.accepted_execution_snapshot ->> 'personalResourceAuthoritySubjectId'
      IS DISTINCT FROM personal_resource_subject
    OR (
      revision_authority_subject IS NOT NULL
      AND personal_resource_subject IS NOT NULL
      AND revision_authority_subject IS DISTINCT FROM personal_resource_subject
    )
    OR (
      revision_authority_subject IS NOT NULL
      AND connection_subject IS NOT NULL
      AND revision_authority_subject IS DISTINCT FROM connection_subject
    )
    OR (
      connection_subject IS NOT NULL
      AND personal_resource_subject IS NOT NULL
      AND connection_subject IS DISTINCT FROM personal_resource_subject
    )
    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
      AND (
        task_row.created_by_kind <> 'subject'
        OR NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId'
          IS DISTINCT FROM task_row.created_by_subject_id
        OR (
          connection_subject IS NOT NULL
          AND connection_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
        OR (
          personal_resource_subject IS NOT NULL
          AND personal_resource_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
        OR (
          revision_authority_subject IS NOT NULL
          AND revision_authority_subject IS DISTINCT FROM task_row.created_by_subject_id
        )
      )
    )
    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' <> 'user'
      AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId' IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'scheduled accepted causal subject differs from frozen authority'
      USING ERRCODE = '42501';
  END IF;
  accepted_causal_subject := coalesce(
    revision_authority_subject,
    personal_resource_subject,
    connection_subject,
    CASE WHEN task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
      THEN task_row.created_by_subject_id END
  );
  IF NEW.accepted_execution_snapshot ->> 'causalHumanSubjectId'
      IS DISTINCT FROM accepted_causal_subject
    OR NEW.accepted_execution_snapshot -> 'causalHumanAuthority'
      IS DISTINCT FROM (CASE WHEN revision_authority_subject IS NULL THEN 'null'::jsonb
        ELSE jsonb_build_object(
          'subjectId', revision_authority_subject,
          'organizationMembershipId', revision_authority_membership_id,
          'membershipAuthorizationRevision',
            revision_authority_membership_revision
        ) END)
    OR (
      NEW.status = 'queued'
      AND
      revision_authority_subject IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = revision_authority_membership_id
          AND membership.account_id = NEW.account_id
          AND membership.subject_id = revision_authority_subject
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.authorization_revision =
            revision_authority_membership_revision
          AND (
            membership.personal_workspace_id = NEW.workspace_id
            OR EXISTS (
              SELECT 1 FROM workspace_memberships workspace_membership
              WHERE workspace_membership.account_id = NEW.account_id
                AND workspace_membership.workspace_id = NEW.workspace_id
                AND workspace_membership.subject_id = revision_authority_subject
            )
          )
      )
    )
    OR (
      (
        EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.account_id = NEW.account_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.id IN (
              task_row.variable_set_id,
              nullif(
                NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'variableSetId', ''
              )::uuid
            )
        )
        OR EXISTS (
          SELECT 1 FROM rigs rig
          WHERE rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
            AND rig.id IN (
              task_row.rig_id,
              nullif(
                NEW.accepted_execution_snapshot -> 'targetSessionExecution' ->> 'rigId', ''
              )::uuid
            )
        )
      )
      AND accepted_causal_subject IS NULL
    )
  THEN
    RAISE EXCEPTION 'scheduled accepted causal human is invalid'
      USING ERRCODE = '42501';
  END IF;

  expected_target_session_id := CASE
    WHEN task_row.run_mode = 'existing_session' THEN task_row.reusable_session_id
    WHEN task_row.run_mode = 'reusable_session' THEN task_row.reusable_session_id
    ELSE NULL
  END;
  target_snapshot := NEW.accepted_execution_snapshot -> 'targetSessionExecution';
  -- A targeted occurrence whose exact session no longer exists is a
  -- deterministic terminal outcome for that occurrence, never a retry loop.
  IF task_row.run_mode = 'existing_session' AND expected_target_session_id IS NULL THEN
    NEW.status := 'failed';
    NEW.error := 'scheduled_target_session_unavailable';
    NEW.completed_at := clock_timestamp();
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
  END IF;
  IF expected_target_session_id IS NULL THEN
    IF target_snapshot IS DISTINCT FROM 'null'::jsonb
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding' = 'null'::jsonb
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'nestedAgentDepthPolicySource' NOT IN ('session','workspace','deployment','default')
      OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'effectiveMaxNestedAgentDepth')::integer < 0
      OR (
        task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL
        AND (
          NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM 'session'
          OR (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
            ->> 'effectiveMaxNestedAgentDepth')::integer
            IS DISTINCT FROM (task_row.agent_config ->> 'maxNestedAgentDepth')::integer
        )
      )
      OR (
        task_row.agent_config ->> 'maxNestedAgentDepth' IS NULL
        AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'nestedAgentDepthPolicySource' = 'session'
      )
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
        ->> 'codexCompactionMode' NOT IN ('portable','remote_v2')
      OR (
        NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%'
        AND NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'codexCompactionMode' <> 'portable'
      )
    THEN
      RAISE EXCEPTION 'generated scheduled run cannot carry target-session execution policy'
        USING ERRCODE = '42501';
    END IF;

    IF task_row.variable_set_id IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedVariableSet' IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled generated Variable Set changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT variable_set.id, variable_set.generation, variable_set.status
        INTO generated_variable_set
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = NEW.account_id
      FOR SHARE;
      IF NOT FOUND
        OR generated_variable_set.status <> 'active'
        OR NEW.accepted_execution_snapshot -> 'resolvedVariableSet' ->> 'id'
          IS DISTINCT FROM generated_variable_set.id::text
        OR (NEW.accepted_execution_snapshot -> 'resolvedVariableSet' ->> 'generation')::bigint
          IS DISTINCT FROM generated_variable_set.generation
      THEN
        RAISE EXCEPTION 'scheduled generated Variable Set changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    IF task_row.rig_id IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedRig' IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled generated Rig changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT rig_value.id, rig_value.status INTO generated_rig
      FROM rigs rig_value
      WHERE rig_value.id = task_row.rig_id
        AND rig_value.account_id = NEW.account_id
      FOR SHARE;
      SELECT version_value.id, version_value.default_variable_set_ids
        INTO generated_rig_version
      FROM rig_versions version_value
      WHERE version_value.rig_id = task_row.rig_id
        AND version_value.account_id = NEW.account_id
        AND version_value.active
      FOR SHARE;
      PERFORM 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.account_id = NEW.account_id
        AND variable_set.id IN (
          SELECT default_id::uuid
          FROM jsonb_array_elements_text(
            coalesce(generated_rig_version.default_variable_set_ids, '[]'::jsonb)
          ) default_id
        )
      ORDER BY variable_set.id
      FOR SHARE;
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
          ORDER BY selected.ordinality
        ),
        '[]'::jsonb
      ) INTO expected_rig_default_variable_sets
      FROM jsonb_array_elements_text(
        coalesce(generated_rig_version.default_variable_set_ids, '[]'::jsonb)
      ) WITH ORDINALITY selected(id, ordinality)
      JOIN workspace_variable_sets variable_set
        ON variable_set.id = selected.id::uuid
       AND variable_set.account_id = NEW.account_id
       AND variable_set.status = 'active';
      IF generated_rig.id IS NULL
        OR generated_rig.status <> 'active'
        OR generated_rig_version.id IS NULL
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'id'
          IS DISTINCT FROM generated_rig.id::text
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' ->> 'versionId'
          IS DISTINCT FROM generated_rig_version.id::text
        OR NEW.accepted_execution_snapshot -> 'resolvedRig' -> 'defaultVariableSets'
          IS DISTINCT FROM expected_rig_default_variable_sets
      THEN
        RAISE EXCEPTION 'scheduled generated Rig changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    IF nullif(task_row.agent_config ->> 'slackBotConnectionId', '') IS NULL THEN
      IF NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
        IS DISTINCT FROM 'null'::jsonb
      THEN
        RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      SELECT connection_value.id, connection_value.version,
          connection_value.verified_install_version, connection_value.metadata,
          connection_value.status, connection_value.subject_id,
          connection_value.provider_domain, connection_value.kind,
          connection_value.verified_install_at
        INTO generated_slack
      FROM connections connection_value
      WHERE connection_value.id = (task_row.agent_config ->> 'slackBotConnectionId')::uuid
        AND connection_value.account_id = NEW.account_id
        AND connection_value.workspace_id = NEW.workspace_id
      FOR SHARE;
      IF generated_slack.id IS NULL
        OR generated_slack.status <> 'active'
        OR generated_slack.subject_id IS NOT NULL
        OR generated_slack.provider_domain <> 'slack.com'
        OR generated_slack.kind <> 'app_install'
        OR generated_slack.verified_install_at IS NULL
        OR generated_slack.verified_install_version IS DISTINCT FROM generated_slack.version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'id'
          IS DISTINCT FROM generated_slack.id::text
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' ->> 'version')::integer
          IS DISTINCT FROM generated_slack.version
        OR (NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection'
          ->> 'verifiedInstallVersion')::integer
          IS DISTINCT FROM generated_slack.verified_install_version
        OR NEW.accepted_execution_snapshot -> 'resolvedSlackBotConnection' -> 'metadata'
          IS DISTINCT FROM generated_slack.metadata
      THEN
        RAISE EXCEPTION 'scheduled Slack bot authority changed during admission'
          USING ERRCODE = '40001';
      END IF;
    END IF;

    SELECT workspace_value.settings INTO STRICT workspace_settings
    FROM workspaces workspace_value
    WHERE workspace_value.id = NEW.workspace_id
      AND workspace_value.account_id = NEW.account_id
    FOR SHARE;
    SELECT configuration.max_nested_agent_depth, configuration.policy_source
      INTO STRICT deployment_depth
    FROM nested_agent_depth_configuration configuration
    WHERE configuration.singleton
    FOR SHARE;
    IF task_row.agent_config ->> 'maxNestedAgentDepth' IS NOT NULL THEN
      expected_depth := (task_row.agent_config ->> 'maxNestedAgentDepth')::integer;
      expected_depth_source := 'session';
    ELSIF jsonb_typeof(workspace_settings -> 'maxNestedAgentDepth') = 'number' THEN
      expected_depth := (workspace_settings ->> 'maxNestedAgentDepth')::integer;
      expected_depth_source := 'workspace';
    ELSE
      expected_depth := deployment_depth.max_nested_agent_depth;
      expected_depth_source := deployment_depth.policy_source;
    END IF;
    expected_compaction_mode := CASE
      WHEN NEW.accepted_execution_snapshot ->> 'resolvedModel' NOT LIKE 'codex/%'
        THEN 'portable'
      WHEN workspace_settings ->> 'codexCompactionDefault' = 'portable'
        THEN 'portable'
      ELSE 'remote_v2'
    END;
    IF (NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'effectiveMaxNestedAgentDepth')::integer IS DISTINCT FROM expected_depth
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'nestedAgentDepthPolicySource' IS DISTINCT FROM expected_depth_source
      OR NEW.accepted_execution_snapshot -> 'generatedSessionBinding'
          ->> 'codexCompactionMode' IS DISTINCT FROM expected_compaction_mode
    THEN
      RAISE EXCEPTION 'scheduled generated policy changed during admission'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    IF NEW.accepted_execution_snapshot -> 'generatedSessionBinding' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'targeted scheduled run cannot carry generated-session binding'
      USING ERRCODE = '42501'; END IF;
    SELECT session_value.* INTO target_row
    FROM sessions session_value
    WHERE session_value.id = expected_target_session_id
      AND session_value.account_id = NEW.account_id
      AND session_value.workspace_id = NEW.workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF NOT FOUND THEN
      -- The exact target was cancelled (or is no longer visible): settle this
      -- occurrence terminally instead of failing the activity.
      NEW.status := 'skipped';
      NEW.error := 'session_cancelled';
      NEW.completed_at := clock_timestamp();
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
    END IF;
    SELECT turn_value.* INTO latest_started
    FROM session_events event_value
    JOIN session_turns turn_value
      ON turn_value.workspace_id = event_value.workspace_id
     AND turn_value.session_id = event_value.session_id
     AND turn_value.id = event_value.turn_id
    WHERE event_value.workspace_id = NEW.workspace_id
      AND event_value.session_id = expected_target_session_id
      AND event_value.type = 'turn.started'
    ORDER BY event_value.sequence DESC
    LIMIT 1;
    IF target_snapshot ->> 'sessionId' IS DISTINCT FROM target_row.id::text
      OR target_snapshot ->> 'visibility' IS DISTINCT FROM target_row.visibility
      OR (target_snapshot ->> 'authorityEpoch')::integer
        IS DISTINCT FROM target_row.authority_epoch
      OR target_snapshot ->> 'model'
        IS DISTINCT FROM coalesce(latest_started.model, target_row.model)
      OR target_snapshot ->> 'reasoningEffort' IS DISTINCT FROM coalesce(
        latest_started.reasoning_effort,
        CASE WHEN target_row.metadata ->> 'reasoningEffort' IN (
          'none','minimal','low','medium','high','xhigh','max'
        )
          THEN target_row.metadata ->> 'reasoningEffort' ELSE 'medium' END
      )
      OR target_snapshot ->> 'latencyMode' IS DISTINCT FROM coalesce(
        latest_started.latency_mode,
        CASE WHEN target_row.metadata ->> 'latencyMode' IN ('standard','priority','fast')
          THEN target_row.metadata ->> 'latencyMode' ELSE 'standard' END
      )
      OR target_snapshot -> 'tools'
        IS DISTINCT FROM (CASE WHEN latest_started.tools_provided THEN latest_started.tools ELSE target_row.tools END)
      OR target_snapshot ->> 'sandboxBackend'
        IS DISTINCT FROM coalesce(latest_started.sandbox_backend, target_row.sandbox_backend)
      OR target_snapshot ->> 'sandboxOs'
        IS DISTINCT FROM coalesce(latest_started.sandbox_os, target_row.sandbox_os)
      OR target_snapshot -> 'firstPartyMcpTools'
        IS DISTINCT FROM target_row.first_party_mcp_tools
      OR target_snapshot -> 'firstPartyMcpPermissions'
        IS DISTINCT FROM coalesce(to_jsonb(target_row.first_party_mcp_permissions), 'null'::jsonb)
      OR target_snapshot -> 'toolPolicy' IS DISTINCT FROM target_row.tool_policy
      OR target_snapshot -> 'mcpServerIds' IS DISTINCT FROM (
        SELECT coalesce(jsonb_agg(server_value.server_id ORDER BY server_value.server_id), '[]'::jsonb)
        FROM session_mcp_servers server_value
        WHERE server_value.workspace_id = NEW.workspace_id
          AND server_value.session_id = target_row.id
      )
      OR (target_snapshot ->> 'toolPolicyVersion')::integer
        IS DISTINCT FROM target_row.tool_policy_version
      OR nullif(target_snapshot ->> 'variableSetId', '')::uuid
        IS DISTINCT FROM target_row.variable_set_id
      OR nullif(target_snapshot ->> 'variableSetGeneration', '')::bigint
        IS DISTINCT FROM (
          SELECT variable_set.generation
          FROM workspace_variable_sets variable_set
          WHERE variable_set.id = target_row.variable_set_id
            AND variable_set.account_id = NEW.account_id
        )
      OR nullif(target_snapshot ->> 'rigId', '')::uuid IS DISTINCT FROM target_row.rig_id
      OR nullif(target_snapshot ->> 'rigVersionId', '')::uuid
        IS DISTINCT FROM target_row.rig_version_id
      OR target_snapshot -> 'rigDefaultVariableSets' IS DISTINCT FROM (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
            ORDER BY selected.ordinality
          ),
          '[]'::jsonb
        )
        FROM rig_versions version_value
        CROSS JOIN LATERAL jsonb_array_elements_text(
          coalesce(version_value.default_variable_set_ids, '[]'::jsonb)
        ) WITH ORDINALITY selected(id, ordinality)
        JOIN workspace_variable_sets variable_set
          ON variable_set.id = selected.id::uuid
         AND variable_set.account_id = NEW.account_id
         AND variable_set.status = 'active'
        WHERE version_value.id = target_row.rig_version_id
          AND version_value.rig_id = target_row.rig_id
          AND version_value.account_id = NEW.account_id
      )
      OR nullif(target_snapshot ->> 'maxNestedAgentDepthOverride', '')::integer
        IS DISTINCT FROM target_row.max_nested_agent_depth_override
      OR (target_snapshot ->> 'effectiveMaxNestedAgentDepth')::integer
        IS DISTINCT FROM target_row.effective_max_nested_agent_depth
    THEN
      RAISE EXCEPTION 'scheduled target-session execution policy changed during admission'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  IF (
    SELECT count(DISTINCT subject_id)
    FROM (
      SELECT authority.initiating_human_subject_id AS subject_id
      FROM scheduled_task_personal_resource_authorities authority
      WHERE authority.task_id = NEW.task_id
        AND authority.task_authority_revision = NEW.task_authority_revision
        AND authority.account_id = NEW.account_id
        AND authority.workspace_id = NEW.workspace_id
      UNION ALL
      SELECT selected ->> 'ownerSubjectId'
      FROM jsonb_array_elements(NEW.accepted_execution_snapshot -> 'personalConnectionDelegations') selected
    ) causal_subjects
  ) > 1 THEN
    RAISE EXCEPTION 'scheduled authority classes require one causal human'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM scheduled_task_personal_resource_snapshots snapshot
    JOIN organization_user_resource_grants grant_value
      ON grant_value.id = snapshot.grant_id
     AND grant_value.account_id = snapshot.account_id
    WHERE snapshot.task_id = NEW.task_id
      AND snapshot.task_authority_revision = NEW.task_authority_revision
      AND snapshot.grant_mode = 'once'
      AND grant_value.status = 'consumed'
  ) THEN
    NEW.status := 'failed';
    NEW.error := 'scheduled_authority_exhausted';
    NEW.completed_at := clock_timestamp();
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_marker, ''), true); RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION bind_scheduled_task_run_connection_authorities(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  run_row record;
  session_row record;
  snapshot_row record;
  canonical jsonb;
  bound_count integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
    current_setting('opengeni.account_id', true), ''
  )::uuid OR p_workspace_id IS DISTINCT FROM nullif(
    current_setting('opengeni.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'scheduled connection run bind scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = p_run_id AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id
  FOR UPDATE;
  IF run_row.status NOT IN ('queued', 'dispatched') THEN
    RAISE EXCEPTION 'scheduled connection run is not turn-admissible'
    USING ERRCODE = '42501';
  END IF;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id AND session_value.status <> 'cancelled'
  FOR SHARE;
  IF run_row.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'scheduled connection run session binding changed'
      USING ERRCODE = '42501';
  END IF;

  FOR snapshot_row IN SELECT snapshot.*
    FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = p_run_id
    ORDER BY snapshot.server_id
    FOR UPDATE
  LOOP
    IF snapshot_row.task_id IS DISTINCT FROM run_row.task_id
      OR snapshot_row.task_authority_revision IS DISTINCT FROM run_row.task_authority_revision
      OR snapshot_row.execution_digest IS DISTINCT FROM run_row.task_execution_digest
      OR snapshot_row.snapshot_digest IS DISTINCT FROM digest(
      convert_to(snapshot_row.canonical_snapshot::text, 'UTF8'), 'sha256'
    ) THEN RAISE EXCEPTION 'scheduled connection run snapshot digest changed'
      USING ERRCODE = '42501';
    END IF;
    IF snapshot_row.target_session_id IS NULL THEN
      IF snapshot_row.canonical_snapshot ->> 'authoritySource' IS DISTINCT FROM 'sender'
        OR (session_row.visibility = 'user_private'
          AND session_row.owner_subject_id IS DISTINCT FROM snapshot_row.owner_subject_id)
      THEN RAISE EXCEPTION 'scheduled connection run owner does not match its target'
        USING ERRCODE = '42501'; END IF;
      canonical := snapshot_row.canonical_snapshot || jsonb_build_object(
        'targetSessionId', p_session_id,
        'sessionVisibility', session_row.visibility,
        'sessionAuthorityEpoch', session_row.authority_epoch
      );
      UPDATE scheduled_task_run_connection_authority_snapshots snapshot
      SET target_session_id = p_session_id,
        session_visibility = session_row.visibility,
        session_authority_epoch = session_row.authority_epoch,
        canonical_snapshot = canonical,
        snapshot_digest = digest(convert_to(canonical::text, 'UTF8'), 'sha256'),
        bound_at = clock_timestamp()
      WHERE snapshot.run_id = p_run_id AND snapshot.server_id = snapshot_row.server_id;
    ELSIF snapshot_row.target_session_id IS DISTINCT FROM p_session_id
      OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
      OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
    THEN RAISE EXCEPTION 'scheduled connection run is bound to another session authority'
      USING ERRCODE = '42501';
    END IF;
    bound_count := bound_count + 1;
  END LOOP;
  RETURN bound_count;
END
$function$;

CREATE OR REPLACE FUNCTION validate_scheduled_agent_run_live_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  run_row record;
  accepted jsonb;
  causal jsonb;
  snapshot record;
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_authority_scope_changed'; END IF;
  SELECT run.* INTO run_row
  FROM scheduled_task_runs run
  WHERE run.id = p_run_id
    AND run.account_id = p_account_id
    AND run.workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR run_row.accepted_execution_snapshot IS NULL THEN
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_authority_snapshot_missing';
  END IF;
  accepted := run_row.accepted_execution_snapshot;
  causal := accepted -> 'causalHumanAuthority';

  -- Match task admission and organization lifecycle lock order. Claim must
  -- linearize before delivery: a concurrent suspension/revocation either
  -- completes first and is observed below, or waits until this claim commits.
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.id IN (
      SELECT (causal ->> 'organizationMembershipId')::uuid
      WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
      UNION
      SELECT frozen.owner_organization_membership_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
    )
  ORDER BY membership.id
  FOR SHARE;
  PERFORM 1 FROM workspace_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.workspace_id = p_workspace_id
    AND membership.subject_id IN (
      SELECT causal ->> 'subjectId'
      WHERE causal IS NOT NULL AND causal <> 'null'::jsonb
      UNION
      SELECT frozen.owner_subject_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
    )
  ORDER BY membership.subject_id
  FOR SHARE;
  PERFORM 1 FROM connections connection_value
  WHERE connection_value.account_id = p_account_id
    AND connection_value.id IN (
      SELECT frozen.connection_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
      UNION
      SELECT (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
      WHERE accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
    )
  ORDER BY connection_value.id
  FOR SHARE;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.id IN (
      SELECT frozen.authority_id
      FROM scheduled_task_run_connection_authority_snapshots frozen
      WHERE frozen.run_id = p_run_id
      UNION
      SELECT xai_authority.id
      FROM organization_user_resource_authorities xai_authority
      WHERE accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
        AND causal IS NOT NULL AND causal <> 'null'::jsonb
        AND xai_authority.account_id = p_account_id
        AND xai_authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND xai_authority.resource_kind = 'xai_subscription'
        AND xai_authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
    )
  ORDER BY authority.id
  FOR SHARE;

  PERFORM 1 FROM rigs rig
  WHERE rig.account_id = p_account_id
    AND rig.id IN (
      SELECT (accepted -> 'resolvedRig' ->> 'id')::uuid
      WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
        AND accepted -> 'resolvedRig' <> 'null'::jsonb
      UNION
      SELECT (accepted -> 'targetSessionExecution' ->> 'rigId')::uuid
      WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
        AND accepted -> 'targetSessionExecution' ->> 'rigId' IS NOT NULL
    )
  ORDER BY rig.id
  FOR SHARE;
  PERFORM 1 FROM rig_versions version_value
  WHERE version_value.account_id = p_account_id
    AND version_value.id IN (
      SELECT (accepted -> 'resolvedRig' ->> 'versionId')::uuid
      WHERE accepted -> 'targetSessionExecution' = 'null'::jsonb
        AND accepted -> 'resolvedRig' <> 'null'::jsonb
      UNION
      SELECT (accepted -> 'targetSessionExecution' ->> 'rigVersionId')::uuid
      WHERE accepted -> 'targetSessionExecution' <> 'null'::jsonb
        AND accepted -> 'targetSessionExecution' ->> 'rigVersionId' IS NOT NULL
    )
  ORDER BY version_value.id
  FOR SHARE;

  IF causal IS NOT NULL AND causal <> 'null'::jsonb AND NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = (causal ->> 'organizationMembershipId')::uuid
      AND membership.account_id = p_account_id
      AND membership.subject_id = causal ->> 'subjectId'
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND membership.authorization_revision =
        (causal ->> 'membershipAuthorizationRevision')::bigint
      AND (
        membership.personal_workspace_id = p_workspace_id
        OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = causal ->> 'subjectId'
        )
      )
  ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_causal_membership_changed'; END IF;
  IF accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.account_id = p_account_id
        AND authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND authority.resource_kind = 'xai_subscription'
        AND authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL
    )
  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_xai_authority_changed'; END IF;
  IF accepted -> 'resolvedSlackBotConnection' <> 'null'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM connections connection_value
      WHERE connection_value.id =
          (accepted -> 'resolvedSlackBotConnection' ->> 'id')::uuid
        AND connection_value.account_id = p_account_id
        AND connection_value.workspace_id = p_workspace_id
        AND connection_value.subject_id IS NULL
        AND connection_value.provider_domain = 'slack.com'
        AND connection_value.kind = 'app_install'
        AND connection_value.status = 'active'
        AND connection_value.verified_install_at IS NOT NULL
        AND connection_value.version =
          (accepted -> 'resolvedSlackBotConnection' ->> 'version')::integer
        AND connection_value.verified_install_version =
          (accepted -> 'resolvedSlackBotConnection'
            ->> 'verifiedInstallVersion')::integer
        AND connection_value.verified_install_version = connection_value.version
        AND connection_value.metadata IS NOT DISTINCT FROM
          accepted -> 'resolvedSlackBotConnection' -> 'metadata'
    )
  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_slack_bot_changed'; END IF;

  FOR snapshot IN
    SELECT value.* FROM scheduled_task_run_connection_authority_snapshots value
    WHERE value.run_id = p_run_id
    ORDER BY value.server_id
  LOOP
    IF snapshot.canonical_snapshot ->> 'authoritySource' IS DISTINCT FROM 'sender'
    THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_authority_changed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = snapshot.owner_organization_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = snapshot.owner_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND membership.authorization_revision = snapshot.membership_authorization_revision
        AND (
          membership.personal_workspace_id = p_workspace_id
          OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot.owner_subject_id
          )
        )
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_membership_changed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM opengeni_private.read_sender_connection(
        p_account_id, snapshot.origin_workspace_id, snapshot.connection_id, snapshot.owner_subject_id
      ) connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = p_account_id
        AND connection_value.workspace_id = snapshot.origin_workspace_id
        AND connection_value.subject_id = snapshot.owner_subject_id
        AND connection_value.owner_organization_membership_id =
          snapshot.owner_organization_membership_id
        AND connection_value.authority_scope = 'user'
        AND connection_value.authority_generation = snapshot.connection_generation
        AND connection_value.status = 'active'
        AND lower(connection_value.provider_domain) = snapshot.provider_domain
        AND connection_value.kind = snapshot.connection_kind
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_changed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.id = snapshot.authority_id
        AND authority.account_id = p_account_id
        AND authority.organization_membership_id =
          snapshot.owner_organization_membership_id
        AND authority.resource_kind = 'connection'
        AND authority.resource_id = snapshot.connection_id
        AND authority.origin_workspace_id = snapshot.origin_workspace_id
        AND authority.generation = snapshot.authority_generation
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_connection_authority_changed'; END IF;
  END LOOP;

  IF accepted -> 'targetSessionExecution' = 'null'::jsonb THEN
    IF accepted -> 'resolvedVariableSet' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.id = (accepted -> 'resolvedVariableSet' ->> 'id')::uuid
        AND variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
        AND variable_set.generation =
          (accepted -> 'resolvedVariableSet' ->> 'generation')::bigint
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_variable_set_changed'; END IF;
    IF accepted -> 'resolvedRig' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1 FROM rigs rig
      JOIN rig_versions version_value
        ON version_value.id = (accepted -> 'resolvedRig' ->> 'versionId')::uuid
       AND version_value.rig_id = rig.id
       AND version_value.account_id = rig.account_id
      WHERE rig.id = (accepted -> 'resolvedRig' ->> 'id')::uuid
        AND rig.account_id = p_account_id
        AND rig.status = 'active'
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_rig_changed'; END IF;
    IF accepted -> 'resolvedRig' <> 'null'::jsonb AND (
      accepted -> 'resolvedRig' -> 'defaultVariableSets' IS DISTINCT FROM (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('id', variable_set.id, 'generation', variable_set.generation)
            ORDER BY selected.ordinality
          ),
          '[]'::jsonb
        )
        FROM rig_versions version_value
        CROSS JOIN LATERAL jsonb_array_elements_text(
          coalesce(version_value.default_variable_set_ids, '[]'::jsonb)
        ) WITH ORDINALITY selected(id, ordinality)
        JOIN workspace_variable_sets variable_set
          ON variable_set.id = selected.id::uuid
         AND variable_set.account_id = p_account_id
         AND variable_set.status = 'active'
        WHERE version_value.id = (accepted -> 'resolvedRig' ->> 'versionId')::uuid
          AND version_value.rig_id = (accepted -> 'resolvedRig' ->> 'id')::uuid
          AND version_value.account_id = p_account_id
      )
    ) THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_rig_default_variable_set_changed'; END IF;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  run_row record;
  run_snapshot record;
  item jsonb;
  selected_count integer;
  snapshot_count integer;
  canonical jsonb;
  accepted jsonb;
  execution_policy jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id THEN
      RAISE EXCEPTION 'scheduled logical-turn occurrence identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.personal_connection_delegations IS NOT DISTINCT FROM OLD.personal_connection_delegations
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'scheduled connection authority cannot change after acceptance'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.* INTO STRICT run_row FROM scheduled_task_runs run
  WHERE run.id = NEW.scheduled_task_run_id AND run.account_id = NEW.account_id
    AND run.workspace_id = NEW.workspace_id
  FOR UPDATE;
  IF run_row.status NOT IN ('queued', 'dispatched')
    OR run_row.session_id IS DISTINCT FROM NEW.session_id
  THEN
    RAISE EXCEPTION 'scheduled turn does not match its run session'
      USING ERRCODE = '42501';
  END IF;
  accepted := run_row.accepted_execution_snapshot;
  execution_policy := accepted -> 'targetSessionExecution';
  IF execution_policy = 'null'::jsonb THEN
    IF NEW.model IS DISTINCT FROM accepted ->> 'resolvedModel'
      OR NEW.reasoning_effort IS DISTINCT FROM accepted ->> 'resolvedReasoningEffort'
      OR NEW.latency_mode IS DISTINCT FROM accepted ->> 'resolvedLatencyMode'
      OR NEW.tools IS DISTINCT FROM accepted -> 'resolvedTools'
      OR NEW.sandbox_backend IS DISTINCT FROM accepted ->> 'resolvedSandboxBackend'
      OR NEW.sandbox_os IS DISTINCT FROM accepted ->> 'resolvedSandboxOs'
    THEN RAISE EXCEPTION 'generated scheduled turn differs from accepted execution policy'
      USING ERRCODE = '42501'; END IF;
  ELSE
    IF execution_policy ->> 'sessionId' IS DISTINCT FROM NEW.session_id::text
      OR NEW.model IS DISTINCT FROM execution_policy ->> 'model'
      OR NEW.reasoning_effort IS DISTINCT FROM execution_policy ->> 'reasoningEffort'
      OR NEW.latency_mode IS DISTINCT FROM execution_policy ->> 'latencyMode'
      OR NEW.tools IS DISTINCT FROM execution_policy -> 'tools'
      OR NEW.sandbox_backend IS DISTINCT FROM execution_policy ->> 'sandboxBackend'
      OR NEW.sandbox_os IS DISTINCT FROM execution_policy ->> 'sandboxOs'
    THEN RAISE EXCEPTION 'targeted scheduled turn differs from accepted execution policy'
      USING ERRCODE = '42501'; END IF;
  END IF;
  IF NEW.personal_connection_delegations IS DISTINCT FROM accepted -> 'personalConnectionDelegations'
    OR NEW.initiating_human_subject_id IS DISTINCT FROM accepted ->> 'causalHumanSubjectId'
  THEN RAISE EXCEPTION 'scheduled turn differs from its accepted owner accounts'
    USING ERRCODE = '42501'; END IF;
  PERFORM bind_scheduled_task_run_connection_authorities(
    NEW.account_id, NEW.workspace_id, NEW.scheduled_task_run_id, NEW.session_id
  );

  SELECT count(*)::integer INTO snapshot_count
  FROM scheduled_task_run_connection_authority_snapshots snapshot
  WHERE snapshot.run_id = NEW.scheduled_task_run_id;
  SELECT count(*)::integer INTO selected_count
  FROM jsonb_array_elements(NEW.personal_connection_delegations) selected
  WHERE selected ->> 'connectionType' IS DISTINCT FROM 'social';
  IF selected_count IS DISTINCT FROM snapshot_count THEN
    RAISE EXCEPTION 'scheduled turn connection authority widened or disappeared'
      USING ERRCODE = '42501';
  END IF;

  FOR run_snapshot IN SELECT snapshot.*
    FROM scheduled_task_run_connection_authority_snapshots snapshot
    WHERE snapshot.run_id = NEW.scheduled_task_run_id
    ORDER BY snapshot.server_id
  LOOP
    SELECT value INTO STRICT item
    FROM jsonb_array_elements(NEW.personal_connection_delegations)
    WHERE value ->> 'serverId' = run_snapshot.server_id;
    IF run_snapshot.canonical_snapshot ->> 'authoritySource' IS DISTINCT FROM 'sender'
      OR NEW.initiating_human_subject_id IS DISTINCT FROM run_snapshot.owner_subject_id
      OR item IS DISTINCT FROM run_snapshot.canonical_snapshot -> 'selection'
    THEN RAISE EXCEPTION 'scheduled turn connection selection changed from its run'
      USING ERRCODE = '42501'; END IF;
    canonical := jsonb_build_object(
      'organizationId', NEW.account_id,
      'originWorkspaceId', run_snapshot.origin_workspace_id,
      'targetWorkspaceId', NEW.workspace_id,
      'targetSessionId', NEW.session_id,
      'targetSessionVisibility', run_snapshot.session_visibility,
      'targetSessionAuthorityEpoch', run_snapshot.session_authority_epoch,
      'acceptedWork', jsonb_build_object(
        'kind', 'scheduled_task', 'taskId', run_snapshot.task_id,
        'taskAuthorityRevision', run_snapshot.task_authority_revision,
        'runId', run_snapshot.run_id
      ),
      'connectionId', run_snapshot.connection_id,
      'connectionGeneration', run_snapshot.connection_generation,
      'connectionStatus', 'active', 'providerDomain', run_snapshot.provider_domain,
      'connectionKind', run_snapshot.connection_kind, 'scope', 'user',
      'ownerSubjectId', run_snapshot.owner_subject_id,
      'ownerOrganizationMembershipId', run_snapshot.owner_organization_membership_id,
      'ownerMembershipAuthorizationRevision', run_snapshot.membership_authorization_revision,
      'authoritySource', 'sender',
      'selectionSources', to_jsonb(run_snapshot.selection_sources),
      'userDelegation', NULL
    );
    INSERT INTO turn_connection_authority_snapshots (
      account_id, workspace_id, session_id, turn_id, server_id,
      connection_id, connection_generation, origin_workspace_id,
      provider_domain, connection_kind, authority_scope, authority_source,
      owner_subject_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      grant_id, grant_generation, grant_mode, grant_context, grant_session_id,
      grant_authority_epoch, session_visibility, session_authority_epoch,
      canonical_snapshot, snapshot_digest
    ) VALUES (
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.id, run_snapshot.server_id,
      run_snapshot.connection_id, run_snapshot.connection_generation,
      run_snapshot.origin_workspace_id, run_snapshot.provider_domain,
      run_snapshot.connection_kind, 'user', 'sender',
      run_snapshot.owner_subject_id, run_snapshot.owner_organization_membership_id,
      run_snapshot.membership_authorization_revision, run_snapshot.authority_id,
      run_snapshot.authority_generation, NULL,
      NULL, NULL,
      NULL, NULL,
      NULL, run_snapshot.session_visibility,
      run_snapshot.session_authority_epoch, canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256')
    );
  END LOOP;
  RETURN NEW;
END
$function$;

-- Schedule definitions retain account choices, not connection consent grants.
CREATE OR REPLACE FUNCTION freeze_scheduled_task_personal_resources(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  task_row record;
  member_row record;
  session_row record;
  resource_row record;
  grant_row record;
  initiating_subject text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id', true)), ''),
    nullif(btrim(current_setting('opengeni.subject_id', true)), '')
  );
  target_session uuid;
  target_visibility text := 'workspace_shared';
  target_epoch integer;
  target_rig_version_id uuid;
  resource_total integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled personal-resource task scope mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_revision
  FOR UPDATE;

  IF task_row.run_mode = 'existing_session'
    OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
  THEN
    target_session := task_row.reusable_session_id;
    SELECT session_value.* INTO STRICT session_row
    FROM sessions session_value
    WHERE session_value.id = target_session
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    target_visibility := session_row.visibility;
    target_epoch := session_row.authority_epoch;
    target_rig_version_id := session_row.rig_version_id;
  END IF;

  SELECT count(*)::integer INTO resource_total
  FROM (
    SELECT variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = task_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'
    UNION
    SELECT rig.id
    FROM rigs rig
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
      AND rig.authority_scope = 'user'
    UNION
    SELECT default_variable_set.id
    FROM rigs rig
    JOIN rig_versions rig_version
      ON rig_version.rig_id = rig.id
     AND rig_version.account_id = rig.account_id
     AND (
       (target_session IS NULL AND rig_version.active)
       OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
     )
    CROSS JOIN LATERAL jsonb_array_elements_text(
      rig_version.default_variable_set_ids
    ) default_id(value)
    JOIN workspace_variable_sets default_variable_set
      ON default_variable_set.id = default_id.value::uuid
     AND default_variable_set.account_id = p_account_id
     AND default_variable_set.authority_scope = 'user'
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
  ) selected;

  IF resource_total = 0 THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION 'scheduled personal resources require a causal human'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = initiating_subject
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'scheduled personal-resource owner lacks workspace access'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    p_task_id, p_revision, p_account_id, p_workspace_id,
    initiating_subject, member_row.id, member_row.authorization_revision,
    target_session, target_visibility, target_epoch, task_row.execution_digest,
    resource_total
  );

  FOR resource_row IN
    WITH selected AS (
      SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id,
        NULL::uuid AS resource_version_id, 'variable_set.use'::text AS action,
        'session_variable_set'::text AS selection_source,
        variable_set.workspace_id AS resource_workspace_id, variable_set.authority_id,
        variable_set.owner_organization_membership_id, variable_set.origin_workspace_id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.authority_scope = 'user'
      UNION ALL
      SELECT 'rig'::text, rig.id, rig_version.id, 'rig.use'::text,
        'session_rig'::text, rig.workspace_id, rig.authority_id,
        rig.owner_organization_membership_id, rig.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND (
         (target_session IS NULL AND rig_version.active)
         OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
       )
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
        AND rig.authority_scope = 'user'
      UNION ALL
      SELECT 'variable_set'::text, default_variable_set.id, NULL::uuid,
        'variable_set.use'::text,
        ('rig_default_variable_set:' || default_id.ordinality::text)::text,
        default_variable_set.workspace_id, default_variable_set.authority_id,
        default_variable_set.owner_organization_membership_id,
        default_variable_set.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND (
         (target_session IS NULL AND rig_version.active)
         OR (target_session IS NOT NULL AND rig_version.id = target_rig_version_id)
       )
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) WITH ORDINALITY default_id(value, ordinality)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = p_account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
    )
    SELECT resource_kind, resource_id, min(resource_version_id::text)::uuid resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) selection_sources,
      min(resource_workspace_id::text)::uuid resource_workspace_id,
      min(authority_id::text)::uuid authority_id,
      min(owner_organization_membership_id::text)::uuid owner_organization_membership_id,
      min(origin_workspace_id::text)::uuid origin_workspace_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
    ORDER BY resource_kind, resource_id
  LOOP
    IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
    THEN
      RAISE EXCEPTION 'scheduled personal resource belongs to another human or organization'
        USING ERRCODE = '42501';
    END IF;

    SELECT grant_value.* INTO grant_row
    FROM organization_user_resource_grants grant_value
    JOIN organization_user_resource_authorities authority
      ON authority.id = grant_value.authority_id
     AND authority.account_id = grant_value.account_id
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
      AND grant_value.owner_organization_membership_id = member_row.id
      AND grant_value.workspace_id = p_workspace_id
      AND grant_value.action = resource_row.action
      AND grant_value.context = target_visibility
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND (
        (target_session IS NULL AND grant_value.mode = 'always'
          AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        OR (target_session IS NOT NULL AND (
          (grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = target_session
            AND grant_value.authority_epoch = target_epoch)
          OR (grant_value.mode = 'always'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        ))
      )
    ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
      grant_value.generation DESC, grant_value.id
    LIMIT 1
    FOR SHARE OF authority, grant_value;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching scheduled personal-resource grant required'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO scheduled_task_personal_resource_snapshots (
      task_id, task_authority_revision, account_id, workspace_id,
      resource_kind, resource_id, resource_version_id, selection_sources, action,
      origin_workspace_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      target_workspace_id, session_visibility, session_authority_epoch,
      grant_id, grant_generation, grant_mode, grant_context,
      grant_session_id, grant_authority_epoch
    )
    SELECT p_task_id, p_revision, p_account_id, p_workspace_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources, resource_row.action,
      resource_row.origin_workspace_id, member_row.id, member_row.authorization_revision,
      authority.id, authority.generation, p_workspace_id, target_visibility, target_epoch,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN resource_total;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$function$
;

CREATE OR REPLACE FUNCTION clone_scheduled_task_personal_resource_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_source_revision bigint, p_target_revision bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  source_authority record;
  target_execution_digest text;
  copied_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled personal-resource clone scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF p_source_revision <= 0
    OR p_target_revision <= p_source_revision
  THEN
    RAISE EXCEPTION 'scheduled personal-resource authority clone revision is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  SELECT task.execution_digest INTO target_execution_digest
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_target_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled personal-resource clone target is not current'
      USING ERRCODE = '40001';
  END IF;

  SELECT authority.* INTO source_authority
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_source_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    source_authority.task_id, p_target_revision,
    source_authority.account_id, source_authority.workspace_id,
    source_authority.initiating_human_subject_id,
    source_authority.owner_organization_membership_id,
    source_authority.membership_authorization_revision,
    source_authority.target_session_id, source_authority.session_visibility,
    source_authority.session_authority_epoch, target_execution_digest,
    source_authority.resource_count
  );

  INSERT INTO scheduled_task_personal_resource_snapshots (
    task_id, task_authority_revision, account_id, workspace_id,
    resource_kind, resource_id, resource_version_id, selection_sources, action,
    origin_workspace_id, owner_organization_membership_id,
    membership_authorization_revision, authority_id, authority_generation,
    target_workspace_id, session_visibility, session_authority_epoch,
    grant_id, grant_generation, grant_mode, grant_context,
    grant_session_id, grant_authority_epoch
  )
  SELECT snapshot.task_id, p_target_revision,
    snapshot.account_id, snapshot.workspace_id, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.action, snapshot.origin_workspace_id,
    snapshot.owner_organization_membership_id,
    snapshot.membership_authorization_revision, snapshot.authority_id,
    snapshot.authority_generation, snapshot.target_workspace_id,
    snapshot.session_visibility, snapshot.session_authority_epoch,
    snapshot.grant_id, snapshot.grant_generation, snapshot.grant_mode,
    snapshot.grant_context, snapshot.grant_session_id, snapshot.grant_authority_epoch
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = p_task_id
    AND snapshot.task_authority_revision = p_source_revision;
  GET DIAGNOSTICS copied_count = ROW_COUNT;
  IF copied_count <> source_authority.resource_count THEN
    RAISE EXCEPTION 'scheduled personal-resource authority clone is incomplete'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN copied_count;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$function$
;


-- Retire native connection-consent issuance; other resource grants remain.
CREATE OR REPLACE FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_action text, p_mode text, p_context text, p_session_id uuid DEFAULT NULL::uuid, p_workspace_shared_acknowledged boolean DEFAULT false)
 RETURNS TABLE(grant_id uuid, target_workspace_id uuid, target_session_id uuid, action text, grant_mode text, grant_context text, grant_generation bigint, grant_status text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
  target_epoch integer;
  target_visibility text;
  normalized_action text := lower(btrim(p_action));
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource grant scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('once', 'session', 'always')
    OR p_context NOT IN ('user_private', 'workspace_shared')
    OR normalized_action = 'connection.use' OR normalized_action = '' OR length(normalized_action) > 64
    OR normalized_action !~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'
  THEN
    RAISE EXCEPTION 'invalid user-resource grant request' USING ERRCODE = '22023';
  END IF;
  IF p_context = 'workspace_shared' AND NOT p_workspace_shared_acknowledged THEN
    RAISE EXCEPTION 'workspace_shared requires durable shared-output acknowledgement'
      USING ERRCODE = '42501';
  END IF;
  IF (p_mode = 'always' AND p_session_id IS NOT NULL)
    OR (p_mode IN ('once', 'session') AND p_session_id IS NULL)
  THEN
    RAISE EXCEPTION 'user-resource grant session fence is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT membership.id INTO STRICT owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active self-owned user-resource authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_workspace_id AND workspace_value.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target workspace is outside the organization' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.id = owner_membership_id
    AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = caller_subject
    ));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner lacks current target-workspace access' USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT session_value.authority_epoch, session_value.visibility
      INTO STRICT target_epoch, target_visibility
    FROM sessions session_value
    WHERE session_value.id = p_session_id
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF target_visibility IS DISTINCT FROM p_context THEN
      RAISE EXCEPTION 'grant context does not match current session visibility'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO organization_user_resource_grants (
    account_id, authority_id, owner_organization_membership_id, workspace_id,
    session_id, action, mode, context, authority_epoch, generation, status
  ) VALUES (
    p_account_id, p_authority_id, owner_membership_id, p_workspace_id,
    p_session_id, normalized_action, p_mode, p_context, target_epoch, 1, 'active'
  )
  ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
    (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(authority_epoch, 0))) WHERE status = 'active'
  DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
  RETURNING id, workspace_id, session_id, organization_user_resource_grants.action,
    mode, context, generation, status, organization_user_resource_grants.expires_at
  INTO grant_id, target_workspace_id, target_session_id, action, grant_mode,
    grant_context, grant_generation, grant_status, expires_at;
  RETURN NEXT;
END
$function$
;

CREATE OR REPLACE FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_resource_kind text, p_mode text, p_context text, p_session_id uuid DEFAULT NULL::uuid, p_expected_authority_epoch integer DEFAULT NULL::integer, p_workspace_shared_acknowledged boolean DEFAULT false)
 RETURNS TABLE(grant_id uuid, organization_id uuid, authority_generation bigint, target_workspace_id uuid, target_session_id uuid, action text, grant_mode text, grant_context text, authority_epoch integer, grant_generation bigint, grant_status text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
  target_epoch integer;
  target_visibility text;
  canonical_action text;
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource grant scope mismatch' USING ERRCODE = '42501';
  END IF;
  canonical_action := CASE p_resource_kind
    WHEN 'document' THEN 'document.read'
    WHEN 'variable_set' THEN 'variable_set.use'
    WHEN 'rig' THEN 'rig.use'
    WHEN 'connected_machine' THEN 'connected_machine.use'
    ELSE NULL
  END;
  IF p_resource_kind IS NULL OR canonical_action IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('session', 'always')
    OR p_context IS NULL OR p_context NOT IN ('user_private', 'workspace_shared')
    OR (p_mode = 'always' AND (p_session_id IS NOT NULL OR p_expected_authority_epoch IS NOT NULL))
    OR (p_mode = 'session' AND (p_session_id IS NULL OR p_expected_authority_epoch IS NULL))
    OR coalesce(p_expected_authority_epoch, 1) <= 0
  THEN
    RAISE EXCEPTION 'invalid user-resource grant request' USING ERRCODE = '22023';
  END IF;
  IF p_context = 'workspace_shared' AND p_workspace_shared_acknowledged IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace_shared requires durable shared-output acknowledgement'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = p_account_id AND activation.activation_version = 1
  ) THEN
    RAISE EXCEPTION 'session tenancy product is not activated' USING ERRCODE = '42501';
  END IF;

  SELECT membership.id INTO owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner membership not found or access denied' USING ERRCODE = '42501';
  END IF;

  SELECT authority.generation INTO authority_generation
  FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND authority.resource_kind = p_resource_kind
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user-resource authority not found or access denied' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_workspace_id AND workspace_value.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.id = owner_membership_id
      AND (
        membership.personal_workspace_id = p_workspace_id
        OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = caller_subject
        )
      )
  ) THEN
    RAISE EXCEPTION 'owner lacks current target-workspace access' USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT session_value.authority_epoch, session_value.visibility
      INTO target_epoch, target_visibility
    FROM sessions session_value
    WHERE session_value.id = p_session_id
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF NOT FOUND
      OR target_visibility IS DISTINCT FROM p_context
      OR target_epoch IS DISTINCT FROM p_expected_authority_epoch
    THEN
      RAISE EXCEPTION 'target session not found or access denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE organization_user_resource_grants grant_value
  SET status = 'expired', updated_at = clock_timestamp()
  WHERE grant_value.account_id = p_account_id
    AND grant_value.authority_id = p_authority_id
    AND grant_value.status = 'active'
    AND grant_value.expires_at IS NOT NULL
    AND grant_value.expires_at <= clock_timestamp();

  INSERT INTO organization_user_resource_grants (
    account_id, authority_id, owner_organization_membership_id, workspace_id,
    session_id, action, mode, context, authority_epoch, generation, status
  ) VALUES (
    p_account_id, p_authority_id, owner_membership_id, p_workspace_id,
    p_session_id, canonical_action, p_mode, p_context, target_epoch, 1, 'active'
  )
  ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
    (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(authority_epoch, 0))) WHERE status = 'active'
  DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
  RETURNING id, workspace_id, session_id, organization_user_resource_grants.action,
    mode, context, organization_user_resource_grants.authority_epoch, generation,
    status, organization_user_resource_grants.expires_at
  INTO grant_id, target_workspace_id, target_session_id, action, grant_mode,
    grant_context, authority_epoch, grant_generation, grant_status, expires_at;
  organization_id := p_account_id;
  RETURN NEXT;
END
$function$
;


-- No callable native consent or task-head connection-grant compatibility lane.
DROP FUNCTION issue_self_local_connection_use_grant(uuid,uuid,uuid,text,boolean);
DROP FUNCTION list_self_connection_authorities(uuid);
DROP FUNCTION issue_self_connection_use_grant(uuid,uuid,uuid,text,text,uuid,boolean);
DROP FUNCTION revoke_self_connection_use_grant(uuid,uuid);
DROP FUNCTION resolve_connection_use_authority(uuid,uuid,uuid,jsonb);
DROP FUNCTION resolve_personal_connection_authority_selection(uuid,uuid,text,uuid,jsonb);
DROP FUNCTION refresh_scheduled_task_personal_resources_clone_connections(uuid,uuid,uuid,bigint,bigint);
DROP FUNCTION freeze_scheduled_task_connection_authorities_inner(uuid,uuid,uuid,bigint);
DROP FUNCTION clone_scheduled_task_connection_authorities_inner(uuid,uuid,uuid,bigint,bigint);
DROP FUNCTION freeze_scheduled_task_personal_resources_0252(uuid,uuid,uuid,bigint);
DROP FUNCTION clone_scheduled_task_personal_resource_authority_0252(uuid,uuid,uuid,bigint,bigint);

-- Task-head connection snapshots are audit history only. Ownership and each
-- accepted occurrence replace their old revision/grant execution gates.
DROP TRIGGER scheduled_task_connection_authority_execution_revision ON scheduled_tasks;
DROP FUNCTION fence_scheduled_task_connection_authority_execution_update();
COMMENT ON COLUMN scheduled_tasks.personal_connection_delegations IS
  'Historical account/grant selections. Never read or written by current execution; current account choices live in agent_config.';
CREATE OR REPLACE FUNCTION record_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE
  sender_prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  subject_value text := nullif(btrim(
    current_setting('opengeni.initiating_human_subject_id', true)
  ), '');
  task_row record;
  membership_row record;
  resource_bearing boolean;
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true);
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN RAISE EXCEPTION 'scheduled revision authority scope mismatch'
    USING ERRCODE = '42501'; END IF;
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR SHARE;
  IF task_row.action ->> 'kind' <> 'agent_turn' THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NULL; END IF;
  -- Connection identity is the immutable task owner and is resolved per run.
  -- This revision receipt belongs only to retained native personal resources;
  -- verified host identities need not have a native organization membership.
  resource_bearing := EXISTS (
      SELECT 1 FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = task_row.account_id
        AND variable_set.authority_scope = 'user'
    )
    OR EXISTS (
      SELECT 1 FROM rigs rig
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
        AND rig.authority_scope = 'user'
    )
    OR task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
    OR EXISTS (
      SELECT 1 FROM scheduled_task_personal_resource_authorities authority
      WHERE authority.task_id = task_row.id
        AND authority.task_authority_revision = task_row.authority_revision
    );
  -- A service/API-key/delegated writer is not a managed human and cannot be a
  -- revision authorizer. That is allowed for a task that delegates no personal
  -- authority (workspace/organization Variable Sets and Rigs use ordinary
  -- workspace authority); a personal-resource task fails closed instead of
  -- running without a causal human.
  IF subject_value IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.subject_id = subject_value
  ) THEN
    IF resource_bearing THEN
      RAISE EXCEPTION
        'scheduled personal-resource agent task requires an exact human revision authorizer'
        USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN NULL;
  END IF;
  SELECT membership.* INTO membership_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = subject_value
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND (
      membership.personal_workspace_id = p_workspace_id
      OR EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = subject_value
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled revision authorizer lacks active workspace membership'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO scheduled_task_revision_authorities (
    task_id, task_authority_revision, account_id, workspace_id, subject_id,
    organization_membership_id, membership_authorization_revision, execution_digest
  ) VALUES (
    task_row.id, task_row.authority_revision, task_row.account_id,
    task_row.workspace_id, subject_value, membership_row.id,
    membership_row.authorization_revision, task_row.execution_digest
  );
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN subject_value;
EXCEPTION WHEN OTHERS THEN RAISE;
END
$function$
;

-- Replacing a routine must retain its trusted data schema ahead of pg_temp.
DO $sender_routine_paths$
DECLARE data_schema text := current_schema(); routine record;
BEGIN
  FOR routine IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (CASE WHEN n.nspname = data_schema THEN p.proname
      ELSE n.nspname || '.' || p.proname END) = ANY (ARRAY[
    'opengeni_private.guard_scheduled_task_owner',
    'opengeni_private.guard_scheduled_run_owner',
    'opengeni_private.read_sender_connection',
    'opengeni_private.capture_accepted_turn_connection_authorities',
    'resolve_accepted_connection_use',
    'list_owned_connection_accounts',
    'admit_scheduled_task_run_connection_authorities',
    'admit_scheduled_agent_run_execution',
    'bind_scheduled_task_run_connection_authorities',
    'validate_scheduled_agent_run_live_authority',
    'opengeni_private.capture_scheduled_turn_connection_authorities',
    'freeze_scheduled_task_personal_resources',
    'clone_scheduled_task_personal_resource_authority',
    'issue_self_user_resource_grant',
    'record_scheduled_task_revision_authority'
    ]) AND n.nspname IN (data_schema, 'opengeni_private')
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      routine.nspname, routine.proname, routine.arguments, data_schema);
  END LOOP;
END
$sender_routine_paths$;
