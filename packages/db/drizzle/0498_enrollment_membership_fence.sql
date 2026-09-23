-- deployment-mode: maintenance
-- Stop old API/control/turn workers. Never restart pre-0498 approval writers:
-- their tenancy/request locks precede the organization membership fence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'enrollment membership migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

-- Only the organization read is RLS-blinded. workspace_memberships is non-RLS:
-- keep its FOR KEY SHARE to exclude raw runtime DELETE, not just lifecycle SQL.
-- No policy or privilege is widened. Preserve the exact existing function's
-- owner, signature, search_path, capability cleanup, and downstream writes.
-- The backfill checker also sees SQL inside transformation strings. Use the
-- existing owner-only transformation window (0343); application RLS is not
-- relaxed and FORCE is restored within this migration's one transaction.
ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;
DO $repair$
DECLARE
  target regprocedure;
  definition text;
  old_fragment text := $old$  ELSIF p_scope = 'user' THEN
    SELECT membership.* INTO STRICT owner_membership
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id AND membership.subject_id = caller_subject
      AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;$old$;
  new_fragment text := $new$  ELSIF p_scope = 'user' THEN
    -- Direct/nested callers may already hold tenancy or request locks. Never
    -- wait for the organization fence here and create a reverse-order cycle.
    -- The public approval wrapper acquires this fence before entering RLS scope.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'organization-membership:' || p_account_id::text, 0
    )) THEN
      RAISE EXCEPTION 'enrollment membership is changing; retry the transaction'
        USING ERRCODE = '55P03';
    END IF;
    SELECT membership.* INTO STRICT owner_membership
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id AND membership.subject_id = caller_subject
      AND membership.status = 'active' AND membership.revoked_at IS NULL;$new$;
BEGIN
  target := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.finalize_scoped_enrollment(uuid,uuid,text,text,boolean,boolean,text,text,text,boolean)',
    pg_catalog.current_schema()
  ));
  definition := pg_catalog.pg_get_functiondef(target);
  IF target IS NULL OR (length(definition) - length(replace(definition, old_fragment, '')))
      / length(old_fragment) <> 1 THEN
    RAISE EXCEPTION '0498 enrollment membership definition drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);

  -- The command already has the 0345 organization/tenancy prefix. A direct
  -- prepare-then-command caller must acquire that fence BEFORE preparation
  -- takes downstream row locks too. Unknown nested callers fail closed.
  target := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.prepare_workspace_membership_removal_settlements(jsonb)',
    pg_catalog.current_schema()
  ));
  definition := pg_catalog.pg_get_functiondef(target);
  old_fragment := $old_prepare$  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value AND workspace.id = workspace_id_value;
  IF NOT FOUND THEN$old_prepare$;
  new_fragment := $new_prepare$  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  )) THEN
    RAISE EXCEPTION 'workspace membership is changing; retry the transaction'
      USING ERRCODE = '55P03';
  END IF;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = account_id_value AND workspace.id = workspace_id_value;
  IF NOT FOUND THEN$new_prepare$;
  IF target IS NULL OR (length(definition) - length(replace(definition, old_fragment, '')))
      / length(old_fragment) <> 1 THEN
    RAISE EXCEPTION '0498 workspace membership preparation definition drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);
END $repair$;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;