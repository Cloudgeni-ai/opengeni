-- deployment-mode: rolling
-- contract-step: after #6446 removed Variable Set consumers and #6710/#6714 shipped readiness and ORM retirement; advance the pinned previous-production baseline in a separate release change before queueing this contract.
-- Values have already migrated to vaults. Historical attachment columns and
-- accepted authority records are deliberately retained byte-for-byte.
-- No CASCADE and no implicit credential or delegation migration.
SET LOCAL lock_timeout = '5s';

ALTER TABLE workspace_variable_sets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_set_variables NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_variable_set_attachments NO FORCE ROW LEVEL SECURITY;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_variable_set_variables) THEN
    RAISE EXCEPTION 'Variable Set values must migrate to vaults before contraction'
      USING ERRCODE = '55000';
  END IF;
  -- Personal resource admission and recovery are immutable. Refuse every such
  -- resource, not just the population visible to a particular workspace.
  IF EXISTS (SELECT 1 FROM workspace_variable_sets WHERE authority_scope = 'user') THEN
    RAISE EXCEPTION 'personal Variable Set authority must retire before contraction'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.check_organization_tenancy_parity_pre_0340(p_organization_id uuid, p_evidence_limit integer DEFAULT 10, p_observation_window_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO '$user', %1$L
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  result jsonb;
  evidence_limit integer := least(greatest(coalesce(p_evidence_limit, 10), 0), 50);
  window_days integer := least(greatest(coalesce(p_observation_window_days, 30), 1), 365);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy parity check requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy parity scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_parity_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  WITH gate_catalog(gate_id) AS (
    VALUES
      ('membership_personal_workspace_pointer'::text),
      ('membership_personal_workspace_exclusive'),
      ('membership_personal_workspace_same_organization'),
      ('personal_workspace_has_no_membership_row'),
      ('authority_resource_single_owner'),
      ('grant_delegation_fence_complete'),
      ('grant_owner_membership_active'),
      ('grant_authority_live'),
      ('grant_session_fence_not_ahead'),
      ('session_owner_provenance_paired'),
      ('session_owner_subject_matches_membership'),
      ('session_owner_membership_same_organization'),
      ('login_binding_dispute_propagated'),
      ('identity_active_binding_owned'),
      ('user_scoped_resource_live_anchor')
  ),
  -- Canonical human identities are organization-INDEPENDENT by design, so an
  -- organization-scoped parity report may only inspect the identities that
  -- actually anchor a subject of THIS organization. `user:<auth_user_id>` is
  -- the canonical subject encoding used by organization_memberships.
  scoped_identities AS (
    SELECT DISTINCT identity_subject.identity_id
    FROM canonical_human_identity_subjects identity_subject
    JOIN organization_memberships membership
      ON membership.account_id = p_organization_id
     AND membership.subject_id = 'user:' || identity_subject.auth_user_id
  ),
  violations(gate_id, evidence_id) AS (
    -- An active membership must identify a personal workspace.
    SELECT 'membership_personal_workspace_pointer'::text, membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.status = 'active'
      AND membership.personal_workspace_id IS NULL

    UNION ALL
    -- A personal workspace may identify at most one organization membership.
    SELECT 'membership_personal_workspace_exclusive', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = p_organization_id
          AND other.id <> membership.id
          AND other.personal_workspace_id = membership.personal_workspace_id
      )

    UNION ALL
    -- The personal workspace must belong to the same organization.
    SELECT 'membership_personal_workspace_same_organization', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces workspace
        WHERE workspace.id = membership.personal_workspace_id
          AND workspace.account_id = p_organization_id
      )

    UNION ALL
    -- A managed personal workspace deliberately has NO workspace_memberships
    -- row: the owner-only access projection is derived, not delegable. A
    -- persisted row there is precisely how membership CRUD and the subject-
    -- membership fallback would widen it. Evidence is the workspace id.
    SELECT DISTINCT 'personal_workspace_has_no_membership_row',
      membership.personal_workspace_id
    FROM organization_memberships membership
    JOIN workspace_memberships workspace_membership
      ON workspace_membership.account_id = p_organization_id
     AND workspace_membership.workspace_id = membership.personal_workspace_id
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL

    UNION ALL
    -- Stable authority uniqueness. The physical unique index is per
    -- (account, membership, kind, resource), so two DIFFERENT memberships can
    -- still claim the same resource - the ambiguity that must never be
    -- resolved toward either user.
    SELECT 'authority_resource_single_owner', authority.id
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_organization_id
      AND authority.status <> 'revoked'
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities rival
        WHERE rival.account_id = p_organization_id
          AND rival.status <> 'revoked'
          AND rival.resource_kind = authority.resource_kind
          AND rival.resource_id = authority.resource_id
          AND rival.organization_membership_id
            <> authority.organization_membership_id
      )

    UNION ALL
    -- Zero partial delegations: `always` carries neither fence, once/session
    -- carry both.
    SELECT 'grant_delegation_fence_complete', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    WHERE resource_grant.account_id = p_organization_id
      AND NOT (
        (resource_grant.mode = 'always'
          AND resource_grant.session_id IS NULL
          AND resource_grant.authority_epoch IS NULL)
        OR (resource_grant.mode IN ('once', 'session')
          AND resource_grant.session_id IS NOT NULL
          AND resource_grant.authority_epoch IS NOT NULL
          AND resource_grant.authority_epoch > 0)
      )

    UNION ALL
    -- A live personal delegation owned by a human whose organization
    -- membership is suspended or revoked is a fallback to user authority.
    -- Suspension revokes personal-resource grants and offboarding runs the
    -- same teardown, so the drained state is the normal one.
    SELECT 'grant_owner_membership_active', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_memberships membership
      ON membership.id = resource_grant.owner_organization_membership_id
     AND membership.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND membership.status <> 'active'

    UNION ALL
    -- An active grant over a revoked authority.
    SELECT 'grant_authority_live', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_user_resource_authorities authority
      ON authority.id = resource_grant.authority_id
     AND authority.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND authority.status = 'revoked'

    UNION ALL
    -- A session-fenced grant whose epoch is AHEAD of the session it fences
    -- would survive the epoch advance that is supposed to revoke it. Epochs
    -- are monotonic and the fence is copied from the session at issuance, so
    -- `grant.authority_epoch <= session.authority_epoch` always holds.
    SELECT 'grant_session_fence_not_ahead', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN sessions session_row
      ON session_row.id = resource_grant.session_id
     AND session_row.workspace_id = resource_grant.workspace_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.session_id IS NOT NULL
      AND resource_grant.authority_epoch > session_row.authority_epoch

    UNION ALL
    -- Session owner provenance is paired, and a user_private session always
    -- has an owner.
    SELECT 'session_owner_provenance_paired', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND (
        (session_row.owner_organization_membership_id IS NULL)
          <> (session_row.owner_subject_id IS NULL)
        OR (session_row.visibility = 'user_private'
          AND session_row.owner_organization_membership_id IS NULL)
      )

    UNION ALL
    -- The denormalized owner subject must still name the owning membership.
    SELECT 'session_owner_subject_matches_membership', session_row.id
    FROM sessions session_row
    JOIN organization_memberships membership
      ON membership.id = session_row.owner_organization_membership_id
     AND membership.account_id = session_row.account_id
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_subject_id IS DISTINCT FROM membership.subject_id

    UNION ALL
    -- The owning membership must exist in this organization.
    SELECT 'session_owner_membership_same_organization', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = session_row.owner_organization_membership_id
          AND membership.account_id = p_organization_id
      )

    UNION ALL
    -- Provider-account collision rule: the physical unique index makes a
    -- second binding for one (provider, provider_account) impossible, so the
    -- collision is recorded by DISPUTING the existing binding and BOTH
    -- identities. A disputed binding whose identity is still usable is a
    -- collision that never fenced its identity.
    SELECT 'login_binding_dispute_propagated', binding.id
    FROM canonical_human_login_bindings binding
    JOIN scoped_identities scoped ON scoped.identity_id = binding.identity_id
    JOIN canonical_human_identities identity ON identity.id = binding.identity_id
    WHERE binding.status = 'disputed'
      AND identity.status <> 'disputed'

    UNION ALL
    -- The FK on active_login_binding_id proves existence, never ownership.
    SELECT 'identity_active_binding_owned', identity.id
    FROM canonical_human_identities identity
    JOIN scoped_identities scoped ON scoped.identity_id = identity.id
    WHERE identity.active_login_binding_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM canonical_human_login_bindings binding
        WHERE binding.id = identity.active_login_binding_id
          AND binding.identity_id = identity.id
      )

    UNION ALL
    -- Shadow comparison, connections lane: legacy effective scope is
    -- workspace; the proposed effective scope is `user`. A row claiming user
    -- authority without a live authority AND a live owning membership has no
    -- reachable user resolution - it must fall back to workspace or deny.
    SELECT 'user_scoped_resource_live_anchor', connection_row.id
    FROM connections connection_row
    WHERE connection_row.account_id = p_organization_id
      AND connection_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = connection_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', rig_row.id
    FROM rigs rig_row
    WHERE rig_row.account_id = p_organization_id
      AND rig_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = rig_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', enrollment.id
    FROM enrollments enrollment
    WHERE enrollment.account_id = p_organization_id
      AND enrollment.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = enrollment.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    -- Documents carry the same claim as authority_kind='personal' WITH a
    -- non-null authority_id (a null authority_id there is the separate,
    -- deliberately bounded legacy lane reported under `lanes`).
    SELECT 'user_scoped_resource_live_anchor', document.id
    FROM documents document
    WHERE document.account_id = p_organization_id
      AND document.authority_kind = 'personal'
      AND document.authority_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = document.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )
  ),
  aggregated AS (
    SELECT
      violation.gate_id,
      count(*)::int AS violation_count,
      (pg_catalog.array_agg(
        violation.evidence_id ORDER BY violation.evidence_id
      ))[1:evidence_limit] AS evidence
    FROM violations violation
    GROUP BY violation.gate_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'evidenceLimit', evidence_limit,
    'observationWindowDays', window_days,
    'gates', (
      SELECT pg_catalog.jsonb_object_agg(
        catalog.gate_id,
        pg_catalog.jsonb_build_object(
          'violations', coalesce(aggregated.violation_count, 0),
          'evidence', pg_catalog.to_jsonb(
            coalesce(aggregated.evidence, ARRAY[]::uuid[])
          ),
          'truncated', coalesce(aggregated.violation_count, 0)
            > coalesce(pg_catalog.array_length(aggregated.evidence, 1), 0)
        )
      )
      FROM gate_catalog catalog
      LEFT JOIN aggregated ON aggregated.gate_id = catalog.gate_id
    ),
    -- Compatibility lanes. These are populations the phase-D backfill drains;
    -- they are NOT invariant violations and must never be read as such.
    'lanes', pg_catalog.jsonb_build_object(
      'connectionsLegacyUser', (
        SELECT count(*)::int FROM connections connection_row
        WHERE connection_row.account_id = p_organization_id
          AND connection_row.authority_scope = 'legacy_user'
      ),
      -- Workspace-writer admissions and retained processes are immutable
      -- history: they are settled by UPDATE, nothing in the tree DELETEs them,
      -- and 0277's one-shot backfill only reached rows whose actor was a turn
      -- (`actor_kind`/`owner_actor_kind` = 'turn'), so every pre-0277 `direct:`
      -- or `process:` admission keeps the legacy_unattributed sentinel
      -- permanently. An all-time count of them therefore can never drain, and
      -- marking it drainable would make cutoverReady structurally unreachable
      -- for any deployment carrying one. Same treatment as the connection-use
      -- lane below: report the bounded recent window, where zero IS reachable
      -- and the honest signal is "the lane stopped being exercised".
      'workspaceWriterAdmissionsLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_workspace_mutation_admissions admission
        WHERE admission.account_id = p_organization_id
          AND admission.initiator_kind = 'legacy_unattributed'
          AND admission.admitted_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'workspaceWriterProcessesLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_retained_processes retained_process
        WHERE retained_process.account_id = p_organization_id
          AND retained_process.initiator_kind = 'legacy_unattributed'
          AND retained_process.started_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'documentsLegacyPersonalNullAuthority', (
        SELECT count(*)::int FROM documents document
        WHERE document.account_id = p_organization_id
          AND document.authority_kind = 'personal'
          AND document.authority_id IS NULL
      ),
      'codexCredentialsUnattributedConnector', 0,
      'workspaceMemberSubjectsWithoutMembershipAnchor', (
        SELECT count(DISTINCT workspace_membership.subject_id)::int
        FROM workspace_memberships workspace_membership
        JOIN workspaces workspace ON workspace.id = workspace_membership.workspace_id
        WHERE workspace.account_id = p_organization_id
          AND workspace_membership.subject_id LIKE 'user:%%'
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = workspace_membership.subject_id
          )
      ),
      -- The DRAINABLE refinement of "ownerless sessions": a session whose
      -- creating subject would be attributed by today's write fence but whose
      -- owner is still null. Total ownerlessness is deliberately NOT reported
      -- as drainable - a service/API-key session is permanently ownerless.
      'sessionsAttributableButUnattributed', (
        SELECT count(*)::int FROM sessions session_row
        WHERE session_row.account_id = p_organization_id
          AND session_row.owner_organization_membership_id IS NULL
          AND session_row.created_by_kind = 'subject'
          AND session_row.created_by_subject_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = session_row.created_by_subject_id
              AND membership.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_organization_id
              AND workspace_membership.workspace_id = session_row.workspace_id
              AND workspace_membership.subject_id = session_row.created_by_subject_id
          )
      ),
      -- Connection-use audit facts are immutable history, so the all-time
      -- count can never drain. The reachable-zero signal is "was the bounded
      -- pre-snapshot/legacy resolution lane exercised inside the observation
      -- window".
      'connectionUseLegacyResolutionsInWindow', (
        SELECT count(*)::int FROM connection_use_audit_facts audit_fact
        WHERE audit_fact.account_id = p_organization_id
          AND audit_fact.authority_scope = 'legacy_user'
          AND audit_fact.occurred_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.configure_fork_session_runtime(p_account_id uuid, p_workspace_id uuid, p_source_session_id uuid, p_destination_session_id uuid, p_actor_subject_id text, p_variable_set_ids jsonb, p_rig_id uuid, p_rig_version_id uuid, p_configuration_digest text)
 RETURNS TABLE(runtime_event_id uuid, runtime_event_sequence integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
DECLARE
  destination_session sessions%%ROWTYPE;
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
  IF selected_count <> 0
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
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.accept_turn_personal_resource_attachment(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_mode text, p_expected_authority_epoch integer, p_workspace_shared_acknowledged boolean, p_shared_output_warning_version integer)
 RETURNS TABLE(grant_mode text, grant_context text, resource_count integer, resource_kinds text[], shared_output_warning_version integer, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  session_row sessions%%ROWTYPE;
  turn_row session_turns%%ROWTYPE;
  member_row organization_memberships%%ROWTYPE;
  resource_row record;
  authority_row organization_user_resource_authorities%%ROWTYPE;
  grant_row organization_user_resource_grants%%ROWTYPE;
  existing_receipt turn_personal_resource_attachment_receipts%%ROWTYPE;
  canonical jsonb;
  request_hash bytea;
  selected_resources jsonb := '[]'::jsonb;
  selected_count integer := 0;
  unauthorized_count integer := 0;
  kinds text[] := ARRAY[]::text[];
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR caller_subject IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('once', 'session', 'always')
    OR p_expected_authority_epoch IS NULL OR p_expected_authority_epoch <= 0
    OR p_shared_output_warning_version IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION 'invalid atomic personal-resource attachment request'
      USING ERRCODE = '22023';
  END IF;
  -- 0611: every organization is session-tenancy activated.

  PERFORM acquire_session_tenancy_fence(p_workspace_id);

  PERFORM 1 FROM workspace_inference_controls control_row
  WHERE control_row.account_id = p_account_id AND control_row.workspace_id = p_workspace_id
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.account_id = p_account_id AND workspace_value.id = p_workspace_id
  FOR KEY SHARE;
  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
  FOR NO KEY UPDATE;
  SELECT turn_value.* INTO STRICT turn_row
  FROM session_turns turn_value
  WHERE turn_value.id = p_turn_id
    AND turn_value.account_id = p_account_id
    AND turn_value.workspace_id = p_workspace_id
    AND turn_value.session_id = p_session_id
  FOR UPDATE;

  IF coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
      CASE WHEN turn_row.initiator_kind = 'subject'
        THEN nullif(btrim(turn_row.initiator_subject_id), '') END)
      IS DISTINCT FROM caller_subject
    OR session_row.authority_epoch IS DISTINCT FROM p_expected_authority_epoch
  THEN
    RAISE EXCEPTION 'atomic personal-resource attachment is not exact accepted work'
      USING ERRCODE = '42501';
  END IF;
  IF session_row.visibility = 'workspace_shared'
    AND p_workspace_shared_acknowledged IS NOT TRUE
  THEN
    RAISE EXCEPTION 'workspace-shared personal-resource attachment requires warning acknowledgement'
      USING ERRCODE = '42501';
  END IF;

  request_hash := digest(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'sessionId', p_session_id, 'turnId', p_turn_id, 'mode', p_mode,
    'authorityEpoch', p_expected_authority_epoch,
    'sessionVisibility', session_row.visibility,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged IS TRUE,
    'sharedOutputWarningVersion', p_shared_output_warning_version
  )::text, 'UTF8'), 'sha256');

  SELECT receipt.* INTO existing_receipt
  FROM turn_personal_resource_attachment_receipts receipt
  WHERE receipt.turn_id = p_turn_id;
  IF FOUND THEN
    IF existing_receipt.request_digest IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'atomic personal-resource attachment replay changed its request'
        USING ERRCODE = '23505';
    END IF;
    grant_mode := existing_receipt.grant_mode;
    grant_context := existing_receipt.session_visibility;
    resource_count := existing_receipt.resource_count;
    SELECT array_agg(DISTINCT snapshot.resource_kind ORDER BY snapshot.resource_kind)
      INTO resource_kinds
    FROM turn_personal_resource_snapshots snapshot
    WHERE snapshot.turn_id = p_turn_id;
    shared_output_warning_version := existing_receipt.shared_output_warning_version;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF session_row.status = 'cancelled'
    OR turn_row.status <> 'queued'
    OR turn_row.active_attempt_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'personal-resource issuance requires new queued accepted work'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL
  FOR SHARE;
  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id
    AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = caller_subject
    )
  THEN
    RAISE EXCEPTION 'owner lacks target-workspace access' USING ERRCODE = '42501';
  END IF;

  -- Freeze every row that can change the server-derived closure before
  -- evaluating it. The closure is materialized once below and reused for grant
  -- issuance, so a concurrent resource edit cannot create a mixed snapshot.
  PERFORM 1 FROM rigs rig
  WHERE rig.id = session_row.rig_id AND rig.account_id = p_account_id
  FOR SHARE;
  PERFORM 1 FROM rig_versions version_value
  WHERE version_value.id = session_row.rig_version_id
    AND version_value.rig_id = session_row.rig_id
    AND version_value.account_id = p_account_id
  FOR SHARE;
  PERFORM sandbox.id
  FROM sandboxes sandbox
  WHERE sandbox.id = session_row.active_sandbox_id
    AND sandbox.account_id = p_account_id
    AND sandbox.kind = 'selfhosted'
  FOR SHARE;
  PERFORM enrollment.id
  FROM sandboxes sandbox
  JOIN enrollments enrollment
    ON enrollment.id = sandbox.enrollment_id
   AND enrollment.account_id = p_account_id
  WHERE sandbox.id = session_row.active_sandbox_id
    AND sandbox.account_id = p_account_id
    AND sandbox.kind = 'selfhosted'
    AND enrollment.authority_scope = 'user'
  FOR SHARE OF enrollment;

  WITH selected AS (
    SELECT 'rig'::text AS resource_kind, rig.id AS resource_id,
      session_row.rig_version_id AS resource_version_id, 'rig.use'::text AS action,
      'session_rig'::text AS selection_source, rig.origin_workspace_id,
      rig.authority_id, rig.owner_organization_membership_id
    FROM rigs rig
    WHERE rig.id = session_row.rig_id
      AND rig.account_id = p_account_id AND rig.authority_scope = 'user'
    UNION ALL
    SELECT 'connected_machine', enrollment.id, NULL::uuid,
      'connected_machine.use', 'session_active_sandbox',
      enrollment.origin_workspace_id, enrollment.authority_id,
      enrollment.owner_organization_membership_id
    FROM sandboxes sandbox
    JOIN enrollments enrollment
      ON enrollment.id = sandbox.enrollment_id
     AND enrollment.account_id = p_account_id
    WHERE sandbox.id = session_row.active_sandbox_id
      AND sandbox.account_id = p_account_id
      AND sandbox.kind = 'selfhosted'
      AND enrollment.authority_scope = 'user'
      AND enrollment.status = 'active'
  ), grouped AS (
    SELECT resource_kind, resource_id,
      min(resource_version_id::text)::uuid AS resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) AS selection_sources,
      min(origin_workspace_id::text)::uuid AS origin_workspace_id,
      min(authority_id::text)::uuid AS authority_id,
      min(owner_organization_membership_id::text)::uuid
        AS owner_organization_membership_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
  )
  SELECT count(*)::integer,
    array_agg(DISTINCT resource_kind ORDER BY resource_kind),
    count(*) FILTER (
      WHERE owner_organization_membership_id IS DISTINCT FROM member_row.id
    )::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'resource_kind', resource_kind,
      'resource_id', resource_id,
      'resource_version_id', resource_version_id,
      'action', action,
      'selection_sources', selection_sources,
      'origin_workspace_id', origin_workspace_id,
      'authority_id', authority_id,
      'owner_organization_membership_id', owner_organization_membership_id
    ) ORDER BY resource_kind, resource_id), '[]'::jsonb)
  INTO selected_count, kinds, unauthorized_count, selected_resources
  FROM grouped;
  IF selected_count = 0 THEN
    RAISE EXCEPTION 'no personal Variable Set, Rig, or Connected Machine is selected by this session'
      USING ERRCODE = '22023';
  END IF;
  IF selected_count > 52 THEN
    RAISE EXCEPTION 'personal resource closure exceeds the accepted-work bound'
      USING ERRCODE = '22023';
  END IF;
  IF unauthorized_count <> 0 THEN
    RAISE EXCEPTION 'a nonowner cannot attach another user''s personal resource'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO turn_personal_resource_attachment_receipts (
    turn_id, account_id, workspace_id, session_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, session_visibility,
    session_authority_epoch, grant_mode, shared_output_warning_version,
    shared_output_acknowledged, request_digest, resource_count
  ) VALUES (
    p_turn_id, p_account_id, p_workspace_id, p_session_id, caller_subject,
    member_row.id, member_row.authorization_revision, session_row.visibility,
    session_row.authority_epoch, p_mode, p_shared_output_warning_version,
    p_workspace_shared_acknowledged IS TRUE, request_hash, selected_count
  );

  FOR resource_row IN
    SELECT * FROM jsonb_to_recordset(selected_resources) AS selected(
      resource_kind text,
      resource_id uuid,
      resource_version_id uuid,
      action text,
      selection_sources text[],
      origin_workspace_id uuid,
      authority_id uuid,
      owner_organization_membership_id uuid
    )
    ORDER BY resource_kind, resource_id
  LOOP
    SELECT authority.* INTO STRICT authority_row
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.status = 'active' AND authority.revoked_at IS NULL
    FOR UPDATE;

    UPDATE organization_user_resource_grants grant_value
    SET status = 'expired', updated_at = clock_timestamp()
    WHERE grant_value.account_id = p_account_id
      AND grant_value.authority_id = authority_row.id
      AND grant_value.status = 'active'
      AND grant_value.expires_at IS NOT NULL
      AND grant_value.expires_at <= clock_timestamp();

    INSERT INTO organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, generation, status
    ) VALUES (
      p_account_id, authority_row.id, member_row.id, p_workspace_id,
      CASE WHEN p_mode = 'always' THEN NULL ELSE p_session_id END,
      resource_row.action, p_mode, session_row.visibility,
      CASE WHEN p_mode = 'always' THEN NULL ELSE session_row.authority_epoch END,
      1, 'active'
    )
    ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
      (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
      (coalesce(authority_epoch, 0))) WHERE status = 'active'
    DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
    RETURNING * INTO grant_row;

    canonical := jsonb_build_object(
      'authorityId', authority_row.id, 'grantId', grant_row.id,
      'organizationId', p_account_id, 'workspaceId', p_workspace_id,
      'sessionId', grant_row.session_id, 'action', resource_row.action,
      'mode', grant_row.mode, 'context', grant_row.context,
      'authorityEpoch', grant_row.authority_epoch,
      'authorityGeneration', authority_row.generation,
      'grantGeneration', grant_row.generation,
      'resourceVersionId', resource_row.resource_version_id
    );
    canonical := canonical - CASE WHEN resource_row.resource_version_id IS NULL
      THEN 'resourceVersionId' ELSE '__not_present__' END;

    INSERT INTO turn_personal_resource_snapshots (
      turn_id, account_id, workspace_id, session_id, resource_kind, resource_id,
      resource_version_id, selection_sources, action, origin_workspace_id,
      owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, grant_id, grant_generation, grant_mode,
      grant_context, grant_session_id, grant_authority_epoch,
      canonical_delegation, snapshot_digest
    ) VALUES (
      p_turn_id, p_account_id, p_workspace_id, p_session_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources,
      resource_row.action, resource_row.origin_workspace_id, member_row.id,
      member_row.authorization_revision, authority_row.id, authority_row.generation,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch, canonical,
      decode('', 'hex')
    );

    IF p_mode = 'once' THEN
      UPDATE organization_user_resource_grants
      SET status = 'consumed', updated_at = clock_timestamp()
      WHERE id = grant_row.id AND account_id = p_account_id
        AND generation = grant_row.generation AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'once grant lost its accepted-turn race' USING ERRCODE = '40001';
      END IF;
      INSERT INTO turn_personal_resource_once_receipts (
        grant_id, turn_id, account_id, authority_id,
        authority_generation, grant_generation
      ) VALUES (
        grant_row.id, p_turn_id, p_account_id, authority_row.id,
        authority_row.generation, grant_row.generation
      );
    END IF;
  END LOOP;

  UPDATE session_turns
  SET personal_resource_attachment_summary = jsonb_build_object(
      'mode', p_mode, 'context', session_row.visibility,
      'resourceCount', selected_count, 'resourceKinds', to_jsonb(kinds),
      'sharedOutputWarningVersion', p_shared_output_warning_version
    ),
    personal_resource_protocol_version = 1,
    updated_at = clock_timestamp()
  WHERE id = p_turn_id AND account_id = p_account_id AND workspace_id = p_workspace_id;

  INSERT INTO audit_events (
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, caller_subject,
    'session.personal_resources.attach', 'session_turn', p_turn_id::text,
    jsonb_build_object(
      'sessionId', p_session_id, 'turnId', p_turn_id, 'mode', p_mode,
      'context', session_row.visibility, 'authorityEpoch', session_row.authority_epoch,
      'sharedOutputWarningVersion', p_shared_output_warning_version,
      'sharedOutputAcknowledged', p_workspace_shared_acknowledged IS TRUE,
      'resourceCount', selected_count, 'resourceKinds', to_jsonb(kinds)
    ), 1
  );

  grant_mode := p_mode;
  grant_context := session_row.visibility;
  resource_count := selected_count;
  resource_kinds := kinds;
  shared_output_warning_version := p_shared_output_warning_version;
  replay := false;
  RETURN NEXT;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.activate_session_tenancy_product(p_account_id uuid, p_inventory_digest text, p_parity_digest text, p_activated_by text, p_application_roles text[])
 RETURNS TABLE(account_id uuid, activation_version integer, activated_at timestamp with time zone, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'opengeni_private', 'public', 'pg_temp'
AS $function$
DECLARE
  existing session_tenancy_activations%%ROWTYPE;
  inserted session_tenancy_activations%%ROWTYPE;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  inventory_report jsonb;
  parity_report jsonb;
  backfill_evidence jsonb;
  computed_inventory_digest text;
  computed_parity_digest text;
  evidence_receipt_ids uuid[];
  required_gate text;
  required_lane text;
  required_gates constant text[] := ARRAY[
    'membership_personal_workspace_pointer',
    'membership_personal_workspace_exclusive',
    'membership_personal_workspace_same_organization',
    'personal_workspace_has_no_membership_row',
    'authority_resource_single_owner',
    'grant_delegation_fence_complete',
    'grant_owner_membership_active',
    'grant_authority_live',
    'grant_session_fence_not_ahead',
    'session_owner_provenance_paired',
    'session_owner_subject_matches_membership',
    'session_owner_membership_same_organization',
    'login_binding_dispute_propagated',
    'identity_active_binding_owned',
    'user_scoped_resource_live_anchor'
  ];
  required_lanes constant text[] := ARRAY[
    'connectionsLegacyUser',
    'workspaceWriterAdmissionsLegacyUnattributedInWindow',
    'workspaceWriterProcessesLegacyUnattributedInWindow',
    'documentsLegacyPersonalNullAuthority',
    'codexCredentialsUnattributedConnector',
    'workspaceMemberSubjectsWithoutMembershipAnchor',
    'sessionsAttributableButUnattributed',
    'connectionUseLegacyResolutionsInWindow'
  ];
BEGIN
  IF p_account_id IS NULL
    OR p_inventory_digest !~ '^[0-9a-f]{64}$'
    OR p_parity_digest !~ '^[0-9a-f]{64}$'
    OR pg_catalog.octet_length(pg_catalog.btrim(p_activated_by)) NOT BETWEEN 1 AND 256
    OR p_application_roles IS NULL
    OR pg_catalog.cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name <> pg_catalog.btrim(role_name)
        OR pg_catalog.octet_length(role_name) NOT BETWEEN 1 AND 63
    )
    OR pg_catalog.cardinality(ARRAY(
      SELECT DISTINCT role_name FROM pg_catalog.unnest(p_application_roles) role_name
    )) <> pg_catalog.cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy activation request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  LOCK TABLE
    workspaces, workspace_memberships, organization_memberships,
    canonical_human_identities, canonical_human_identity_subjects,
    canonical_human_login_bindings, sessions, session_turns,
    session_turn_attempts, session_attempt_interruptions,
    session_system_updates, session_human_input_requests,
    session_pending_tool_calls, agent_run_states, session_goals,
    session_realtime_modes,
    session_realtime_connections, scheduled_tasks,
    rigs, enrollments, connections, documents,
    sandbox_workspace_mutation_admissions,
    sandbox_retained_processes, sandbox_lease_holders,
    organization_user_resource_authorities, organization_user_resource_grants,
    connection_use_audit_facts, tenancy_backfill_receipts,
    tenancy_backfill_unresolved_rows, session_tenancy_activations
  IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  -- Lock every provisioning source before the shared deployment fence. The
  -- greenfield path writes its graph first and takes the fence last; reversing
  -- this order would deadlock RowExclusive -> boundary against boundary ->
  -- AccessExclusive during the first cutover.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  SELECT * INTO existing FROM session_tenancy_activations activation
  WHERE activation.account_id = p_account_id;
  IF FOUND THEN
    IF existing.inventory_digest <> p_inventory_digest
      OR existing.parity_digest <> p_parity_digest
    THEN
      RAISE EXCEPTION 'session tenancy activation evidence conflicts with the durable receipt'
        USING ERRCODE = '23505';
    END IF;
    account_id := existing.account_id;
    activation_version := existing.activation_version;
    activated_at := existing.activated_at;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  inventory_report := inventory_organization_tenancy(p_account_id);
  parity_report := check_organization_tenancy_parity(p_account_id, 10, 30);
  backfill_evidence := check_tenancy_backfill_activation_evidence(p_account_id);
  IF inventory_report #>> '{schemaVersion}' <> '2'
    OR inventory_report ->> 'organizationId' <> p_account_id::text
    OR parity_report #>> '{schemaVersion}' <> '1'
    OR parity_report ->> 'organizationId' <> p_account_id::text
    OR pg_catalog.jsonb_typeof(parity_report -> 'gates') <> 'object'
    OR pg_catalog.jsonb_typeof(parity_report -> 'lanes') <> 'object'
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;

  FOREACH required_gate IN ARRAY required_gates LOOP
    IF NOT (parity_report -> 'gates' ? required_gate)
      OR pg_catalog.jsonb_typeof(parity_report -> 'gates' -> required_gate -> 'violations')
        <> 'number'
      OR (parity_report #>> ARRAY['gates', required_gate, 'violations'])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation parity gate is not clean: %%', required_gate
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'gates') gate
    WHERE pg_catalog.jsonb_typeof(gate.value -> 'violations') <> 'number'
      OR (gate.value ->> 'violations')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation parity has a non-zero gate'
      USING ERRCODE = '55000';
  END IF;
  FOREACH required_lane IN ARRAY required_lanes LOOP
    IF NOT (parity_report -> 'lanes' ? required_lane)
      OR pg_catalog.jsonb_typeof(parity_report -> 'lanes' -> required_lane) <> 'number'
      OR (parity_report #>> ARRAY['lanes', required_lane])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation compatibility lane is not drained: %%',
        required_lane USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'lanes') lane
    WHERE pg_catalog.jsonb_typeof(lane.value) <> 'number'
      OR (lane.value #>> '{}')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation has an undrained compatibility lane'
      USING ERRCODE = '55000';
  END IF;
  IF coalesce((backfill_evidence ->> 'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'session tenancy activation requires settled backfill evidence'
      USING ERRCODE = '55000', DETAIL = (backfill_evidence -> 'blockers')::text;
  END IF;

  computed_inventory_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(inventory_report), 'UTF8'
  ), 'sha256'), 'hex');
  computed_parity_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(parity_report), 'UTF8'
  ), 'sha256'), 'hex');
  IF computed_inventory_digest <> p_inventory_digest
    OR computed_parity_digest <> p_parity_digest
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence changed before the cutover lock'
      USING ERRCODE = '40001';
  END IF;

  SELECT pg_catalog.array_agg(receipt_id::uuid ORDER BY ordinal)
    INTO evidence_receipt_ids
  FROM pg_catalog.jsonb_array_elements_text(backfill_evidence -> 'receiptIds')
    WITH ORDINALITY AS evidence(receipt_id, ordinal);
  IF pg_catalog.cardinality(evidence_receipt_ids) <> 6 THEN
    RAISE EXCEPTION 'session tenancy activation backfill evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;
  -- The narrow marker window for the one append this function performs. The
  -- `RETURNING` read is covered by 0303's existing organization-isolation
  -- SELECT policy, whose account GUC this function already set above.
  BEGIN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
    );
    INSERT INTO session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) VALUES (
      p_account_id, 1, p_inventory_digest, p_parity_digest,
      pg_catalog.btrim(p_activated_by), evidence_receipt_ids
    ) RETURNING * INTO inserted;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RAISE;
  END;
  account_id := inserted.account_id;
  activation_version := inserted.activation_version;
  activated_at := inserted.activated_at;
  replay := false;
  RETURN NEXT;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.admit_scheduled_task_run_personal_resources()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
