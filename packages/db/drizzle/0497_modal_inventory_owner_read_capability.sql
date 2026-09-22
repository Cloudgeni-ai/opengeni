-- deployment-mode: rolling
-- The global orphan-safety inventory must not interpret FORCE-RLS blindness
-- as an empty fleet. Restore its existing cross-tenant read contract only
-- while the audited function runs as the exact non-bypass migration owner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.modal_inventory_read_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  data_schema text NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, data_schema)
);
REVOKE ALL ON TABLE opengeni_private.modal_inventory_read_capabilities FROM PUBLIC;

-- Hostile owner defaults must not give any non-owner a mint/read/delete seam.
DO $capability_acl$
DECLARE role_name text;
BEGIN
  FOR role_name IN
    SELECT DISTINCT role.rolname
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE relation.oid = 'opengeni_private.modal_inventory_read_capabilities'::regclass
      AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE opengeni_private.modal_inventory_read_capabilities FROM %I',
      role_name
    );
  END LOOP;
END
$capability_acl$;

DO $inventory$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  role_name text;
BEGIN
  -- RLS checks function EXECUTE before short-circuiting the owner comparison.
  -- This public, value-free predicate cannot create a capability. Authority
  -- checks current_user in the policy, not a role name supplied by its caller.
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.modal_inventory_read_capability_active()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog AS $body$
      SELECT EXISTS (
        SELECT 1 FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %2$L
      )
    $body$;
    REVOKE ALL ON FUNCTION %1$I.modal_inventory_read_capability_active() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION %1$I.modal_inventory_read_capability_active() TO PUBLIC;
    CREATE POLICY modal_inventory_owner_read ON %1$I.sandbox_leases FOR SELECT
      USING (current_user = %3$L AND %1$I.modal_inventory_read_capability_active());
  $ddl$, data_schema, data_schema, migration_owner);

  -- RETURN QUERY materializes its rows before cleanup and before the caller
  -- regains control. A nested invocation retains any pre-existing capability;
  -- the outer owner remains responsible for its lifetime. Exception rollback
  -- also removes a capability inserted by this invocation.
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.list_live_modal_sandbox_leases()
    RETURNS TABLE (
      lease_id uuid, workspace_id uuid, sandbox_group_id uuid,
      instance_id text, liveness text
    ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE opened integer;
    BEGIN
      INSERT INTO opengeni_private.modal_inventory_read_capabilities (
        backend_pid, transaction_id, data_schema
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %2$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;

      RETURN QUERY SELECT lease.id, lease.workspace_id, lease.sandbox_group_id,
        lease.instance_id, lease.liveness
      FROM %1$I.sandbox_leases lease
      WHERE lease.liveness IN ('warming', 'warm', 'draining')
        AND (lease.backend = 'modal' OR lease.resume_backend_id = 'modal');

      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %2$L;
      END IF;
      RETURN;
    END
    $body$;
  $ddl$, data_schema, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() FROM PUBLIC;
  -- Preserve existing explicit runtime grants; support existing configured
  -- roles and migrate-before-provision installs without requiring role creation.
  FOR role_name IN SELECT jsonb_array_elements_text(coalesce(nullif(
    pg_catalog.current_setting('opengeni.migration_application_roles', true), ''
  )::jsonb, '[]'::jsonb)) LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() TO %I',
        role_name
      );
    END IF;
  END LOOP;
END
$inventory$;