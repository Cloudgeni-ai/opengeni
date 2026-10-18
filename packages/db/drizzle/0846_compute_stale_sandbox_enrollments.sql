-- deployment-mode: rolling
-- The worker's stale compute enrollment inventory.
--
-- A compute sandbox's enrollment must not stay active once nothing can use
-- it. The orphan sweep revokes the enrollment of every sandbox the fabric
-- still lists, but an enrollment whose sandbox is already gone (a delete that
-- succeeded before its revoke failed, a create that never made a sandbox) is
-- no longer in any fabric listing. This inventory finds those from Opengeni's
-- own records, across workspaces: active sandbox enrollments created more
-- than 10 minutes ago (the create settle window) whose group's lease neither
-- names them nor is warming a new box. The worker then revokes each one under
-- its own workspace's RLS, re-checking the same condition. It returns one
-- page of at most 100 in enrollment-id order, after the id the caller gives
-- (none for the first page), so a caller can reach every entry however many
-- of the first ones keep failing.
--
-- It reuses the owner-only, transaction-bound read capability of the Modal
-- inventory (0497): one more SELECT policy on enrollments, true only for the
-- migration owner while that capability is held, admitted in the table's
-- restrictive SELECT policies. The inventory returns ids only and changes
-- nothing. The previous release never calls it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE INDEX IF NOT EXISTS enrollments_active_sandbox_id_idx
  ON enrollments (id)
  WHERE kind = 'sandbox' AND status = 'active';

DO $policy$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  target_table regclass := pg_catalog.format('%I.%I', data_schema, 'enrollments')::regclass;
  admitted text := pg_catalog.format(
    '(current_user = %L AND %I.modal_inventory_read_capability_active())',
    migration_owner, data_schema
  );
  restrictive record;
BEGIN
  EXECUTE pg_catalog.format(
    'DROP POLICY IF EXISTS compute_enrollment_inventory_owner_read ON %s', target_table
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY compute_enrollment_inventory_owner_read ON %s AS PERMISSIVE FOR SELECT USING %s',
    target_table, admitted
  );
  FOR restrictive IN
    SELECT policy.polname, pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS qual
    FROM pg_catalog.pg_policy policy
    WHERE policy.polrelid = target_table
      AND NOT policy.polpermissive
      AND policy.polcmd IN ('r', '*')
      AND policy.polqual IS NOT NULL
  LOOP
    IF pg_catalog.strpos(restrictive.qual, 'modal_inventory_read_capability_active') = 0 THEN
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %s USING ((%s) OR %s)',
        restrictive.polname, target_table, restrictive.qual, admitted
      );
    END IF;
  END LOOP;
END
$policy$;

DO $inventory$
DECLARE data_schema text := pg_catalog.current_schema(); role_name text;
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(after_enrollment uuid)
    RETURNS TABLE (workspace_id uuid, enrollment_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE opened integer;
    BEGIN
      INSERT INTO opengeni_private.modal_inventory_read_capabilities
        (backend_pid, transaction_id, data_schema)
      VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %2$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;
      RETURN QUERY SELECT enrollment.workspace_id, enrollment.id
        FROM %1$I.enrollments enrollment
        WHERE enrollment.kind = 'sandbox' AND enrollment.status = 'active'
          AND enrollment.created_at < now() - interval '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_leases lease
            WHERE lease.workspace_id = enrollment.workspace_id
              AND lease.sandbox_group_id = enrollment.sandbox_group_id
              AND (lease.liveness = 'warming'
                OR lease.resume_state #>> '{sessionState,enrollmentId}' = enrollment.id::text)
          )
          AND (after_enrollment IS NULL OR enrollment.id > after_enrollment)
        ORDER BY enrollment.id LIMIT 100;
      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %2$L;
      END IF;
    END
    $body$;
  $ddl$, data_schema, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(uuid) FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE proc.oid = 'opengeni_private.list_stale_compute_sandbox_enrollments(uuid)'::regprocedure
      AND acl.grantee <> proc.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(uuid) FROM %I', role_name);
  END LOOP;
  -- Mirror the existing approved inventory callers, including custom runtime
  -- roles. No new public cross-workspace capability is introduced.
  FOR role_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE proc.oid = 'opengeni_private.list_live_modal_sandbox_leases()'::regprocedure
      AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> proc.proowner
  LOOP
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(uuid) TO %I', role_name);
  END LOOP;
END;
$inventory$;
