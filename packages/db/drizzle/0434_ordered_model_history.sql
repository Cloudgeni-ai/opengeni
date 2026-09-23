-- deployment-mode: maintenance
-- Drain writers. Preserve model history order in PostgreSQL json; keep existing
-- jsonb columns as synchronized query/legacy-writer projections. Old rows can
-- only preserve the ordering already present when this migration runs.

ALTER TABLE session_history_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_history_items ADD COLUMN item_ordered json;
UPDATE session_history_items SET item_ordered = item::json;
ALTER TABLE session_history_items FORCE ROW LEVEL SECURITY;
CREATE FUNCTION sync_session_history_items_ordered() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.item_ordered IS NULL THEN
      NEW.item_ordered := NEW.item::json;
    ELSE
      NEW.item := NEW.item_ordered::jsonb;
    END IF;
  ELSIF NEW.item_ordered::text IS DISTINCT FROM OLD.item_ordered::text THEN
    NEW.item := NEW.item_ordered::jsonb;
  ELSIF NEW.item IS DISTINCT FROM OLD.item THEN
    NEW.item_ordered := NEW.item::json;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER a_sync_ordered_model_history BEFORE INSERT OR UPDATE OF item, item_ordered ON session_history_items
FOR EACH ROW EXECUTE FUNCTION sync_session_history_items_ordered();

ALTER TABLE session_pending_tool_calls NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_pending_tool_calls ADD COLUMN call_item_ordered json;
UPDATE session_pending_tool_calls SET call_item_ordered = call_item::json;
ALTER TABLE session_pending_tool_calls ADD COLUMN result_item_ordered json;
UPDATE session_pending_tool_calls SET result_item_ordered = result_item::json;
ALTER TABLE session_pending_tool_calls ADD COLUMN tied_reasoning_items_ordered json;
UPDATE session_pending_tool_calls SET tied_reasoning_items_ordered = tied_reasoning_items::json;
ALTER TABLE session_pending_tool_calls FORCE ROW LEVEL SECURITY;
CREATE FUNCTION sync_session_pending_tool_calls_ordered() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.call_item_ordered IS NULL THEN
      NEW.call_item_ordered := NEW.call_item::json;
    ELSE
      NEW.call_item := NEW.call_item_ordered::jsonb;
    END IF;
  ELSIF NEW.call_item_ordered::text IS DISTINCT FROM OLD.call_item_ordered::text THEN
    NEW.call_item := NEW.call_item_ordered::jsonb;
  ELSIF NEW.call_item IS DISTINCT FROM OLD.call_item THEN
    NEW.call_item_ordered := NEW.call_item::json;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.result_item_ordered IS NULL THEN
      NEW.result_item_ordered := NEW.result_item::json;
    ELSE
      NEW.result_item := NEW.result_item_ordered::jsonb;
    END IF;
  ELSIF NEW.result_item_ordered::text IS DISTINCT FROM OLD.result_item_ordered::text THEN
    NEW.result_item := NEW.result_item_ordered::jsonb;
  ELSIF NEW.result_item IS DISTINCT FROM OLD.result_item THEN
    NEW.result_item_ordered := NEW.result_item::json;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.tied_reasoning_items_ordered IS NULL THEN
      NEW.tied_reasoning_items_ordered := NEW.tied_reasoning_items::json;
    ELSE
      NEW.tied_reasoning_items := NEW.tied_reasoning_items_ordered::jsonb;
    END IF;
  ELSIF NEW.tied_reasoning_items_ordered::text IS DISTINCT FROM OLD.tied_reasoning_items_ordered::text THEN
    NEW.tied_reasoning_items := NEW.tied_reasoning_items_ordered::jsonb;
  ELSIF NEW.tied_reasoning_items IS DISTINCT FROM OLD.tied_reasoning_items THEN
    NEW.tied_reasoning_items_ordered := NEW.tied_reasoning_items::json;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER a_sync_ordered_model_history BEFORE INSERT OR UPDATE OF call_item, call_item_ordered, result_item, result_item_ordered, tied_reasoning_items, tied_reasoning_items_ordered ON session_pending_tool_calls
FOR EACH ROW EXECUTE FUNCTION sync_session_pending_tool_calls_ordered();

-- Fork both lifecycle overloads without changing their authority or receipt logic.
-- Carry the ordered representation through the existing transaction-local spool.
DO $migration$
DECLARE candidate record; definition text; updated text;
BEGIN
  FOR candidate IN SELECT oid FROM pg_proc WHERE proname = 'fork_session_content'
    AND pronamespace = current_schema()::regnamespace
  LOOP
    definition := pg_get_functiondef(candidate.oid);
    IF position('opengeni_session_fork_history_spool' in definition) = 0 THEN CONTINUE; END IF;
    updated := replace(definition, 'item jsonb NOT NULL,', 'item jsonb NOT NULL, item_ordered json NOT NULL,');
    updated := replace(updated, 'position, item, item_codec_version, active,', 'position, item, item_ordered, item_codec_version, active,');
    updated := replace(updated, 'source_item.position, source_item.item,', 'source_item.position, source_item.item, source_item.item_ordered,');
    IF updated = definition THEN RAISE EXCEPTION 'ordered history fork rewrite did not match'; END IF;
    EXECUTE updated;
  END LOOP;
END
$migration$;
