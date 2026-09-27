-- deployment-mode: rolling
-- A missing create reply is not evidence that no provider was created. Keep
-- this receipt outside resume_state, which archive/rollback code may replace.
ALTER TABLE sandbox_leases ADD COLUMN provider_create_attempt jsonb;
ALTER TABLE sandbox_leases ADD COLUMN provider_create_recovery_after timestamptz;

ALTER TABLE sandbox_leases ADD CONSTRAINT sandbox_provider_create_attempt_shape CHECK (
  provider_create_attempt IS NULL OR (
    jsonb_typeof(provider_create_attempt) = 'object'
    AND provider_create_attempt->>'version' = '1'
    AND length(provider_create_attempt->>'operationId') > 0
    AND length(provider_create_attempt->>'providerBindingKey') > 0
    AND length(provider_create_attempt->>'appId') > 0
    AND provider_create_attempt->>'providerName' = 'opengeni-create-' || (provider_create_attempt->>'operationId')
    AND provider_create_attempt->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(provider_create_attempt->'leaseEpoch') = 'number'
    AND provider_create_attempt ? 'instanceId'
    AND (provider_create_attempt->'instanceId' = 'null'::jsonb
      OR (jsonb_typeof(provider_create_attempt->'instanceId') = 'string'
        AND length(provider_create_attempt->>'instanceId') > 0))
  ) IS TRUE
);

CREATE FUNCTION opengeni_private.guard_unresolved_provider_create()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.provider_create_attempt IS NOT NULL
     AND OLD.provider_create_attempt->'instanceId' = 'null'::jsonb THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'provider_create_outcome_unknown: cannot delete unresolved lease';
    END IF;
    IF NEW.provider_create_attempt IS NULL
       OR (NEW.provider_create_attempt - 'instanceId') IS DISTINCT FROM
          (OLD.provider_create_attempt - 'instanceId')
       OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
       OR NEW.backend IS DISTINCT FROM OLD.backend
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.sandbox_group_id IS DISTINCT FROM OLD.sandbox_group_id
       OR NEW.current_checkpoint_artifact_id IS DISTINCT FROM OLD.current_checkpoint_artifact_id
       OR NEW.previous_checkpoint_artifact_id IS DISTINCT FROM OLD.previous_checkpoint_artifact_id
       OR NEW.workspace_generation IS DISTINCT FROM OLD.workspace_generation
       OR NEW.archive_generation IS DISTINCT FROM OLD.archive_generation
       OR NEW.liveness IS DISTINCT FROM OLD.liveness
       OR (NEW.provider_create_attempt->'instanceId' = 'null'::jsonb
          AND NEW.resume_state IS DISTINCT FROM OLD.resume_state)
       OR (NEW.instance_id IS DISTINCT FROM OLD.instance_id AND
          NEW.instance_id IS DISTINCT FROM NEW.provider_create_attempt->>'instanceId') THEN
      RAISE EXCEPTION 'provider_create_outcome_unknown: preserve operation until exact provider attribution';
    END IF;
    IF NEW.provider_create_attempt->'instanceId' <> 'null'::jsonb
       AND NEW.instance_id IS DISTINCT FROM NEW.provider_create_attempt->>'instanceId' THEN
      RAISE EXCEPTION 'provider_create_outcome_unknown: attribution must bind authoritative instance';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_provider_create_fence
BEFORE UPDATE OR DELETE ON sandbox_leases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_unresolved_provider_create();

-- Trigger execution does not require callers to execute its function. Remove
-- PUBLIC and hostile default grants instead of widening specialized roles.
REVOKE ALL ON FUNCTION opengeni_private.guard_unresolved_provider_create() FROM PUBLIC;
DO $guard_acl$
DECLARE role_name text;
BEGIN
  FOR role_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE proc.oid = 'opengeni_private.guard_unresolved_provider_create()'::regprocedure
      AND acl.grantee <> proc.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION opengeni_private.guard_unresolved_provider_create() FROM %I', role_name);
  END LOOP;
END;
$guard_acl$;

-- Preserve the installed reaper's locks, scope, holder settlement and ACL.
-- Skip unknown creates instead of letting one fence abort the entire sweep.
DO $patch_reaper$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure
  );
  anchor text := 'AND lease.instance_id IS NULL';
BEGIN
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'unexpected global reaper create-reset definition';
  END IF;
  EXECUTE replace(definition, anchor, anchor || E'\n        AND (lease.provider_create_attempt IS NULL OR lease.provider_create_attempt->>''instanceId'' IS NOT NULL)');
END;
$patch_reaper$;

-- Reuse the narrowly-scoped owner SELECT capability installed by 0497. This
-- inventory cannot change leases; receipt attribution still uses tenant RLS.
DO $create_inventory$
DECLARE data_schema text := pg_catalog.current_schema(); role_name text;
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.list_pending_modal_provider_creates()
    RETURNS TABLE (workspace_id uuid, sandbox_group_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE opened integer;
    BEGIN
      INSERT INTO opengeni_private.modal_inventory_read_capabilities
        (backend_pid, transaction_id, data_schema)
      VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %2$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;
      RETURN QUERY SELECT lease.workspace_id, lease.sandbox_group_id
        FROM %1$I.sandbox_leases lease
        WHERE lease.backend = 'modal' AND lease.liveness = 'warming'
          AND lease.instance_id IS NULL
          AND lease.provider_create_attempt->'instanceId' = 'null'::jsonb
          AND lease.expires_at < now()
          AND coalesce(lease.provider_create_recovery_after, '-infinity'::timestamptz) <= now()
        ORDER BY coalesce(lease.provider_create_recovery_after, '-infinity'::timestamptz), lease.id LIMIT 32;
      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %2$L;
      END IF;
    END
    $body$;
  $ddl$, data_schema, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_pending_modal_provider_creates() FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT role.rolname FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE proc.oid = 'opengeni_private.list_pending_modal_provider_creates()'::regprocedure
      AND acl.grantee <> proc.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION opengeni_private.list_pending_modal_provider_creates() FROM %I', role_name);
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
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.list_pending_modal_provider_creates() TO %I', role_name);
  END LOOP;
END;
$create_inventory$;
