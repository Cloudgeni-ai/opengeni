-- deployment-mode: rolling
-- Repair the post-0388 provider-deadline interaction lifecycle without
-- widening ordinary interaction expiry or weakening the session-tenancy fence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The TTL-aware fence inventory below must discover due lease-free controller
-- transitions before the SECURITY DEFINER reaper opens its fenced owner scope.
-- Keep this as inventory-only SELECT authority; the 0388 fenced owner policies
-- remain the sole mutation path after every workspace advisory lock is held.
DO $interaction_reaper_inventory_policies$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'browser_sessions',
    'computer_sessions',
    'interaction_operations'
  ] LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS session_tenancy_fence_inventory_read ON %I.%I',
      target_schema,
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fence_inventory_read ON %I.%I '
        || 'FOR SELECT USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user::text, %L::text, %s::oid, workspace_id, true))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;
END
$interaction_reaper_inventory_policies$;

-- The no-argument helper remains installed for reap_sandbox_leases() and old
-- in-flight callers. The interaction reaper uses this overload so its bounded
-- stale-operation batch can also see lease-free Connected Machine and attached-
-- device workspaces. Because SKIP LOCKED can advance beyond any preselected
-- operation row, fence every currently due workspace, but no healthy lease-free
-- interaction workspace, in canonical UUID order before taking row locks.
CREATE OR REPLACE FUNCTION acquire_sandbox_reaper_session_tenancy_fences(
  p_interaction_holder_ttl_ms bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $interaction_reaper_fences$
DECLARE
  inventory_capability_id uuid;
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  IF p_interaction_holder_ttl_ms <= 0 THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
  inventory_capability_id :=
    opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
  FOR workspace_id_value IN
    SELECT candidate.workspace_id
    FROM (
      SELECT lease.workspace_id
      FROM sandbox_leases lease
      WHERE lease.workspace_id IS NOT NULL
        AND (
          lease.liveness <> 'cold'
          OR EXISTS (
            SELECT 1
            FROM sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id
          )
        )
      UNION
      SELECT operation.workspace_id
      FROM interaction_operations operation
      WHERE operation.workspace_id IS NOT NULL
        -- Lease-free prepared operations remain replayable. A dispatched
        -- operation is the first controller-side effect and is the only
        -- lease-free transition the ordinary stale-transition reaper settles.
        AND operation.state = 'dispatched'
        AND operation.updated_at
          < pg_catalog.now()
            - pg_catalog.make_interval(
                secs => p_interaction_holder_ttl_ms / 1000.0
              )
        AND (
          EXISTS (
            SELECT 1
            FROM browser_sessions browser
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
            FROM computer_sessions computer
            WHERE operation.resource_kind = 'computer_session'
              AND operation.account_id = computer.account_id
              AND operation.workspace_id = computer.workspace_id
              AND operation.resource_id = computer.id
              AND computer.lifecycle IN ('starting', 'ending')
          )
        )
    ) candidate
    ORDER BY candidate.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RETURN locked_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RAISE;
END
$interaction_reaper_fences$;

REVOKE ALL ON FUNCTION
  acquire_sandbox_reaper_session_tenancy_fences(bigint)
  FROM PUBLIC;

-- CREATE OR REPLACE records `SET search_path FROM CURRENT` from the migrator
-- connection. Re-pin this overload to the exact target schema before callers
-- can invoke the enclosing reaper, so a caller-created temp relation cannot
-- shadow its lease-free inventory before workspace fences are acquired.
DO $pin_interaction_reaper_fence_helper$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.acquire_sandbox_reaper_session_tenancy_fences(bigint) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
END
$pin_interaction_reaper_fence_helper$;

-- Patch only the exact 0388 definition. The interaction reaper keeps the
-- canonical advisory-fence -> owner capability -> operation -> lease -> holder
-- ordering. The holder EXISTS is an unlocked eligibility read before LIMIT;
-- lease rows are still the first ownership rows locked by the deadline phase.
DO $provider_deadline_interaction_followup$
DECLARE
  data_schema text := pg_catalog.current_schema();
  definition text;
  patched text;
  fence_anchor constant text :=
    E'      PERFORM acquire_sandbox_reaper_session_tenancy_fences();';
  fence_replacement constant text :=
    E'      -- 0391 provider-deadline interaction follow-up: inventory due\n'
    || E'      -- lease-free transitions before any interaction row lock.\n'
    || E'      PERFORM acquire_sandbox_reaper_session_tenancy_fences(\n'
    || E'        p_interaction_holder_ttl_ms\n'
    || E'      );';
  liveness_anchor constant text :=
    E'          AND lease.liveness IN (''warming'', ''warm'')';
  liveness_replacement constant text :=
    E'          AND lease.liveness IN (''warming'', ''warm'', ''draining'')';
  deadline_anchor constant text :=
    E'          AND lease.provider_deadline_at <= pg_catalog.now()';
  deadline_replacement text;
  occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  ) INTO definition;

  IF definition IS NULL
    OR pg_catalog.strpos(definition, 'deadline_lease_ids uuid[]') = 0
    OR pg_catalog.strpos(definition, 'provider_deadline_rotation') = 0
    OR pg_catalog.strpos(definition, 'open_session_tenancy_fenced_access') = 0
    OR pg_catalog.strpos(definition, 'LIMIT 500') = 0
  THEN
    RAISE EXCEPTION '0391 interaction reaper prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.strpos(
    definition,
    '0391 provider-deadline interaction follow-up'
  ) > 0 THEN
    IF pg_catalog.strpos(
      definition,
      'acquire_sandbox_reaper_session_tenancy_fences('
    ) = 0
      OR pg_catalog.strpos(
        definition,
        'p_interaction_holder_ttl_ms'
      ) = 0
      OR pg_catalog.strpos(
        definition,
        'lease.liveness IN (''warming'', ''warm'', ''draining'')'
      ) = 0
      OR pg_catalog.strpos(
        definition,
        'interaction_holder.kind = ''interaction'''
      ) = 0
    THEN
      RAISE EXCEPTION '0391 interaction reaper replay definition drift'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    patched := definition;

    occurrences := (
      pg_catalog.length(patched)
        - pg_catalog.length(pg_catalog.replace(patched, fence_anchor, ''))
    ) / pg_catalog.length(fence_anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0391 interaction reaper fence anchor drift'
        USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(patched, fence_anchor, fence_replacement);

    occurrences := (
      pg_catalog.length(patched)
        - pg_catalog.length(pg_catalog.replace(patched, liveness_anchor, ''))
    ) / pg_catalog.length(liveness_anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0391 interaction reaper liveness anchor drift'
        USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(
      patched,
      liveness_anchor,
      liveness_replacement
    );

    occurrences := (
      pg_catalog.length(patched)
        - pg_catalog.length(pg_catalog.replace(patched, deadline_anchor, ''))
    ) / pg_catalog.length(deadline_anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0391 interaction reaper deadline anchor drift'
        USING ERRCODE = '55000';
    END IF;
    deadline_replacement := deadline_anchor || pg_catalog.format(
      E'\n          AND EXISTS (\n'
        || E'            SELECT 1\n'
        || E'            FROM %I.sandbox_lease_holders interaction_holder\n'
        || E'            WHERE interaction_holder.lease_id = lease.id\n'
        || E'              AND interaction_holder.kind = ''interaction''\n'
        || E'          )',
      data_schema
    );
    patched := pg_catalog.replace(
      patched,
      deadline_anchor,
      deadline_replacement
    );

    IF pg_catalog.strpos(
      patched,
      '0391 provider-deadline interaction follow-up'
    ) = 0
      OR pg_catalog.strpos(
        patched,
        'lease.liveness IN (''warming'', ''warm'', ''draining'')'
      ) = 0
      OR pg_catalog.strpos(
        patched,
        'interaction_holder.kind = ''interaction'''
      ) = 0
    THEN
      RAISE EXCEPTION '0391 interaction reaper patch failed'
        USING ERRCODE = '55000';
    END IF;

    EXECUTE patched;
  END IF;
END
$provider_deadline_interaction_followup$;

RESET statement_timeout;
RESET lock_timeout;