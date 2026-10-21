-- deployment-mode: rolling
-- A browser or desktop whose sandbox instance is gone no longer keeps the
-- sandbox warm.
--
-- A browser or desktop controller runs inside one exact provider instance and
-- is bound to it (placement_instance_id). Its interaction holder pins the
-- sandbox lease. When the lease stops running that instance (the provider
-- reported it missing, a drain or rotation retired it, or a replacement was
-- created) the controller died with it: it can no longer heartbeat, act or be
-- ended there, and nothing ever rebinds it to a successor. The interaction
-- reaper only released holders of resources that had already ended, so such a
-- resource stayed `active` forever and its holder kept every later instance of
-- the sandbox warm, never idle-drained.
--
-- The reaper now closes a live browser or desktop whose lease no longer runs
-- its bound instance before the orphan sweep: prepared operations fail (they
-- had no provider effect), dispatched ones settle as outcome unknown, the
-- resource becomes `lost` with failure code `placement_instance_lost`, and its
-- now-meaningless controller binding is cleared. The orphan sweep in the same
-- transaction then deletes its holder and reap_sandbox_leases() recomputes the
-- refcount, so the lease drains by the ordinary idle rule. Resources still
-- bound to the lease's current instance, or not yet bound to any instance
-- (a create that has not activated), are untouched.
--
-- Expand only: the signature, ownership and grants are unchanged, and the
-- previous release keeps working with the patched routine.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $retired_instance_interactions$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  );
  declare_anchor text := E'      fenced_access_capability_id uuid;\n';
  declare_replacement text := E'      fenced_access_capability_id uuid;\n'
    || E'      retired_lease_ids uuid[] := ARRAY[]::uuid[];\n'
    || E'      retired_holder_ids uuid[] := ARRAY[]::uuid[];\n'
    || E'      retired_browser_ids uuid[] := ARRAY[]::uuid[];\n'
    || E'      retired_computer_ids uuid[] := ARRAY[]::uuid[];\n'
    || E'      retired_settled_count integer := 0;\n';
  phase_anchor text :=
    E'      -- Terminal/mismatched interaction holders are lifecycle orphans.';
  phase_replacement text;
