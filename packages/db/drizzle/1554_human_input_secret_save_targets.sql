-- deployment-mode: rolling
-- A secret answer must go somewhere the asking turn can resolve it. The
-- existing live-attempt check still gates resolution. The pending card needs
-- the same vault reach, but the attempt that posted it has already closed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE FUNCTION opengeni_private.vault_turn_context(
  p_account uuid, p_workspace uuid, p_session uuid, p_turn uuid
) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path FROM CURRENT
    AS $$
DECLARE
  session_row record;
  acting_subject text;
  membership_id uuid;
  human_expected boolean;
  human_valid boolean := false;
  has_use boolean;
  agent_allowed boolean;
  schedule_policy jsonb;
  schedule_owner text;
  policy_ids jsonb;
  narrowed_by uuid;
BEGIN
  SELECT session_value.id, session_value.root_session_id, session_value.first_party_mcp_permissions,
      coalesce(
        nullif(pg_catalog.btrim(turn_value.initiating_human_subject_id), ''),
        CASE WHEN turn_value.initiator_kind = 'subject'
          THEN nullif(pg_catalog.btrim(turn_value.initiator_subject_id), '') END
      ) AS human_subject,
      turn_value.scheduled_task_run_id
    INTO session_row
  FROM sessions session_value
  JOIN session_turns turn_value
    ON turn_value.id = p_turn
   AND turn_value.account_id = session_value.account_id
   AND turn_value.workspace_id = session_value.workspace_id
   AND turn_value.session_id = session_value.id
  WHERE session_value.id = p_session
    AND session_value.account_id = p_account
    AND session_value.workspace_id = p_workspace;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'turn not found');
  END IF;

  IF session_row.scheduled_task_run_id IS NOT NULL THEN
    SELECT task.owner_subject_id, task.vault_policy INTO schedule_owner, schedule_policy
    FROM scheduled_task_runs run
    JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
    WHERE run.id = session_row.scheduled_task_run_id AND run.workspace_id = p_workspace;
  END IF;
  acting_subject := coalesce(session_row.human_subject, nullif(pg_catalog.btrim(schedule_owner), ''));
  human_expected := acting_subject IS NOT NULL;
  IF human_expected THEN
    membership_id := vault_actor_membership(p_account, acting_subject);
    human_valid := membership_id IS NOT NULL
      AND opengeni_private.vault_subject_in_workspace(p_account, p_workspace, acting_subject);
    IF NOT human_valid THEN
      membership_id := NULL;
    END IF;
    has_use := human_valid
      AND opengeni_private.vault_subject_has_secrets_use(p_account, p_workspace, acting_subject);
  ELSE
    has_use := true;
  END IF;
  agent_allowed := session_row.first_party_mcp_permissions IS NULL
    OR pg_catalog.jsonb_typeof(session_row.first_party_mcp_permissions) <> 'array'
    OR session_row.first_party_mcp_permissions ?| ARRAY[
      'secrets:use', 'variable-sets:use', 'variable-sets:attach', 'environments:use'
    ];
  SELECT chain.vault_ids, chain.narrowed_by INTO policy_ids, narrowed_by
  FROM opengeni_private.vault_session_policy_chain(p_account, p_workspace, p_session, true) chain;
  policy_ids := opengeni_private.vault_policy_intersect(
    policy_ids, opengeni_private.vault_policy_ids(schedule_policy)
  );
  RETURN pg_catalog.jsonb_build_object(
    'kind', 'attempt',
    'accountId', p_account,
    'workspaceId', p_workspace,
    'subjectId', acting_subject,
    'sessionId', p_session,
    'membershipId', membership_id,
    'humanExpected', human_expected,
    'humanValid', human_valid,
    'hasSecretsUse', has_use,
    'agentAllowed', agent_allowed,
    'includeUser', agent_allowed AND human_valid AND has_use,
    'includeShared', agent_allowed AND has_use AND (NOT human_expected OR human_valid),
    -- The delegated grant controls saved logins, not the current task's input.
    'taskMode', 'root',
    'taskRoot', coalesce(session_row.root_session_id, p_session),
    'personalWorkspace', opengeni_private.vault_workspace_is_personal(p_account, p_workspace),
    'policyVaultIds', policy_ids,
    'narrowedBySessionId', narrowed_by
  );
