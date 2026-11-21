-- deployment-mode: rolling
-- Shared service connections (docs/secrets.md, "Shared service connections"):
-- a workspace-owned API-key connection whose stored credential holds
-- secret references to vault items. The API and worker resolve them only for
-- the request they send to the tool, as the new `service_connection` vault
-- principal:
--
--   1. vault_principal_context accepts kind 'service_connection'. It reaches
--      the workspace's vaults and the organization vaults that work here
--      (include_shared), never an Only me vault (include_user stays false)
--      or a chat's task vault (task_mode 'none'), and has no acting person.
--      With a connectionId it must name an active workspace-owned API-key
--      connection of this workspace marked credentialSource 'vault'; without
--      one (an admin checking a key before saving it) the reach is the same.
--   2. vault_assert_writable refuses it, like a Site viewer: it only reads.
--   3. record_vault_secret_use also records the connectionId in the
--      vault.secret.used audit row (never a value).
--
-- The bodies are copied from 0977_baseline_01, their latest definitions,
-- with only these additions. Same signatures, so owners and grants stay;
-- search paths are pinned again below as the baseline had them.
--
-- Rolling: the previous release never sends this principal kind, and every
-- other kind behaves exactly as before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

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
  human_expected boolean := false;
  human_valid boolean := false;
  has_use boolean := false;
  agent_allowed boolean := true;
  include_user boolean := false;
  include_shared boolean := false;
  task_root uuid;
  task_mode text := 'none';
  policy_ids jsonb := NULL;
  narrowed_by uuid := NULL;
  session_row record;
  schedule_policy jsonb;
  schedule_owner text;
  attempt_session uuid;
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
    SELECT session_value.id, session_value.root_session_id,
        session_value.first_party_mcp_permissions,
        coalesce(
          nullif(pg_catalog.btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject'
            THEN nullif(pg_catalog.btrim(turn_value.initiator_subject_id), '') END
        ) AS human_subject,
        turn_value.scheduled_task_run_id
      INTO session_row
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
    task_root := coalesce(session_row.root_session_id, session_row.id);
    attempt_session := session_row.id;
    task_mode := 'root';
    acting_subject := session_row.human_subject;
    IF acting_subject IS NOT NULL THEN
      human_expected := true;
    ELSIF session_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT task.owner_subject_id, task.vault_policy INTO schedule_owner, schedule_policy
      FROM scheduled_task_runs run
      JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
      WHERE run.id = session_row.scheduled_task_run_id AND run.workspace_id = guc_workspace;
      acting_subject := nullif(pg_catalog.btrim(schedule_owner), '');
      human_expected := acting_subject IS NOT NULL;
    END IF;
    IF human_expected THEN
      membership_id := vault_actor_membership(guc_account, acting_subject);
      human_valid := membership_id IS NOT NULL
        AND opengeni_private.vault_subject_in_workspace(guc_account, guc_workspace, acting_subject);
      IF NOT human_valid THEN
        membership_id := NULL;
      END IF;
      has_use := human_valid
        AND opengeni_private.vault_subject_has_secrets_use(guc_account, guc_workspace, acting_subject);
    ELSE
      has_use := true;
    END IF;
    agent_allowed := session_row.first_party_mcp_permissions IS NULL
      OR pg_catalog.jsonb_typeof(session_row.first_party_mcp_permissions) <> 'array'
      OR session_row.first_party_mcp_permissions ?| ARRAY[
        'secrets:use', 'variable-sets:use', 'variable-sets:attach', 'environments:use'
      ];
    include_user := agent_allowed AND human_valid AND has_use;
    include_shared := agent_allowed AND has_use AND (NOT human_expected OR human_valid);
    IF NOT agent_allowed THEN
      task_mode := 'none';
    END IF;
    SELECT chain.vault_ids, chain.narrowed_by INTO policy_ids, narrowed_by
    FROM opengeni_private.vault_session_policy_chain(guc_account, guc_workspace, session_row.id, true) chain;
    IF schedule_policy IS NULL AND session_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT task.vault_policy INTO schedule_policy
      FROM scheduled_task_runs run
      JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
      WHERE run.id = session_row.scheduled_task_run_id AND run.workspace_id = guc_workspace;
    END IF;
    policy_ids := opengeni_private.vault_policy_intersect(
      policy_ids, opengeni_private.vault_policy_ids(schedule_policy)
    );
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
    'sessionId', attempt_session,
    'membershipId', membership_id,
    'humanExpected', human_expected,
    'humanValid', human_valid,
    'hasSecretsUse', has_use,
    'agentAllowed', agent_allowed,
    'includeUser', include_user,
    'includeShared', include_shared,
    'taskMode', task_mode,
    'taskRoot', task_root,
    'personalWorkspace', opengeni_private.vault_workspace_is_personal(guc_account, guc_workspace),
    'policyVaultIds', policy_ids,
    'narrowedBySessionId', narrowed_by
  );
END
$$;

CREATE OR REPLACE FUNCTION opengeni_private.vault_assert_writable(p_context jsonb, p_vault vaults) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path FROM CURRENT
    AS $$
BEGIN
  IF p_context ->> 'kind' = 'site_viewer' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'Sites cannot change vault items');
  END IF;
  IF p_context ->> 'kind' = 'service_connection' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'service connections only read vault items');
  END IF;
  IF p_vault.source <> 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_read_only',
      'items in a connected vault change through its provider',
      pg_catalog.jsonb_build_object('vaultId', p_vault.id));
  END IF;
  IF p_vault.mode <> 'read_write' THEN
    PERFORM opengeni_private.vault_raise('vault_read_only', 'vault is read-only',
      pg_catalog.jsonb_build_object('vaultId', p_vault.id));
  END IF;
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
    AND item.vault_id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(context) reach);
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

DO $service_connection_search_paths$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.vault_principal_context(jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.vault_assert_writable(jsonb, vaults) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION record_vault_secret_use(jsonb, jsonb, jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $service_connection_search_paths$;

