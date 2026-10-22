-- deployment-mode: rolling
-- Workspace admins see that someone else's Only me schedule exists: its owner,
-- cadence, status, last run and 30-day cost, and they can pause it. They never
-- see its name, prompt, target chat or runs.
--
-- Those schedules, their runs and their usage are hidden by the session
-- visibility policies whenever they point at the owner's Only me chat. These
-- two SECURITY DEFINER functions read and pause them through a transaction-local
-- capability, the same protocol Insights uses for model_call_facts: the policy
-- only honours it when the current user is the table owner (so only inside a
-- definer function), for the exact account, workspace and caller context, and
-- in the current transaction. The functions return aggregates only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE opengeni_private.insights_fact_read_runtime_capabilities
  DROP CONSTRAINT IF EXISTS insights_fact_read_runtime_capabilities_kind_chk;
ALTER TABLE opengeni_private.insights_fact_read_runtime_capabilities
  ADD CONSTRAINT insights_fact_read_runtime_capabilities_kind_chk CHECK (
    capability_kind = ANY (ARRAY['model_call_facts', 'usage_events', 'private_scheduled_task_summary'])
  );

DO $policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  target record;
  capability text;
BEGIN
  FOR target IN
    SELECT policy.tablename, policy.qual
    FROM pg_catalog.pg_policies policy
    WHERE policy.schemaname = data_schema
      AND policy.tablename IN ('scheduled_tasks', 'scheduled_task_runs')
      AND policy.policyname = 'session_visibility_isolation'
  LOOP
    IF position('private_scheduled_task_summary' IN target.qual) > 0 THEN
      CONTINUE;
    END IF;
    capability := pg_catalog.format(
      '(SELECT %1$I.insights_fact_read_policy_capability_active((CURRENT_USER)::text, '
        || '(pg_get_userbyid((SELECT relation.relowner FROM pg_class relation '
        || 'WHERE relation.oid = %2$L::regclass)))::text, ''private_scheduled_task_summary''))',
      data_schema,
      pg_catalog.format('%I.%I', data_schema, target.tablename)
    );
    EXECUTE pg_catalog.format(
      'ALTER POLICY session_visibility_isolation ON %I.%I USING ((%s) OR %s)',
      data_schema,
      target.tablename,
      target.qual,
      capability
    );
  END LOOP;
END
$policies$;

