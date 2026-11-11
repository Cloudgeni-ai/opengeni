-- deployment-mode: rolling
-- A live-voice minute counts against the member who started the call.
--
-- Live-voice settlement writes a model.cost usage event (source
-- voice_realtime, key voice.realtime_cost:<connection>:<minute>) and then a
-- voice_realtime_debit for the same amount. The debit trigger resolved the
-- member only from an exact attribution receipt or a turn, and no receipt was
-- captured for live voice, so its debits moved the workspace counter but never
-- the member's. A member allowance therefore never filled from live voice.
--
-- The usage-event trigger now captures a receipt for the live-voice cost
-- event exactly as it does for voice input (attribution fields only, keyed by
-- the event's idempotency key, immutable once written), and the debit trigger
-- reads it for a voice_realtime_debit with the same source, key and amount.
-- Free-form debit metadata is still never trusted.
--
-- Rolling: both receipt constraints are replaced NOT VALID to admit the new
-- kind; 1292 validates them. Every existing row satisfies the new
-- definitions. The previous release writes the same events and debits, which
-- these triggers now count; it never reads receipts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.usage_allowance_attribution_receipts
  DROP CONSTRAINT usage_attribution_source_kind,
  ADD CONSTRAINT usage_attribution_source_kind
    CHECK (source_kind IN ('turn', 'schedule', 'knowledge_query', 'voice_transcription',
      'voice_realtime')) NOT VALID;
ALTER TABLE opengeni_private.usage_allowance_attribution_receipts
  DROP CONSTRAINT usage_attribution_source_shape,
  ADD CONSTRAINT usage_attribution_source_shape CHECK (coalesce(
    (source_kind = 'knowledge_query' AND session_id IS NULL AND quantity IS NOT NULL
      AND idempotency_key = 'knowledge.query_cost:' || source_id)
    OR (source_kind = 'voice_transcription' AND session_id IS NULL AND quantity IS NOT NULL
      AND idempotency_key = 'voice.transcription_cost:' || source_id)
    OR (source_kind = 'voice_realtime' AND session_id IS NULL AND quantity IS NOT NULL
      AND idempotency_key = 'voice.realtime_cost:' || source_id)
    OR (source_kind IN ('turn', 'schedule') AND quantity IS NULL AND idempotency_key IS NULL),
    false)) NOT VALID;

-- Same signature; the usage_events branch also captures (and freezes) the
-- live-voice cost event.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION capture_usage_allowance_attribution() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
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
        OR (OLD.source_resource_type='voice_transcription' AND OLD.event_type='model.cost')
        OR (OLD.source_resource_type='voice_realtime' AND OLD.event_type='model.cost'))
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
    ELSIF NEW.source_resource_type='voice_realtime' AND NEW.event_type='model.cost'
      AND NEW.idempotency_key='voice.realtime_cost:'||NEW.source_resource_id THEN
      v_source_kind:='voice_realtime';
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
END $body$
$create$, data_schema);
END $install$;
REVOKE ALL ON FUNCTION capture_usage_allowance_attribution() FROM PUBLIC;

