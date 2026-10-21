-- deployment-mode: rolling
-- Install only after the keyed ledger lookup index from 0893 is available.
-- Capture committed arrivals, not timestamps pretending to be commit order.
-- Reopening a claimed key prevents a concurrent repair from losing a delayed
-- event. The consumer deletes only its own batch, never a reopened key.
CREATE FUNCTION model_fact_reconciliation_enqueue()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE ledger record;
BEGIN
  IF TG_TABLE_NAME = 'usage_events' THEN
    IF TG_OP = 'UPDATE' AND
      (OLD.session_id,OLD.turn_id,OLD.source_resource_type,OLD.source_resource_id,OLD.event_type)
      IS NOT DISTINCT FROM
      (NEW.session_id,NEW.turn_id,NEW.source_resource_type,NEW.source_resource_id,NEW.event_type) THEN
      RETURN NEW;
    END IF;
    ledger := NEW;
  ELSE
    IF NEW.turn_association <> 'current' OR NEW.turn_id IS NULL
      OR jsonb_typeof(NEW.payload->'sourceKey') <> 'string' THEN
      RETURN NEW;
    END IF;
    SELECT account_id,workspace_id,session_id,turn_id,source_resource_type,source_resource_id,occurred_at
      INTO ledger FROM usage_events
      WHERE workspace_id=NEW.workspace_id AND event_type='model.cost'
        AND source_resource_id=NEW.turn_id::text||':'||(NEW.payload->>'sourceKey')
        AND source_resource_type='model_response'
      LIMIT 1;
    IF NOT FOUND THEN RETURN NEW; END IF;
  END IF;
  IF ledger.session_id IS NULL OR ledger.turn_id IS NULL
    OR ledger.source_resource_type IS DISTINCT FROM 'model_response'
    OR left(ledger.source_resource_id,37) IS DISTINCT FROM ledger.turn_id::text||':' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM model_call_facts WHERE workspace_id=ledger.workspace_id
    AND turn_id=ledger.turn_id AND source_key=substr(ledger.source_resource_id,38)) THEN
    RETURN NEW;
  END IF;
  INSERT INTO model_call_fact_reconciliation_candidates
    (account_id,workspace_id,session_id,turn_id,source_key,occurred_at)
    VALUES (ledger.account_id,ledger.workspace_id,ledger.session_id,ledger.turn_id,
      substr(ledger.source_resource_id,38),ledger.occurred_at)
    ON CONFLICT (workspace_id,turn_id,source_key) DO UPDATE SET batch_id=NULL
      WHERE model_call_fact_reconciliation_candidates.batch_id IS NOT NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION model_fact_reconciliation_enqueue() FROM PUBLIC;
CREATE TRIGGER model_fact_reconciliation_ledger_arrival
  AFTER INSERT OR UPDATE OF session_id,turn_id,source_resource_type,source_resource_id,event_type
  ON usage_events FOR EACH ROW
  WHEN (NEW.event_type='model.cost') EXECUTE FUNCTION model_fact_reconciliation_enqueue();
CREATE TRIGGER model_fact_reconciliation_event_arrival
  AFTER INSERT ON session_events FOR EACH ROW
  WHEN (NEW.type='agent.model.usage') EXECUTE FUNCTION model_fact_reconciliation_enqueue();
