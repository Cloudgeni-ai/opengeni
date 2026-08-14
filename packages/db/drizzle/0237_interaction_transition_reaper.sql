-- deployment-mode: maintenance
-- Settle controller transitions whose API owner disappeared after dispatch.
-- Active Browser/Computer sessions are deliberately excluded: their durable
-- placement must survive a hidden UI, a closed laptop, and long human login.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $transition_reaper$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.reap_stale_interaction_transitions(
      p_interaction_holder_ttl_ms bigint
    )
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      stale_operation_ids uuid[] := ARRAY[]::uuid[];
      stale_browser_ids uuid[] := ARRAY[]::uuid[];
      stale_computer_ids uuid[] := ARRAY[]::uuid[];
      changed_workspace_ids uuid[] := ARRAY[]::uuid[];
      orphan_workspace_ids uuid[] := ARRAY[]::uuid[];
      affected_lease_ids uuid[] := ARRAY[]::uuid[];
      settled_count integer := 0;
    BEGIN
      IF p_interaction_holder_ttl_ms <= 0 THEN
        RETURN 0;
      END IF;

      -- The exact lifecycle operation is the request-owner heartbeat. Long
      -- controller calls pulse updated_at; a stale dispatched operation means
      -- the caller vanished. Prepared operations cannot have a physical side
      -- effect yet and remain replayable, so they are intentionally excluded.
      SELECT coalesce(pg_catalog.array_agg(candidate.operation_id), ARRAY[]::uuid[])
      INTO stale_operation_ids
      FROM (
        SELECT operation.operation_id
        FROM %1$I.interaction_operations operation
        WHERE operation.state = 'dispatched'
          AND operation.updated_at
            < pg_catalog.now()
              - pg_catalog.make_interval(
                  secs => p_interaction_holder_ttl_ms / 1000.0
                )
          AND (
            EXISTS (
              SELECT 1
              FROM %1$I.browser_sessions browser
              WHERE operation.resource_kind = 'browser_session'
                AND operation.account_id = browser.account_id
                AND operation.workspace_id = browser.workspace_id
                AND operation.resource_id = browser.id
                AND browser.lifecycle IN (
                  'starting', 'suspending', 'restoring', 'ending'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM %1$I.computer_sessions computer
              WHERE operation.resource_kind = 'computer_session'
                AND operation.account_id = computer.account_id
                AND operation.workspace_id = computer.workspace_id
                AND operation.resource_id = computer.id
                AND computer.lifecycle IN ('starting', 'ending')
            )
          )
        ORDER BY operation.updated_at, operation.operation_id
        LIMIT 500
        FOR UPDATE OF operation SKIP LOCKED
      ) candidate;

      SELECT coalesce(
               pg_catalog.array_agg(operation.resource_id)
                 FILTER (WHERE operation.resource_kind = 'browser_session'),
               ARRAY[]::uuid[]
             ),
             coalesce(
               pg_catalog.array_agg(operation.resource_id)
                 FILTER (WHERE operation.resource_kind = 'computer_session'),
               ARRAY[]::uuid[]
             ),
             coalesce(
               pg_catalog.array_agg(DISTINCT operation.workspace_id),
               ARRAY[]::uuid[]
             )
      INTO stale_browser_ids, stale_computer_ids, changed_workspace_ids
      FROM %1$I.interaction_operations operation
      WHERE operation.operation_id = ANY(stale_operation_ids);

      -- Lock every affected lease before its holder, matching lease acquire,
      -- release and the ordinary global reaper. Connected-machine transitions
      -- have no lease and still settle through the same operation contract.
      SELECT coalesce(pg_catalog.array_agg(DISTINCT holder.lease_id), ARRAY[]::uuid[])
      INTO affected_lease_ids
      FROM %1$I.sandbox_lease_holders holder
      WHERE holder.kind = 'interaction'
        AND (
          holder.holder_id IN (
            SELECT 'browser-session:' || id::text
            FROM pg_catalog.unnest(stale_browser_ids) ids(id)
          )
          OR holder.holder_id IN (
            SELECT 'computer-session:' || id::text
            FROM pg_catalog.unnest(stale_computer_ids) ids(id)
          )
        );

      PERFORM lease.id
      FROM %1$I.sandbox_leases lease
      WHERE lease.id = ANY(affected_lease_ids)
      ORDER BY lease.id
      FOR UPDATE OF lease;

      PERFORM holder.id
      FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = ANY(affected_lease_ids)
        AND holder.kind = 'interaction'
        AND (
          holder.holder_id IN (
            SELECT 'browser-session:' || id::text
            FROM pg_catalog.unnest(stale_browser_ids) ids(id)
          )
          OR holder.holder_id IN (
            SELECT 'computer-session:' || id::text
            FROM pg_catalog.unnest(stale_computer_ids) ids(id)
          )
        )
      ORDER BY holder.id
      FOR UPDATE OF holder;

      UPDATE %1$I.interaction_operations operation
      SET state = 'outcome_unknown',
          error_code = 'controller_transition_expired',
          error_message = 'Interaction controller transition heartbeat expired',
          error_retryable = false,
          error_details = pg_catalog.jsonb_build_object(
            'reason', 'transition_heartbeat_expired'
          ),
          settled_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      WHERE operation.operation_id = ANY(stale_operation_ids)
        AND operation.state = 'dispatched';
      GET DIAGNOSTICS settled_count = ROW_COUNT;

      -- Outcome is unknown: retain the exact controller binding so a subsequent
      -- end/cleanup can target the same generation. The lease holder is released
      -- below; provider drain remains the final physical cleanup fence.
      UPDATE %1$I.browser_sessions browser
      SET lifecycle = 'lost',
          failure_code = 'controller_transition_expired',
          updated_at = pg_catalog.now()
      WHERE browser.id = ANY(stale_browser_ids)
        AND browser.lifecycle IN (
          'starting', 'suspending', 'restoring', 'ending'
        );

      UPDATE %1$I.computer_sessions computer
      SET lifecycle = 'lost',
          failure_code = 'controller_transition_expired',
          updated_at = pg_catalog.now()
      WHERE computer.id = ANY(stale_computer_ids)
        AND computer.lifecycle IN ('starting', 'ending');

      -- Terminal/mismatched interaction holders are lifecycle orphans. Include
      -- the transitions settled above plus missed best-effort releases after a
      -- successful suspend/end/failure. Active controllers remain immortal.
      SELECT coalesce(pg_catalog.array_agg(DISTINCT holder.lease_id), ARRAY[]::uuid[]),
             coalesce(pg_catalog.array_agg(DISTINCT holder.workspace_id), ARRAY[]::uuid[])
      INTO affected_lease_ids, orphan_workspace_ids
      FROM %1$I.sandbox_lease_holders holder
      JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
      WHERE holder.kind = 'interaction'
        AND NOT (
          EXISTS (
            SELECT 1
            FROM %1$I.browser_sessions browser
            WHERE holder.holder_id = ('browser-session:' || browser.id::text)
              AND holder.account_id = browser.account_id
              AND holder.workspace_id = browser.workspace_id
              AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
              AND browser.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
          )
          OR EXISTS (
            SELECT 1
            FROM %1$I.computer_sessions computer
            WHERE holder.holder_id = ('computer-session:' || computer.id::text)
              AND holder.account_id = computer.account_id
              AND holder.workspace_id = computer.workspace_id
              AND computer.sandbox_group_id = lease.sandbox_group_id
              AND computer.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
          )
        );

      PERFORM lease.id
      FROM %1$I.sandbox_leases lease
      WHERE lease.id = ANY(affected_lease_ids)
      ORDER BY lease.id
      FOR UPDATE OF lease;

      DELETE FROM %1$I.sandbox_lease_holders holder
      USING %1$I.sandbox_leases lease
      WHERE holder.lease_id = lease.id
        AND holder.lease_id = ANY(affected_lease_ids)
        AND holder.kind = 'interaction'
        AND NOT (
          EXISTS (
            SELECT 1
            FROM %1$I.browser_sessions browser
            WHERE holder.holder_id = ('browser-session:' || browser.id::text)
              AND holder.account_id = browser.account_id
              AND holder.workspace_id = browser.workspace_id
              AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
              AND browser.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
          )
          OR EXISTS (
            SELECT 1
            FROM %1$I.computer_sessions computer
            WHERE holder.holder_id = ('computer-session:' || computer.id::text)
              AND holder.account_id = computer.account_id
              AND holder.workspace_id = computer.workspace_id
              AND computer.sandbox_group_id = lease.sandbox_group_id
              AND computer.lifecycle IN (
                'starting', 'active', 'suspending', 'restoring', 'ending'
              )
          )
        );

      UPDATE %1$I.workspace_interaction_revisions revision
      SET revision = revision.revision + 1,
          updated_at = pg_catalog.now()
      WHERE revision.workspace_id = ANY(changed_workspace_ids || orphan_workspace_ids);

      RETURN settled_count;
    END;
    $function$;
  $create$, data_schema);
END
$transition_reaper$;

REVOKE ALL ON FUNCTION opengeni_private.reap_stale_interaction_transitions(bigint)
  FROM PUBLIC;

DO $reaper_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.reap_stale_interaction_transitions(bigint)
      TO opengeni_app;
  END IF;
END
$reaper_grant$;

RESET statement_timeout;
RESET lock_timeout;
