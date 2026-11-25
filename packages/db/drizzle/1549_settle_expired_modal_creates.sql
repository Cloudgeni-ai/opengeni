-- deployment-mode: rolling
-- An unresolved Modal create (its reply was lost, so no instance id was ever
-- recorded) fences its lease until an exact provider receipt attributes it.
-- When no receipt ever appears, that fence never lifts and the chat waits
-- forever. Modal ends every sandbox within its maximum lifetime of 24 hours,
-- so once the attempt started more than 25 hours ago nothing it created can
-- still be running. This keeps 0977's guard and adds exactly one transition:
-- clearing such an expired attempt while every other lease column stays as it
-- was. The ordinary expired-warming reset then moves the lease to cold with a
-- new epoch, keeping its archive, and the next turn creates a fresh box.
--
-- Same signature, so the trigger and grants are kept.
-- Rolling: the previous release never clears an attempt, so it is unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.guard_unresolved_provider_create() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
BEGIN
  IF OLD.provider_create_attempt IS NOT NULL
     AND OLD.provider_create_attempt->'instanceId' = 'null'::jsonb THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'provider_create_outcome_unknown: cannot delete unresolved lease';
    END IF;
    -- Settlement by the provider's maximum sandbox lifetime (see header).
    -- Nested so startedAt is only read when the attempt is being cleared.
    IF NEW.provider_create_attempt IS NULL AND OLD.backend = 'modal' THEN
      IF (OLD.provider_create_attempt->>'startedAt')::timestamptz <= now() - interval '25 hours'
         AND NEW.lease_epoch IS NOT DISTINCT FROM OLD.lease_epoch
         AND NEW.backend IS NOT DISTINCT FROM OLD.backend
         AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
         AND NEW.sandbox_group_id IS NOT DISTINCT FROM OLD.sandbox_group_id
         AND NEW.current_checkpoint_artifact_id IS NOT DISTINCT FROM OLD.current_checkpoint_artifact_id
         AND NEW.previous_checkpoint_artifact_id IS NOT DISTINCT FROM OLD.previous_checkpoint_artifact_id
         AND NEW.workspace_generation IS NOT DISTINCT FROM OLD.workspace_generation
         AND NEW.archive_generation IS NOT DISTINCT FROM OLD.archive_generation
         AND NEW.liveness IS NOT DISTINCT FROM OLD.liveness
         AND NEW.resume_state IS NOT DISTINCT FROM OLD.resume_state
         AND NEW.instance_id IS NULL THEN
        RETURN NEW;
      END IF;
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
