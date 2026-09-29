-- deployment-mode: rolling
-- The direct session-attach lane (terminal, Files, Git and the desktop viewer)
-- materializes the frozen Sandbox Environment version's default Variable Sets
-- before the session's own selection, in the same order as an agent turn. The agent
-- attempt seam admits a set selected by the session OR listed in the session's
-- frozen Sandbox Environment version defaults, but this seam admitted only the
-- session's own `variable_set_ids`. A session whose creator did not repeat the
-- environment defaults (API/SDK, Slack, scheduled and child sessions) therefore
-- hit `SELECT ... INTO STRICT` with no row, raised P0002, and every attach
-- answered HTTP 500.
--
-- Admit the frozen environment defaults through the same join the attempt seam
-- uses (the session's own rig_version_id + rig_id + account), and keep every
-- other check unchanged: exact account/workspace scope, live session status,
-- active set, workspace-scope containment, the exact personal owner membership,
-- authority and session/always `variable_set.use` grant, the row locks, and the
-- materialization audit fact. A set that is neither selected nor an environment
-- default is now a clean 42501 authorization denial (which the caller records as
-- a `variable_set.materialize.denied` fact) instead of an unmapped P0002.
--
-- The signature, return type, owner and EXECUTE ACL are unchanged, so old and new
-- API images coexist. The CREATE OR REPLACE resets proconfig, so the SECURITY
-- DEFINER search path is re-pinned to pg_catalog, the data schema, then pg_temp.

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
  INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
  ON CONFLICT DO NOTHING;

  SELECT variable_set AS selected_set,
    session_value.authority_epoch AS session_epoch,
    session_value.visibility AS session_visibility,
    session_value.owner_organization_membership_id AS session_owner_membership
  INTO selected_row
  FROM sessions session_value
  LEFT JOIN rig_versions rig_version
    ON rig_version.id = session_value.rig_version_id
   AND rig_version.rig_id = session_value.rig_id
   AND rig_version.account_id = session_value.account_id
  JOIN workspace_variable_sets variable_set
    ON variable_set.id = p_variable_set_id
   AND variable_set.account_id = session_value.account_id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND (
      coalesce(session_value.variable_set_ids, '[]'::jsonb) ? p_variable_set_id::text
      OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
        ? p_variable_set_id::text
    )
    AND session_value.status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity', 'failed'
    )
    AND variable_set.status = 'active'
    AND (
      variable_set.authority_scope IN ('organization', 'user')
      OR (
        variable_set.authority_scope = 'workspace'
        AND variable_set.workspace_id = p_workspace_id
      )
    )
  FOR SHARE OF session_value, variable_set;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'variable set is not selected by, or not available to, the exact session'
      USING ERRCODE = '42501';
  END IF;
  variable_set_row := selected_row.selected_set;
  session_authority_epoch := selected_row.session_epoch;
  session_authority_visibility := selected_row.session_visibility;
  session_owner_membership := selected_row.session_owner_membership;

  IF variable_set_row.authority_scope = 'user' THEN
    PERFORM 1
    FROM organization_memberships membership
    JOIN organization_user_resource_authorities authority
      ON authority.id = variable_set_row.authority_id
     AND authority.account_id = membership.account_id
     AND authority.organization_membership_id = membership.id
     AND authority.resource_kind = 'variable_set'
     AND authority.resource_id = variable_set_row.id
     AND authority.origin_workspace_id IS NOT DISTINCT FROM variable_set_row.origin_workspace_id
     AND authority.generation = variable_set_row.generation
     AND authority.status = 'active'
     AND authority.revoked_at IS NULL
    JOIN organization_user_resource_grants grant_value
      ON grant_value.account_id = authority.account_id
     AND grant_value.authority_id = authority.id
     AND grant_value.owner_organization_membership_id = membership.id
     AND grant_value.workspace_id = p_workspace_id
     AND grant_value.action = 'variable_set.use'
     AND grant_value.context = session_authority_visibility
     AND grant_value.status = 'active'
     AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
     AND (
       (
         grant_value.mode = 'session'
         AND grant_value.session_id = p_session_id
         AND grant_value.authority_epoch = session_authority_epoch
       )
       OR (
         grant_value.mode = 'always'
         AND grant_value.session_id IS NULL
         AND grant_value.authority_epoch IS NULL
       )
     )
    WHERE membership.id = variable_set_row.owner_organization_membership_id
      AND membership.account_id = p_account_id
      AND membership.subject_id = causal_human
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND membership.authorization_revision > 0
      AND (
        membership.personal_workspace_id = p_workspace_id
        OR EXISTS (
          SELECT 1
          FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = membership.account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = membership.subject_id
        )
      )
      AND (
        session_authority_visibility = 'workspace_shared'
        OR session_owner_membership = membership.id
      )
    ORDER BY grant_value.id
    FOR SHARE OF membership, authority, grant_value;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'personal variable-set session grant is not exact or current'
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

  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'resolve';
  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'resolve';
  DELETE FROM opengeni_private.variable_set_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'materialize';
  RAISE;
END
$$;

DO $pin_session_attach_search_path$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %1$I.materialize_scoped_variable_set_for_session(uuid, uuid, uuid, uuid) '
      'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
END
$pin_session_attach_search_path$;
