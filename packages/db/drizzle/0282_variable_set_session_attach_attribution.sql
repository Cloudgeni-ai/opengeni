-- deployment-mode: rolling
-- Migration 0282: the session-attach variable-set materialization records the
-- accepted subject and an audit fact.
--
-- `materialize_scoped_variable_set_for_session` (0254) is the API-direct
-- lane: a viewer attach or a direct channel operation cold-creating a box
-- materializes the session's variable set so the manifest environment matches
-- the next turn's. Unlike the attempt lane (0254/0280), it validated only the
-- session linkage - it took no subject and wrote no audit event, so a
-- materialization through this lane was invisible to the audit timeline.
--
-- The function keeps its exact signature and grants. Attribution arrives
-- through the standard request context GUCs (`opengeni.subject_id`,
-- `opengeni.initiating_human_subject_id`) that the application wrapper sets,
-- and the function now writes the same `variable_set.materialized` audit fact
-- the attempt lane writes: actor kind `session_attach`, the caller subject,
-- the derived causal human, and the live session authority tuple
-- (epoch/visibility/owner membership) read from the exact session row this
-- transaction already locks FOR SHARE. Metadata only - never a value.
--
-- Rolling window: unchanged signature; an old image calls without the subject
-- GUC and the audit row records the explicit legacy subject
-- `service:session` (the same honest sentinel the application's denial
-- recorder already uses for this lane) with NULL causal human. Denials keep
-- RAISE + rollback semantics; denial recording remains with the application
-- caller in a fresh transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_session(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
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
  selected_row record;
  variable_set_row workspace_variable_sets%ROWTYPE;
  session_authority_epoch integer;
  session_authority_visibility text;
  session_owner_membership uuid;
  audit_subject text;
  causal_human text;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'variable-set session materialization scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- Attribution (0282): the request subject from the standard context GUCs.
  -- An old image that sets no subject records the explicit legacy sentinel.
  audit_subject := coalesce(
    nullif(pg_catalog.current_setting('opengeni.subject_id', true), ''),
    'service:session'
  );
  causal_human := coalesce(
    nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
    CASE WHEN audit_subject LIKE 'user:%' THEN audit_subject END
  );

  INSERT INTO opengeni_private.variable_set_authority_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
  ON CONFLICT DO NOTHING;

  SELECT variable_set AS selected_set,
    session_value.authority_epoch AS session_epoch,
    session_value.visibility AS session_visibility,
    session_value.owner_organization_membership_id AS session_owner_membership
  INTO STRICT selected_row
  FROM sessions session_value
  JOIN workspace_variable_sets variable_set
    ON variable_set.id = p_variable_set_id
   AND variable_set.account_id = session_value.account_id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.variable_set_id = p_variable_set_id
    AND session_value.status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity'
    )
    AND variable_set.status = 'active'
    AND (
      variable_set.authority_scope = 'organization'
      OR (
        variable_set.authority_scope = 'workspace'
        AND variable_set.workspace_id = p_workspace_id
      )
    )
  FOR SHARE OF session_value, variable_set;
  variable_set_row := selected_row.selected_set;
  session_authority_epoch := selected_row.session_epoch;
  session_authority_visibility := selected_row.session_visibility;
  session_owner_membership := selected_row.session_owner_membership;

  -- The audit fact (0282): same action as the attempt lane, actor kind
  -- session_attach, live session authority from the row locked above.
  -- Metadata only - never a variable value.
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
      'actorKind', 'session_attach',
      'sessionId', p_session_id,
      'causalHumanSubjectId', causal_human,
      'authorityEpoch', session_authority_epoch,
      'authorityVisibility', session_authority_visibility,
      'authorityOwnerOrganizationMembershipId', session_owner_membership,
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

REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_session(
  uuid, uuid, uuid, uuid
) FROM PUBLIC;
DO $session_materialize_attribution_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION materialize_scoped_variable_set_for_session(
      uuid, uuid, uuid, uuid
    ) TO opengeni_app;
  END IF;
END
$session_materialize_attribution_grant$;
