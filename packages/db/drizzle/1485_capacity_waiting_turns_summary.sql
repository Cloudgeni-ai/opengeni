-- deployment-mode: rolling
-- How many turns are parked waiting for subscription capacity right now, by
-- provider, with the age of the oldest wait.
--
-- A turn that hits a provider's usage limit (or finds no eligible account)
-- parks on its session's row in subscription_capacity_waiters: the turn and
-- the session become `waiting_capacity`, the attempt closes with outcome
-- `waiting_capacity`, and nothing runs until capacity returns. That parked
-- turn is the session's active turn, never a `queued` one, so
-- opengeni_turns_queued_by_hold{hold="waiting_capacity"} (0988) does not
-- count it: that class counts only further prompts queued behind it. A
-- deployment can therefore have turns parked for hours with that gauge at 0.
--
-- opengeni_private.summarize_capacity_waiting_turns_v1() returns one row per
-- waiter provider (always all three, so an emptied provider reads 0): the
-- number of live waits (the waiter still names the session's active turn,
-- and both the session and that turn are `waiting_capacity`; a row a Steer
-- or Cancel left behind for the reconcile to supersede is not a wait) and
-- how long ago the oldest of them parked. A wait parked when its attempt
-- closed with outcome `waiting_capacity`; a resumption that lands straight
-- back on missing capacity parks again and starts a new wait. Counts and
-- ages only, nothing that names a tenant.
--
-- The waiters table gains the read-only owner inventory policy sessions and
-- turns already have, so the owner-run summary sees waiter rows in every
-- workspace inside that transaction-scoped window (as 0982 did for credit
-- allocations).
--
-- As 0937, 0978, 1060 and 1404 explain, the previous release rejects a
-- runtime EXECUTE grant on a definer it doesn't know, so this migration
-- grants nothing. Until a later migration grants it the control worker does
-- not publish the gauge.
--
-- Rolling: one owner-only read policy no runtime query can satisfy, and one
-- definer the previous release never calls. The definer only reads; its one
-- write is the transaction's own inventory capability row.
SET LOCAL lock_timeout = '5s';

-- Sessions, turns and attempts already admit their owner inside the session
-- inventory window (session_tenancy_fence_inventory_read). Waiter rows were
-- readable only in their own organization's context; the same read-only
-- owner policy lets the summary below see them, and nothing else changes.
DO $capacity_waiters_inventory$
DECLARE
  data_schema text := current_schema();
  owner_name text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_catalog.pg_class
    WHERE oid = pg_catalog.format('%I.subscription_capacity_waiters', data_schema)::regclass;
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_tenancy_fence_inventory_read ON %1$I.subscription_capacity_waiters '
    'FOR SELECT USING (%1$I.session_tenancy_fence_owner_policy_active('
    '(CURRENT_USER)::text, %2$L::text, %3$s::oid, workspace_id, true))',
    data_schema, owner_name, data_schema::regnamespace::oid);
END
$capacity_waiters_inventory$;

DO $capacity_waiting_turns$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.summarize_capacity_waiting_turns_v1()
    RETURNS TABLE(provider text, count bigint, oldest_age_seconds double precision)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      -- Sessions and turns are row-secured even for their owner; the
      -- inventory window admits this cross-workspace count, as in 1002.
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH providers(provider) AS (
        VALUES ('codex'::text), ('claude'::text), ('xai'::text)
      ), waits AS (
        SELECT
          waiter.provider,
          COALESCE(
            (
              SELECT pg_catalog.max(attempt.closed_at)
              FROM %1$I.session_turn_attempts attempt
              WHERE attempt.workspace_id = waiter.workspace_id
                AND attempt.session_id = waiter.session_id
                AND attempt.turn_id = waiter.turn_id
                AND attempt.outcome = 'waiting_capacity'
            ),
            waiter.updated_at
          ) AS parked_at
        FROM %1$I.subscription_capacity_waiters waiter
        JOIN %1$I.sessions chat
          ON chat.workspace_id = waiter.workspace_id
         AND chat.id = waiter.session_id
         AND chat.active_turn_id = waiter.turn_id
         AND chat.status = 'waiting_capacity'
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = waiter.workspace_id
         AND turn.id = waiter.turn_id
         AND turn.status = 'waiting_capacity'
      )
      SELECT
        providers.provider,
        pg_catalog.count(waits.provider)::bigint,
        COALESCE(
          GREATEST(0, EXTRACT(EPOCH FROM (pg_catalog.now() - pg_catalog.min(waits.parked_at)))),
          0
        )::double precision
      FROM providers
      LEFT JOIN waits ON waits.provider = providers.provider
      GROUP BY providers.provider
      ORDER BY providers.provider;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$
  $definition$, data_schema);
END
$capacity_waiting_turns$;

REVOKE ALL ON FUNCTION opengeni_private.summarize_capacity_waiting_turns_v1() FROM PUBLIC;
