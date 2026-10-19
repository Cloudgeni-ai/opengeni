-- deployment-mode: rolling
-- A compute sandbox's finished command output is released only while the
-- sandbox is awake.
--
-- Releasing a background command's captured output takes two passes of the
-- maintenance reconciler: the first attaches to the op and sends its final
-- ACK, and a later one observes that the agent no longer keeps the op. Both
-- send the agent a request, and a request wakes a sleeping compute sandbox.
-- The agent forgets an acknowledged op at its next housekeeping pass, which
-- runs on the agent's own clock, and that clock stands still while the
-- sandbox sleeps. So a sandbox that fell asleep between the two passes was
-- woken by every pass, for about a second each time, and the release never
-- completed.
--
-- So a live sandbox-kind runner is eligible for output release only while
-- its lease does not record the sandbox asleep (compute_asleep_since, set
-- and cleared from the host's reports through the agent gateway). The work
-- waits, untouched, until something else wakes the sandbox, and completes on
-- a later pass while it is awake. A retired runner (enrollment revoked,
-- connection replaced, or gone offline for good) stays eligible whether or
-- not its sandbox sleeps: its settlement reaches no agent. Connected
-- Machines are unchanged. Both the due probe and the claim use this one
-- helper, so the probe stays a superset of the claim.
--
-- The previous release reads only the helper's result, so it is unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $migration$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.connected_output_runner_eligible_v1(
      p_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text
    ) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.enrollments enrollment
        WHERE enrollment.workspace_id = p_workspace_id
          AND enrollment.id = p_enrollment_id
          AND (
            enrollment.status = 'revoked'
            OR (enrollment.connection_instance_id IS NOT NULL
              AND enrollment.connection_instance_id <> p_connection_instance_id)
            OR (enrollment.connection_instance_id IS NULL
              AND enrollment.went_offline_reason IN (
                'GOING_OFFLINE_REASON_USER_STOP',
                'GOING_OFFLINE_REASON_UPDATE',
                'GOING_OFFLINE_REASON_HOST_SHUTDOWN'))
            OR (enrollment.status = 'active'
              AND enrollment.connection_instance_id = p_connection_instance_id
              AND enrollment.connection_lease_expires_at > now()
              AND enrollment.went_offline_at IS NULL
              AND NOT (enrollment.kind = 'sandbox' AND EXISTS (
                SELECT 1 FROM %1$I.sandbox_leases lease
                WHERE lease.workspace_id = enrollment.workspace_id
                  AND lease.sandbox_group_id = enrollment.sandbox_group_id
                  AND lease.backend = 'compute'
                  AND lease.compute_asleep_since IS NOT NULL)))
          )
      )
    $body$;
  $create$, data_schema);
END
$migration$;

REVOKE ALL ON FUNCTION opengeni_private.connected_output_runner_eligible_v1(uuid, uuid, text) FROM PUBLIC;
