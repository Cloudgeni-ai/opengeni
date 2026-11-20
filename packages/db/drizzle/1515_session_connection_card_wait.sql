-- deployment-mode: rolling
-- A connection card (connect, reconnect or more access) the agent waits on
-- needs the person, as an approval does. The card is announced with a
-- `session.notification.posted` event whose key starts with
-- `connection-card:` (CONNECTION_CARD_NOTICE_PREFIX in @opengeni/contracts)
-- and withdrawn with `session.notification.withdrawn` under the same key once
-- the card is done. This keeps that state on the session, so chat lists and
-- the sub-agent bar can show an idle chat that waits on a card as needing the
-- person without reading its history:
--
-- * sessions.awaiting_connection_keys: the keys of the chat's open
--   connection-card notices; null when none is open.
-- * sessions.awaiting_connection_since: when the oldest of them was posted
--   (kept while any stays open); null when none is open.
-- * An AFTER INSERT trigger on session_events (added by 1516) maintains both: a posted
--   notice adds its key, a withdrawn one removes it, and a turn's first
--   `turn.started` clears them: once the agent works again (the person wrote, the card's
--   setup continued it, or anything else woke it) it no longer waits, and a
--   card it still needs is posted again by that turn. A failure
--   is a warning and never aborts the event's transaction. Imported
--   read-only chats are left alone.
-- * The inbox trigger also takes `turn.started` (1516), which closes the chat's
--   open connection-card notices (status withdrawn). Its function is 1289's
--   plus that branch; same signature, so grants are kept.
-- * A new session never starts waiting: a BEFORE INSERT trigger clears the
--   columns a fork copies from its source row.
-- * Changing the timestamp notifies session lists, like other list fields.
--
-- This migration changes only `sessions` (columns, its triggers and the
-- tracking function); 1516 attaches the triggers on session_events. Keeping
-- them in separate transactions means neither ever holds a lock on one table
-- while waiting for the other, which live event writes take in the opposite
-- order.
--
-- Rolling: both columns are nullable without default (catalog-only), the new
-- routines are SECURITY INVOKER, and the previous release neither reads nor
-- writes the columns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS awaiting_connection_since timestamptz,
  ADD COLUMN IF NOT EXISTS awaiting_connection_keys text[];
COMMENT ON COLUMN sessions.awaiting_connection_since IS
  'When the oldest still-open connection-card notice of this chat was posted; null when none is open. Maintained by session_events_connection_wait_v1.';
COMMENT ON COLUMN sessions.awaiting_connection_keys IS
  'Keys of this chat''s open connection-card notices (connection-card:...); null when none is open. Maintained by session_events_connection_wait_v1.';

CREATE OR REPLACE FUNCTION opengeni_private.track_session_connection_wait_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path FROM CURRENT
AS $track$
DECLARE
  v_key text;
BEGIN
  BEGIN
    IF NEW.type = 'turn.started' THEN
      -- Only a turn's first start: a resume after an approval or an answer
      -- continues the same turn, whose cards are not posted again.
      IF NEW.turn_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM session_events earlier
        WHERE earlier.workspace_id = NEW.workspace_id AND earlier.turn_id = NEW.turn_id
          AND earlier.type = 'turn.started' AND earlier.id <> NEW.id) THEN
        RETURN NULL;
      END IF;
      UPDATE sessions SET awaiting_connection_since = NULL, awaiting_connection_keys = NULL
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND (awaiting_connection_keys IS NOT NULL OR awaiting_connection_since IS NOT NULL);
      RETURN NULL;
    END IF;
    IF jsonb_typeof(NEW.payload -> 'key') IS DISTINCT FROM 'string'
      OR nullif(NEW.payload ->> 'recipientSubjectId', '') IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_key := NEW.payload ->> 'key';
    IF NOT starts_with(v_key, 'connection-card:') THEN RETURN NULL; END IF;
    IF NEW.type = 'session.notification.posted' THEN
      -- A repeat card updates its notice in place: the wait keeps its start.
      UPDATE sessions SET
        awaiting_connection_keys = array_append(coalesce(awaiting_connection_keys, '{}'), v_key),
        awaiting_connection_since = coalesce(awaiting_connection_since, NEW.occurred_at)
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND imported_archive_import_id IS NULL
        AND NOT (v_key = ANY (coalesce(awaiting_connection_keys, '{}')));
    ELSIF NEW.type = 'session.notification.withdrawn' THEN
      UPDATE sessions SET
        awaiting_connection_keys = nullif(array_remove(awaiting_connection_keys, v_key), '{}'),
        awaiting_connection_since = CASE
          WHEN cardinality(array_remove(awaiting_connection_keys, v_key)) = 0 THEN NULL
          ELSE awaiting_connection_since END
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND v_key = ANY (awaiting_connection_keys);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A chat list hint must never abort the lifecycle transaction.
    RAISE WARNING 'connection card wait skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$track$;

CREATE OR REPLACE FUNCTION opengeni_private.reset_session_connection_wait_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $reset$
BEGIN
  NEW.awaiting_connection_since := NULL;
  NEW.awaiting_connection_keys := NULL;
  RETURN NEW;
END
$reset$;

CREATE TRIGGER sessions_connection_wait_insert_reset_v1 BEFORE INSERT ON sessions
  FOR EACH ROW
  WHEN (NEW.awaiting_connection_since IS NOT NULL OR NEW.awaiting_connection_keys IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.reset_session_connection_wait_v1();

CREATE TRIGGER sessions_list_connection_wait_update_v1 AFTER UPDATE OF awaiting_connection_since
  ON sessions FOR EACH ROW
  WHEN (OLD.awaiting_connection_since IS DISTINCT FROM NEW.awaiting_connection_since)
  EXECUTE FUNCTION notify_session_list_change();

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.track_session_connection_wait_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.reset_session_connection_wait_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$pin$;

-- Trigger functions fire without EXECUTE; nobody calls them directly.
REVOKE ALL ON FUNCTION opengeni_private.track_session_connection_wait_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.reset_session_connection_wait_v1() FROM PUBLIC;