DECLARE
  task_row record;
  authority_row record;
  once_snapshot record;
  selected_personal_count integer;
  has_authority boolean := false;
  invalid_count integer;
  affected integer;
BEGIN
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = NEW.task_id
    AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR UPDATE;

  IF (NEW.task_authority_revision IS NULL) <> (NEW.task_execution_digest IS NULL) THEN
    RAISE EXCEPTION 'scheduled task run execution binding is incomplete'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.task_authority_revision IS NOT NULL AND (
    NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
  ) THEN
    RAISE EXCEPTION 'scheduled task changed after worker read'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
  ON CONFLICT DO NOTHING;

  SELECT authority.* INTO authority_row
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = task_row.authority_revision;
  has_authority := FOUND;
  IF NOT has_authority THEN
    SELECT count(*)::integer INTO selected_personal_count
    FROM rigs rig
    WHERE rig.id = task_row.rig_id AND rig.account_id = task_row.account_id
      AND rig.authority_scope = 'user';
    IF selected_personal_count = 0 THEN
      DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
      WHERE backend_pid = pg_backend_pid()
        AND transaction_id = pg_current_xact_id_if_assigned()
        AND capability_kind = 'run_admit';
      RETURN NEW;
    END IF;
  END IF;

  -- Ordinary run-history rows remain writable for paused tasks. The active
  -- fence applies only when this insert would admit personal-resource
  -- authority, and is checked while holding the task row lock before any
  -- admission/snapshot/once-consumption write.
  IF task_row.status <> 'active' THEN
    RAISE EXCEPTION 'scheduled task is not active' USING ERRCODE = '55000';
  END IF;

  IF NOT has_authority THEN
    RAISE EXCEPTION 'scheduled personal-resource task has no authority snapshot'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.task_authority_revision IS NULL THEN
    RAISE EXCEPTION 'scheduled personal-resource run requires an execution binding'
      USING ERRCODE = '42501';
  END IF;
  IF authority_row.execution_digest IS DISTINCT FROM task_row.execution_digest
    OR authority_row.task_authority_revision IS DISTINCT FROM NEW.task_authority_revision
    OR authority_row.execution_digest IS DISTINCT FROM NEW.task_execution_digest
  THEN
    RAISE EXCEPTION 'scheduled personal-resource execution binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO invalid_count
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision
    AND NOT (
      EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = snapshot.account_id
          AND membership.subject_id = authority_row.initiating_human_subject_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = snapshot.workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = membership.account_id
              AND workspace_membership.workspace_id = snapshot.workspace_id
              AND workspace_membership.subject_id = membership.subject_id
          ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id
          AND authority.account_id = snapshot.account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = snapshot.resource_kind
          AND authority.resource_id = snapshot.resource_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
      )
      AND (
        (snapshot.resource_kind = 'rig' AND EXISTS (
          SELECT 1 FROM rigs rig
          JOIN rig_versions rig_version
            ON rig_version.id = snapshot.resource_version_id
           AND rig_version.rig_id = rig.id
           AND rig_version.account_id = rig.account_id
          WHERE rig.id = snapshot.resource_id
            AND rig.account_id = snapshot.account_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = snapshot.authority_id
            AND rig.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
        ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = snapshot.account_id
          AND grant_value.authority_id = snapshot.authority_id
          AND grant_value.owner_organization_membership_id =
            snapshot.owner_organization_membership_id
          AND grant_value.workspace_id = snapshot.target_workspace_id
          AND grant_value.action = snapshot.action
          AND grant_value.mode = snapshot.grant_mode
          AND grant_value.context = snapshot.grant_context
          AND grant_value.generation = snapshot.grant_generation
          AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
          AND grant_value.authority_epoch IS NOT DISTINCT FROM snapshot.grant_authority_epoch
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      )
      AND (
        authority_row.target_session_id IS NULL
        OR EXISTS (
          SELECT 1 FROM sessions session_value
          WHERE session_value.id = authority_row.target_session_id
            AND session_value.account_id = authority_row.account_id
            AND session_value.workspace_id = authority_row.workspace_id
            AND session_value.status <> 'cancelled'
            AND (authority_row.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'scheduled personal-resource authority snapshot is no longer live'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO scheduled_task_run_personal_resource_admissions (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    NEW.id, authority_row.task_id, authority_row.task_authority_revision,
    authority_row.account_id, authority_row.workspace_id,
    authority_row.initiating_human_subject_id,
    authority_row.owner_organization_membership_id,
    authority_row.membership_authorization_revision, authority_row.target_session_id,
    authority_row.session_visibility, authority_row.session_authority_epoch,
    authority_row.execution_digest, authority_row.resource_count
  );

  INSERT INTO scheduled_task_run_personal_resource_snapshots (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    resource_kind, resource_id, resource_version_id, selection_sources, action,
    origin_workspace_id, owner_organization_membership_id,
    membership_authorization_revision, authority_id, authority_generation,
    target_workspace_id, session_visibility, session_authority_epoch,
    grant_id, grant_generation, grant_mode, grant_context,
    grant_session_id, grant_authority_epoch
  )
  SELECT NEW.id, snapshot.task_id, snapshot.task_authority_revision,
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
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision;

  FOR once_snapshot IN
    SELECT snapshot.*
    FROM scheduled_task_run_personal_resource_snapshots snapshot
    WHERE snapshot.run_id = NEW.id
      AND snapshot.grant_mode = 'once'
    ORDER BY snapshot.grant_id
  LOOP
    UPDATE organization_user_resource_grants grant_value
    SET status = 'consumed', updated_at = clock_timestamp()
    WHERE grant_value.id = once_snapshot.grant_id
      AND grant_value.account_id = once_snapshot.account_id
      AND grant_value.authority_id = once_snapshot.authority_id
      AND grant_value.generation = once_snapshot.grant_generation
      AND grant_value.status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'scheduled occurrence once grant lost its first-use race'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO scheduled_task_run_personal_resource_once_receipts (
      grant_id, run_id, account_id, workspace_id, authority_id,
      authority_generation, grant_generation
    ) VALUES (
      once_snapshot.grant_id, NEW.id, once_snapshot.account_id,
      once_snapshot.workspace_id, once_snapshot.authority_id,
      once_snapshot.authority_generation, once_snapshot.grant_generation
    );
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.admit_session_attempt_personal_resources()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO %1$L, 'pg_catalog'
AS $function$
    DECLARE
      session_row sessions%%ROWTYPE;
      turn_row session_turns%%ROWTYPE;
      member_row organization_memberships%%ROWTYPE;
      resource_row record;
      grant_row organization_user_resource_grants%%ROWTYPE;
      resource_total integer := 0;
      snapshot_total integer := 0;
      initiating_subject text;
      affected integer;
    BEGIN
      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'admit')
      ON CONFLICT DO NOTHING;

      SELECT session_value.* INTO STRICT session_row
      FROM sessions session_value
      WHERE session_value.id = NEW.session_id
        AND session_value.account_id = NEW.account_id
        AND session_value.workspace_id = NEW.workspace_id
      FOR SHARE;

      SELECT turn_value.* INTO STRICT turn_row
      FROM session_turns turn_value
      WHERE turn_value.id = NEW.turn_id
        AND turn_value.account_id = NEW.account_id
        AND turn_value.workspace_id = NEW.workspace_id
        AND turn_value.session_id = NEW.session_id
      FOR SHARE;

      SELECT count(*)::integer INTO resource_total
      FROM rigs rig
      WHERE rig.id = session_row.rig_id AND rig.account_id = NEW.account_id
        AND rig.authority_scope = 'user';

      IF resource_total = 0 THEN
        DELETE FROM opengeni_private.personal_resource_delegation_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN NEW;
      END IF;

      IF NEW.execution_generation <= 0
        OR NEW.state NOT IN ('claimed', 'running')
        OR NEW.closed_at IS NOT NULL
        OR NEW.quiesced_at IS NOT NULL
        OR session_row.active_turn_id IS DISTINCT FROM NEW.turn_id
        OR turn_row.active_attempt_id IS DISTINCT FROM NEW.id
        OR turn_row.execution_generation IS DISTINCT FROM NEW.execution_generation
        OR turn_row.status <> 'running'
        OR EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.account_id = NEW.account_id
            AND interruption.workspace_id = NEW.workspace_id
            AND interruption.session_id = NEW.session_id
            AND interruption.attempt_id = NEW.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      THEN
        RAISE EXCEPTION 'personal-resource admission requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      IF NOT (NEW.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
        OR NEW.authority_owner_organization_membership_id
          IS DISTINCT FROM session_row.owner_organization_membership_id
      THEN
        RAISE EXCEPTION 'personal-resource admission requires the exact session authority'
          USING ERRCODE = '42501';
      END IF;

      initiating_subject := coalesce(
        nullif(btrim(turn_row.initiating_human_subject_id), ''),
        CASE WHEN turn_row.initiator_kind = 'subject'
          THEN nullif(btrim(turn_row.initiator_subject_id), '') END
      );
      IF initiating_subject IS NULL THEN
        RAISE EXCEPTION 'personal-resource admission requires an initiating human subject'
          USING ERRCODE = '42501';
      END IF;

      BEGIN
      SELECT membership.* INTO STRICT member_row
      FROM organization_memberships membership
      WHERE membership.account_id = NEW.account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;
      EXCEPTION WHEN no_data_found THEN
        RAISE EXCEPTION 'personal-resource initiating membership required' USING ERRCODE = 'OG001';
      END;

      IF member_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
        PERFORM 1
        FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = NEW.account_id
          AND workspace_membership.workspace_id = NEW.workspace_id
          AND workspace_membership.subject_id = initiating_subject
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'initiating human lacks target-workspace membership'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      INSERT INTO session_attempt_personal_resource_admissions (
        attempt_id, account_id, workspace_id, session_id, turn_id,
        execution_generation, initiating_human_subject_id,
        owner_organization_membership_id, membership_authorization_revision,
        session_visibility, session_authority_epoch, resource_count
      ) VALUES (
        NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
        NEW.execution_generation, initiating_subject, member_row.id,
        member_row.authorization_revision, session_row.visibility,
        session_row.authority_epoch, resource_total
      );

      FOR resource_row IN
        WITH selected AS (
          SELECT 'rig'::text AS resource_kind, rig.id AS resource_id,
            session_row.rig_version_id AS resource_version_id, 'rig.use'::text AS action,
            'session_rig'::text AS selection_source, rig.workspace_id AS resource_workspace_id,
            rig.authority_id, rig.owner_organization_membership_id, rig.origin_workspace_id
          FROM rigs rig
          WHERE rig.id = session_row.rig_id AND rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
        )
        SELECT resource_kind, resource_id,
          min(resource_version_id::text)::uuid AS resource_version_id,
          action, array_agg(selection_source ORDER BY selection_source) AS selection_sources,
          min(resource_workspace_id::text)::uuid AS resource_workspace_id,
          min(authority_id::text)::uuid AS authority_id,
          min(owner_organization_membership_id::text)::uuid
            AS owner_organization_membership_id,
          min(origin_workspace_id::text)::uuid AS origin_workspace_id
        FROM selected
        GROUP BY resource_kind, resource_id, action
        ORDER BY resource_kind, resource_id
      LOOP
        IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
        THEN
          RAISE EXCEPTION 'personal resource owner/origin does not match initiating membership'
            USING ERRCODE = '42501';
        END IF;

          PERFORM 1 FROM rigs rig
          WHERE rig.id = resource_row.resource_id
            AND rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = resource_row.authority_id
            AND rig.owner_organization_membership_id = member_row.id
          FOR SHARE;
          IF FOUND THEN
            PERFORM 1 FROM rig_versions rig_version
            WHERE rig_version.id = resource_row.resource_version_id
              AND rig_version.account_id = NEW.account_id
              AND rig_version.rig_id = resource_row.resource_id
            FOR SHARE;
          END IF;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource identity changed during admission'
            USING ERRCODE = '42501';
        END IF;

        PERFORM 1
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id
          AND authority.organization_membership_id = member_row.id
          AND authority.resource_kind = resource_row.resource_kind
          AND authority.resource_id = resource_row.resource_id
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource authority is not live'
            USING ERRCODE = '42501';
        END IF;

        SELECT grant_value.* INTO grant_row
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.account_id = NEW.account_id
          AND grant_value.authority_id = resource_row.authority_id
          AND grant_value.owner_organization_membership_id = member_row.id
          AND grant_value.workspace_id = NEW.workspace_id
          AND grant_value.action = resource_row.action
          AND (grant_value.context = session_row.visibility OR (
      grant_value.context = 'user_private' AND session_row.visibility = 'workspace_shared'
      AND grant_value.mode IN ('once','session') AND grant_value.session_id = session_row.id
      AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)))
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND (
            (
              grant_value.mode IN ('once', 'session')
              AND grant_value.session_id = NEW.session_id
              AND (grant_value.authority_epoch BETWEEN session_row.execution_authority_epoch AND session_row.authority_epoch)
            ) OR (
              grant_value.mode = 'always'
              AND grant_value.session_id IS NULL
              AND grant_value.authority_epoch IS NULL
            )
          )
        ORDER BY
          CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
          grant_value.generation DESC,
          grant_value.id
        LIMIT 1
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'matching personal-resource grant required'
            USING ERRCODE = 'OG002';
        END IF;

        INSERT INTO session_attempt_personal_resource_snapshots (
          attempt_id, account_id, workspace_id, session_id, turn_id,
          execution_generation, resource_kind, resource_id, resource_version_id,
          selection_sources, action, origin_workspace_id,
          owner_organization_membership_id, membership_authorization_revision,
          authority_id, authority_generation, target_workspace_id,
          session_visibility, session_authority_epoch, grant_id, grant_generation,
          grant_mode, grant_context, grant_session_id, grant_authority_epoch
        )
        SELECT
          NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
          NEW.execution_generation, resource_row.resource_kind, resource_row.resource_id,
          resource_row.resource_version_id, resource_row.selection_sources,
          resource_row.action, resource_row.origin_workspace_id, member_row.id,
          member_row.authorization_revision, authority.id, authority.generation,
          NEW.workspace_id, session_row.visibility, session_row.authority_epoch,
          grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
          grant_row.session_id, grant_row.authority_epoch
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id;

        IF grant_row.mode = 'once' THEN
          UPDATE organization_user_resource_grants
          SET status = 'consumed', updated_at = clock_timestamp()
          WHERE id = grant_row.id
            AND account_id = NEW.account_id
            AND generation = grant_row.generation
            AND status = 'active';
          GET DIAGNOSTICS affected = ROW_COUNT;
          IF affected <> 1 THEN
            RAISE EXCEPTION 'once grant lost its first-use race'
              USING ERRCODE = '40001';
          END IF;
          INSERT INTO personal_resource_once_consumption_receipts (
            grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
            execution_generation, authority_id, authority_generation, grant_generation
          ) SELECT
            grant_row.id, NEW.account_id, NEW.id, NEW.workspace_id, NEW.session_id,
            NEW.turn_id, NEW.execution_generation, authority.id, authority.generation,
            grant_row.generation
          FROM organization_user_resource_authorities authority
          WHERE authority.id = resource_row.authority_id
            AND authority.account_id = NEW.account_id;
        END IF;
        snapshot_total := snapshot_total + 1;
      END LOOP;

      IF snapshot_total <> resource_total THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is not exact'
          USING ERRCODE = '23514';
      END IF;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RAISE;
    END;
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.authorize_session_attempt_personal_resource_reads(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
DECLARE
  personal_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'personal-resource read scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT count(*)::integer INTO personal_count
  FROM session_turn_attempts attempt
  JOIN sessions session_value
    ON session_value.id = attempt.session_id
   AND session_value.account_id = attempt.account_id
   AND session_value.workspace_id = attempt.workspace_id
  LEFT JOIN rigs rig
    ON rig.id = session_value.rig_id
   AND rig.account_id = session_value.account_id
   AND rig.authority_scope = 'user'
  LEFT JOIN rig_versions rig_version
    ON rig_version.id = session_value.rig_version_id
   AND rig_version.rig_id = session_value.rig_id
   AND rig_version.account_id = session_value.account_id
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND rig.id IS NOT NULL;
  IF personal_count = 0 THEN RETURN; END IF;
  PERFORM * FROM resolve_session_attempt_personal_resources(
    p_account_id, p_workspace_id, p_attempt_id
  );
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.finalize_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'opengeni_private', 'pg_temp'
AS $function$
DECLARE
  member organization_memberships%%ROWTYPE;
  deletion organization_user_retention_deletions%%ROWTYPE;
  prior_event organization_user_retention_deletion_events%%ROWTYPE;
  unsupported_kind text;
  candidate_file_ids uuid[];
  deleted_documents integer := 0;
  deleted_files integer := 0;
  deleted_variable_sets integer := 0;
  deleted_rigs integer := 0;
  deleted_connections integer := 0;
  deleted_codex integer := 0;
  deleted_xai integer := 0;
  deleted_claude integer := 0;
  deleted_subscriptions integer := 0;
  tombstoned_machines integer := 0;
  deleted_workspace integer := 0;
  object_count integer := 0;
  locked_personal_workspace_id uuid;
  result_value jsonb;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  PERFORM opengeni_private.assert_organization_retention_account(p_account_id);
  PERFORM acquire_organization_session_tenancy_fences(
    p_account_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-retention:' || p_operation_id::text, 0)
  );
  SELECT * INTO prior_event FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
    AND event.kind = 'completed';
  IF FOUND THEN
    IF prior_event.membership_id IS DISTINCT FROM p_membership_id THEN
      RAISE EXCEPTION 'retention completion operation id belongs to another membership'
        USING ERRCODE = '23505';
    END IF;
    SELECT candidate.database_result INTO result_value
    FROM organization_user_retention_deletions candidate
    WHERE candidate.account_id = p_account_id
      AND candidate.membership_id = p_membership_id;
    IF NOT FOUND
      OR result_value ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
    THEN
      RAISE EXCEPTION 'retention completion operation id has different frozen input'
        USING ERRCODE = '23505';
    END IF;
    RETURN result_value;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
  THEN RAISE EXCEPTION 'retention membership is not eligible' USING ERRCODE = '42501'; END IF;
  locked_personal_workspace_id := member.personal_workspace_id;
  IF locked_personal_workspace_id IS NOT NULL THEN
    PERFORM 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = locked_personal_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retention personal workspace is missing' USING ERRCODE = '40001';
    END IF;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
    OR member.personal_workspace_id IS DISTINCT FROM locked_personal_workspace_id
  THEN RAISE EXCEPTION 'retention membership changed during finalization'
    USING ERRCODE = '40001'; END IF;
  SELECT * INTO deletion FROM organization_user_retention_deletions candidate
  WHERE candidate.account_id = p_account_id AND candidate.membership_id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'claimed'
    OR deletion.claim_operation_id <> p_operation_id
    OR deletion.claim_expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001'; END IF;
  IF deletion.retention_until IS DISTINCT FROM member.personal_retention_until THEN
    RAISE EXCEPTION 'retention deadline changed after claim' USING ERRCODE = '40001';
  END IF;
  IF deletion.database_finalized_at IS NOT NULL THEN
    IF deletion.database_result ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
      OR EXISTS (
        SELECT 1 FROM organization_user_retention_object_obligations obligation
        WHERE obligation.account_id = p_account_id
          AND obligation.membership_id = p_membership_id
          AND obligation.object_bucket <> p_object_bucket
      )
    THEN
      RAISE EXCEPTION 'retention object bucket changed after database finalization'
        USING ERRCODE = '40001';
    END IF;
    RETURN pg_catalog.jsonb_set(
      deletion.database_result,
      '{operationId}',
      pg_catalog.to_jsonb(p_operation_id::text),
      false
    );
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM documents document
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = document.authority_id
     AND authority.account_id = document.account_id
     AND authority.organization_membership_id = document.owner_organization_membership_id
     AND authority.resource_kind = 'document'
     AND authority.resource_id = document.id
    WHERE document.account_id = p_account_id
      AND document.workspace_id = member.personal_workspace_id
      AND (
        authority.id IS NULL
        OR authority.organization_membership_id <> p_membership_id
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains retained external document authority'
      USING ERRCODE = '55000';
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM workspace_captures capture
    WHERE capture.account_id = p_account_id
      AND capture.workspace_id = member.personal_workspace_id
      AND (
        pg_catalog.jsonb_typeof(capture.blob_keys) <> 'array'
        OR CASE WHEN pg_catalog.jsonb_typeof(capture.blob_keys) = 'array' THEN EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(capture.blob_keys) blob(value)
            WHERE pg_catalog.jsonb_typeof(blob.value) <> 'string'
              OR octet_length(convert_to(blob.value #>> '{}', 'UTF8')) NOT BETWEEN 1 AND 4096
          ) ELSE false END
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains malformed external object inventory'
      USING ERRCODE = '55000';
  END IF;
  SELECT authority.resource_kind INTO unsupported_kind
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind NOT IN (
      'claude_subscription', 'codex_subscription', 'connected_machine', 'connection', 'document',
      'rig', 'subscription_connection', 'variable_set', 'xai_subscription'
    )
  ORDER BY authority.resource_kind LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsupported retained resource kind: %%', unsupported_kind
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
  ORDER BY authority.id FOR UPDATE;
  SELECT COALESCE(array_agg(candidate.file_id ORDER BY candidate.file_id), ARRAY[]::uuid[])
  INTO candidate_file_ids
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate;
  PERFORM 1 FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
  ORDER BY file.id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM opengeni_private.organization_retention_file_candidates(
      p_account_id, p_membership_id
    ) candidate
    WHERE candidate.object_bucket IS DISTINCT FROM p_object_bucket
  ) THEN
    RAISE EXCEPTION 'retention file bucket differs from configured object storage'
      USING ERRCODE = '55000';
  END IF;
  -- Freeze every external-key source before materializing obligations. The
  -- workspace row above excludes new FK children; these row locks exclude key
  -- rotation while exact obligations are copied and the workspace is erased.
  PERFORM 1 FROM session_recordings recording
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
  ORDER BY recording.id FOR UPDATE;
  PERFORM 1 FROM browser_state_artifacts artifact
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
  ORDER BY artifact.id FOR UPDATE;
  PERFORM 1 FROM browser_state_uploads upload
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
  ORDER BY upload.id FOR UPDATE;
  PERFORM 1 FROM transcription_recording_objects recording_object
  WHERE recording_object.account_id = p_account_id
    AND recording_object.workspace_id = member.personal_workspace_id
  ORDER BY recording_object.object_key FOR UPDATE;
  PERFORM 1 FROM video_generation_references reference
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
  ORDER BY reference.operation_id, reference.ordinal FOR UPDATE;
  PERFORM 1 FROM workspace_artifact_versions version
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  ORDER BY version.id FOR UPDATE;
  PERFORM 1 FROM editable_artifact_blob_refs blob
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  ORDER BY blob.artifact_id, blob.id FOR UPDATE;
  PERFORM 1 FROM workspace_captures capture
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
  ORDER BY capture.id FOR UPDATE;
  INSERT INTO organization_user_retention_object_obligations (
    account_id, membership_id, object_kind, source_id, object_bucket, object_key,
    prepared_operation_id, object_key_hash
  )
  SELECT p_account_id, p_membership_id, candidate.object_kind,
    candidate.source_id, p_object_bucket, candidate.object_key, p_operation_id,
    encode(digest(candidate.object_key, 'sha256'), 'hex')
  FROM opengeni_private.organization_retention_object_candidates(
    p_account_id, p_membership_id
  ) candidate;
  GET DIAGNOSTICS object_count = ROW_COUNT;

  DELETE FROM documents document
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'document'
    AND authority.resource_id = document.id
    AND document.account_id = authority.account_id
    AND document.authority_id = authority.id
    AND document.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_documents = ROW_COUNT;
  DELETE FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
    AND NOT EXISTS (SELECT 1 FROM documents document WHERE document.file_id = file.id);
  GET DIAGNOSTICS deleted_files = ROW_COUNT;

  deleted_variable_sets := 0;

  UPDATE capability_facet_installations binding SET connection_id = NULL,
    status = 'needs_attention',
    attention_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  UPDATE integration_facet_bindings binding SET connection_id = NULL,
    status = 'needs_attention',
    last_error_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  DELETE FROM connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_connections = ROW_COUNT;

  DELETE FROM subscription_connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'subscription_connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_subscriptions = ROW_COUNT;

  DELETE FROM rigs resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'rig'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_rigs = ROW_COUNT;

  UPDATE enrollments resource SET status = 'revoked',
    revoked_at = COALESCE(resource.revoked_at, clock_timestamp()),
    generation = resource.generation + 1, connection_instance_id = NULL,
    connection_lease_expires_at = NULL, desktop_unavailable_reason = NULL,
    updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS tombstoned_machines = ROW_COUNT;

  UPDATE organization_user_resource_authorities authority
  SET status = 'revoked', revoked_at = COALESCE(authority.revoked_at, clock_timestamp()),
    generation = authority.generation + 1, updated_at = clock_timestamp()
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.status <> 'revoked';
  UPDATE organization_memberships membership
  SET personal_workspace_id = NULL, updated_at = clock_timestamp()
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF member.personal_workspace_id IS NOT NULL THEN
    DELETE FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = member.personal_workspace_id;
    GET DIAGNOSTICS deleted_workspace = ROW_COUNT;
  END IF;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', p_membership_id,
    'operationId', p_operation_id,
    'outcome', 'cleanup_pending',
    'objectBucket', p_object_bucket,
    'objectCount', object_count,
    'deletedResources', pg_catalog.jsonb_build_object(
      'documents', deleted_documents, 'files', deleted_files,
      'variableSets', deleted_variable_sets, 'rigs', deleted_rigs,
      'connections', deleted_connections, 'codexSubscriptions', deleted_codex,
      'xaiSubscriptions', deleted_xai, 'claudeSubscriptions', deleted_claude,
      'subscriptionConnections', deleted_subscriptions, 'connectedMachinesTombstoned', tombstoned_machines,
      'personalWorkspaces', deleted_workspace
    ),
    'databaseFinalizedAt', clock_timestamp()
  );
  UPDATE organization_user_retention_deletions current_deletion
  SET database_result = result_value, database_finalized_at = clock_timestamp(),
    claim_expires_at = clock_timestamp() + interval '15 minutes',
    updated_at = clock_timestamp()
  WHERE current_deletion.account_id = p_account_id
    AND current_deletion.membership_id = p_membership_id
    AND current_deletion.claim_operation_id = p_operation_id;
  RETURN result_value;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.freeze_scheduled_task_personal_resources(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
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
  FROM rigs rig
  WHERE rig.id = task_row.rig_id AND rig.account_id = p_account_id
    AND rig.authority_scope = 'user';

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
      SELECT 'rig'::text AS resource_kind, rig.id AS resource_id,
        rig_version.id AS resource_version_id, 'rig.use'::text AS action,
        'session_rig'::text AS selection_source, rig.workspace_id AS resource_workspace_id,
        rig.authority_id, rig.owner_organization_membership_id, rig.origin_workspace_id
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

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.inventory_organization_tenancy(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO '$user', %1$L
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy inventory requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy inventory scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 2,
    'organizationId', p_organization_id,
    'workspaces', (
      SELECT count(*)::int FROM workspaces w WHERE w.account_id = p_organization_id
    ),
    'organizationMemberships', (
      SELECT pg_catalog.jsonb_build_object(
        'byStatus', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(m.status, m.n)
           FROM (
             SELECT om.status, count(*)::int AS n
             FROM organization_memberships om
             WHERE om.account_id = p_organization_id
             GROUP BY om.status
           ) m),
          '{}'::jsonb
        ),
        'activeWithoutPersonalWorkspace', (
          SELECT count(*)::int FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.status = 'active'
            AND om.personal_workspace_id IS NULL
        )
      )
    ),
    -- Humans with persisted workspace access in this organization but no
    -- organization-membership anchor: nothing exists yet for a backfill to
    -- attach canonical ownership to (they never re-authenticated post-0219).
    'workspaceMemberSubjectsWithoutMembershipAnchor', (
      SELECT count(DISTINCT wm.subject_id)::int
      FROM workspace_memberships wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.account_id = p_organization_id
        AND wm.subject_id LIKE 'user:%%'
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.subject_id = wm.subject_id
        )
    ),
    'sessions', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'ownerless', count(*) FILTER (
          WHERE s.owner_organization_membership_id IS NULL
        )::int,
        'userPrivate', count(*) FILTER (
          WHERE s.visibility = 'user_private'
        )::int,
        'advancedAuthorityEpoch', count(*) FILTER (
          WHERE s.authority_epoch > 1
        )::int
      )
      FROM sessions s WHERE s.account_id = p_organization_id
    ),
    -- Variable Sets, Rigs, and Connected Machines report ONLY the authority
    -- lane breakdown. An `unclassified` counter is deliberately absent: the
    -- shape checks REQUIRE a NULL authority_id for organization/workspace
    -- rows, `authority_scope` DEFAULTS to 'workspace', and no column records
    -- that a classification decision was ever made - see this migration's
    -- header for the per-family analysis.
    'variableSets', pg_catalog.jsonb_build_object('byScope', '{}'::jsonb),
    'rigs', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(r.authority_scope, r.n)
           FROM (
             SELECT rr.authority_scope, count(*)::int AS n
             FROM rigs rr WHERE rr.account_id = p_organization_id
             GROUP BY rr.authority_scope
           ) r),
          '{}'::jsonb
        )
      )
    ),
    'machines', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(e.authority_scope, e.n)
           FROM (
             SELECT en.authority_scope, count(*)::int AS n
             FROM enrollments en WHERE en.account_id = p_organization_id
             GROUP BY en.authority_scope
           ) e),
          '{}'::jsonb
        )
      )
    ),
    'connections', (
      SELECT coalesce(
        (SELECT pg_catalog.jsonb_object_agg(c.authority_scope, c.n)
         FROM (
           SELECT cn.authority_scope, count(*)::int AS n
           FROM connections cn WHERE cn.account_id = p_organization_id
           GROUP BY cn.authority_scope
         ) c),
        '{}'::jsonb
      )
    ),
    -- Linked-input gate (documents-internal migration is owned elsewhere and
    -- never written by this program; the count is the cutover gate input).
    'documents', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        -- The gate population is a LEGACY personal Document with no common
        -- authority - organization/workspace documents are REQUIRED to have
        -- a NULL authority_id forever (documents_authority_chk, 0258) and
        -- must never be counted as unmigrated.
        'legacyPersonalNullAuthority', count(*) FILTER (
          WHERE d.authority_kind = 'personal' AND d.authority_id IS NULL
        )::int
      )
      FROM documents d WHERE d.account_id = p_organization_id
    ),
    -- The legacy credential population is gone; retain the report's shape.
    'codexCredentials', pg_catalog.jsonb_build_object('total', 0, 'unattributedConnector', 0),
    'workspaceWriters', (
      SELECT pg_catalog.jsonb_build_object(
        'admissions', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE a.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_workspace_mutation_admissions a
          WHERE a.account_id = p_organization_id
        ),
        'retainedProcesses', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE p.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_retained_processes p
          WHERE p.account_id = p_organization_id
        )
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.record_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
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

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_resources_legacy_0305(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid)
 RETURNS TABLE(resource_kind text, resource_id uuid, resource_version_id uuid, selection_sources text[], action text, authority_id uuid, authority_generation bigint, grant_id uuid, grant_generation bigint, grant_mode text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO %1$L, 'pg_catalog'
AS $function$
    DECLARE
      admission_row session_attempt_personal_resource_admissions%%ROWTYPE;
      invalid_count integer;
      caller_subject text := coalesce(
        nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
      );
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN
        RAISE EXCEPTION 'personal-resource resolve scope mismatch'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;

      SELECT admission.* INTO STRICT admission_row
      FROM session_attempt_personal_resource_admissions admission
      WHERE admission.attempt_id = p_attempt_id
        AND admission.account_id = p_account_id
        AND admission.workspace_id = p_workspace_id;

      IF caller_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
        RAISE EXCEPTION 'personal-resource resolve initiating human mismatch'
          USING ERRCODE = '42501';
      END IF;

      PERFORM 1
      FROM sessions session_value
      JOIN session_turns turn_value
        ON turn_value.account_id = session_value.account_id
       AND turn_value.workspace_id = session_value.workspace_id
       AND turn_value.session_id = session_value.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn_value.account_id
       AND attempt.workspace_id = turn_value.workspace_id
       AND attempt.session_id = turn_value.session_id
       AND attempt.turn_id = turn_value.id
      WHERE session_value.id = admission_row.session_id
        AND session_value.account_id = admission_row.account_id
        AND session_value.workspace_id = admission_row.workspace_id
        AND session_value.active_turn_id = admission_row.turn_id
        AND turn_value.id = admission_row.turn_id
        AND turn_value.active_attempt_id = admission_row.attempt_id
        AND turn_value.execution_generation = admission_row.execution_generation
        AND turn_value.status = 'running'
        AND attempt.id = admission_row.attempt_id
        AND attempt.execution_generation = admission_row.execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND attempt.closed_at IS NULL
        AND attempt.quiesced_at IS NULL
      FOR SHARE OF session_value, turn_value
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'personal-resource resolve requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM session_attempt_interruptions interruption
        WHERE interruption.account_id = admission_row.account_id
          AND interruption.workspace_id = admission_row.workspace_id
          AND interruption.session_id = admission_row.session_id
          AND interruption.attempt_id = admission_row.attempt_id
          AND interruption.state IN ('pending', 'delivered', 'acknowledged')
      )
      THEN
        RAISE EXCEPTION 'personal-resource resolve requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
        AND NOT (
          EXISTS (
            SELECT 1
            FROM session_turn_attempts attempt
            JOIN sessions session_value
              ON session_value.id = attempt.session_id
             AND session_value.account_id = attempt.account_id
             AND session_value.workspace_id = attempt.workspace_id
            JOIN session_turns turn_value
              ON turn_value.id = attempt.turn_id
             AND turn_value.account_id = attempt.account_id
             AND turn_value.workspace_id = attempt.workspace_id
             AND turn_value.session_id = attempt.session_id
            WHERE attempt.id = snapshot.attempt_id
              AND attempt.account_id = snapshot.account_id
              AND attempt.workspace_id = snapshot.workspace_id
              AND attempt.session_id = snapshot.session_id
              AND attempt.turn_id = snapshot.turn_id
              AND attempt.execution_generation = snapshot.execution_generation
              AND attempt.state IN ('claimed', 'running')
              AND attempt.quiesced_at IS NULL
              AND (attempt.authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)
              AND (snapshot.session_authority_epoch BETWEEN session_value.execution_authority_epoch AND session_value.authority_epoch)
              AND coalesce(
                nullif(btrim(turn_value.initiating_human_subject_id), ''),
                CASE WHEN turn_value.initiator_kind = 'subject'
                  THEN nullif(btrim(turn_value.initiator_subject_id), '') END
              ) = admission_row.initiating_human_subject_id
          )
          AND EXISTS (
            SELECT 1
            FROM organization_memberships membership
            WHERE membership.id = snapshot.owner_organization_membership_id
              AND membership.account_id = snapshot.account_id
              AND membership.subject_id = admission_row.initiating_human_subject_id
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
              AND membership.authorization_revision
                = snapshot.membership_authorization_revision
              AND (
                membership.personal_workspace_id = snapshot.workspace_id
                OR EXISTS (
                  SELECT 1
                  FROM workspace_memberships workspace_membership
                  WHERE workspace_membership.account_id = membership.account_id
                    AND workspace_membership.workspace_id = snapshot.workspace_id
                    AND workspace_membership.subject_id = membership.subject_id
                )
              )
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_authorities authority
            WHERE authority.id = snapshot.authority_id
              AND authority.account_id = snapshot.account_id
              AND authority.organization_membership_id
                = snapshot.owner_organization_membership_id
              AND authority.resource_kind = snapshot.resource_kind
              AND authority.resource_id = snapshot.resource_id
              AND authority.generation = snapshot.authority_generation
              AND authority.status = 'active'
              AND authority.revoked_at IS NULL
          )
          AND (
            (
              snapshot.resource_kind = 'rig'
              AND EXISTS (
                SELECT 1 FROM rigs rig
                JOIN rig_versions rig_version
                  ON rig_version.id = snapshot.resource_version_id
                 AND rig_version.rig_id = rig.id
                 AND rig_version.account_id = rig.account_id
                WHERE rig.id = snapshot.resource_id
                  AND rig.account_id = snapshot.account_id
                  AND rig.authority_scope = 'user'
                  AND rig.authority_id = snapshot.authority_id
                  AND rig.owner_organization_membership_id
                    = snapshot.owner_organization_membership_id
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_grants grant_value
            WHERE grant_value.id = snapshot.grant_id
              AND grant_value.account_id = snapshot.account_id
              AND grant_value.authority_id = snapshot.authority_id
              AND grant_value.owner_organization_membership_id
                = snapshot.owner_organization_membership_id
              AND grant_value.workspace_id = snapshot.target_workspace_id
              AND grant_value.action = snapshot.action
              AND grant_value.mode = snapshot.grant_mode
              AND grant_value.context = snapshot.grant_context
              AND grant_value.generation = snapshot.grant_generation
              AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
              AND grant_value.authority_epoch
                IS NOT DISTINCT FROM snapshot.grant_authority_epoch
              AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
              AND (
                (
                  snapshot.grant_mode = 'once'
                  AND grant_value.status = 'consumed'
                  AND EXISTS (
                    SELECT 1 FROM personal_resource_once_consumption_receipts receipt
                    WHERE receipt.grant_id = snapshot.grant_id
                      AND receipt.account_id = snapshot.account_id
                      AND receipt.attempt_id = snapshot.attempt_id
                      AND receipt.authority_id = snapshot.authority_id
                      AND receipt.authority_generation = snapshot.authority_generation
                      AND receipt.grant_generation = snapshot.grant_generation
                  )
                ) OR (
                  snapshot.grant_mode IN ('session', 'always')
                  AND grant_value.status = 'active'
                )
              )
          )
        );

      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'personal-resource authority snapshot is no longer live'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id;
      IF invalid_count <> admission_row.resource_count THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is incomplete'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT snapshot.resource_kind, snapshot.resource_id,
        snapshot.resource_version_id, snapshot.selection_sources, snapshot.action,
        snapshot.authority_id, snapshot.authority_generation, snapshot.grant_id,
        snapshot.grant_generation, snapshot.grant_mode
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
      ORDER BY snapshot.resource_kind, snapshot.resource_id;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END;
    $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.verify_organization_resource_classification(p_organization_id uuid, p_run_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO %1$L, 'pg_catalog', 'pg_temp'
 SET statement_timeout TO '5min'
AS $function$
DECLARE
  -- family label (0286 vocabulary), resource table, authority resource_kind
  families constant text[][] := ARRAY[
    ARRAY['variable_sets', NULL, 'variable_set'],
    ARRAY['rigs', 'rigs', 'rig'],
    ARRAY['machines', 'enrollments', 'connected_machine']
  ];
  family text[];
  claimed_rows integer := 0;
  claimed boolean := false;
  ledger_available boolean;
  classification_sql text;
  family_result jsonb;
  families_result jsonb := '{}'::jsonb;
  receipt_id uuid;
  unresolved_row record;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'resource classification requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'resource classification scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_key IS NOT NULL AND length(btrim(p_run_key)) = 0 THEN
    RAISE EXCEPTION 'resource classification run key must not be blank'
      USING ERRCODE = '22023';
  END IF;

  -- The ledger lives in its own migration. Probe rather than assume, so this
  -- seam neither hard-fails nor silently drops the obligation when the two
  -- land in either order.
  ledger_available := p_run_key IS NOT NULL
    AND to_regprocedure('open_tenancy_backfill_receipt(uuid, text, text)') IS NOT NULL
    AND to_regprocedure('record_tenancy_backfill_unresolved(uuid, uuid, text)') IS NOT NULL
    AND to_regprocedure(
      'complete_tenancy_backfill_receipt(uuid, bigint, bigint, text)'
    ) IS NOT NULL;

  INSERT INTO opengeni_private.resource_classification_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;
  -- Only release what this call claimed, so a nested or enclosing holder of
  -- the same transaction-scoped capability is never revoked underneath.
  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  claimed := claimed_rows > 0;

  FOREACH family SLICE 1 IN ARRAY families LOOP
    -- One verdict per row. The first two branches are the phase D terminal
    -- states; every other branch is an explicit refusal to classify, carrying
    -- a fixed 0286 reason code and never a proposed owner.
    IF family[1] = 'variable_sets' THEN
      classification_sql := 'SELECT NULL::uuid AS resource_id, NULL::text AS verdict WHERE false';
    ELSE
    classification_sql := format($classification$
      SELECT resource.id AS resource_id,
        CASE
          WHEN resource.authority_scope = 'workspace'
            AND resource.authority_id IS NULL
            AND resource.owner_organization_membership_id IS NULL
            THEN 'workspace_owned'
          -- Organization scope is a deliberate lifecycle choice (0254/0262),
          -- never a legacy default, so it is reported separately rather than
          -- folded into the workspace population it is not part of.
          WHEN resource.authority_scope = 'organization'
            AND resource.authority_id IS NULL
            AND resource.owner_organization_membership_id IS NULL
            THEN 'organization_owned'
          WHEN resource.authority_scope <> 'user'
            OR resource.authority_id IS NULL
            OR resource.owner_organization_membership_id IS NULL
            THEN 'legacy_shape_unrecognized'
          WHEN authority.id IS NULL
            OR authority.resource_kind <> %%2$L
            OR authority.resource_id <> resource.id
            OR authority.organization_membership_id
               <> resource.owner_organization_membership_id
            THEN 'conflicting_authority_rows'
          WHEN membership.id IS NULL
            OR membership.status <> 'active'
            OR membership.revoked_at IS NOT NULL
            THEN 'missing_organization_membership'
          WHEN authority.status <> 'active' OR authority.revoked_at IS NOT NULL
            THEN 'ambiguous_candidate_authority'
          WHEN resource.origin_workspace_id IS NULL
            THEN 'no_deterministic_evidence'
          ELSE 'user_owned'
        END AS verdict
      FROM %%1$I resource
      LEFT JOIN organization_user_resource_authorities authority
        ON authority.id = resource.authority_id
       AND authority.account_id = resource.account_id
      LEFT JOIN organization_memberships membership
        ON membership.id = resource.owner_organization_membership_id
       AND membership.account_id = resource.account_id
      WHERE resource.account_id = $1
    $classification$, family[2], family[3]);
    END IF;

    EXECUTE format($summary$
      WITH classified AS (%%1$s)
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'workspaceOwned', count(*) FILTER (WHERE verdict = 'workspace_owned')::int,
        'organizationOwned', count(*) FILTER (
          WHERE verdict = 'organization_owned'
        )::int,
        'userOwned', count(*) FILTER (WHERE verdict = 'user_owned')::int,
        'unresolved', count(*) FILTER (
          WHERE verdict NOT IN ('workspace_owned', 'organization_owned', 'user_owned')
        )::int,
        'unresolvedRows', coalesce((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'resourceId', bounded.resource_id, 'reasonCode', bounded.verdict
            ) ORDER BY bounded.resource_id
          )
          FROM (
            SELECT resource_id, verdict FROM classified
            WHERE verdict NOT IN (
              'workspace_owned', 'organization_owned', 'user_owned'
            )
            ORDER BY resource_id LIMIT 1000
          ) bounded
        ), '[]'::jsonb),
        'unresolvedTruncated', count(*) FILTER (
          WHERE verdict NOT IN ('workspace_owned', 'organization_owned', 'user_owned')
        ) > 1000
      )
      FROM classified
    $summary$, classification_sql)
    USING p_organization_id
    INTO family_result;

    IF ledger_available THEN
      EXECUTE 'SELECT open_tenancy_backfill_receipt($1, $2, $3)'
        USING p_organization_id, family[1], p_run_key
        INTO receipt_id;
      FOR unresolved_row IN EXECUTE format(
        'SELECT resource_id, verdict FROM (%%1$s) classified '
          || 'WHERE verdict NOT IN '
          || '(''workspace_owned'', ''organization_owned'', ''user_owned'') '
          || 'ORDER BY resource_id',
        classification_sql
      ) USING p_organization_id LOOP
        EXECUTE 'SELECT record_tenancy_backfill_unresolved($1, $2, $3)'
          USING receipt_id, unresolved_row.resource_id, unresolved_row.verdict;
      END LOOP;
      -- `classified_count` is the population this run PROVED already carries a
      -- terminal non-user classification; `skipped_count` is the reviewed
      -- user-owned population the backfill must not touch. Neither reflects a
      -- rewrite: this run changes no resource row.
      EXECUTE 'SELECT complete_tenancy_backfill_receipt($1, $2, $3, $4)'
        USING receipt_id,
          (family_result ->> 'workspaceOwned')::bigint
            + (family_result ->> 'organizationOwned')::bigint,
          (family_result ->> 'userOwned')::bigint,
          'completed';
      family_result := family_result
        || pg_catalog.jsonb_build_object('receiptId', receipt_id);
    END IF;

    families_result := families_result
      || pg_catalog.jsonb_build_object(family[1], family_result);
  END LOOP;

  IF claimed THEN
    DELETE FROM opengeni_private.resource_classification_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'runKey', p_run_key,
    'ledgerAvailable', ledger_available,
    'rewroteResourceRows', false,
    'families', families_result
  );
