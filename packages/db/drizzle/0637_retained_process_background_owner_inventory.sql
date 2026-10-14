-- deployment-mode: rolling
-- A retained process durably adopted as a session background command is owned
-- by its session, not by the turn that launched it: normal turn completion and
-- Steer detach it without cancellation. The inventory previously classified
-- such a process by its launch turn's status, so every healthy adopted command
-- (a dev server, a tunnel) reported as a terminal-owner backlog the moment its
-- turn completed. Classify it exactly as claim_terminal_retained_processes
-- already does: background_running is session-owned live work, while
-- background_stopping remains a backlog because Pause/Cancel already asked the
-- exact process to stop. Read-only SECURITY DEFINER inventory; no table, row,
-- grant, or ownership change, so old and new workers coexist.

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.count_active_retained_processes_by_owner_state()
    RETURNS TABLE (owner_state text, active_count bigint, terminal_owner_count bigint)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT inventory.owner_state,
        pg_catalog.count(*)::bigint AS active_count,
        pg_catalog.count(*) FILTER (WHERE inventory.terminal_owner)::bigint
          AS terminal_owner_count
      FROM (
        SELECT CASE
            WHEN command.state = 'stopping' THEN 'background_stopping'
            WHEN command.state = 'running' THEN 'background_running'
            WHEN process.owner_actor_kind = 'direct' THEN 'direct'
            ELSE COALESCE(turn_row.status, 'missing')
          END AS owner_state,
          CASE
            WHEN command.state = 'stopping' THEN true
            WHEN command.state = 'running' THEN false
            WHEN process.owner_actor_kind = 'direct' THEN NOT EXISTS (
              SELECT 1
              FROM %1$I.sandbox_workspace_mutation_admissions admission
              JOIN %1$I.sandbox_lease_holders holder
                ON holder.lease_id = admission.lease_id
               AND holder.account_id = admission.account_id
               AND holder.workspace_id = admission.workspace_id
               AND holder.kind = 'direct'
               AND holder.holder_id = admission.holder_id
               AND holder.subject_id = admission.session_id
              WHERE admission.id = process.parent_admission_id
                AND admission.actor_kind = 'direct'
            )
            ELSE attempt.state = 'closed'
          END AS terminal_owner
        FROM %1$I.sandbox_retained_processes process
        LEFT JOIN %1$I.session_background_commands command
          ON command.retained_process_id = process.id
         AND command.state IN ('running', 'stopping')
        LEFT JOIN LATERAL (
          SELECT source_turn.status
          FROM %1$I.session_turns source_turn
          WHERE source_turn.workspace_id = process.workspace_id
            AND source_turn.id = process.owner_turn_id
          LIMIT 1
        ) turn_row ON true
        LEFT JOIN LATERAL (
          SELECT source_attempt.state
          FROM %1$I.session_turn_attempts source_attempt
          WHERE source_attempt.workspace_id = process.workspace_id
            AND source_attempt.id = process.owner_attempt_id
          LIMIT 1
        ) attempt ON true
        WHERE process.state = 'active'
          AND process.owner_actor_kind IN ('direct', 'turn')
      ) inventory
      GROUP BY inventory.owner_state;
    $function$;
  $create$, data_schema);
END $privileged_functions$;
