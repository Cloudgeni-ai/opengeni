-- deployment-mode: rolling
-- A secret answer must go somewhere the asking turn can resolve it. The
-- existing live-attempt check still gates resolution. The pending card needs
-- the same vault reach, but the attempt that posted it has already closed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

-- Only the asking session can use these answers without saved-login access.
-- Bind to the written generation, not later edits or moves of the item.
ALTER TABLE vault_items
  ADD COLUMN secure_answer_session_id uuid,
  ADD COLUMN secure_answer_generation bigint;

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
    -- Keep full task-vault reach gated. The resolver can use only this
    -- session's secure answers in the restricted mode.
    'taskMode', CASE WHEN agent_allowed THEN 'root' ELSE 'answer' END,
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
      SELECT 1 FROM vaults vault
      WHERE vault.id = p_vault_id AND vault.owner_kind = 'task'
        AND vault.account_id = (p_asking ->> 'accountId')::uuid
        AND vault.workspace_id = (p_asking ->> 'workspaceId')::uuid
        AND vault.root_session_id = (p_asking ->> 'taskRoot')::uuid
    )
    WHEN 'user' THEN (p_asking ->> 'includeUser')::boolean
      AND (p_answering ->> 'membershipId') IS NOT DISTINCT FROM (p_asking ->> 'membershipId')
    WHEN 'workspace' THEN (p_asking ->> 'includeShared')::boolean
    ELSE false
  END AND (p_target = 'task' OR CASE
    WHEN p_vault_id IS NULL THEN pg_catalog.jsonb_typeof(p_asking -> 'policyVaultIds') IS DISTINCT FROM 'array'
    ELSE EXISTS (
      SELECT 1 FROM opengeni_private.vault_reach(p_asking) reach
      JOIN vaults vault ON vault.id = reach.vault_id
      WHERE reach.vault_id = p_vault_id AND vault.source = 'opengeni' AND vault.mode = 'read_write'
        AND (vault.owner_kind = p_target OR (p_target = 'workspace' AND vault.owner_kind = 'organization'))
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
  item_input jsonb;
  target text;
  restricted boolean;
  vault_row vaults;
  existing vault_items;
  item_row vault_items;
  results jsonb := '[]'::jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  asking := opengeni_private.vault_turn_context((context ->> 'accountId')::uuid,
    (context ->> 'workspaceId')::uuid, p_session, p_turn);
  restricted := asking ->> 'taskMode' = 'answer';
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
    item_input := (answer -> 'item') - 'expectedGeneration'
      || pg_catalog.jsonb_build_object('createdByKind', 'human');
    existing := NULL;
    SELECT item.* INTO existing FROM vault_items item
    WHERE item.vault_id = vault_row.id AND item.archived_at IS NULL
      AND item.name_key = vault_name_key(item_input ->> 'name');
    IF restricted AND existing.id IS NOT NULL THEN
      -- Never turn a pre-existing Task item (including its other fields or
      -- older versions) into an answer for a restricted session.
      item_input := item_input || pg_catalog.jsonb_build_object('name',
        pg_catalog.left(item_input ->> 'name', 83) || ' ' || pg_catalog.gen_random_uuid()::text);
      existing := NULL;
    END IF;
    item_row := opengeni_private.vault_write_item(context, vault_row, existing, item_input);
    IF restricted THEN
      UPDATE vault_items SET secure_answer_session_id = p_session,
        secure_answer_generation = item_row.generation WHERE id = item_row.id;
    END IF;
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'questionId', answer ->> 'questionId',
      'created', existing.id IS NULL,
      'item', opengeni_private.vault_item_json(item_row, false)));
  END LOOP;
  PERFORM opengeni_private.vault_capability_close();
  RETURN results;
END
$$;

CREATE FUNCTION opengeni_private.vault_secure_answer_matches(p_context jsonb, p_item vault_items) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path FROM CURRENT
    AS $$
  SELECT p_context ->> 'taskMode' = 'answer'
    AND p_item.account_id = (p_context ->> 'accountId')::uuid
    AND p_item.secure_answer_session_id = (p_context ->> 'sessionId')::uuid
    AND p_item.secure_answer_generation = p_item.generation
    AND EXISTS (
      SELECT 1 FROM vaults vault
      WHERE vault.id = p_item.vault_id AND vault.owner_kind = 'task'
        AND vault.workspace_id = (p_context ->> 'workspaceId')::uuid
        AND vault.root_session_id = (p_context ->> 'taskRoot')::uuid
    )
$$;

