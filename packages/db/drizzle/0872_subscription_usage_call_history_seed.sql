-- deployment-mode: rolling
-- Separate from trigger installation: no writer-conflicting DDL locks during
-- this bounded historical scan. Later writes already maintain the projection.
-- The preceding history expansion installs the write-through triggers.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10min';
DO $seed$
DECLARE w record;
BEGIN
  FOR w IN SELECT account_id, id FROM workspaces ORDER BY id LOOP
    PERFORM set_config('opengeni.account_id', w.account_id::text, true),
      set_config('opengeni.workspace_id', w.id::text, true);
    INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
      (backend_pid, transaction_id, capability_kind, account_id, workspace_id, subject_id, initiating_human_subject_id)
    VALUES (pg_backend_pid(), pg_current_xact_id(), 'model_call_facts', w.account_id, w.id,
      nullif(current_setting('opengeni.subject_id', true), ''),
      nullif(current_setting('opengeni.initiating_human_subject_id', true), ''));
    INSERT INTO opengeni_private.subscription_usage_calls
      (fact_id, account_id, connection_id, occurred_at, units)
    SELECT f.id, f.account_id, f.connection_id, f.occurred_at, f.estimated_provider_cost_micros
      FROM model_call_facts f WHERE f.account_id = w.account_id AND f.workspace_id = w.id
        AND f.connection_id IS NOT NULL AND f.estimated_provider_cost_micros IS NOT NULL
        AND f.occurred_at >= statement_timestamp() - interval '14 days'
      ON CONFLICT DO NOTHING;
    DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
      WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id()
        AND capability_kind = 'model_call_facts';
  END LOOP;
END $seed$;
