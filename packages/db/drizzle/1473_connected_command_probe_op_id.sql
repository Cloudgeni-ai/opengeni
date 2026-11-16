-- deployment-mode: rolling
-- online-safety-exception: nonconcurrent-index: the private projection holds one narrow row per background command and only the trigger of session_background_commands writes it; the concurrent-index runner recovers failed builds only in the current schema, not opengeni_private.
-- The private command projection records each connected command's op id.
--
-- classify_connected_command_ops looks up the command rows of the operations
-- one runner process reports: on every completion notice (1474) and every
-- inventory page. Almost every completion notice is foreground work, which
-- has no command row, yet each lookup opened a session-tenancy fence
-- inventory, a capability row written and deleted in its own transaction.
-- 1474 first asks this projection, which the definer can read without that
-- capability, whether the runner process has any row for those operations.
--
-- New and changed rows carry their op id from here on. Rows written before
-- this migration (and by a writer still running the previous trigger body
-- while it commits) keep a NULL op id, which 1474 treats as "may match", so
-- their runner process keeps the full lookup. Nothing is backfilled: the
-- answer stays exact, and the saving applies to runner processes whose rows
-- all carry their op id.
--
-- Rolling: the projection is private and nothing in the previous release
-- reads it. The sync routine keeps its signature, owner and grants. The
-- index serves 1474's lookup: one runner process's rows for a set of op ids,
-- or any of its rows without one.
SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.maintenance_probe_session_background_commands
  ADD COLUMN IF NOT EXISTS op_id text;

CREATE INDEX IF NOT EXISTS maintenance_probe_session_background_commands_op_idx
ON opengeni_private.maintenance_probe_session_background_commands
  (control_workspace_id, enrollment_id, connection_instance_id, op_id)
WHERE provider = 'connected_machine';

CREATE OR REPLACE FUNCTION opengeni_private.maintenance_probe_session_background_commands_sync() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          TRUNCATE opengeni_private.maintenance_probe_session_background_commands;
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.state, NEW.reconcile_after, NEW.provider, NEW.output_release_observed_at, NEW.output_unavailable_at, NEW.control_workspace_id, NEW.enrollment_id, NEW.connection_instance_id, NEW.completion_notified_at, NEW.reconcile_proof_outcome, NEW.last_reconcile_outcome, NEW.op_id) IS NOT DISTINCT FROM ROW(OLD.id, OLD.state, OLD.reconcile_after, OLD.provider, OLD.output_release_observed_at, OLD.output_unavailable_at, OLD.control_workspace_id, OLD.enrollment_id, OLD.connection_instance_id, OLD.completion_notified_at, OLD.reconcile_proof_outcome, OLD.last_reconcile_outcome, OLD.op_id) THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
          DELETE FROM opengeni_private.maintenance_probe_session_background_commands WHERE id = OLD.id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          INSERT INTO opengeni_private.maintenance_probe_session_background_commands (id, state, reconcile_after, provider, output_release_observed_at, output_unavailable_at, control_workspace_id, enrollment_id, connection_instance_id, completion_notified_at, reconcile_proof_outcome, last_reconcile_outcome, op_id) VALUES (NEW.id, NEW.state, NEW.reconcile_after, NEW.provider, NEW.output_release_observed_at, NEW.output_unavailable_at, NEW.control_workspace_id, NEW.enrollment_id, NEW.connection_instance_id, NEW.completion_notified_at, NEW.reconcile_proof_outcome, NEW.last_reconcile_outcome, NEW.op_id)
          ON CONFLICT (id) DO UPDATE SET (id, state, reconcile_after, provider, output_release_observed_at, output_unavailable_at, control_workspace_id, enrollment_id, connection_instance_id, completion_notified_at, reconcile_proof_outcome, last_reconcile_outcome, op_id) = (EXCLUDED.id, EXCLUDED.state, EXCLUDED.reconcile_after, EXCLUDED.provider, EXCLUDED.output_release_observed_at, EXCLUDED.output_unavailable_at, EXCLUDED.control_workspace_id, EXCLUDED.enrollment_id, EXCLUDED.connection_instance_id, EXCLUDED.completion_notified_at, EXCLUDED.reconcile_proof_outcome, EXCLUDED.last_reconcile_outcome, EXCLUDED.op_id);
        END IF;
        RETURN NULL;
      END $$;
