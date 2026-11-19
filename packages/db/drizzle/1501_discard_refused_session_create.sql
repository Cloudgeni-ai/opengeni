-- deployment-mode: rolling
-- Discard a keyed session create the server refused before its first turn.
--
-- Session creation commits the session row first and installs its first
-- event and turn in a second transaction. When that second step refuses the
-- request (for example a personal-resource attachment that selects nothing
-- attachable), the caller is answered with a 4xx. An unkeyed shell is then
-- deleted, but a keyed one stayed: the BEFORE INSERT idempotency guard had
-- already bound its key to the session in session_create_idempotency_guard,
-- which the runtime cannot write. The refused shell lingered as an idle,
-- usable chat holding its requested session id, and a corrected retry got
-- 409.
--
-- opengeni_private.discard_refused_session_create_v1(workspace, session)
-- runs in that workspace's RLS context. Under the key's admission lock
-- (taken before the row, as every keyed create takes it), it deletes a keyed
-- session that has no event, turn or child, together with the guard row
-- that names it, and returns 'discarded'. A shell that initialized (also an
-- outcome-unknown commit) returns 'initialized' and is kept; a missing one
-- returns 'not_found'; an unkeyed one returns 'unkeyed' and is left to the
-- runtime's own delete. A retry with the same key then evaluates the request
-- again: an unchanged request gets the same refusal, a corrected one creates
-- the session.
--
-- As 0937, 0978, 1060, 1404 and 1492 explain, the previous release rejects
-- a runtime EXECUTE grant on a definer it doesn't know, so this migration
-- grants nothing. Until a later migration grants it, a refused keyed shell
-- stays as before.
--
-- Rolling: one definer the previous release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $discard_refused_session_create$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.discard_refused_session_create_v1(
      p_workspace_id uuid, p_session_id uuid)
    RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_account_id uuid := opengeni_private.current_account_id();
      v_key text;
      v_last_sequence integer;
    BEGIN
      IF v_account_id IS NULL
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN
        RAISE EXCEPTION 'discarding a refused session create requires its workspace scope'
          USING ERRCODE = '42501';
      END IF;
      SELECT shell.create_idempotency_key INTO v_key
      FROM sessions shell
      WHERE shell.workspace_id = p_workspace_id AND shell.id = p_session_id
        AND shell.account_id = v_account_id;
      IF NOT FOUND THEN
        RETURN 'not_found';
      END IF;
      IF v_key IS NULL THEN
        RETURN 'unkeyed';
      END IF;
      -- The key's admission lock, before the row lock, as keyed creates take it.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('session-create:' || p_workspace_id::text || ':' || v_key));
      SELECT shell.last_sequence INTO v_last_sequence
      FROM sessions shell
      WHERE shell.workspace_id = p_workspace_id AND shell.id = p_session_id
        AND shell.account_id = v_account_id
        AND shell.create_idempotency_key = v_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN 'not_found';
      END IF;
      IF v_last_sequence <> 0
        OR EXISTS (
          SELECT 1 FROM session_events event_row
          WHERE event_row.workspace_id = p_workspace_id AND event_row.session_id = p_session_id)
        OR EXISTS (
          SELECT 1 FROM session_turns turn_row
          WHERE turn_row.workspace_id = p_workspace_id AND turn_row.session_id = p_session_id)
        OR EXISTS (
          SELECT 1 FROM sessions child
          WHERE child.workspace_id = p_workspace_id AND child.parent_session_id = p_session_id)
      THEN
        RETURN 'initialized';
      END IF;
      DELETE FROM sessions shell
      WHERE shell.workspace_id = p_workspace_id AND shell.id = p_session_id;
      DELETE FROM session_create_idempotency_guard ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.idempotency_key = v_key
        AND ledger.outcome = 'session'
        AND ledger.session_id = p_session_id;
      RETURN 'discarded';
    END
    $body$
  $definition$, data_schema);
END
$discard_refused_session_create$;

REVOKE ALL ON FUNCTION opengeni_private.discard_refused_session_create_v1(uuid, uuid) FROM PUBLIC;
