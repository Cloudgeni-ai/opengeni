-- deployment-mode: rolling
-- A Slack thread delivery that a wake marked while it was still open
-- (slack_interactions.delivery_reopen_after_sequence, migration 1521) stays
-- open for the woken answer when the pass that settles the earlier turn
-- closes it. The rule lived in the API's close statement; as a trigger it
-- holds for every release's close, so during a rolling deploy a pass on the
-- previous release (which may close without it, or not know the column) and
-- a pass on this one settle the thread the same way. Which release marked
-- the wake doesn't matter either: both write the same column.
--
-- A delivery that failed (a close with an error code) always closes, as
-- before. The trigger is SECURITY INVOKER and reads only what the closing
-- statement could read under its own row security; it adds no columns.
CREATE OR REPLACE FUNCTION opengeni_private.slack_delivery_stays_open_for_wake_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
BEGIN
  IF OLD.terminal_delivery_state = 'open'
    AND NEW.terminal_delivery_state <> 'open'
    AND OLD.delivery_reopen_after_sequence IS NOT NULL THEN
    IF NEW.delivery_last_error_code IS NULL AND EXISTS (
      SELECT 1 FROM session_events wake
      JOIN session_system_updates wake_update
        ON wake_update.workspace_id = wake.workspace_id
        AND wake_update.session_id = wake.session_id
        AND wake_update.id::text = wake.payload ->> 'updateId'
      WHERE wake.workspace_id = NEW.workspace_id
        AND wake.session_id = NEW.session_id
        AND wake.sequence = OLD.delivery_reopen_after_sequence + 1
        AND wake.type = 'system.update.pending'
        AND (wake_update.state = 'pending'
          OR (wake_update.state = 'delivered'
            AND wake_update.delivered_turn_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM session_events done
              WHERE done.workspace_id = wake.workspace_id
                AND done.session_id = wake.session_id
                AND done.turn_id = wake_update.delivered_turn_id
                AND done.type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
                AND done.sequence <= NEW.last_delivered_session_event_sequence)))
    ) THEN
      NEW.terminal_delivery_state := 'open';
      NEW.last_delivered_session_event_sequence := greatest(
        NEW.last_delivered_session_event_sequence, OLD.delivery_reopen_after_sequence);
    END IF;
    NEW.delivery_reopen_after_sequence := NULL;
  END IF;
  RETURN NEW;
END $$;

DO $search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.slack_delivery_stays_open_for_wake_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$search_paths$;
REVOKE ALL ON FUNCTION opengeni_private.slack_delivery_stays_open_for_wake_v1() FROM PUBLIC;

SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS slack_interactions_delivery_stays_open_for_wake_v1 ON slack_interactions;
CREATE TRIGGER slack_interactions_delivery_stays_open_for_wake_v1
  BEFORE UPDATE OF terminal_delivery_state ON slack_interactions
  FOR EACH ROW
  WHEN (OLD.terminal_delivery_state = 'open' AND NEW.terminal_delivery_state <> 'open'
    AND OLD.delivery_reopen_after_sequence IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.slack_delivery_stays_open_for_wake_v1();
