-- deployment-mode: rolling
-- Keep the existing owner-only, PID/xid/tenant/actor capability and ordinary
-- session predicates. A row-independent SELECT capability is an initPlan,
-- not a SECURITY DEFINER SQL call for every fact. No write policy or ACL changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $capability_initplans$
DECLARE
  data_schema text := current_schema();
  target text;
  installed record;
  capability text;
  original_expression text;
  optimized_expression text;
  expected_expression text;
BEGIN
  FOREACH target IN ARRAY ARRAY['model_call_facts', 'usage_events'] LOOP
    SELECT policy.polpermissive, policy.polcmd,
      pg_get_expr(policy.polqual, policy.polrelid) AS expression INTO installed
    FROM pg_policy policy
    WHERE policy.polrelid = format('%I.%I', data_schema, target)::regclass
      AND policy.polname = 'session_visibility_isolation';
    IF NOT FOUND OR installed.polpermissive OR installed.polcmd <> 'r'
      OR installed.expression IS NULL THEN
      RAISE EXCEPTION 'Insights plan optimization refuses unknown SELECT visibility policy'
        USING ERRCODE = '55000';
    END IF;
    capability := format('%1$I.insights_fact_read_policy_capability_active(current_user,
      pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.oid = %2$L::pg_catalog.regclass)), %3$L)',
      data_schema, format('%I.%I', data_schema, target), target);
    original_expression := format('CASE WHEN %s THEN true ELSE
      %I.session_reference_visible(account_id, workspace_id, session_id) END', capability, data_schema);
    optimized_expression := format('CASE WHEN (SELECT %s) THEN true ELSE
      %I.session_reference_visible(account_id, workspace_id, session_id) END', capability, data_schema);
    IF target = 'usage_events' THEN
      original_expression := format('CASE WHEN (SELECT %I.organization_usage_policy_capability_active(current_user))
        THEN true ELSE (%s) END', data_schema, original_expression);
      optimized_expression := format('CASE WHEN (SELECT %I.organization_usage_policy_capability_active(current_user))
        THEN true ELSE (%s) END', data_schema, optimized_expression);
    END IF;
    -- Compare parsed policy trees as 0473 does. Refuse future semantic drift;
    -- don't replace an unknown predicate on the strength of a substring match.
    EXECUTE format('CREATE POLICY insights_plan_expected_visibility ON %I.%I
      AS RESTRICTIVE FOR SELECT USING (%s)', data_schema, target, original_expression);
    SELECT pg_get_expr(policy.polqual, policy.polrelid) INTO expected_expression
    FROM pg_policy policy
    WHERE policy.polrelid = format('%I.%I', data_schema, target)::regclass
      AND policy.polname = 'insights_plan_expected_visibility';
    EXECUTE format('DROP POLICY insights_plan_expected_visibility ON %I.%I', data_schema, target);
    IF installed.expression IS DISTINCT FROM expected_expression THEN
      RAISE EXCEPTION 'Insights plan optimization refuses changed SELECT visibility semantics'
        USING ERRCODE = '55000';
    END IF;
    EXECUTE format('ALTER POLICY session_visibility_isolation ON %I.%I USING (%s)',
      data_schema, target, optimized_expression);
  END LOOP;
END
$capability_initplans$;

DO $aggregate_plans$
DECLARE
  definition text;
  original text;
  old_owner_scan text;
  new_owner_scan text;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure)
    INTO original;
  -- All-row totals no longer use the visibility join. The unused materialized
  -- session CTE and LEFT JOIN otherwise still scan sessions and hash 4M rows.
  definition := regexp_replace(original,
    'WITH visible_sessions AS MATERIALIZED \(.*?\), visible AS MATERIALIZED \(',
    'WITH visible AS NOT MATERIALIZED (');
  definition := regexp_replace(definition,
    'LEFT JOIN visible_sessions session_row[[:space:]]+ON session_row.id = usage_row.session_id[[:space:]]+AND session_row.account_id = usage_row.account_id[[:space:]]+AND session_row.workspace_id = usage_row.workspace_id', '');
  -- Format UTC labels after grouping, not once for each ledger row.
  definition := replace(definition,
    $old$CASE WHEN p_include_period THEN to_char(date_trunc(p_granularity, usage_row.occurred_at AT TIME ZONE 'UTC'),
              CASE WHEN p_granularity = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END) END AS bucket$old$,
    $new$CASE WHEN p_include_period THEN date_trunc(p_granularity, usage_row.occurred_at AT TIME ZONE 'UTC') END AS bucket$new$);
  definition := replace(definition,
    'SELECT bucket, jsonb_agg(total ORDER BY total->>''eventType'', total->>''unit'') AS totals',
    $new$SELECT to_char(bucket, CASE WHEN p_granularity = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END) AS bucket,
            jsonb_agg(total ORDER BY total->>'eventType', total->>'unit') AS totals$new$);
  old_owner_scan := $old$usage_row.event_type, usage_row.unit, sum(usage_row.quantity) AS quantity,
            count(*) AS event_count
          FROM$old$;
  new_owner_scan := $new$usage_row.event_type, usage_row.unit, sum(usage_row.quantity) AS quantity,
            sum(usage_row.event_count) AS event_count
          FROM$new$;
  definition := replace(definition, 'WITH private_sessions AS MATERIALIZED (',
    format('WITH usage_by_session AS MATERIALIZED (
          SELECT workspace_id, session_id, event_type, unit, sum(quantity) AS quantity, count(*) AS event_count
          FROM %I.usage_events
          WHERE account_id = context_account_id AND session_id IS NOT NULL
            AND occurred_at >= p_since AND occurred_at < p_until
          GROUP BY workspace_id, session_id, event_type, unit
        ), private_sessions AS MATERIALIZED (', current_schema()));
  definition := replace(definition, old_owner_scan, new_owner_scan);
  definition := regexp_replace(definition,
    'FROM ([^[:space:]]+\.)?usage_events usage_row[[:space:]]+JOIN private_sessions session_row',
    'FROM usage_by_session usage_row JOIN private_sessions session_row');
  definition := replace(definition,
    $old$WHERE usage_row.account_id = context_account_id
            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until
          GROUP BY session_row.workspace_id$old$,
    'GROUP BY session_row.workspace_id');
  IF definition = original OR position('WITH visible_sessions' IN definition) > 0
    OR position('LEFT JOIN visible_sessions' IN definition) > 0
    OR position('usage_by_session AS MATERIALIZED' IN definition) = 0
    OR position('sum(usage_row.event_count)' IN definition) = 0
    OR position('FROM usage_by_session usage_row JOIN private_sessions' IN definition) = 0
    OR position('WHERE usage_row.account_id = context_account_id' || chr(10) ||
      '            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until' || chr(10) ||
      '          GROUP BY session_row.workspace_id' IN definition) > 0 THEN
    RAISE EXCEPTION 'Insights aggregate plan source contract changed' USING ERRCODE = '55000';
  END IF;
  EXECUTE definition;
  -- Per-event arrays and provider filters must remain selective even after
  -- repeated calls choose a generic PL/pgSQL plan. These settings are local to
  -- the existing readers and don't change the caller's transaction settings.
  ALTER FUNCTION opengeni_private.complete_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[])
    SET plan_cache_mode = force_custom_plan;
  ALTER FUNCTION opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)
    SET plan_cache_mode = force_custom_plan;
END
$aggregate_plans$;

RESET statement_timeout;
RESET lock_timeout;