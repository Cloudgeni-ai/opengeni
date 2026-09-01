-- deployment-mode: rolling
-- Active BrowserSession/ComputerSession placement deliberately survives UI and
-- API-owner disappearance. A finite-lifetime Modal identity is the exception:
-- once its hard provider deadline passes, retaining an interaction holder can
-- no longer preserve a usable controller and must not pin rotation forever.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The interaction reaper became an owner-only global mutator before the
-- session-tenancy cutover, but 0345 added its exact capability/lock policy only
-- to the lease tables. A NOSUPERUSER migration owner otherwise sees no
-- BrowserSession/ComputerSession/operation rows under FORCE RLS and treats
-- every interaction holder as an orphan. Admit the same already-fenced owner
-- only on the four interaction tables the reaper reads or updates.
DO $interaction_reaper_owner_policies$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'browser_sessions',
    'computer_sessions',
    'interaction_operations',
    'workspace_interaction_revisions'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fenced_owner_interaction ON %I.%I '
        || 'FOR ALL USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, false)) '
        || 'WITH CHECK ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, false))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;
END
$interaction_reaper_owner_policies$;

DO $deadline_interaction_reaper$
DECLARE
  data_schema text := current_schema();
  definition text;
  patched text;
  declaration_anchor constant text :=
    E'      affected_lease_ids uuid[] := ARRAY[]::uuid[];\n'
    || E'      settled_count integer := 0;';
  entry_anchor constant text :=
    E'      fenced_access_capability_id :=\n'
    || E'        opengeni_private.open_session_tenancy_fenced_access(\n'
    || E'          session_tenancy_fence_target_schema()\n'
    || E'        );';
  settled_anchor constant text :=
    E'      GET DIAGNOSTICS settled_count = ROW_COUNT;';
  revision_anchor constant text :=
    E'      WHERE revision.workspace_id = ANY(changed_workspace_ids || orphan_workspace_ids);';
  deadline_block text;
  occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  ) INTO definition;

  IF definition IS NULL
    OR pg_catalog.strpos(definition, 'error_code = ''outcome_unknown''') = 0
    OR pg_catalog.strpos(
      definition,
      'acquire_sandbox_reaper_session_tenancy_fences'
    ) = 0
    OR pg_catalog.strpos(definition, 'open_session_tenancy_fenced_access') = 0
    OR pg_catalog.strpos(definition, 'close_session_tenancy_fenced_access') = 0
  THEN
    RAISE EXCEPTION '0388 interaction reaper prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.strpos(definition, 'deadline_lease_ids') > 0
    OR pg_catalog.strpos(definition, 'provider_deadline_rotation') > 0
  THEN
    RAISE EXCEPTION '0388 interaction reaper deadline patch already present'
      USING ERRCODE = '55000';
  END IF;

  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, declaration_anchor, ''))
  ) / pg_catalog.length(declaration_anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0388 interaction reaper declaration anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    definition,
    declaration_anchor,
    E'      affected_lease_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_lease_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_holder_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_browser_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_computer_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_workspace_ids uuid[] := ARRAY[]::uuid[];\n'
      || E'      deadline_settled_count integer := 0;\n'
      || E'      settled_count integer := 0;'
  );

  deadline_block := pg_catalog.format($block$

      -- Active interaction placement has no timestamp expiry: a human may
      -- legitimately leave it active for days. A requested Modal rotation
      -- whose provider deadline is already due is different. The controller
      -- cannot outlive that identity, so close only that exact holder/resource
      -- population in a bounded batch. The enclosing function has already
      -- acquired every affected workspace tenancy fence and owner-only access.
      SELECT coalesce(
               pg_catalog.array_agg(candidate.id),
               ARRAY[]::uuid[]
             )
      INTO deadline_lease_ids
      FROM (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.backend = 'modal'
          AND lease.liveness IN ('warming', 'warm')
          AND lease.rotation_requested_at IS NOT NULL
          AND lease.provider_deadline_at IS NOT NULL
          AND lease.provider_deadline_at <= pg_catalog.now()
        ORDER BY lease.provider_deadline_at, lease.id
        LIMIT 500
        FOR UPDATE OF lease SKIP LOCKED
      ) candidate;

      -- Lease before holder is the canonical sandbox ownership lock order.
      -- A large shared lease is drained over multiple sweeps instead of making
      -- one global reaper transaction unbounded.
      SELECT coalesce(
               pg_catalog.array_agg(candidate.id),
               ARRAY[]::uuid[]
             )
      INTO deadline_holder_ids
      FROM (
        SELECT holder.id
        FROM %1$I.sandbox_lease_holders holder
        WHERE holder.lease_id = ANY(deadline_lease_ids)
          AND holder.kind = 'interaction'
        ORDER BY holder.id
        LIMIT 500
        FOR UPDATE OF holder SKIP LOCKED
      ) candidate;

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
        ),
        coalesce(
          pg_catalog.array_agg(DISTINCT holder.workspace_id),
          ARRAY[]::uuid[]
        )
      INTO deadline_browser_ids, deadline_computer_ids, deadline_workspace_ids
      FROM %1$I.sandbox_lease_holders holder
      JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
      LEFT JOIN %1$I.browser_sessions browser
        ON holder.holder_id = ('browser-session:' || browser.id::text)
        AND holder.account_id = browser.account_id
        AND holder.workspace_id = browser.workspace_id
        AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
      LEFT JOIN %1$I.computer_sessions computer
        ON holder.holder_id = ('computer-session:' || computer.id::text)
        AND holder.account_id = computer.account_id
        AND holder.workspace_id = computer.workspace_id
        AND computer.sandbox_group_id = lease.sandbox_group_id
      WHERE holder.id = ANY(deadline_holder_ids);

      -- Match the ordinary lifecycle lock order for rows the controller API
      -- also touches: operation before BrowserSession/ComputerSession.
      PERFORM operation.operation_id
      FROM %1$I.interaction_operations operation
      WHERE (
          (
            operation.resource_kind = 'browser_session'
            AND operation.resource_id = ANY(deadline_browser_ids)
          ) OR (
            operation.resource_kind = 'computer_session'
            AND operation.resource_id = ANY(deadline_computer_ids)
          )
        )
        AND operation.state IN ('prepared', 'dispatched')
      ORDER BY operation.operation_id
      FOR UPDATE OF operation;

      PERFORM browser.id
      FROM %1$I.browser_sessions browser
      WHERE browser.id = ANY(deadline_browser_ids)
      ORDER BY browser.id
      FOR UPDATE OF browser;

      PERFORM computer.id
      FROM %1$I.computer_sessions computer
      WHERE computer.id = ANY(deadline_computer_ids)
      ORDER BY computer.id
      FOR UPDATE OF computer;

      -- Prepared operations have no provider side effect and fail
      -- deterministically. Dispatched operations retain honest uncertainty.
      UPDATE %1$I.interaction_operations operation
      SET state = CASE
            WHEN operation.state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'failed'
          END,
          error_code = CASE
            WHEN operation.state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'controller_lost'
          END,
          error_message = 'Interaction controller reached its sandbox provider deadline',
          error_retryable = false,
          error_details = pg_catalog.jsonb_build_object(
            'reason', 'provider_deadline_rotation'
          ),
          settled_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      WHERE (
          (
            operation.resource_kind = 'browser_session'
            AND operation.resource_id = ANY(deadline_browser_ids)
          ) OR (
            operation.resource_kind = 'computer_session'
            AND operation.resource_id = ANY(deadline_computer_ids)
          )
        )
        AND operation.state IN ('prepared', 'dispatched');
      GET DIAGNOSTICS deadline_settled_count = ROW_COUNT;

      -- Preserve the exact controller binding for cleanup/audit. The ordinary
      -- orphan phase below removes holders for these now-terminal resources;
      -- reap_sandbox_leases() then recomputes refcounts and returns the exact
      -- drainable box in this same outer transaction.
      UPDATE %1$I.browser_sessions browser
      SET lifecycle = 'lost',
          failure_code = 'provider_deadline_rotation',
          updated_at = pg_catalog.now()
      WHERE browser.id = ANY(deadline_browser_ids)
        AND browser.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND EXISTS (
          SELECT 1
          FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
          WHERE holder.id = ANY(deadline_holder_ids)
            AND holder.holder_id = ('browser-session:' || browser.id::text)
            AND holder.account_id = browser.account_id
            AND holder.workspace_id = browser.workspace_id
            AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
        );

      UPDATE %1$I.computer_sessions computer
      SET lifecycle = 'lost',
          failure_code = 'provider_deadline_rotation',
          updated_at = pg_catalog.now()
      WHERE computer.id = ANY(deadline_computer_ids)
        AND computer.lifecycle IN (
          'starting', 'active', 'suspending', 'restoring', 'ending'
        )
        AND EXISTS (
          SELECT 1
          FROM %1$I.sandbox_lease_holders holder
          JOIN %1$I.sandbox_leases lease ON lease.id = holder.lease_id
          WHERE holder.id = ANY(deadline_holder_ids)
            AND holder.holder_id = ('computer-session:' || computer.id::text)
            AND holder.account_id = computer.account_id
            AND holder.workspace_id = computer.workspace_id
            AND computer.sandbox_group_id = lease.sandbox_group_id
        );
