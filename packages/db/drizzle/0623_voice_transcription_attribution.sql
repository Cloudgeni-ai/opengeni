-- deployment-mode: rolling
-- Retain exact transcription payer receipts for member allowance attribution.
-- The API freezes the authenticated payer; ledger metadata alone is not proof.
DO $constraints$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='opengeni_private.usage_allowance_attribution_receipts'::regclass AND contype='c'
  LOOP
    IF (item.definition LIKE '%source_kind%' AND item.definition LIKE '%knowledge_query%') THEN
      EXECUTE format('ALTER TABLE opengeni_private.usage_allowance_attribution_receipts DROP CONSTRAINT %I',item.conname);
    END IF;
  END LOOP;
END $constraints$;
ALTER TABLE opengeni_private.usage_allowance_attribution_receipts
  ADD CONSTRAINT usage_attribution_source_kind CHECK (source_kind IN ('turn','schedule','knowledge_query','voice_transcription')),
  ADD CONSTRAINT usage_attribution_source_shape CHECK (coalesce(
    (source_kind='knowledge_query' AND session_id IS NULL AND quantity IS NOT NULL
      AND idempotency_key='knowledge.query_cost:'||source_id)
    OR (source_kind='voice_transcription' AND session_id IS NULL AND quantity IS NOT NULL
      AND idempotency_key='voice.transcription_cost:'||source_id)
    OR (source_kind IN ('turn','schedule') AND quantity IS NULL AND idempotency_key IS NULL),false));

CREATE OR REPLACE FUNCTION capture_usage_allowance_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  v_source_kind text; v_source_id text; v_session_id uuid; v_attribution jsonb;
  v_quantity bigint; v_idempotency_key text; opened integer;
BEGIN
  IF TG_TABLE_NAME='session_turns' THEN
    IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.initiating_human_subject_id IS DISTINCT FROM OLD.initiating_human_subject_id) THEN
      RAISE EXCEPTION 'Allowance turn attribution is immutable' USING ERRCODE='23514';
    END IF;
    v_source_kind:='turn'; v_source_id:=NEW.id::text; v_session_id:=NEW.session_id;
    v_attribution:=jsonb_build_object('kind','turn','turnId',NEW.id,
      'initiatingHumanSubjectId',NEW.initiating_human_subject_id);
  ELSIF TG_TABLE_NAME='scheduled_task_runs' THEN
    IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.accepted_execution_snapshot->'causalHumanSubjectId' IS DISTINCT FROM
        OLD.accepted_execution_snapshot->'causalHumanSubjectId') THEN
      RAISE EXCEPTION 'Allowance scheduled attribution is immutable' USING ERRCODE='23514';
    END IF;
    v_source_kind:='schedule'; v_source_id:=NEW.id::text;
    v_attribution:=CASE WHEN NOT coalesce(NEW.accepted_execution_snapshot ? 'causalHumanSubjectId',false)
      THEN '{"kind":"unknown"}'::jsonb
      WHEN NEW.accepted_execution_snapshot->>'causalHumanSubjectId' IS NULL THEN '{"kind":"service"}'::jsonb
      ELSE jsonb_build_object('kind','human',
        'initiatingHumanSubjectId',NEW.accepted_execution_snapshot->>'causalHumanSubjectId') END;
  ELSIF TG_TABLE_NAME='usage_events' THEN
    IF TG_OP='UPDATE' THEN
      IF ((OLD.source_resource_type='knowledge_query' AND OLD.event_type='document.query_embedding_cost')
        OR (OLD.source_resource_type='voice_transcription' AND OLD.event_type='model.cost'))
        AND (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
          OR NEW.source_resource_type IS DISTINCT FROM OLD.source_resource_type
          OR NEW.source_resource_id IS DISTINCT FROM OLD.source_resource_id
          OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.quantity IS DISTINCT FROM OLD.quantity
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.initiator_context->'creditDebitAttribution' IS DISTINCT FROM
            OLD.initiator_context->'creditDebitAttribution') THEN
        RAISE EXCEPTION 'Allowance query attribution is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.workspace_id IS NULL OR NEW.source_resource_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.source_resource_type='knowledge_query' AND NEW.event_type='document.query_embedding_cost'
      AND NEW.idempotency_key='knowledge.query_cost:'||NEW.source_resource_id THEN
      v_source_kind:='knowledge_query';
    ELSIF NEW.source_resource_type='voice_transcription' AND NEW.event_type='model.cost'
      AND NEW.idempotency_key='voice.transcription_cost:'||NEW.source_resource_id THEN
      v_source_kind:='voice_transcription';
    ELSE RETURN NEW;
    END IF;
    v_source_id:=NEW.source_resource_id;
    v_quantity:=NEW.quantity; v_idempotency_key:=NEW.idempotency_key;
    -- Copy only attribution fields, never the initiator envelope/query/content.
    v_attribution:=NEW.initiator_context->'creditDebitAttribution';
    v_attribution:=CASE v_attribution->>'kind'
      WHEN 'human' THEN jsonb_build_object('kind','human',
        'initiatingHumanSubjectId',v_attribution->'initiatingHumanSubjectId')
      WHEN 'turn' THEN jsonb_build_object('kind','turn','turnId',v_attribution->'turnId',
        'initiatingHumanSubjectId',v_attribution->'initiatingHumanSubjectId')
      WHEN 'service' THEN '{"kind":"service"}'::jsonb
      ELSE '{"kind":"unknown"}'::jsonb END;
  ELSE
    RAISE EXCEPTION 'Unknown allowance attribution source' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened=ROW_COUNT;
  INSERT INTO opengeni_private.usage_allowance_attribution_receipts
    (account_id,workspace_id,source_kind,source_id,session_id,attribution,quantity,idempotency_key)
    VALUES(NEW.account_id,NEW.workspace_id,v_source_kind,v_source_id,v_session_id,v_attribution,v_quantity,v_idempotency_key);
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=TG_TABLE_SCHEMA AND account_id=NEW.account_id AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NEW;
END $$;

DO $debit$
DECLARE definition text:=pg_get_functiondef('count_workspace_allowance_debit()'::regprocedure);
  anchor text:=$anchor$IF NEW.source_type='knowledge_query' THEN$anchor$;
  replacement text:=$replacement$IF NEW.source_type='voice_transcription' THEN
    SELECT receipt.attribution INTO attribution FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.source_kind='voice_transcription' AND receipt.source_id=NEW.source_id
      AND receipt.idempotency_key='voice.transcription_cost:'||NEW.source_id
      AND receipt.quantity=amount AND NEW.type='voice_transcription_debit';
    attribution:=coalesce(attribution,'{"kind":"unknown"}'::jsonb);
  ELSIF NEW.source_type='knowledge_query' THEN$replacement$;
BEGIN
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION 'Unexpected allowance debit source branch' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $debit$;

DO $harden$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.capture_usage_allowance_attribution() SET search_path=pg_catalog,%I,pg_temp', current_schema(), current_schema());
END $harden$;