EXCEPTION WHEN OTHERS THEN
  IF claimed THEN
    DELETE FROM opengeni_private.resource_classification_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;
  RAISE;
END
$function$

$create$, data_schema);
END
$install$;

-- These permissive policies exist exclusively for the retired Variable Set
-- SECURITY DEFINER seams; normal tenancy and other capabilities are unchanged.
DROP POLICY "variable_set_authority_capability_read" ON "organization_memberships";
DROP POLICY "variable_set_authority_capability_delete" ON "organization_user_resource_authorities";
DROP POLICY "variable_set_authority_capability_insert" ON "organization_user_resource_authorities";
DROP POLICY "variable_set_authority_capability_read" ON "organization_user_resource_authorities";
DROP POLICY "variable_set_authority_capability_update" ON "organization_user_resource_authorities";
DROP POLICY "variable_set_authority_capability_delete" ON "organization_user_resource_grants";
DROP POLICY "variable_set_authority_capability_insert" ON "organization_user_resource_grants";
DROP POLICY "variable_set_authority_capability_read" ON "organization_user_resource_grants";
DROP POLICY "variable_set_authority_capability_update" ON "organization_user_resource_grants";
DROP POLICY "variable_set_authority_capability_read" ON "rig_versions";
DROP POLICY "variable_set_authority_capability_read" ON "scheduled_tasks";
DROP POLICY "variable_set_authority_capability_read" ON "session_attempt_interruptions";
DROP POLICY "variable_set_authority_capability_read" ON "session_turn_attempts";
DROP POLICY "variable_set_authority_capability_read" ON "session_turns";
DROP POLICY "variable_set_authority_capability_read" ON "sessions";
DROP POLICY "variable_set_authority_capability_read" ON "workspace_memberships";