$block$, data_schema);

  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, entry_anchor, ''))
  ) / pg_catalog.length(entry_anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0388 interaction reaper entry anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    patched,
    entry_anchor,
    entry_anchor || deadline_block
  );

  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, settled_anchor, ''))
  ) / pg_catalog.length(settled_anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0388 interaction reaper settlement anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    patched,
    settled_anchor,
    settled_anchor
      || E'\n      settled_count := settled_count + deadline_settled_count;'
  );

  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, revision_anchor, ''))
  ) / pg_catalog.length(revision_anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0388 interaction reaper revision anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    patched,
    revision_anchor,
    E'      WHERE revision.workspace_id = ANY(\n'
      || E'        changed_workspace_ids || deadline_workspace_ids || orphan_workspace_ids\n'
      || E'      );'
  );

  IF pg_catalog.strpos(patched, 'deadline_lease_ids uuid[]') = 0
    OR pg_catalog.strpos(patched, 'LIMIT 500') = 0
    OR pg_catalog.strpos(patched, 'provider_deadline_at <= pg_catalog.now()') = 0
    OR pg_catalog.strpos(patched, 'provider_deadline_rotation') = 0
    OR pg_catalog.strpos(patched, 'settled_count + deadline_settled_count') = 0
  THEN
    RAISE EXCEPTION '0388 interaction reaper deadline patch failed'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE patched;