END
$$;

CREATE OR REPLACE FUNCTION opengeni_private.vault_principal_context(p_principal jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path FROM CURRENT
    AS $$
DECLARE
  guc_account uuid := nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid;
  guc_workspace uuid := nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid;
  guc_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  principal_kind text := coalesce(p_principal ->> 'kind', 'subject');
  acting_subject text;
  membership_id uuid;
  human_valid boolean := false;
  has_use boolean := false;
  include_user boolean := false;
  include_shared boolean := false;
  task_mode text := 'none';
BEGIN
  IF guc_account IS NULL OR guc_workspace IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'vault access needs a tenant context');
  END IF;
  IF p_principal IS NOT NULL AND (
    (p_principal ->> 'accountId')::uuid IS DISTINCT FROM guc_account
    OR (p_principal ->> 'workspaceId')::uuid IS DISTINCT FROM guc_workspace
  ) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'principal is outside the tenant context');
  END IF;

  IF principal_kind IN ('subject', 'human', 'site_viewer') THEN
    acting_subject := CASE WHEN principal_kind = 'subject' THEN guc_subject
      ELSE nullif(p_principal ->> 'subjectId', '') END;
    IF principal_kind <> 'subject' AND guc_subject IS NOT NULL AND acting_subject IS DISTINCT FROM guc_subject THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'principal subject mismatch');
    END IF;
    membership_id := CASE WHEN acting_subject IS NULL THEN NULL
      ELSE vault_actor_membership(guc_account, acting_subject) END;
    human_valid := membership_id IS NOT NULL;
    IF principal_kind = 'site_viewer' THEN
      has_use := human_valid
        AND opengeni_private.vault_subject_has_secrets_use(guc_account, guc_workspace, acting_subject);
      include_user := has_use;
      include_shared := has_use;
    ELSE
      -- Human and API callers: permission checks happen at the route.
      has_use := true;
      include_user := human_valid;
      include_shared := true;
      task_mode := 'visible';
    END IF;
  ELSIF principal_kind = 'attempt' THEN
    PERFORM 1
    FROM sessions session_value
    JOIN session_turns turn_value
      ON turn_value.id = (p_principal ->> 'turnId')::uuid
     AND turn_value.account_id = session_value.account_id
     AND turn_value.workspace_id = session_value.workspace_id
     AND turn_value.session_id = session_value.id
    JOIN session_turn_attempts attempt
      ON attempt.id = (p_principal ->> 'attemptId')::uuid
     AND attempt.account_id = turn_value.account_id
     AND attempt.workspace_id = turn_value.workspace_id
     AND attempt.session_id = turn_value.session_id
     AND attempt.turn_id = turn_value.id
    WHERE session_value.id = (p_principal ->> 'sessionId')::uuid
      AND session_value.account_id = guc_account
      AND session_value.workspace_id = guc_workspace
      AND session_value.active_turn_id = turn_value.id
      AND turn_value.active_attempt_id = attempt.id
      AND turn_value.execution_generation = (p_principal ->> 'executionGeneration')::integer
      AND attempt.execution_generation = (p_principal ->> 'executionGeneration')::integer
      AND attempt.state IN ('claimed', 'running')
      AND attempt.closed_at IS NULL
      AND attempt.quiesced_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM session_attempt_interruptions interruption
        WHERE interruption.account_id = guc_account
          AND interruption.workspace_id = guc_workspace
          AND interruption.session_id = session_value.id
          AND interruption.attempt_id = attempt.id
          AND interruption.state IN ('pending', 'delivered', 'acknowledged')
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'vault_permission_denied: secret resolution requires the exact current attempt',
        HINT = 'opengeni.vault_error';
    END IF;
    RETURN opengeni_private.vault_turn_context(guc_account, guc_workspace,
      (p_principal ->> 'sessionId')::uuid, (p_principal ->> 'turnId')::uuid);
  ELSIF principal_kind = 'service_connection' THEN
    IF guc_subject IS NOT NULL THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'a service connection acts for no person');
    END IF;
    IF nullif(p_principal ->> 'connectionId', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM connections connection
      WHERE connection.id = (p_principal ->> 'connectionId')::uuid
        AND connection.account_id = guc_account
        AND connection.workspace_id = guc_workspace
        AND connection.subject_id IS NULL
        AND connection.kind = 'api_key'
        AND connection.status = 'active'
        AND connection.metadata ->> 'credentialSource' = 'vault'
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'not an active shared service connection of this workspace');
    END IF;
    has_use := true;
    include_shared := true;
  ELSE
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'unknown principal kind');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'kind', principal_kind,
    'accountId', guc_account,
    'workspaceId', guc_workspace,
    'subjectId', acting_subject,
    'sessionId', NULL,
    'membershipId', membership_id,
    'humanExpected', false,
    'humanValid', human_valid,
    'hasSecretsUse', has_use,
    'agentAllowed', true,
    'includeUser', include_user,
    'includeShared', include_shared,
    'taskMode', task_mode,
    'taskRoot', NULL,
    'personalWorkspace', opengeni_private.vault_workspace_is_personal(guc_account, guc_workspace),
    'policyVaultIds', NULL,
    'narrowedBySessionId', NULL
  );
