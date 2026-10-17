-- deployment-mode: rolling
-- Separate transaction from trigger DDL: this historical scan takes no
-- writer-conflicting lock. All later facts already have transactional deltas.
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10min';
DO $queue$
DECLARE w record;
BEGIN
  FOR w IN SELECT account_id,id FROM workspaces ORDER BY id LOOP
    PERFORM set_config('opengeni.account_id',w.account_id::text,true),set_config('opengeni.workspace_id',w.id::text,true);
    INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
      (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
    VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',w.account_id,w.id,
      nullif(current_setting('opengeni.subject_id',true),''),nullif(current_setting('opengeni.initiating_human_subject_id',true),''));
    INSERT INTO opengeni_private.insights_usage_hourly_backfill(account_id,workspace_id,hour)
      SELECT DISTINCT w.account_id,w.id,date_trunc('hour',f.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      FROM model_call_facts f WHERE f.account_id=w.account_id AND f.workspace_id=w.id
      UNION
      -- A historical hour can become empty after trigger installation. Its
      -- negative provisional delta still needs rebuilding. Read both sides in
      -- one snapshot so a concurrent move/delete cannot fall between them.
      SELECT r.account_id,r.workspace_id,r.hour FROM opengeni_private.insights_usage_hourly_rollups r
        WHERE r.account_id=w.account_id AND r.workspace_id=w.id
      ON CONFLICT DO NOTHING;
    DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND capability_kind='model_call_facts';
  END LOOP;
END
$queue$;