-- Same resolver and reference forms; only the matching answer generations
-- enter the candidate set for an attempt without saved-login access.
CREATE OR REPLACE FUNCTION resolve_secret_reference_candidates(p_principal jsonb, p_refs jsonb) RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  context jsonb;
  reach_ids uuid[];
  answers_only boolean;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  IF pg_catalog.jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_refs) > 500 THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'p_refs must be an array of at most 500 references');
  END IF;
  answers_only := context ->> 'taskMode' = 'answer';
  SELECT coalesce(pg_catalog.array_agg(reach.vault_id), '{}') INTO reach_ids
  FROM opengeni_private.vault_reach(CASE WHEN answers_only THEN
    context || '{"taskMode":"root"}'::jsonb ELSE context END) reach;
  RETURN NEXT pg_catalog.jsonb_build_object(
    'meta', true,
    'kind', context ->> 'kind',
    'subjectId', context ->> 'subjectId',
    'humanExpected', (context ->> 'humanExpected')::boolean,
    'humanValid', (context ->> 'humanValid')::boolean,
    'hasSecretsUse', (context ->> 'hasSecretsUse')::boolean,
    'agentAllowed', (context ->> 'agentAllowed')::boolean,
    'includeUser', (context ->> 'includeUser')::boolean,
    'includeShared', (context ->> 'includeShared')::boolean,
    'policyVaultIds', context -> 'policyVaultIds',
    'reachableVaultCount', CASE WHEN answers_only THEN 0 ELSE pg_catalog.cardinality(reach_ids) END
  );
  RETURN QUERY
  WITH refs AS (
    SELECT (ref ->> 'index')::integer AS ref_index,
      ref ->> 'form' AS form,
      CASE WHEN ref ->> 'form' = 'id' THEN (ref ->> 'itemId')::uuid END AS item_id,
      CASE WHEN pg_catalog.jsonb_typeof(ref -> 'segments') = 'array' THEN ref -> 'segments'
        ELSE '[]'::jsonb END AS segments,
      nullif(ref ->> 'field', '') AS field,
      coalesce((ref ->> 'otp')::boolean, false) AS otp,
      coalesce((ref ->> 'previous')::boolean, false) AS previous
    FROM pg_catalog.jsonb_array_elements(p_refs) ref
  ), shaped AS (
    SELECT refs.*, pg_catalog.jsonb_array_length(refs.segments) AS segment_count FROM refs
  ), base AS (
    SELECT shaped.ref_index, 'item'::text AS interpretation, match.vault_id, match.item_id,
      match.matched_by, NULL::text AS field_name, false AS require_field, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 1
    UNION ALL
    SELECT shaped.ref_index, 'item_field', match.vault_id, match.item_id, match.matched_by,
      shaped.segments ->> 1, true, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 2
    UNION ALL
    SELECT shaped.ref_index, 'vault_item', vault_match.vault_id, match.item_id,
      CASE WHEN vault_match.matched_by = 'name' AND match.matched_by = 'name' THEN 'name' ELSE 'alias' END,
      NULL::text, false, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_vaults_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) vault_match
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(ARRAY[vault_match.vault_id], vault_name_key(shaped.segments ->> 1)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 2
    UNION ALL
    SELECT shaped.ref_index, 'vault_item_field', vault_match.vault_id, match.item_id,
      CASE WHEN vault_match.matched_by = 'name' AND match.matched_by = 'name' THEN 'name' ELSE 'alias' END,
      shaped.segments ->> 2, true, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_vaults_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) vault_match
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(ARRAY[vault_match.vault_id], vault_name_key(shaped.segments ->> 1)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 3
    UNION ALL
    SELECT shaped.ref_index, 'id', item.vault_id, item.id, 'id', shaped.field, shaped.field IS NOT NULL,
      shaped.otp, shaped.previous
    FROM shaped
    JOIN vault_items item ON item.id = shaped.item_id AND item.vault_id = ANY (reach_ids)
    WHERE shaped.form = 'id'
  )
  SELECT pg_catalog.jsonb_build_object(
    'refIndex', base.ref_index,
    'interpretation', base.interpretation,
    'tier', CASE vault.owner_kind WHEN 'task' THEN 0 WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END,
    'matchedBy', base.matched_by,
    'vaultId', vault.id,
    'vaultName', vault.name,
    'vaultOwnerKind', vault.owner_kind,
    'source', vault.source,
    'providerConnectionId', vault.provider_connection_id,
    'providerVaultRef', vault.provider_vault_ref,
    'providerCacheEpoch', vault.provider_cache_epoch::text,
    'itemId', item.id,
    'itemName', item.name,
    'itemType', item.type,
    'archived', item.archived_at IS NOT NULL,
    'providerItemRef', item.provider_item_ref,
    'fieldId', field.id,
    'fieldName', field.name,
    'fieldKind', field.kind,
    'fileName', field.file_name,
    'providerFieldRef', field.provider_field_ref,
    'currentVersion', field.current_version,
    'version', version.version,
    'valueEncrypted', version.value_encrypted,
    'missing', CASE
      WHEN field.id IS NULL THEN CASE
        WHEN base.field_name IS NOT NULL THEN 'field'
        WHEN base.otp THEN 'totp_field'
        ELSE 'primary_field' END
      WHEN field.current_version IS NOT NULL AND version.version IS NULL THEN
        CASE WHEN base.previous THEN 'previous_version' ELSE 'value' END
    END
  )
  FROM base
  JOIN vault_items item ON item.id = base.item_id
  JOIN vaults vault ON vault.id = base.vault_id
  LEFT JOIN LATERAL (
    SELECT candidate_field.* FROM vault_item_fields candidate_field
    WHERE candidate_field.item_id = item.id AND (
      (base.field_name IS NOT NULL AND candidate_field.name_key = vault_name_key(base.field_name))
      OR (base.field_name IS NULL AND base.otp AND candidate_field.kind = 'totp')
      OR (base.field_name IS NULL AND NOT base.otp AND candidate_field.id = item.primary_field_id)
    )
    ORDER BY candidate_field.position, candidate_field.name_key
    LIMIT 1
  ) field ON true
  LEFT JOIN LATERAL (
    SELECT candidate_version.version, candidate_version.value_encrypted
    FROM vault_field_versions candidate_version
    WHERE candidate_version.field_id = field.id
      AND CASE WHEN base.previous THEN candidate_version.version < field.current_version
        ELSE candidate_version.version = field.current_version END
    ORDER BY candidate_version.version DESC
    LIMIT 1
  ) version ON true
  WHERE (NOT base.require_field OR field.id IS NOT NULL)
    AND (NOT answers_only OR (NOT base.previous AND opengeni_private.vault_secure_answer_matches(context, item)))
  ORDER BY base.ref_index, base.interpretation, vault.id, item.id;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