END
$$;

-- Used by the card for the default vault of each scope and again by the answer
-- transaction for the actual vault (including a caller-specified vault id).
-- An uncreated default can only be used when the asking turn is not narrowed.
CREATE FUNCTION opengeni_private.human_input_secret_target_reachable(
  p_asking jsonb, p_answering jsonb, p_target text, p_vault_id uuid
) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path FROM CURRENT
    AS $$
  SELECT CASE p_target
    WHEN 'task' THEN p_vault_id IS NULL OR EXISTS (
      SELECT 1 FROM opengeni_private.vault_reach(p_asking) reach
      JOIN vaults vault ON vault.id = reach.vault_id AND vault.owner_kind = 'task'
      WHERE reach.vault_id = p_vault_id
    )
    WHEN 'user' THEN (p_asking ->> 'includeUser')::boolean
      AND (p_answering ->> 'membershipId') IS NOT DISTINCT FROM (p_asking ->> 'membershipId')
    WHEN 'workspace' THEN (p_asking ->> 'includeShared')::boolean
    ELSE false
  END AND (p_target = 'task' OR CASE
    WHEN p_vault_id IS NULL THEN pg_catalog.jsonb_typeof(p_asking -> 'policyVaultIds') IS DISTINCT FROM 'array'
    ELSE EXISTS (
      SELECT 1 FROM opengeni_private.vault_reach(p_asking) reach
      JOIN vaults vault ON vault.id = reach.vault_id AND vault.owner_kind = p_target
      WHERE reach.vault_id = p_vault_id AND vault.source = 'opengeni' AND vault.mode = 'read_write'
    )
  END)
$$;

CREATE FUNCTION opengeni_private.human_input_secret_save_targets(
  p_answering jsonb, p_session uuid, p_turn uuid
) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path FROM CURRENT
    AS $$
  WITH reach AS MATERIALIZED (
    SELECT opengeni_private.vault_turn_context((p_answering ->> 'accountId')::uuid,
      (p_answering ->> 'workspaceId')::uuid, p_session, p_turn) AS asking
  )
  SELECT coalesce(pg_catalog.jsonb_agg(candidate.target ORDER BY candidate.ordinal), '[]'::jsonb)
  FROM reach CROSS JOIN (VALUES ('user', 1), ('task', 2), ('workspace', 3)) candidate(target, ordinal)
  LEFT JOIN LATERAL (
    SELECT vault.id
    FROM vaults vault
    WHERE vault.account_id = (p_answering ->> 'accountId')::uuid
      AND vault.owner_kind = candidate.target
      AND ((candidate.target = 'user'
          AND vault.owner_organization_membership_id = (p_answering ->> 'membershipId')::uuid)
        OR (candidate.target = 'workspace' AND vault.workspace_id = (p_answering ->> 'workspaceId')::uuid))
      AND (vault.is_default OR vault.name_key = vault_name_key(
        CASE candidate.target WHEN 'user' THEN 'Private' ELSE 'Shared' END))
    ORDER BY vault.is_default DESC, vault.created_at
    LIMIT 1
  ) destination ON true
  WHERE opengeni_private.human_input_secret_target_reachable(reach.asking, p_answering, candidate.target, destination.id)
