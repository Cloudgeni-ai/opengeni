-- deployment-mode: rolling
-- Content-free metrics only. Count the first terminal transition in the same
-- transaction as the run, including terminal receipts created at admission.
-- No history scan or backfill. Shards spread concurrent writes to the same
-- bucket and are never exposed as Prometheus labels.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE automation_run_counters (
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('clock', 'event', 'once', 'initial', 'manual', 'retry', 'repair')),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'failed', 'skipped')),
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 31),
  runs bigint NOT NULL CHECK (runs > 0),
  PRIMARY KEY (trigger_kind, outcome, shard)
);
ALTER TABLE automation_run_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_run_counters FORCE ROW LEVEL SECURITY;
-- Only authorized database roles have DML; all rows contain global, bounded
-- aggregates, without any account, workspace, run or task identifiers.
CREATE POLICY automation_run_counters_read ON automation_run_counters FOR SELECT USING (true);
CREATE POLICY automation_run_counters_insert ON automation_run_counters FOR INSERT WITH CHECK (true);
CREATE POLICY automation_run_counters_update ON automation_run_counters FOR UPDATE USING (true) WITH CHECK (true);

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION %1$I.count_automation_run_outcome() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path TO pg_catalog, %1$I, pg_temp
    AS $counter$
    DECLARE kind text;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.status IN ('succeeded', 'failed', 'skipped') THEN
        RETURN NULL;
      END IF;
      kind := CASE NEW.trigger_type
        WHEN 'event' THEN 'event' WHEN 'provider_event' THEN 'event'
        WHEN 'scheduled' THEN CASE WHEN coalesce(NEW.accepted_execution_snapshot #>> '{task,schedule,type}',
          (SELECT t.schedule->>'type' FROM %1$I.scheduled_tasks t
            WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id)) = 'once'
          THEN 'once' ELSE 'clock' END
        ELSE NEW.trigger_type END;
      INSERT INTO %1$I.automation_run_counters AS c(trigger_kind, outcome, shard, runs)
        VALUES(kind, CASE NEW.status WHEN 'succeeded' THEN 'ok' ELSE NEW.status END,
          (get_byte(uuid_send(NEW.id), 15) & 31)::smallint, 1)
        ON CONFLICT (trigger_kind, outcome, shard) DO UPDATE SET runs=c.runs+1;
      RETURN NULL;
    END
    $counter$
  $definition$, data_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.count_automation_run_outcome() FROM PUBLIC', data_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE automation_run_counters FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE automation_run_counters TO opengeni_app;
    EXECUTE format('REVOKE ALL ON FUNCTION %I.count_automation_run_outcome() FROM opengeni_app', data_schema);
  END IF;
END
$install$;

CREATE TRIGGER automation_run_outcome
AFTER INSERT OR UPDATE OF status ON scheduled_task_runs
FOR EACH ROW WHEN (NEW.status IN ('succeeded', 'failed', 'skipped'))
EXECUTE FUNCTION count_automation_run_outcome();
