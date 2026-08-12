-- deployment-mode: rolling
-- Forward-repair direct session references introduced after migration 0225.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_visibility_slack_task_repair$
DECLARE
  data_schema text := current_schema();
  target_table text;
  policy_expression text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'slack_interaction_action_handles',
    'slack_shared_task_origins'
  ]
  LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', data_schema, target_table)) IS NULL THEN
      RAISE EXCEPTION 'session visibility repair table is missing: %', target_table
        USING ERRCODE = '42P01';
    END IF;

    policy_expression := pg_catalog.format(
      '%I.session_reference_visible(account_id, workspace_id, session_id)',
      data_schema
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS session_visibility_isolation ON %I.%I',
      data_schema,
      target_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_visibility_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR ALL USING (%s) WITH CHECK (%s)',
      data_schema,
      target_table,
      policy_expression,
      policy_expression
    );
  END LOOP;
END
$session_visibility_slack_task_repair$;