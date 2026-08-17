-- deployment-mode: rolling
-- Migration 0279: workspace-owned connections stop bypassing the accepted
-- connection-use authority.
--
-- Before this migration `resolve_accepted_connection_use` had two lanes -
-- the frozen per-turn personal snapshot ('user') and the bounded
-- 'legacy_user' compatibility lane - and the worker short-circuited every
-- workspace-scope request straight to credential resolution: no lifecycle
-- fences, no idempotent audit fact, no per-provider-request authorization.
-- This redefinition adds the workspace lane: the same canonical
-- control/workspace/session/turn/attempt fences and interruption checks, the
-- same physical-request idempotency, and a live validation that the exact
-- connection is workspace-owned ('workspace' authority scope), belongs to
-- this workspace, still matches its provider domain and kind, and is active.
-- The audit-fact shape already admits authority_scope 'workspace' (0264).
--
-- A frozen personal snapshot for the same turn+server keeps taking the
-- snapshot lane, so a workspace-scope request against a personally delegated
-- server denies with connection_identity_changed instead of borrowing the
-- workspace row. Requests with no connection id remain unresolvable in this
-- lane ('connection_missing'): the worker's bounded legacy path for
-- pre-snapshot turns stays TypeScript-side and unprivileged.
--
-- Rolling window: same function identity, so existing EXECUTE grants
-- survive; an old worker image keeps its short-circuit (exactly as weak as
-- before, never weaker) until replaced. CREATE OR REPLACE resets the
-- attached search_path, so the 0275 definer posture is re-applied below.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

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
SET search_path = pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  prior record;
  connection_row record;
  snapshot record;
  session_row record;
  grant_row record;
  request_digest bytea;
  has_prior boolean := false;
  reason text;
  scheduled_run_id uuid;
BEGIN
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
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turns turn_value
    WHERE turn_value.id = p_turn_id AND turn_value.account_id = p_account_id
      AND turn_value.workspace_id = p_workspace_id AND turn_value.session_id = p_session_id
      AND turn_value.active_attempt_id = p_attempt_id
      AND turn_value.execution_generation = p_execution_generation
      AND turn_value.status = 'running'
    FOR UPDATE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
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
      RETURN NEXT; RETURN;
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
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = p_account_id;
      IF snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'), 'sha256'
      ) THEN reason := 'accepted_snapshot_digest_changed';
      ELSIF NOT FOUND THEN reason := 'connection_missing';
      ELSIF snapshot.authority_scope IS DISTINCT FROM 'user'
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
      ELSE
        SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id AND grant_value.account_id = p_account_id
        FOR UPDATE;
        IF NOT FOUND THEN reason := 'grant_missing';
        ELSIF grant_row.authority_id IS DISTINCT FROM snapshot.authority_id
          OR grant_row.owner_organization_membership_id
            IS DISTINCT FROM snapshot.owner_organization_membership_id
          OR grant_row.workspace_id IS DISTINCT FROM p_workspace_id
          OR grant_row.action <> 'connection.use'
          OR grant_row.mode IS DISTINCT FROM snapshot.grant_mode
          OR grant_row.context IS DISTINCT FROM snapshot.grant_context
          OR grant_row.session_id IS DISTINCT FROM snapshot.grant_session_id
          OR grant_row.authority_epoch IS DISTINCT FROM snapshot.grant_authority_epoch
        THEN reason := 'grant_identity_changed';
        ELSIF grant_row.generation IS DISTINCT FROM snapshot.grant_generation
        THEN reason := 'grant_generation_changed';
        ELSIF grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= clock_timestamp()
        THEN reason := 'grant_expired';
        ELSIF grant_row.mode = 'once' THEN
          IF grant_row.status <> 'consumed' OR NOT EXISTS (
            SELECT 1 FROM connection_use_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_row.id
              AND receipt.authority_id = snapshot.authority_id
              AND receipt.authority_generation = snapshot.authority_generation
              AND receipt.grant_generation = snapshot.grant_generation
              AND (
                (receipt.accepted_work_kind = 'turn'
                  AND receipt.accepted_work_id = p_turn_id)
                OR (receipt.accepted_work_kind = 'scheduled_task'
                  AND scheduled_run_id IS NOT NULL
                  AND receipt.accepted_work_id = scheduled_run_id)
              )
          ) THEN reason := 'grant_already_consumed'; END IF;
        ELSIF grant_row.status <> 'active' THEN reason := 'grant_status_inactive';
        END IF;
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
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = p_connection_id AND connection_value.account_id = p_account_id;
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
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = p_connection_id AND connection_value.account_id = p_account_id;
      IF NOT FOUND THEN reason := 'connection_missing';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'legacy_user'
        OR p_subject_scope IS DISTINCT FROM 'subject' OR p_owner_subject_id IS NULL
        OR connection_row.subject_id IS DISTINCT FROM p_owner_subject_id
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
        authority_scope := 'legacy_user'; owner_subject_id := connection_row.subject_id;
      END IF;
    END IF;
  END IF;

  authorization_status := CASE WHEN reason IS NULL THEN 'authorized' ELSE 'denied' END;
  denial_reason := reason;
  IF NOT has_prior THEN
    INSERT INTO connection_use_audit_facts (
      physical_request_id, use_phase, request_digest, account_id, workspace_id,
      session_id, turn_id, attempt_id, execution_generation, server_id,
      connection_id, connection_generation, authority_scope, owner_subject_id,
      authority_id, grant_id, outcome, denial_reason
    ) VALUES (
      p_physical_request_id, p_use_phase, request_digest, p_account_id,
      p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
      p_execution_generation, p_server_id, resolved_connection_id,
      connection_generation, authority_scope, owner_subject_id, authority_id,
      grant_id, authorization_status, denial_reason
    ) ON CONFLICT (physical_request_id) DO NOTHING;
  END IF;
  RETURN NEXT;
END
$body$;

DO $workspace_connection_lane_posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
  signature text := 'resolve_accepted_connection_use'
    || '(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)';
BEGIN
  -- Re-pin the 0275 definer posture: CREATE OR REPLACE replaced the attached
  -- search_path with the minimal header value. `public` stays in the path for
  -- the pgcrypto digest() dependency, exactly as 0275 set it.
  EXECUTE format(
    'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, public, pg_temp',
    data_schema, signature, data_schema
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO opengeni_app', data_schema, signature);
  END IF;
END
$workspace_connection_lane_posture$;
