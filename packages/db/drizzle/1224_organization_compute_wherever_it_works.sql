-- deployment-mode: rolling
-- Every organization machine and sandbox environment (rig), wherever it
-- works, for the people who decide where it works
-- (docs/design/ownership-and-reach.md, rules 3 and 4: the owner manages a
-- thing, and reach is separate from ownership). A workspace's machine and rig
-- lists hold only the organization ones that reach that workspace (1190), so
-- one limited to other workspaces was missing from them even for organization
-- owners. Organization settings > Shared lists them all, with where each
-- works.
--
-- list_organization_compute_v1 answers a caller in the current tenant context
-- with a summary of each active organization machine or rig of the asked
-- kind: its id, name and reach, never its connection, policy or versions. It
-- makes the same caller checks as the scoped machine and rig lists
-- (scoped_compute_actor_membership): the tenant context must match, and a
-- member must be able to use the requested workspace. The routes require an
-- organization owner or admin, as changing where one works already does, and
-- refuse agent runs: they only ever see what reaches their workspace.
--
-- Runtime EXECUTE is withheld for one release (runtime-posture
-- DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release rejects a runtime
-- grant on a definer it does not know. Until a later migration grants it, the
-- API answers with the organization machines and rigs that work in the
-- current workspace and says the list is incomplete.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.list_organization_compute_v1(
  p_account_id uuid, p_workspace_id uuid, p_kind text
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $organization_compute$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('machine', 'rig') THEN
    RAISE EXCEPTION 'invalid organization compute kind' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  PERFORM scoped_compute_actor_membership(p_account_id, p_workspace_id);
  IF p_kind = 'machine' THEN
    RETURN QUERY
      SELECT pg_catalog.jsonb_build_object(
        'id', enrollment.id,
        'sandboxId', sandbox.id,
        'sandboxName', sandbox.name,
        'os', enrollment.os,
        'reach', pg_catalog.jsonb_build_object(
          'homeWorkspaceId', enrollment.workspace_id,
          'allowedWorkspaceIds', pg_catalog.to_jsonb(enrollment.allowed_workspace_ids),
          'allowPersonalWorkspaces', enrollment.allow_personal_workspaces
        )
      )
      FROM enrollments enrollment
      LEFT JOIN LATERAL (
        SELECT value.id, value.name FROM sandboxes value
        WHERE value.enrollment_id = enrollment.id AND value.account_id = enrollment.account_id
        ORDER BY value.created_at LIMIT 1
      ) sandbox ON true
      WHERE enrollment.account_id = p_account_id AND enrollment.status = 'active'
        AND enrollment.kind = 'machine' AND enrollment.authority_scope = 'organization'
      ORDER BY enrollment.created_at DESC, enrollment.id;
  ELSE
    RETURN QUERY
      SELECT pg_catalog.jsonb_build_object(
        'id', rig.id,
        'name', rig.name,
        'reach', pg_catalog.jsonb_build_object(
          'homeWorkspaceId', rig.workspace_id,
          'allowedWorkspaceIds', pg_catalog.to_jsonb(rig.allowed_workspace_ids),
          'allowPersonalWorkspaces', rig.allow_personal_workspaces
        )
      )
      FROM rigs rig
      WHERE rig.account_id = p_account_id AND rig.status = 'active'
        AND rig.authority_scope = 'organization'
      ORDER BY rig.created_at, rig.id;
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$organization_compute$;

REVOKE ALL ON FUNCTION opengeni_private.list_organization_compute_v1(uuid, uuid, text) FROM PUBLIC;

DO $organization_compute_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_organization_compute_v1(uuid, uuid, text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $organization_compute_search_path$;
