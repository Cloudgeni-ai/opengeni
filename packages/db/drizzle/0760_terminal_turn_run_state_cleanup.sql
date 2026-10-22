-- deployment-mode: rolling
-- RunState is temporary approval/control state, never conversation memory.
-- Every terminal writer (including SQL lifecycle seams) must retire it in the
-- same transaction. Recovering, requires_action and waiting_capacity retain it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION retire_terminal_turn_run_state()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM agent_run_states
  WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
    AND session_id = NEW.session_id AND turn_id = NEW.id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION retire_terminal_turn_run_state() FROM PUBLIC;
DO $pin$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.retire_terminal_turn_run_state() SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema());
END
$pin$;

CREATE TRIGGER terminal_turn_run_state_cleanup
AFTER UPDATE OF status ON session_turns
FOR EACH ROW
WHEN (NEW.status IN ('completed', 'failed', 'cancelled', 'superseded', 'withdrawn_for_edit'))
EXECUTE FUNCTION retire_terminal_turn_run_state();

-- These table locks exclude live writers. Do not acquire workspace advisory
-- fences after them; temporarily bypass only the owner's FORCE-RLS and the
-- run-state workspace-fence trigger for this one transactional repair.
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_run_states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_run_states DISABLE TRIGGER session_tenancy_workspace_fence;
DELETE FROM agent_run_states state
USING session_turns turn
WHERE turn.id = state.turn_id AND turn.account_id = state.account_id
  AND turn.workspace_id = state.workspace_id AND turn.session_id = state.session_id
  AND turn.status IN ('completed', 'failed', 'cancelled', 'superseded', 'withdrawn_for_edit');
ALTER TABLE agent_run_states ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE agent_run_states FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