BEGIN
  IF strpos(definition, '0883 retired placement instance') > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, declare_anchor, '')))
      / length(declare_anchor) <> 1
    OR (length(definition) - length(replace(definition, phase_anchor, '')))
      / length(phase_anchor) <> 1 THEN
    RAISE EXCEPTION '0883 retired instance interactions prerequisite drift'
      USING ERRCODE = '55000';
  END IF;

  phase_replacement := format($phase$      -- 0883 retired placement instance: a live browser or desktop is bound
      -- to the exact provider instance its controller runs in. Once its lease
      -- no longer runs that instance the controller is gone and can never
      -- heartbeat, act or end there, so it would pin every later instance of
      -- the sandbox warm. Close it here; the orphan phase below then releases
      -- its holder. Lock order: lease, holder, operation, resource.
      SELECT coalesce(pg_catalog.array_agg(candidate.id), ARRAY[]::uuid[])
      INTO retired_lease_ids
      FROM (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.id IN (
          SELECT holder.lease_id
          FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases bound_lease ON bound_lease.id = holder.lease_id
          WHERE holder.kind = 'interaction'
            AND (
              EXISTS (
                SELECT 1 FROM %1$I.browser_sessions browser
                WHERE holder.holder_id = ('browser-session:' || browser.id::text)
                  AND holder.account_id = browser.account_id
                  AND holder.workspace_id = browser.workspace_id
                  AND browser.controller_host_sandbox_group_id = bound_lease.sandbox_group_id
                  AND browser.lifecycle IN (
                    'starting', 'active', 'suspending', 'restoring', 'ending'
                  )
                  AND browser.placement_instance_id IS NOT NULL
                  AND browser.placement_instance_id IS DISTINCT FROM bound_lease.instance_id
              )
              OR EXISTS (
                SELECT 1 FROM %1$I.computer_sessions computer
                WHERE holder.holder_id = ('computer-session:' || computer.id::text)
                  AND holder.account_id = computer.account_id
                  AND holder.workspace_id = computer.workspace_id
                  AND computer.sandbox_group_id = bound_lease.sandbox_group_id
                  AND computer.lifecycle IN (
                    'starting', 'active', 'suspending', 'restoring', 'ending'
                  )
                  AND computer.placement_instance_id IS NOT NULL
                  AND computer.placement_instance_id IS DISTINCT FROM bound_lease.instance_id
              )
            )
        )
        ORDER BY lease.id
        LIMIT 500
        FOR UPDATE OF lease SKIP LOCKED
      ) candidate;

      SELECT coalesce(pg_catalog.array_agg(candidate.id), ARRAY[]::uuid[])
      INTO retired_holder_ids
      FROM (
        SELECT holder.id
        FROM %1$I.sandbox_lease_holders holder
        WHERE holder.lease_id = ANY(retired_lease_ids)
          AND holder.kind = 'interaction'
        ORDER BY holder.id
        LIMIT 500
        FOR UPDATE OF holder SKIP LOCKED
      ) candidate;

      -- Leases and holders are locked, so the instance each resource is
      -- compared with can no longer change under this decision.
      SELECT
        coalesce(
          pg_catalog.array_agg(DISTINCT browser.id)
            FILTER (WHERE browser.id IS NOT NULL),
          ARRAY[]::uuid[]
        ),
        coalesce(
          pg_catalog.array_agg(DISTINCT computer.id)
            FILTER (WHERE computer.id IS NOT NULL),
          ARRAY[]::uuid[]
        )
      INTO retired_browser_ids, retired_computer_ids
      FROM %1$I.sandbox_lease_holders holder
      JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
      LEFT JOIN %1$I.browser_sessions browser
        ON holder.holder_id = ('browser-session:' || browser.id::text)
        AND holder.account_id = browser.account_id
        AND holder.workspace_id = browser.workspace_id
        AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
        AND browser.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND browser.placement_instance_id IS NOT NULL
        AND browser.placement_instance_id IS DISTINCT FROM lease.instance_id
      LEFT JOIN %1$I.computer_sessions computer
        ON holder.holder_id = ('computer-session:' || computer.id::text)
        AND holder.account_id = computer.account_id
        AND holder.workspace_id = computer.workspace_id
        AND computer.sandbox_group_id = lease.sandbox_group_id
        AND computer.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND computer.placement_instance_id IS NOT NULL
        AND computer.placement_instance_id IS DISTINCT FROM lease.instance_id
      WHERE holder.id = ANY(retired_holder_ids);

      PERFORM operation.operation_id
      FROM %1$I.interaction_operations operation
      WHERE (
          (
            operation.resource_kind = 'browser_session'
            AND operation.resource_id = ANY(retired_browser_ids)
          ) OR (
            operation.resource_kind = 'computer_session'
            AND operation.resource_id = ANY(retired_computer_ids)
          )
        )
        AND operation.state IN ('prepared', 'dispatched')
      ORDER BY operation.operation_id
      FOR UPDATE OF operation;

      PERFORM browser.id
      FROM %1$I.browser_sessions browser
      WHERE browser.id = ANY(retired_browser_ids)
      ORDER BY browser.id
      FOR UPDATE OF browser;

      PERFORM computer.id
      FROM %1$I.computer_sessions computer
      WHERE computer.id = ANY(retired_computer_ids)
      ORDER BY computer.id
      FOR UPDATE OF computer;

      -- Re-read under the resource locks: a resource that was ended, or
      -- rebound, meanwhile drops out.
      SELECT coalesce(pg_catalog.array_agg(browser.id), ARRAY[]::uuid[])
      INTO retired_browser_ids
      FROM %1$I.browser_sessions browser
      WHERE browser.id = ANY(retired_browser_ids)
        AND browser.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND browser.placement_instance_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
          WHERE holder.id = ANY(retired_holder_ids)
            AND holder.holder_id = ('browser-session:' || browser.id::text)
            AND holder.account_id = browser.account_id
            AND holder.workspace_id = browser.workspace_id
            AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
            AND browser.placement_instance_id IS DISTINCT FROM lease.instance_id
        );

      SELECT coalesce(pg_catalog.array_agg(computer.id), ARRAY[]::uuid[])
      INTO retired_computer_ids
      FROM %1$I.computer_sessions computer
      WHERE computer.id = ANY(retired_computer_ids)
        AND computer.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND computer.placement_instance_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
          WHERE holder.id = ANY(retired_holder_ids)
            AND holder.holder_id = ('computer-session:' || computer.id::text)
            AND holder.account_id = computer.account_id
            AND holder.workspace_id = computer.workspace_id
            AND computer.sandbox_group_id = lease.sandbox_group_id
            AND computer.placement_instance_id IS DISTINCT FROM lease.instance_id
        );

      -- No operation can complete on an instance that no longer exists.
      -- Prepared operations had no provider effect and fail; dispatched ones
      -- keep honest uncertainty.
      UPDATE %1$I.interaction_operations operation
      SET state = CASE
            WHEN operation.state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'failed'
          END,
          error_code = CASE
            WHEN operation.state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'controller_lost'
          END,
          error_message = 'Interaction controller sandbox instance was retired',
          error_retryable = false,
          error_details = pg_catalog.jsonb_build_object(
            'reason', 'placement_instance_retired'
          ),
          settled_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      WHERE (
          (
            operation.resource_kind = 'browser_session'
            AND operation.resource_id = ANY(retired_browser_ids)
          ) OR (
            operation.resource_kind = 'computer_session'
            AND operation.resource_id = ANY(retired_computer_ids)
          )
        )
        AND operation.state IN ('prepared', 'dispatched');
      GET DIAGNOSTICS retired_settled_count = ROW_COUNT;
      settled_count := settled_count + retired_settled_count;

      UPDATE %1$I.browser_sessions browser
      SET lifecycle = 'lost',
          failure_code = 'placement_instance_lost',
          controller_id = NULL,
          controller_generation = NULL,
          placement_instance_id = NULL,
          controller_heartbeat_at = NULL,
          updated_at = pg_catalog.now()
      WHERE browser.id = ANY(retired_browser_ids);

      UPDATE %1$I.computer_sessions computer
      SET lifecycle = 'lost',
          failure_code = 'placement_instance_lost',
          controller_id = NULL,
          controller_generation = NULL,
          placement_instance_id = NULL,
          controller_heartbeat_at = NULL,
          updated_at = pg_catalog.now()
      WHERE computer.id = ANY(retired_computer_ids);

      -- Terminal/mismatched interaction holders are lifecycle orphans.$phase$, current_schema());

  definition := replace(definition, declare_anchor, declare_replacement);
  definition := replace(definition, phase_anchor, phase_replacement);
  EXECUTE definition;
END;
$retired_instance_interactions$;