$$;

-- Keep the same runtime grant during rolling deployments. The old binary
-- calls the unchanged view; only the new binary asks for the turn projection.
CREATE OR REPLACE FUNCTION session_secrets_view(p_session uuid, p_principal jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  context jsonb;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  IF p_principal ->> 'humanInputTurnId' IS NOT NULL THEN
    result := pg_catalog.jsonb_build_object('secretSaveTargets',
      opengeni_private.human_input_secret_save_targets(context, p_session,
        (p_principal ->> 'humanInputTurnId')::uuid));
  ELSE
    result := opengeni_private.vault_session_view_json(context, p_session);
  END IF;
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION apply_secret_answers(p_session uuid, p_turn uuid, p_answers jsonb, p_principal jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  context jsonb;
  asking jsonb;
  answer jsonb;
  target text;
  vault_row vaults;
  existing vault_items;
  item_row vault_items;
  results jsonb := '[]'::jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  asking := opengeni_private.vault_turn_context((context ->> 'accountId')::uuid,
    (context ->> 'workspaceId')::uuid, p_session, p_turn);
  FOR answer IN SELECT element FROM pg_catalog.jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) element LOOP
    target := coalesce(answer ->> 'saveTo', 'user');
    IF target = 'user' AND (asking ->> 'subjectId') IS DISTINCT FROM (context ->> 'subjectId') THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'only the person this task works for can save an Only-me answer; save it to the task or the workspace instead');
    END IF;
    IF answer ->> 'vaultId' IS NOT NULL THEN
      vault_row := opengeni_private.vault_reachable_row(context, (answer ->> 'vaultId')::uuid);
    ELSIF target = 'task' THEN
      vault_row := opengeni_private.vault_ensure_task(context, p_session);
    ELSE
      vault_row := opengeni_private.vault_ensure_default(context, target);
      vault_row := opengeni_private.vault_reachable_row(context, vault_row.id);
    END IF;
    IF NOT opengeni_private.human_input_secret_target_reachable(asking, context, target, vault_row.id) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'this task cannot use the chosen vault');
    END IF;
    PERFORM opengeni_private.vault_assert_writable(context, vault_row);
    existing := NULL;
    SELECT item.* INTO existing FROM vault_items item
    WHERE item.vault_id = vault_row.id AND item.archived_at IS NULL
      AND item.name_key = vault_name_key(answer #>> '{item,name}');
    item_row := opengeni_private.vault_write_item(context, vault_row, existing,
      (answer -> 'item') - 'expectedGeneration'
        || pg_catalog.jsonb_build_object('createdByKind', 'human'));
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'questionId', answer ->> 'questionId',
      'created', existing.id IS NULL,
      'item', opengeni_private.vault_item_json(item_row, false)));
  END LOOP;
  PERFORM opengeni_private.vault_capability_close();
  RETURN results;
END
$$;

REVOKE ALL ON FUNCTION opengeni_private.vault_turn_context(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.human_input_secret_target_reachable(jsonb, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.human_input_secret_save_targets(jsonb, uuid, uuid) FROM PUBLIC;

DO $search_paths$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'opengeni_private.vault_turn_context(uuid, uuid, uuid, uuid)',
    'opengeni_private.vault_principal_context(jsonb)',
    'opengeni_private.human_input_secret_target_reachable(jsonb, jsonb, text, uuid)',
    'opengeni_private.human_input_secret_save_targets(jsonb, uuid, uuid)',
    'session_secrets_view(uuid, jsonb)',
    'apply_secret_answers(uuid, uuid, jsonb, jsonb)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      signature, current_schema());
  END LOOP;
END $search_paths$;