DO $functions$
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.private_scheduled_task_summaries(
      p_account uuid, p_workspace uuid, p_exclude_owner text, p_task uuid, p_since timestamptz, p_limit integer
    ) RETURNS TABLE(
      id uuid, owner_subject_id text, owner_name text, status text, schedule jsonb,
      created_at timestamptz, last_run_at timestamptz, runs bigint, credit_micros bigint, provider_micros bigint
    ) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
    DECLARE
      a uuid;
      w uuid;
      subject_value text := nullif(current_setting('opengeni.subject_id', true), '');
      human_value text := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
    BEGIN
      BEGIN
        a := nullif(current_setting('opengeni.account_id', true), '')::uuid;
        w := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Private schedule summary scope malformed' USING ERRCODE = '42501';
      END;
      IF a IS NULL OR a IS DISTINCT FROM p_account OR w IS NULL OR w IS DISTINCT FROM p_workspace THEN
        RAISE EXCEPTION 'Private schedule summary requires exact scope' USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR NOT isfinite(p_since) OR p_since < now() - interval '370 days'
        OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'Private schedule summary input invalid' USING ERRCODE = '22023';
      END IF;
      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id, workspace_id, subject_id, initiating_human_subject_id)
      VALUES
        (pg_backend_pid(), pg_current_xact_id(), 'model_call_facts', a, w, subject_value, human_value),
        (pg_backend_pid(), pg_current_xact_id(), 'private_scheduled_task_summary', a, w, subject_value, human_value);
      BEGIN
        RETURN QUERY
          SELECT task.id, task.owner_subject_id,
            (SELECT coalesce(u.name, member.subject_label) FROM %1$I.workspace_memberships member
              LEFT JOIN %1$I.auth_users u ON member.subject_id = 'user:' || u.id
              WHERE member.account_id = a AND member.workspace_id = w
                AND member.subject_id = task.owner_subject_id LIMIT 1),
            task.status, task.schedule, task.created_at,
            (SELECT max(run.fired_at) FROM %1$I.scheduled_task_runs run
              WHERE run.account_id = a AND run.workspace_id = w AND run.task_id = task.id),
            (SELECT count(*) FROM %1$I.scheduled_task_runs run
              WHERE run.account_id = a AND run.workspace_id = w AND run.task_id = task.id
                AND run.fired_at >= p_since),
            coalesce((SELECT sum(fact.priced_cost_micros) FILTER (WHERE fact.billing_path = 'opengeni_credits')
              FROM %1$I.model_call_facts fact
              WHERE fact.account_id = a AND fact.workspace_id = w AND fact.scheduled_task_id = task.id
                AND fact.occurred_at >= p_since), 0)::bigint,
            coalesce((SELECT sum(fact.estimated_provider_cost_micros)
              FROM %1$I.model_call_facts fact
              WHERE fact.account_id = a AND fact.workspace_id = w AND fact.scheduled_task_id = task.id
                AND fact.occurred_at >= p_since), 0)::bigint
          FROM %1$I.scheduled_tasks task
          WHERE task.account_id = a AND task.workspace_id = w
            AND task.deleted_at IS NULL
            AND task.visibility = 'user_private'
            AND task.owner_subject_id IS NOT NULL
            AND task.owner_subject_id IS DISTINCT FROM p_exclude_owner
            AND (p_task IS NULL OR task.id = p_task)
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT p_limit;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
            AND capability_kind IN ('model_call_facts', 'private_scheduled_task_summary');
        RAISE;
      END;
      DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
          AND capability_kind IN ('model_call_facts', 'private_scheduled_task_summary');
    END
    $fn$;

    CREATE FUNCTION opengeni_private.pause_private_scheduled_task(
      p_account uuid, p_workspace uuid, p_exclude_owner text, p_task uuid
    ) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
    DECLARE
      a uuid;
      w uuid;
      subject_value text := nullif(current_setting('opengeni.subject_id', true), '');
      human_value text := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
      found_task boolean;
    BEGIN
      BEGIN
        a := nullif(current_setting('opengeni.account_id', true), '')::uuid;
        w := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Private schedule pause scope malformed' USING ERRCODE = '42501';
      END;
      IF a IS NULL OR a IS DISTINCT FROM p_account OR w IS NULL OR w IS DISTINCT FROM p_workspace
        OR p_task IS NULL THEN
        RAISE EXCEPTION 'Private schedule pause requires exact scope' USING ERRCODE = '42501';
      END IF;
      -- The same workspace mutation fence every schedule writer takes.
      PERFORM %1$I.acquire_session_tenancy_fence(w);
      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id, workspace_id, subject_id, initiating_human_subject_id)
      VALUES
        (pg_backend_pid(), pg_current_xact_id(), 'private_scheduled_task_summary', a, w, subject_value, human_value);
      BEGIN
        UPDATE %1$I.scheduled_tasks task SET status = 'paused', updated_at = now()
          WHERE task.account_id = a AND task.workspace_id = w AND task.id = p_task
            AND task.deleted_at IS NULL AND task.visibility = 'user_private'
            AND task.owner_subject_id IS NOT NULL
            AND task.owner_subject_id IS DISTINCT FROM p_exclude_owner
            AND task.status IS DISTINCT FROM 'paused';
        SELECT EXISTS (
          SELECT 1 FROM %1$I.scheduled_tasks task
          WHERE task.account_id = a AND task.workspace_id = w AND task.id = p_task
            AND task.deleted_at IS NULL AND task.visibility = 'user_private'
            AND task.owner_subject_id IS NOT NULL
            AND task.owner_subject_id IS DISTINCT FROM p_exclude_owner
        ) INTO found_task;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
            AND capability_kind = 'private_scheduled_task_summary';
        RAISE;
      END;
      DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
          AND capability_kind = 'private_scheduled_task_summary';
      RETURN found_task;
    END
    $fn$;
  $ddl$, pg_catalog.current_schema());
END
$functions$;

DO $acl$
DECLARE
  routine regprocedure;
  role_name text;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private'
      AND p.proname IN ('private_scheduled_task_summaries', 'pause_private_scheduled_task')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    FOR role_name IN
      SELECT r.rolname
      FROM pg_catalog.jsonb_array_elements_text(
        pg_catalog.current_setting('opengeni.migration_application_roles')::jsonb
      ) configured(value)
      JOIN pg_catalog.pg_roles r ON r.rolname = configured.value
      WHERE pg_catalog.has_table_privilege(
        r.rolname, pg_catalog.format('%I.scheduled_tasks', pg_catalog.current_schema()), 'UPDATE'
      )
    LOOP
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I', routine, role_name);
    END LOOP;
  END LOOP;
END
$acl$;
RESET statement_timeout;
RESET lock_timeout;
