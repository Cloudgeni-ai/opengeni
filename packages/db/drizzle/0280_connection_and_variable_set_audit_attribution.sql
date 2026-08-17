-- deployment-mode: rolling
-- Migration 0280: connection-use audit facts and variable-set audit events
-- carry the accepted authority attribution.
--
-- `connection_use_audit_facts` (0264) recorded what was used but not by whose
-- causal authority: no causal initiator, no session tenancy epoch/visibility,
-- no owning membership. The columns below are nullable audit evidence written
-- by the resolver from the exact rows the same transaction already locked -
-- the frozen turn identity verbatim (a pre-0096 sentinel stays the sentinel)
-- and the live session authority triple. A denial whose lifecycle fence never
-- loaded the row leaves NULL attribution, which is itself the honest fact.
-- No foreign keys: audit rows are immutable evidence and must never block a
-- membership lifecycle or retention operation.
--
-- The variable-set audit events (0254/0273) gain the same attribution in
-- their metadata: causal human, attempt authority epoch/visibility/owner
-- membership, and the variable set's owner authority/membership/origin.
-- Denials in these functions RAISE and roll the transaction back, so denial
-- recording stays with the application caller in a fresh transaction
-- (metadata-only, content-free) - recording inside the aborted transaction is
-- impossible by design, and weakening RAISE to a soft return would change the
-- authority contract.
--
-- Rolling window: nullable columns plus CREATE OR REPLACE of three existing
-- functions with unchanged signatures and grants; an old image keeps writing
-- audit rows without attribution exactly as before.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- 1. Attribution columns ------------------------------------------------
-- Conditional on the 0264 cutover having been activated: a deployment that
-- defers the connection-authority maintenance cutover replays this rolling
-- migration without the audit table, and the resolver redefinition below is
-- inert there for the same reason the 0264 activation gate is.

DO $connection_audit_attribution_columns$
BEGIN
  IF to_regclass('connection_use_audit_facts') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE "connection_use_audit_facts"
    ADD COLUMN IF NOT EXISTS "initiator_kind" text,
    ADD COLUMN IF NOT EXISTS "initiator_subject_id" text,
    ADD COLUMN IF NOT EXISTS "initiating_human_subject_id" text,
    ADD COLUMN IF NOT EXISTS "authority_epoch" integer,
    ADD COLUMN IF NOT EXISTS "authority_visibility" text,
    ADD COLUMN IF NOT EXISTS "authority_owner_organization_membership_id" uuid;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connection_use_audit_attribution_check'
  ) THEN
    ALTER TABLE "connection_use_audit_facts"
      ADD CONSTRAINT "connection_use_audit_attribution_check"
      CHECK (
        ("authority_visibility" IS NULL
          OR "authority_visibility" IN ('user_private', 'workspace_shared'))
        AND ("authority_epoch" IS NULL OR "authority_epoch" > 0)
      ) NOT VALID;
  END IF;
  ALTER TABLE "connection_use_audit_facts"
    VALIDATE CONSTRAINT "connection_use_audit_attribution_check";
END
$connection_audit_attribution_columns$;

-- 2. The connection-use resolver records attribution --------------------

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
  turn_row record;
  audit_initiator_kind text;
  audit_initiator_subject text;
  audit_initiating_human text;
  audit_authority_epoch integer;
  audit_authority_visibility text;
  audit_owner_membership uuid;
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
END
$body$;

DO $connection_audit_attribution_posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
  signature text := 'resolve_accepted_connection_use'
    || '(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)';
BEGIN
  -- Same re-pin as 0279: CREATE OR REPLACE replaced the attached search_path
  -- with the minimal header value; `public` stays for the pgcrypto digest().
  EXECUTE format(
    'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, public, pg_temp',
    data_schema, signature, data_schema
  );
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO opengeni_app', data_schema, signature);
  END IF;
END
$connection_audit_attribution_posture$;

-- 3. Variable-set materialization audit attribution ---------------------

CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_variable_set_id uuid
) RETURNS TABLE (
  variable_set_id uuid,
  variable_set_name text,
  variable_set_description text,
  authority_scope text,
  variable_set_generation bigint,
  variable_name text,
  value_encrypted text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  audit_subject text;
  causal_human text;
  audit_actor_kind text;
  variable_set_row workspace_variable_sets%ROWTYPE;
  resolved_count integer;
  attempt_authority_epoch integer;
  attempt_authority_visibility text;
  attempt_owner_membership uuid;
BEGIN
  INSERT INTO opengeni_private.variable_set_authority_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
  ON CONFLICT DO NOTHING;

  SELECT actor_subject, causal_human_subject, actor_kind
  INTO STRICT audit_subject, causal_human, audit_actor_kind
  FROM assert_scoped_variable_set_materialization_attempt(
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
    p_execution_generation
  );

  -- Attribution evidence (0280): the exact attempt the assert above already
  -- validated owns the frozen session tenancy authority for this use.
  SELECT attempt.authority_epoch, attempt.authority_visibility,
    attempt.authority_owner_organization_membership_id
  INTO attempt_authority_epoch, attempt_authority_visibility, attempt_owner_membership
  FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id;

  SELECT variable_set.* INTO STRICT variable_set_row
  FROM workspace_variable_sets variable_set
  WHERE variable_set.id = p_variable_set_id
    AND variable_set.account_id = p_account_id
    AND variable_set.status = 'active'
  FOR SHARE;

  PERFORM 1 FROM sessions session_value
  LEFT JOIN rig_versions rig_version
    ON rig_version.id = session_value.rig_version_id
   AND rig_version.rig_id = session_value.rig_id
   AND rig_version.account_id = session_value.account_id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND (
      session_value.variable_set_id = variable_set_row.id
      OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
        ? variable_set_row.id::text
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime variable set was not selected by the exact session'
      USING ERRCODE = '42501';
  END IF;

  IF variable_set_row.authority_scope = 'workspace'
    AND variable_set_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'workspace variable set is outside the runtime workspace'
      USING ERRCODE = '42501';
  ELSIF variable_set_row.authority_scope = 'user' THEN
    IF causal_human IS NULL THEN
      RAISE EXCEPTION 'personal variable-set materialization requires an initiating human subject'
        USING ERRCODE = '42501';
    END IF;
    SELECT count(*)::integer INTO resolved_count
    FROM resolve_session_attempt_personal_resources(
      p_account_id, p_workspace_id, p_attempt_id
    ) resolved
    WHERE resolved.resource_kind = 'variable_set'
      AND resolved.resource_id = variable_set_row.id
      AND resolved.authority_id = variable_set_row.authority_id
      AND resolved.authority_generation = variable_set_row.generation;
    IF resolved_count <> 1 THEN
      RAISE EXCEPTION 'personal variable-set grant is not exact or current'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO audit_events (
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, audit_subject,
    'variable_set.materialized', 'workspace_variable_set',
    variable_set_row.id::text,
    pg_catalog.jsonb_build_object(
      'variableSetId', variable_set_row.id,
      'scope', variable_set_row.authority_scope,
      'generation', variable_set_row.generation,
      'actorKind', audit_actor_kind,
      'sessionId', p_session_id,
      'turnId', p_turn_id,
      'attemptId', p_attempt_id,
      'executionGeneration', p_execution_generation,
      'causalHumanSubjectId', causal_human,
      'authorityEpoch', attempt_authority_epoch,
      'authorityVisibility', attempt_authority_visibility,
      'authorityOwnerOrganizationMembershipId', attempt_owner_membership,
      'ownerAuthorityId', variable_set_row.authority_id,
      'ownerOrganizationMembershipId', variable_set_row.owner_organization_membership_id,
      'originWorkspaceId', variable_set_row.origin_workspace_id
    ),
    1
  );

  RETURN QUERY
  SELECT selected.id, selected.name, selected.description,
    selected.authority_scope, selected.generation,
    variable.name, variable.value_encrypted
  FROM workspace_variable_sets selected
  LEFT JOIN workspace_variable_set_variables variable
    ON variable.account_id = selected.account_id
   AND variable.variable_set_id = selected.id
  WHERE selected.id = variable_set_row.id
  ORDER BY variable.name;

  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) FROM PUBLIC;
DO $materialize_attribution_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION materialize_scoped_variable_set_for_attempt(
      uuid, uuid, uuid, uuid, uuid, integer, uuid
    ) TO opengeni_app;
  END IF;
END
$materialize_attribution_grant$;

-- 4. Variable-set secret-read audit attribution -------------------------

DO $secret_read_attribution$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.read_scoped_variable_set_secret(
      p_account_id uuid,
      p_workspace_id uuid,
      p_variable_set_id uuid,
      p_variable_set_name text,
      p_variable_name text,
      p_actor_kind text,
      p_session_id uuid DEFAULT NULL,
      p_turn_id uuid DEFAULT NULL,
      p_attempt_id uuid DEFAULT NULL,
      p_execution_generation integer DEFAULT NULL
    ) RETURNS TABLE (
      variable_set_id uuid,
      variable_name text,
      variable_version integer,
      value_encrypted text,
      authority_scope text,
      variable_set_generation bigint
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership_id uuid;
      variable_set_row workspace_variable_sets%%ROWTYPE;
      resolved_count integer;
      attempt_authority_epoch integer;
      attempt_authority_visibility text;
      attempt_owner_membership uuid;
      audit_subject text := coalesce(
        nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
      );
    BEGIN
      IF (p_variable_set_id IS NULL) = (p_variable_set_name IS NULL)
        OR p_actor_kind NOT IN ('subject', 'agent_attempt')
      THEN
        RAISE EXCEPTION 'invalid exact variable-set read request' USING ERRCODE = '22023';
      END IF;
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
      ON CONFLICT DO NOTHING;

      IF p_actor_kind = 'subject' THEN
        actor_membership_id := scoped_variable_set_actor_membership(
          p_account_id, p_workspace_id
        );
      ELSE
        audit_subject := assert_scoped_variable_set_attempt(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
          p_execution_generation
        );
        -- Attribution evidence (0280): the exact attempt the assert above
        -- already validated owns the frozen session tenancy authority.
        SELECT attempt.authority_epoch, attempt.authority_visibility,
          attempt.authority_owner_organization_membership_id
        INTO attempt_authority_epoch, attempt_authority_visibility,
          attempt_owner_membership
        FROM session_turn_attempts attempt
        WHERE attempt.id = p_attempt_id
          AND attempt.account_id = p_account_id
          AND attempt.workspace_id = p_workspace_id;
      END IF;

      SELECT variable_set.* INTO STRICT variable_set_row
      FROM workspace_variable_sets variable_set
      WHERE variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
        AND (
          (p_variable_set_id IS NOT NULL AND variable_set.id = p_variable_set_id)
          OR (p_variable_set_name IS NOT NULL AND variable_set.name = p_variable_set_name)
        )
        AND (
          variable_set.authority_scope = 'organization'
          OR (
            variable_set.authority_scope = 'workspace'
            AND variable_set.workspace_id = p_workspace_id
          )
          OR (
            variable_set.authority_scope = 'user'
            AND (
              (p_actor_kind = 'subject'
                AND variable_set.owner_organization_membership_id = actor_membership_id)
              OR p_actor_kind = 'agent_attempt'
            )
          )
        )
      ORDER BY CASE variable_set.authority_scope
        WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END
      LIMIT 1
      FOR SHARE;

      IF p_actor_kind = 'agent_attempt' THEN
        PERFORM 1 FROM sessions session_value
        LEFT JOIN rig_versions rig_version
          ON rig_version.id = session_value.rig_version_id
         AND rig_version.rig_id = session_value.rig_id
         AND rig_version.account_id = session_value.account_id
        WHERE session_value.id = p_session_id
          AND session_value.account_id = p_account_id
          AND session_value.workspace_id = p_workspace_id
          AND (
            session_value.variable_set_id = variable_set_row.id
            OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
              ? variable_set_row.id::text
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION 'exact variable-set resource was not admitted for this attempt'
            USING ERRCODE = '42501';
        END IF;
        IF variable_set_row.authority_scope = 'user' THEN
          SELECT count(*)::integer INTO resolved_count
          FROM resolve_session_attempt_personal_resources(
            p_account_id, p_workspace_id, p_attempt_id
          ) resolved
          WHERE resolved.resource_kind = 'variable_set'
            AND resolved.resource_id = variable_set_row.id
            AND resolved.authority_id = variable_set_row.authority_id
            AND resolved.authority_generation = variable_set_row.generation;
          IF resolved_count <> 1 THEN
            RAISE EXCEPTION 'personal variable-set grant is not exact or current'
              USING ERRCODE = '42501';
          END IF;
        END IF;
      END IF;

      RETURN QUERY
      SELECT variable_set_row.id, variable.name, variable.version,
        variable.value_encrypted, variable_set_row.authority_scope,
        variable_set_row.generation
      FROM workspace_variable_set_variables variable
      WHERE variable.account_id = p_account_id
        AND variable.variable_set_id = variable_set_row.id
        AND variable.name = p_variable_name;
      IF FOUND THEN
        INSERT INTO audit_events (
          account_id, workspace_id, subject_id, action, target_type, target_id,
          metadata, metadata_codec_version
        ) VALUES (
          p_account_id, p_workspace_id, audit_subject,
          'variable_set.variable.read', 'workspace_variable_set',
          variable_set_row.id::text,
          pg_catalog.jsonb_build_object(
            'variableSetId', variable_set_row.id,
            'name', p_variable_name,
            'actorKind', p_actor_kind,
            'scope', variable_set_row.authority_scope,
            'generation', variable_set_row.generation,
            'sessionId', p_session_id,
            'turnId', p_turn_id,
            'attemptId', p_attempt_id,
            'executionGeneration', p_execution_generation,
            'actorMembershipId', actor_membership_id,
            'authorityEpoch', attempt_authority_epoch,
            'authorityVisibility', attempt_authority_visibility,
            'authorityOwnerOrganizationMembershipId', attempt_owner_membership,
            'ownerAuthorityId', variable_set_row.authority_id,
            'ownerOrganizationMembershipId', variable_set_row.owner_organization_membership_id,
            'originWorkspaceId', variable_set_row.origin_workspace_id
          ),
          1
        );
      END IF;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$secret_read_attribution$;

REVOKE ALL ON FUNCTION read_scoped_variable_set_secret(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer
) FROM PUBLIC;
DO $secret_read_attribution_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION read_scoped_variable_set_secret(
      uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer
    ) TO opengeni_app;
  END IF;
END
$secret_read_attribution_grant$;