DROP TRIGGER sessions_variable_set_attachments_sync ON sessions;
DROP TRIGGER sessions_variable_set_attachment_status_sync ON sessions;
ALTER TABLE sessions DROP CONSTRAINT sessions_environment_id_fkey;
ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_environment_id_fkey;

-- Attachment guards reject deletion, not a closed group DDL contraction.
DROP TABLE session_variable_set_attachments, workspace_variable_set_variables,
  workspace_variable_sets RESTRICT;

DO $drop$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('DROP FUNCTION opengeni_private.detach_retention_variable_set_session_selections(uuid,uuid,uuid) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION opengeni_private.variable_set_authority_capability_active(text) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.count_scoped_variable_sets(uuid,uuid,text) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.create_scoped_variable_set(uuid,uuid,text,text,text,jsonb,boolean) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.list_scoped_variable_sets(uuid,uuid,uuid,text,text) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.materialize_scoped_variable_set_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.materialize_scoped_variable_set_for_session(uuid,uuid,uuid,uuid) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.mutate_scoped_variable_set(uuid,uuid,uuid,text,text,boolean,text,boolean,text,text,boolean) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.read_scoped_variable_set_secret(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,integer) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.scheduled_variable_set_expected_generation_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.scoped_variable_set_json(uuid) RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.guard_variable_set_session_attachments() RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.sync_session_variable_set_attachments() RESTRICT', data_schema);
  EXECUTE format('DROP FUNCTION %1$I.sync_session_variable_set_attachment_status() RESTRICT', data_schema);
END
$drop$;
DROP TABLE opengeni_private.variable_set_authority_capabilities RESTRICT;
