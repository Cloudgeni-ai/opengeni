-- deployment-mode: rolling
-- Removing a Connected Machine detaches every conversation that points at it,
-- including one whose turn is queued, paused or recovering. Such a turn is not
-- running on the machine: the machine's sandbox lease is what proves live work,
-- and removal still refuses while that lease has a holder or recovery pending.
-- A detached session's next attempt finds no machine route and falls back to
-- its managed sandbox, exactly as after a swap back home, so the conversation
-- and its history are kept.
--
-- The function was patched in place by 0345, so this edits the live definition:
-- it removes the one active-turn refusal and fails if the definition drifted.
SET LOCAL lock_timeout = '5s';

DO $repair$
DECLARE
  target regprocedure;
  definition text;
  anchor text;
  occurrences integer;
BEGIN
  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.detach_scoped_machine_dependent_sessions(uuid,uuid,uuid)'
  );
  IF target IS NULL THEN
    RAISE EXCEPTION '0703 machine detach function is missing' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'  IF EXISTS (\n'
    || E'    SELECT 1 FROM sessions session\n'
    || E'    WHERE session.account_id = p_account_id\n'
    || E'      AND (session.active_sandbox_id = p_sandbox_id\n'
    || E'        OR session.sandbox_group_id = p_sandbox_id)\n'
    || E'      AND session.active_turn_id IS NOT NULL\n'
    || E'  ) THEN RAISE EXCEPTION ''machine still has active dependent sessions''\n'
    || E'    USING ERRCODE = ''55000''; END IF;\n';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0703 machine detach definition drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, anchor, '');
END
$repair$;
