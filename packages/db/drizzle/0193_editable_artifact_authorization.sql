-- deployment-mode: rolling
-- Durable editable-artifact authorization projection and revocation fencing.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.authorize_editable_artifact_actor(
  p_account_id uuid,
  p_workspace_id uuid,
  p_artifact_id text,
  p_actor_kind text,
  p_actor_subject_id text,
  p_agent_session_id text,
  p_agent_turn_id text,
  p_agent_attempt_id text,
  p_agent_generation integer,
  p_service_name text,
  p_permission text,
  p_data_schema name DEFAULT pg_catalog.current_schema()
) RETURNS TABLE (allowed boolean, authorization_revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE data_schema name;
DECLARE required_permission text;
DECLARE current_revision bigint;
DECLARE principal_allowed boolean := false;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_artifact_id !~ '^[0-9a-f]{32}$' OR p_artifact_id ~ '^0+$'
    OR p_actor_kind NOT IN ('human', 'agent', 'service')
    OR p_actor_subject_id IS NULL
    OR octet_length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR p_permission NOT IN ('create', 'read', 'edit', 'import', 'export', 'manage')
    OR NOT opengeni_private.editable_artifact_scope_matches_context(
      p_account_id, p_workspace_id
    )
  THEN
    RAISE EXCEPTION 'editable artifact authorization request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (p_actor_kind = 'human' AND (
      p_agent_session_id IS NOT NULL OR p_agent_turn_id IS NOT NULL
      OR p_agent_attempt_id IS NOT NULL OR p_agent_generation IS NOT NULL
      OR p_service_name IS NOT NULL
    )) OR (p_actor_kind = 'agent' AND (
      p_agent_session_id IS NULL OR p_agent_turn_id IS NULL
      OR p_agent_attempt_id IS NULL OR p_agent_generation IS NULL
      OR p_agent_generation < 0 OR p_service_name IS NOT NULL
    )) OR (p_actor_kind = 'service' AND (
      p_agent_session_id IS NOT NULL OR p_agent_turn_id IS NOT NULL
      OR p_agent_attempt_id IS NOT NULL OR p_agent_generation IS NOT NULL
      OR p_service_name IS NULL
    ))
  THEN
    RAISE EXCEPTION 'editable artifact authorization actor is invalid'
      USING ERRCODE = '22023';
  END IF;

  data_schema := opengeni_private.resolve_editable_artifact_data_schema(p_data_schema);
  required_permission := CASE
    WHEN p_permission IN ('read', 'export') THEN 'artifacts:read'
    ELSE 'artifacts:publish'
  END;

  IF p_permission = 'create' THEN
    current_revision := opengeni_private.ensure_editable_artifact_scope_authorization_head(
      p_account_id, p_workspace_id, data_schema
    );
  ELSE
    EXECUTE pg_catalog.format($query$
      SELECT artifact.authorization_revision
      FROM %I.editable_artifacts artifact
      WHERE artifact.account_id = $1 AND artifact.workspace_id = $2
        AND artifact.id = $3
    $query$, data_schema)
      INTO current_revision
      USING p_account_id, p_workspace_id, p_artifact_id;
    current_revision := coalesce(current_revision, 1);
  END IF;

  IF p_actor_kind = 'agent' THEN
    EXECUTE pg_catalog.format($query$
      SELECT true
      FROM %I.sessions session
      JOIN %I.session_turns turn
        ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
      JOIN %I.session_turn_attempts attempt
        ON attempt.account_id = turn.account_id
        AND attempt.workspace_id = turn.workspace_id
        AND attempt.session_id = turn.session_id
        AND attempt.turn_id = turn.id
      WHERE session.account_id = $1 AND session.workspace_id = $2
        AND session.id::text = $3
        AND turn.id::text = $4
        AND attempt.id::text = $5
        AND session.active_turn_id = turn.id
        AND turn.active_attempt_id = attempt.id
        AND turn.execution_generation = $6
        AND attempt.execution_generation = $6
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt.state IN ('claimed', 'running')
        AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM %I.session_attempt_interruptions interruption
          WHERE interruption.account_id = session.account_id
            AND interruption.workspace_id = session.workspace_id
            AND interruption.session_id = session.id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
        AND (
          session.first_party_mcp_permissions IS NULL
          OR session.first_party_mcp_permissions ? $7
          OR session.first_party_mcp_permissions ? 'workspace:admin'
        )
      LIMIT 1
      FOR SHARE OF session, turn, attempt
    $query$, data_schema, data_schema, data_schema, data_schema)
      INTO principal_allowed
      USING p_account_id, p_workspace_id, p_agent_session_id,
        p_agent_turn_id, p_agent_attempt_id, p_agent_generation,
        required_permission;
  ELSIF p_actor_kind = 'service'
    AND p_service_name = 'api_key'
    AND p_actor_subject_id ~ '^api_key:[0-9a-fA-F-]{36}$'
  THEN
    EXECUTE pg_catalog.format($query$
      SELECT true
      FROM %I.api_keys api_key
      WHERE api_key.account_id = $1 AND api_key.workspace_id = $2
        AND api_key.id::text = substring($3 from 9)
        AND api_key.revoked_at IS NULL
        AND (api_key.expires_at IS NULL OR api_key.expires_at > pg_catalog.clock_timestamp())
        AND (api_key.permissions ? $4 OR api_key.permissions ? 'workspace:admin')
      LIMIT 1
      FOR SHARE OF api_key
    $query$, data_schema)
      INTO principal_allowed
      USING p_account_id, p_workspace_id, p_actor_subject_id, required_permission;
  ELSIF p_actor_kind = 'human'
    OR (p_actor_kind = 'service' AND p_service_name = 'configured_key')
  THEN
    -- Configured deployments authenticate the shared key at the HTTP boundary,
    -- then persist its exact subject as a workspace membership. Revalidate that
    -- durable tenant/permission grant here just as for a human session; key
    -- possession itself is never accepted from caller-authored SQL inputs.
    EXECUTE pg_catalog.format($query$
      SELECT true
      FROM %I.workspace_memberships membership
      WHERE membership.account_id = $1 AND membership.workspace_id = $2
        AND membership.subject_id = $3
        AND (membership.permissions ? $4 OR membership.permissions ? 'workspace:admin')
      LIMIT 1
      FOR SHARE OF membership
    $query$, data_schema)
      INTO principal_allowed
      USING p_account_id, p_workspace_id, p_actor_subject_id, required_permission;
  ELSE
    -- Delegated service grants have no independent transactionally
    -- revalidatable authority source. Fail closed rather than accepting a
    -- self-carried grant.
    principal_allowed := false;
  END IF;

  RETURN QUERY SELECT coalesce(principal_allowed, false), current_revision;
END;
$body$;

REVOKE ALL ON FUNCTION opengeni_private.authorize_editable_artifact_actor(
  uuid, uuid, text, text, text, text, text, text, integer, text, text, name
) FROM PUBLIC;

DO $runtime_authorization_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_editable_artifact_actor(
      uuid, uuid, text, text, text, text, text, text, integer, text, text, name
    ) TO opengeni_app;
  END IF;
END;
$runtime_authorization_grant$;

RESET statement_timeout;
RESET lock_timeout;
