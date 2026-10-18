-- deployment-mode: rolling
-- A compute sandbox's running command is never polled.
--
-- Every message to a compute sandbox's agent wakes the sandbox, so the
-- connected-command reconciler's periodic provider probe would keep a sandbox
-- with a long-running command awake forever. Polling is also unnecessary
-- there: the agent pushes each completion and retries until it is
-- acknowledged, and the agent process outlives sleep, memory restores and
-- moves. A process that does not survive gets a new connection instance (the
-- claim then retires the command as op_connection_replaced) and a deleted
-- sandbox's enrollment is revoked (op_enrollment_revoked).
--
-- So a running command on a sandbox-kind enrollment is claimed only once it
-- has a pushed completion, a saved proof or a retirement reason. A stopping
-- command (Stop, Pause or Cancel) is claimed as before, since the claim is
-- what delivers the cancellation, and stopping lasts only until the agent
-- reports the exit. Commands on
-- Connected Machines are claimed exactly as before. The due probe gets the
-- same filter so it stays a superset of the claim without reporting idle
-- compute commands as work on every tick.
--
-- The previous release never creates sandbox enrollments, so it is unaffected.

DO $compute_command_settlement$
DECLARE
  claim_definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint,timestamp with time zone)'::regprocedure
  );
  claim_anchor text := 'ORDER BY command.reconcile_after, command.started_at, command.id';
  claim_replacement text :=
    'AND (enrollment.kind <> ''sandbox'''
    || ' OR enrollment.status = ''revoked'''
    || ' OR (enrollment.connection_instance_id IS NOT NULL'
    || ' AND enrollment.connection_instance_id <> command.connection_instance_id)'
    || ' OR command.state = ''stopping'''
    || ' OR command.completion_notified_at IS NOT NULL'
    || ' OR command.reconcile_proof_outcome IS NOT NULL)'
    || E'\n        ' || claim_anchor;
  due_definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.connected_command_reconciliation_due_v1()'::regprocedure
  );
  due_anchor text := 'AND command.provider = ''connected_machine''';
  due_replacement text := due_anchor
    || format(
      E'\n          AND NOT EXISTS (SELECT 1 FROM %I.enrollments enrollment'
      || ' WHERE enrollment.id = command.enrollment_id'
      || ' AND enrollment.account_id = command.account_id'
      || ' AND enrollment.workspace_id = command.control_workspace_id'
      || ' AND enrollment.kind = ''sandbox'''
      || ' AND enrollment.status <> ''revoked'''
      || ' AND (enrollment.connection_instance_id IS NULL'
      || ' OR enrollment.connection_instance_id = command.connection_instance_id)'
      || ' AND command.state = ''running'''
      || ' AND command.completion_notified_at IS NULL'
      || ' AND command.reconcile_proof_outcome IS NULL)',
      pg_catalog.current_schema()
    );
BEGIN
  IF strpos(claim_definition, 'enrollment.kind <> ''sandbox''') = 0 THEN
    IF (length(claim_definition) - length(replace(claim_definition, claim_anchor, '')))
        / length(claim_anchor) <> 1 THEN
      RAISE EXCEPTION '0846 connected-command claim prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(claim_definition, claim_anchor, claim_replacement);
  END IF;
  IF strpos(due_definition, 'enrollment.kind = ''sandbox''') = 0 THEN
    IF (length(due_definition) - length(replace(due_definition, due_anchor, '')))
        / length(due_anchor) <> 1 THEN
      RAISE EXCEPTION '0846 connected-command due probe prerequisite drift' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(due_definition, due_anchor, due_replacement);
  END IF;
END;
$compute_command_settlement$;
