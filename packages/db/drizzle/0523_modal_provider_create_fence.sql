-- deployment-mode: rolling
-- A missing create reply is not evidence that no provider was created. Keep
-- this receipt outside resume_state, which archive/rollback code may replace.
ALTER TABLE sandbox_leases ADD COLUMN provider_create_attempt jsonb;

ALTER TABLE sandbox_leases ADD CONSTRAINT sandbox_provider_create_attempt_shape CHECK (
  provider_create_attempt IS NULL OR (
    jsonb_typeof(provider_create_attempt) = 'object'
    AND provider_create_attempt->>'version' = '1'
    AND length(provider_create_attempt->>'operationId') > 0
    AND length(provider_create_attempt->>'providerBindingKey') > 0
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