-- Same signature; adds the voice_realtime receipt branch, checked like the
-- voice_transcription one (source, key, amount and debit type).
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION count_workspace_allowance_debit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
DECLARE
  cfg jsonb; p record; c opengeni_private.workspace_allowance_counters%%ROWTYPE; g record;
  saved opengeni_private.workspace_usage_allowances%%ROWTYPE;
  human text; candidate text; amount bigint := -NEW.amount_micros;
  attribution jsonb; billing_workspace uuid;
  grant_allocations jsonb := '[]'::jsonb;
  included bigint := 0; grant_used bigint := 0; pending bigint;
  opened integer;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.amount_micros >= 0 THEN RETURN NULL; END IF;
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND account_id=NEW.account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'allowance debit workspace mismatch' USING ERRCODE='23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:' || NEW.workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  SELECT * INTO saved FROM opengeni_private.workspace_usage_allowances WHERE workspace_id=NEW.workspace_id;
  cfg:=saved.config;
  -- Settlement time, not caller-supplied occurred_at, decides pool expiry and
  -- period. Late settlements cannot spend an already expired historical pool.
  SELECT * INTO p FROM usage_allowance_effective_period(NEW.workspace_id,cfg, clock_timestamp());
  IF cfg IS NOT NULL THEN
    IF saved.active_period_key IS DISTINCT FROM p.period_key THEN
      UPDATE opengeni_private.workspace_allowance_periods
        SET closed_at=coalesce(saved.active_end_at,clock_timestamp())
        WHERE workspace_id=NEW.workspace_id AND period_key=saved.active_period_key AND closed_at IS NULL;
    END IF;
    UPDATE opengeni_private.workspace_usage_allowances SET active_period_key=p.period_key,
      active_start_at=p.start_at,active_end_at=p.end_at WHERE workspace_id=NEW.workspace_id;
  END IF;
  SELECT * INTO c FROM opengeni_private.workspace_allowance_counters
    WHERE workspace_id=NEW.workspace_id AND period_key=p.period_key AND subject_id='';
  IF cfg IS NOT NULL THEN
    included := least(amount,greatest(0,(cfg->>'includedCredits')::bigint-
      (coalesce(c.used,0)-coalesce(c.grants_used,0))));
    pending := amount-included;
    FOR g IN SELECT * FROM opengeni_private.workspace_allowance_grants WHERE workspace_id=NEW.workspace_id
      AND remaining>0 AND (expires_at IS NULL OR expires_at>clock_timestamp())
      ORDER BY expires_at NULLS LAST,created_at,operation_id
    LOOP
      EXIT WHEN pending=0;
      UPDATE opengeni_private.workspace_allowance_grants SET remaining=remaining-least(pending,g.remaining)
        WHERE workspace_id=NEW.workspace_id AND operation_id=g.operation_id;
      grant_allocations:=grant_allocations||jsonb_build_array(
        jsonb_build_object('operationId',g.operation_id,'credits',least(pending,g.remaining)));
      grant_used := grant_used+least(pending,g.remaining);
      pending := pending-least(pending,g.remaining);
    END LOOP;
  END IF;
  INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used,included_used,grants_used)
    VALUES (NEW.workspace_id,NEW.account_id,p.period_key,'',amount,included,grant_used)
  ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET
    used=opengeni_private.workspace_allowance_counters.used+excluded.used,
    included_used=opengeni_private.workspace_allowance_counters.included_used+excluded.included_used,
    grants_used=opengeni_private.workspace_allowance_counters.grants_used+excluded.grants_used;
  -- Exact source receipts take precedence over caller metadata. to_jsonb
  -- allows 0547 to coexist with old writers until 0548 adds the immutable
  -- attribution column; absent legacy receipts remain workspace-only.
  IF NEW.source_type='voice_transcription' THEN
    SELECT receipt.attribution INTO attribution FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.source_kind='voice_transcription' AND receipt.source_id=NEW.source_id
      AND receipt.idempotency_key='voice.transcription_cost:'||NEW.source_id
      AND receipt.quantity=amount AND NEW.type='voice_transcription_debit';
    attribution:=coalesce(attribution,'{"kind":"unknown"}'::jsonb);
  ELSIF NEW.source_type='voice_realtime' THEN
    SELECT receipt.attribution INTO attribution FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.source_kind='voice_realtime' AND receipt.source_id=NEW.source_id
      AND receipt.idempotency_key='voice.realtime_cost:'||NEW.source_id
      AND receipt.quantity=amount AND NEW.type='voice_realtime_debit';
    attribution:=coalesce(attribution,'{"kind":"unknown"}'::jsonb);
  ELSIF NEW.source_type='knowledge_query' THEN
    SELECT receipt.attribution INTO attribution FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.source_kind='knowledge_query' AND receipt.source_id=NEW.source_id
      AND receipt.idempotency_key='knowledge.query_cost:'||NEW.source_id
      AND receipt.quantity=amount;
    attribution:=coalesce(attribution,'{"kind":"unknown"}'::jsonb);
  ELSIF NEW.source_type='scheduled_task_run' THEN
    SELECT receipt.attribution INTO attribution FROM opengeni_private.usage_allowance_attribution_receipts receipt
      WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
        AND receipt.source_kind='schedule' AND receipt.source_id=NEW.source_id;
    attribution:=coalesce(attribution,'{"kind":"unknown"}'::jsonb);
  ELSIF NEW.source_type='knowledge_revision' AND NEW.source_id ~* '^[0-9a-f-]{36}$' THEN
    SELECT to_jsonb(j)->'billing_attribution',
      CASE WHEN e.scope='personal' THEN coalesce(
        (SELECT om.personal_workspace_id FROM organization_memberships om
          WHERE om.account_id=e.account_id AND om.subject_id=e.scope_subject_id AND om.status='active'),
        e.origin_workspace_id) ELSE e.origin_workspace_id END
      INTO attribution,billing_workspace
    FROM knowledge_index_jobs j JOIN knowledge_entries e
      ON e.id=j.entry_id AND e.account_id=j.account_id
    WHERE j.account_id=NEW.account_id AND j.revision_id=NEW.source_id::uuid;
    IF billing_workspace IS DISTINCT FROM NEW.workspace_id THEN attribution:=NULL; END IF;
  ELSIF NEW.source_type='sandbox_lease' AND split_part(NEW.source_id,':',1) ~* '^[0-9a-f-]{36}$'
    AND split_part(NEW.source_id,':',2) ~ '^[0-9]+$' THEN
    SELECT lease.resume_state#>'{opengeniWarmBilling,attribution}' INTO attribution
    FROM sandbox_leases lease WHERE lease.account_id=NEW.account_id AND lease.workspace_id=NEW.workspace_id
      AND lease.sandbox_group_id=split_part(NEW.source_id,':',1)::uuid
      AND lease.lease_epoch=split_part(NEW.source_id,':',2)::integer;
  END IF;
  -- Verified source receipts freeze the causal human alongside the turn.
  -- Personal Knowledge can outlive/rebind away from the turn's workspace;
  -- its retained receipt remains authoritative without widening turn reads.
  IF attribution->>'kind' IN ('human','turn') THEN human:=attribution->>'initiatingHumanSubjectId'; END IF;
  candidate := CASE WHEN attribution IS NOT NULL THEN NULL
    WHEN NEW.source_type IN ('session_turn','model_response')
    THEN CASE WHEN split_part(NEW.source_id,':',1) ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN split_part(NEW.source_id,':',1) ELSE NEW.metadata->>'turnId' END
    ELSE NEW.metadata->>'turnId' END;
  IF human IS NULL AND candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT receipt.attribution->>'initiatingHumanSubjectId' INTO human
    FROM opengeni_private.usage_allowance_attribution_receipts receipt
      WHERE receipt.source_kind='turn' AND receipt.source_id=candidate::uuid::text
        AND receipt.workspace_id=NEW.workspace_id AND receipt.account_id=NEW.account_id;
  END IF;
  IF human IS NOT NULL THEN
    INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used)
      VALUES (NEW.workspace_id,NEW.account_id,p.period_key,human,amount)
    ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET used=opengeni_private.workspace_allowance_counters.used+excluded.used;
  END IF;
  IF NEW.type='video_generation_debit' AND NEW.source_type='video_generation_operation'
    AND NEW.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NEW.idempotency_key='credit:video_generation_debit:'||NEW.source_id THEN
    INSERT INTO opengeni_private.workspace_video_allowance_allocations
      (ledger_id,account_id,workspace_id,operation_id,period_key,human_subject_id,
        amount,included_used,grants_used,grant_allocations)
    VALUES(NEW.id,NEW.account_id,NEW.workspace_id,NEW.source_id::uuid,p.period_key,human,
      amount,included,grant_used,grant_allocations);
  END IF;
  PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());
  UPDATE opengeni_private.workspace_usage_allowances SET maintenance_next_at=least(maintenance_next_at,clock_timestamp())
    WHERE workspace_id=NEW.workspace_id;
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=TG_TABLE_SCHEMA AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NULL;
END $body$
$create$, data_schema);
END $install$;
REVOKE ALL ON FUNCTION count_workspace_allowance_debit() FROM PUBLIC;