END
$deadline_interaction_reaper$;

DO $interaction_backlog_metric$
DECLARE data_schema text := current_schema();
BEGIN
  IF pg_catalog.to_regprocedure(
    'opengeni_private.sandbox_rotation_backlog()'
  ) IS NULL THEN
    RAISE EXCEPTION '0388 sandbox rotation backlog prerequisite missing'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_rotation_backlog()
    RETURNS TABLE (
      requested bigint,
      overdue bigint,
      turn_blocked bigint,
      direct_blocked bigint,
      process_blocked bigint
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE inventory_capability_id uuid;
    BEGIN
      inventory_capability_id :=
        opengeni_private.open_session_tenancy_fence_inventory(
          %1$I.session_tenancy_fence_target_schema()
        );
      RETURN QUERY
      SELECT
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND lease.provider_deadline_at <= pg_catalog.now()
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id
                AND holder.kind = 'turn'
            )
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id
                AND holder.kind = 'direct'
            )
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id
                AND holder.kind = 'process'
            )
        )::bigint
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal'
        AND lease.liveness IN ('warming', 'warm', 'draining');
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );
      RAISE;
    END
    $function$;

    CREATE OR REPLACE FUNCTION
      opengeni_private.sandbox_rotation_interaction_blocked()
    RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      inventory_capability_id uuid;
      blocked_count bigint;
    BEGIN
      inventory_capability_id :=
        opengeni_private.open_session_tenancy_fence_inventory(
          %1$I.session_tenancy_fence_target_schema()
        );
      SELECT pg_catalog.count(*)::bigint
      INTO blocked_count
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal'
        AND lease.liveness IN ('warming', 'warm', 'draining')
        AND lease.rotation_requested_at IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM %1$I.sandbox_lease_holders holder
          WHERE holder.lease_id = lease.id
            AND holder.kind = 'interaction'
        );
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );
      RETURN blocked_count;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(
        inventory_capability_id
      );
      RAISE;
    END
    $function$;
  $create$, data_schema);
END
$interaction_backlog_metric$;

REVOKE ALL ON FUNCTION
  opengeni_private.sandbox_rotation_backlog()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.sandbox_rotation_interaction_blocked()
  FROM PUBLIC;

DO $interaction_backlog_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.sandbox_rotation_backlog()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.sandbox_rotation_interaction_blocked()
      TO opengeni_app;
  END IF;
END
$interaction_backlog_grant$;

RESET statement_timeout;
RESET lock_timeout;