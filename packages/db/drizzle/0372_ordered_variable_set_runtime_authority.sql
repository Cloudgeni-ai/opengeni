-- deployment-mode: rolling
-- Migration 0352 activated ordered session Variable Set selections and extended
-- accepted personal-resource grants, but four runtime authorization seams
-- still consulted only the legacy final-entry `sessions.variable_set_id` alias.
-- A selected set earlier in `variable_set_ids` could therefore be accepted and
-- snapshotted correctly, then rejected during materialization or an exact agent
-- secret read. Keep every public signature, return type, grant, search path, and
-- audit behavior unchanged while switching those selection checks to the full
-- ordered session selection.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $repair_ordered_variable_set_runtime_authority$
DECLARE
  data_schema text := pg_catalog.current_schema();
  patch_record record;
  function_oid regprocedure;
  definition text;
  patched text;
  occurrences integer;
BEGIN
  FOR patch_record IN
    SELECT * FROM (VALUES
      (
        'materialize_scoped_variable_set_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)',
        'session_value.variable_set_id = variable_set_row.id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text'
      ),
      (
        'read_scoped_variable_set_secret(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,integer)',
        'session_value.variable_set_id = variable_set_row.id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text'
      ),
      (
        'authorize_session_attempt_personal_resource_reads(uuid,uuid,uuid)',
        'variable_set.id = session_value.variable_set_id',
        'coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set.id::text'
      )
    ) AS patches(function_signature, old_anchor, new_anchor)
  LOOP
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.quote_ident(data_schema) || '.' || patch_record.function_signature
    );
    IF function_oid IS NULL THEN
      RAISE EXCEPTION '0372 required function is unavailable: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;

    definition := pg_catalog.pg_get_functiondef(function_oid);
    occurrences := (
      pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, patch_record.old_anchor, ''))
    ) / pg_catalog.length(patch_record.old_anchor);
    IF occurrences <> 1 OR pg_catalog.strpos(definition, patch_record.new_anchor) > 0 THEN
      RAISE EXCEPTION '0372 ordered Variable Set authority definition drift: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;

    patched := pg_catalog.replace(
      definition,
      patch_record.old_anchor,
      patch_record.new_anchor
    );
    IF pg_catalog.strpos(patched, patch_record.new_anchor) = 0
      OR pg_catalog.strpos(patched, patch_record.old_anchor) > 0
    THEN
      RAISE EXCEPTION '0372 ordered Variable Set authority patch failed: %',
        patch_record.function_signature
        USING ERRCODE = '55000';
    END IF;
    EXECUTE patched;
  END LOOP;
END
$repair_ordered_variable_set_runtime_authority$;

-- The direct session-attach lane has no attempt snapshot to resolve. Admit a
-- user-scoped set only through the exact live owner membership, resource
-- authority, and session/always grant that accepted work issued for this
-- session. Every mutable authority row is locked before ciphertext egress so a
-- concurrent revocation wins before a later attach or attach retry.
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
  INTO STRICT selected_row
  FROM sessions session_value
  JOIN workspace_variable_sets variable_set
    ON variable_set.id = p_variable_set_id
   AND variable_set.account_id = session_value.account_id
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND coalesce(session_value.variable_set_ids, '[]'::jsonb) ? p_variable_set_id::text
    AND session_value.status IN (
      'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity'
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
