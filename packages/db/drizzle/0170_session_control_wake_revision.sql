-- deployment-mode: rolling
-- Preserve control-priority Temporal signals across coalesced session wakes.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "session_workflow_wake_outbox"
  ADD COLUMN "control_revision" bigint NOT NULL DEFAULT 0;

ALTER TABLE "session_workflow_wake_outbox"
  ADD CONSTRAINT "session_workflow_wake_outbox_control_revision_check"
  CHECK (
    "control_revision" >= 0
    AND "control_revision" <= "wake_revision"
    AND "control_revision" <= 9007199254740991
  ) NOT VALID;

-- Mixed-version writers do not know the new column. Stamp recognized control
-- reasons in the database so an old Steer followed by an old Send still leaves
-- the earlier control revision outstanding until delivery.
CREATE OR REPLACE FUNCTION opengeni_private.stamp_session_workflow_control_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.reason IN (
    'prompt_steer',
    'queue_steer',
    'agent_steer',
    'session_cancelled',
    'session_pause_interruption',
    'workspace_pause_interruption',
    'attempt_interruption_settled',
    'attempt_interruption_rejected_stale'
  ) AND NEW.wake_revision > NEW.delivered_revision THEN
    NEW.control_revision := greatest(NEW.control_revision, NEW.wake_revision);
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS session_workflow_wake_control_revision
  ON "session_workflow_wake_outbox";
CREATE TRIGGER session_workflow_wake_control_revision
BEFORE INSERT OR UPDATE OF reason, wake_revision, control_revision
ON "session_workflow_wake_outbox"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.stamp_session_workflow_control_revision();

-- Preserve already-committed ownerless Steer/cancellation wakes during rolling
-- activation. Active-attempt controls remain independently discoverable from
-- the interruption ledger below.
UPDATE "session_workflow_wake_outbox"
SET "control_revision" = "wake_revision"
WHERE "delivered_revision" < "wake_revision"
  AND "reason" IN (
    'prompt_steer',
    'queue_steer',
    'agent_steer',
    'session_cancelled',
    'session_pause_interruption',
    'workspace_pause_interruption'
  );

ALTER TABLE "session_workflow_wake_outbox"
  VALIDATE CONSTRAINT "session_workflow_wake_outbox_control_revision_check";

DROP FUNCTION opengeni_private.claim_session_workflow_wakes(integer);
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      wake_revision bigint,
      interruption_requested boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RETURN QUERY
        WITH due AS (
          SELECT o.session_id
          FROM %1$I.session_workflow_wake_outbox o
          WHERE o.wake_revision > o.delivered_revision
            AND o.next_attempt_at <= now()
          ORDER BY o.next_attempt_at, o.updated_at, o.session_id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
        )
        UPDATE %1$I.session_workflow_wake_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(o.attempts, 8))::integer))
            ),
            updated_at = now()
        FROM due
        WHERE o.session_id = due.session_id
        RETURNING o.account_id, o.workspace_id, o.session_id,
          o.temporal_workflow_id, o.wake_revision,
          o.control_revision > o.delivered_revision
          OR EXISTS (
            SELECT 1
            FROM %1$I.session_attempt_interruptions interruption
            WHERE interruption.workspace_id = o.workspace_id
              AND interruption.session_id = o.session_id
              AND interruption.state IN (
                'pending', 'delivered', 'acknowledged', 'settled', 'rejected_stale'
              )
          ) AS interruption_requested;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer)
      TO opengeni_app;
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;