CREATE OR REPLACE FUNCTION record_vault_secret_use(p_principal jsonb, p_use jsonb, p_items jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  context jsonb;
  touched integer;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  UPDATE vault_items item SET last_used_at = pg_catalog.now()
  WHERE item.id IN (
      SELECT (element ->> 'itemId')::uuid FROM pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) element
    )
    AND item.account_id = (context ->> 'accountId')::uuid
    AND (item.vault_id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(context) reach)
      OR opengeni_private.vault_secure_answer_matches(context, item));
  GET DIAGNOSTICS touched = ROW_COUNT;
  PERFORM opengeni_private.vault_audit((context ->> 'accountId')::uuid, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.secret.used', 'vault_item', NULL,
    coalesce(p_use, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'principalKind', context ->> 'kind',
      'sessionId', coalesce(context ->> 'sessionId', p_principal ->> 'sessionId'),
      'turnId', p_principal ->> 'turnId',
      'attemptId', p_principal ->> 'attemptId',
      'siteId', p_principal ->> 'siteId',
      'connectionId', p_principal ->> 'connectionId',
      'count', pg_catalog.jsonb_array_length(coalesce(p_items, '[]'::jsonb)),
      'itemsTouched', touched,
      'items', coalesce(p_items, '[]'::jsonb)));
  PERFORM opengeni_private.vault_capability_close();
END
$$;

REVOKE ALL ON FUNCTION opengeni_private.vault_turn_context(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.human_input_secret_target_reachable(jsonb, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.human_input_secret_save_targets(jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.vault_secure_answer_matches(jsonb, vault_items) FROM PUBLIC;

DO $search_paths$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'opengeni_private.vault_turn_context(uuid, uuid, uuid, uuid)',
    'opengeni_private.vault_principal_context(jsonb)',
    'opengeni_private.human_input_secret_target_reachable(jsonb, jsonb, text, uuid)',
    'opengeni_private.human_input_secret_save_targets(jsonb, uuid, uuid)',
    'opengeni_private.vault_secure_answer_matches(jsonb, vault_items)',
    'session_secrets_view(uuid, jsonb)',
    'apply_secret_answers(uuid, uuid, jsonb, jsonb)',
    'resolve_secret_reference_candidates(jsonb, jsonb)',
    'record_vault_secret_use(jsonb, jsonb, jsonb)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      signature, current_schema());
  END LOOP;
END $search_paths$;
