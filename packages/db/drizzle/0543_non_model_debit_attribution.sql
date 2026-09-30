-- deployment-mode: rolling
-- Preserve causal billing facts before asynchronous Knowledge dispatch. Null
-- creator/owner labels are not proof of service work or human authentication.
ALTER TABLE documents ADD COLUMN billing_attribution jsonb
  NOT NULL DEFAULT '{"kind":"unknown"}'::jsonb;
ALTER TABLE documents ADD CONSTRAINT documents_billing_attribution_check
  CHECK (jsonb_typeof(billing_attribution)='object' AND coalesce(CASE billing_attribution->>'kind'
    WHEN 'unknown' THEN billing_attribution='{"kind":"unknown"}'::jsonb
    WHEN 'service' THEN billing_attribution='{"kind":"service"}'::jsonb
    WHEN 'human' THEN jsonb_typeof(billing_attribution->'initiatingHumanSubjectId')='string'
      AND octet_length(billing_attribution->>'initiatingHumanSubjectId') BETWEEN 1 AND 1024
    WHEN 'turn' THEN coalesce(billing_attribution->>'turnId','') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND (billing_attribution->'initiatingHumanSubjectId'='null'::jsonb OR
        (jsonb_typeof(billing_attribution->'initiatingHumanSubjectId')='string'
          AND octet_length(billing_attribution->>'initiatingHumanSubjectId') BETWEEN 1 AND 1024))
    ELSE false END,false));
ALTER TABLE knowledge_index_jobs ADD COLUMN billing_attribution jsonb
  NOT NULL DEFAULT '{"kind":"unknown"}'::jsonb;
ALTER TABLE knowledge_index_jobs ADD CONSTRAINT knowledge_index_billing_attribution_check
  CHECK (jsonb_typeof(billing_attribution)='object' AND coalesce(CASE billing_attribution->>'kind'
    WHEN 'unknown' THEN billing_attribution='{"kind":"unknown"}'::jsonb
    WHEN 'service' THEN billing_attribution='{"kind":"service"}'::jsonb
    WHEN 'human' THEN jsonb_typeof(billing_attribution->'initiatingHumanSubjectId')='string'
      AND octet_length(billing_attribution->>'initiatingHumanSubjectId') BETWEEN 1 AND 1024
    WHEN 'turn' THEN coalesce(billing_attribution->>'turnId','') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND (billing_attribution->'initiatingHumanSubjectId'='null'::jsonb OR
        (jsonb_typeof(billing_attribution->'initiatingHumanSubjectId')='string'
          AND octet_length(billing_attribution->>'initiatingHumanSubjectId') BETWEEN 1 AND 1024))
    ELSE false END,false));

CREATE OR REPLACE FUNCTION knowledge_enqueue_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  attribution jsonb := '{"kind":"unknown"}'::jsonb;
  causal_turn session_turns%ROWTYPE;
  preparation jsonb;
  accepted jsonb;
  document_attribution jsonb;
  billing_workspace uuid := nullif(current_setting('opengeni.workspace_id',true),'')::uuid;
  opened integer;
  previous text := current_setting('opengeni.knowledge_index_dispatcher',true);
BEGIN
  IF NEW.change_kind='archive' THEN RETURN NEW; END IF;
  -- The accepted actor's publication transaction is trusted; the trigger
  -- needs only the same tenant's immutable initiating facts through FORCE-RLS,
  -- including private turns. Reuse 0542's exact owner-only SELECT capability.
  INSERT INTO opengeni_private.usage_allowance_capabilities
    VALUES(pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,billing_workspace)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  -- knowledge_entry_apply already resolved the trusted actor and held the exact
  -- attempt/publication locks. Do not read a session's latest turn or creator.
  IF NEW.actor->>'kind'='agent' THEN
    SELECT * INTO causal_turn FROM session_turns t
      WHERE t.account_id=NEW.account_id AND t.id=NEW.created_by_turn_id
        AND t.session_id=NEW.created_by_session_id
        AND t.id::text=NEW.actor->>'turnId';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Knowledge initiating turn unavailable' USING ERRCODE='42501';
    END IF;
    attribution:=jsonb_build_object('kind','turn','turnId',causal_turn.id,
      'initiatingHumanSubjectId',causal_turn.initiating_human_subject_id);
  ELSIF NEW.actor->>'kind'='human' AND NEW.actor->>'principalKind'='human_session'
    AND current_setting('opengeni.knowledge_actor_kind',true)='human'
    AND NEW.actor->>'subjectId'=nullif(current_setting('opengeni.subject_id',true),'') THEN
    attribution:=jsonb_build_object('kind','human',
      'initiatingHumanSubjectId',NEW.actor->>'subjectId');
  ELSIF NEW.actor->>'kind'='service'
    AND current_setting('opengeni.knowledge_actor_kind',true)='service' THEN
    attribution:='{"kind":"service"}'::jsonb;
  ELSIF NEW.actor->>'kind'='source_preparation' THEN
    -- The preparation lease retains the accepted scheduled occurrence, not a
    -- mutable task creator. Older direct uploads have only created_by/ownership
    -- labels and remain unknown rather than falsely becoming service debits.
    SELECT e.document_preparation,d.billing_attribution INTO preparation,document_attribution
      FROM knowledge_entries e LEFT JOIN documents d
        ON d.account_id=e.account_id AND d.id=e.legacy_document_id
      WHERE e.account_id=NEW.account_id AND e.id=NEW.entry_id;
    IF preparation->>'scheduledTaskRunId' IS NOT NULL THEN
      SELECT r.accepted_execution_snapshot INTO accepted FROM scheduled_task_runs r
        WHERE r.account_id=NEW.account_id AND r.id=(preparation->>'scheduledTaskRunId')::uuid;
      IF accepted ? 'causalHumanSubjectId' THEN
        attribution:=CASE WHEN accepted->>'causalHumanSubjectId' IS NULL
          THEN '{"kind":"service"}'::jsonb
          ELSE jsonb_build_object('kind','human',
            'initiatingHumanSubjectId',accepted->>'causalHumanSubjectId') END;
      END IF;
    ELSE
      attribution:=coalesce(document_attribution,'{"kind":"unknown"}'::jsonb);
    END IF;
  END IF;
  PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
  INSERT INTO knowledge_index_jobs(account_id,entry_id,revision_id,billing_attribution)
    VALUES(NEW.account_id,NEW.entry_id,NEW.id,attribution);
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=TG_TABLE_SCHEMA AND account_id=NEW.account_id AND workspace_id=billing_workspace;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;

CREATE FUNCTION knowledge_index_attribution_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.billing_attribution IS DISTINCT FROM OLD.billing_attribution THEN
    RAISE EXCEPTION 'Knowledge initiating attribution is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_index_attribution_immutable BEFORE UPDATE ON knowledge_index_jobs
  FOR EACH ROW EXECUTE FUNCTION knowledge_index_attribution_immutable();
CREATE TRIGGER document_billing_attribution_immutable BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION knowledge_index_attribution_immutable();

-- Recovery may replace routing/envelope fields and cold admission may start a
-- new priced epoch. While the admitted provider exists, its causal payer is
-- immutable even if another member joins or an async cleanup rewrites state.
CREATE FUNCTION sandbox_warm_attribution_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.liveness<>'cold' AND NEW.liveness<>'cold'
    AND OLD.resume_state#>>'{opengeniWarmBilling,mode}'='credits'
    AND NEW.resume_state#>'{opengeniWarmBilling,attribution}' IS DISTINCT FROM
      OLD.resume_state#>'{opengeniWarmBilling,attribution}' THEN
    RAISE EXCEPTION 'Sandbox initiating attribution is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sandbox_warm_attribution_immutable BEFORE UPDATE ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION sandbox_warm_attribution_immutable();

-- Query-cost usage receipts precede their debit in the same transaction. Keep
-- their exact source/amount and trusted initiating snapshot immutable while
-- allowing normal billing export bookkeeping on the usage row.
CREATE FUNCTION knowledge_query_billing_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.source_resource_type='knowledge_query'
    AND OLD.event_type='document.query_embedding_cost'
    AND OLD.initiator_context ? 'creditDebitAttribution'
    AND (NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.source_resource_type IS DISTINCT FROM OLD.source_resource_type
      OR NEW.source_resource_id IS DISTINCT FROM OLD.source_resource_id
      OR NEW.event_type IS DISTINCT FROM OLD.event_type
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.initiator_context->'creditDebitAttribution' IS DISTINCT FROM
        OLD.initiator_context->'creditDebitAttribution') THEN
    RAISE EXCEPTION 'Knowledge query billing receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_query_billing_receipt_immutable BEFORE UPDATE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION knowledge_query_billing_receipt_immutable();

-- The existing managed-video protocol debits before provider submission and
-- refunds a definite failure/cancel. Record the actual debit's allocation so
-- its refund removes phantom spend without repricing under today's policy.
-- This is an accounting receipt, not a new compute/credit reservation.
CREATE TABLE workspace_video_allowance_allocations (
  ledger_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  period_key text NOT NULL,
  human_subject_id text,
  amount bigint NOT NULL CHECK(amount>0),
  included_used bigint NOT NULL CHECK(included_used>=0 AND included_used<=amount),
  grants_used bigint NOT NULL CHECK(grants_used>=0 AND grants_used<=amount-included_used),
  grant_allocations jsonb NOT NULL CHECK(jsonb_typeof(grant_allocations)='array'),
  reversed_by_ledger_id uuid,
  FOREIGN KEY(workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE,
  CHECK(human_subject_id IS NULL OR octet_length(human_subject_id) BETWEEN 1 AND 1024)
);
CREATE UNIQUE INDEX workspace_video_allowance_allocations_operation_idx
  ON workspace_video_allowance_allocations(account_id,workspace_id,operation_id);
ALTER TABLE workspace_video_allowance_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_video_allowance_allocations FORCE ROW LEVEL SECURITY;
DO $video_allocation_policy$
DECLARE owner_name text:=current_user; target_schema text:=current_schema();
BEGIN
  EXECUTE format('CREATE POLICY usage_allowance_owner ON workspace_video_allowance_allocations
    FOR ALL USING(current_user=%L AND %I.usage_allowance_capability_active(account_id,workspace_id))
    WITH CHECK(current_user=%L AND %I.usage_allowance_capability_active(account_id,workspace_id))',
    owner_name,target_schema,owner_name,target_schema);
END $video_allocation_policy$;
REVOKE ALL ON TABLE workspace_video_allowance_allocations FROM PUBLIC;

-- Amend only the current 0542 declaration/allocation/attribution boundaries.
-- Exact unique anchors reject a changed implementation instead of silently
-- losing either attribution or grant restoration during a future migration.
-- The DO only installs a function body, never executes its embedded INSERT.
-- Keep its migration-time owner posture explicit for the static RLS guard.
ALTER TABLE workspace_video_allowance_allocations NO FORCE ROW LEVEL SECURITY;
DO $video_allocation_capture$
DECLARE
  definition text:=pg_get_functiondef('count_workspace_allowance_debit()'::regprocedure);
  anchor text;
  replacement text;
BEGIN
  anchor:='attribution jsonb; billing_workspace uuid;';
  replacement:=anchor||E'\n  grant_allocations jsonb := ''[]''::jsonb;';
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0543 unexpected allowance attribution declaration' USING ERRCODE='55000';
  END IF;
  definition:=replace(definition,anchor,replacement);
  anchor:='grant_used := grant_used+least(pending,g.remaining);';
  replacement:=$capture_grant$grant_allocations:=grant_allocations||jsonb_build_array(
        jsonb_build_object('operationId',g.operation_id,'credits',least(pending,g.remaining)));
      grant_used := grant_used+least(pending,g.remaining);$capture_grant$;
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0543 unexpected allowance grant allocation' USING ERRCODE='55000';
  END IF;
  definition:=replace(definition,anchor,replacement);
  anchor:=$candidate$CASE WHEN attribution->>'kind'='turn' THEN attribution->>'turnId'
    WHEN attribution IS NOT NULL THEN NULL$candidate$;
  replacement:='CASE WHEN attribution IS NOT NULL THEN NULL';
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0543 unexpected allowance source candidate' USING ERRCODE='55000';
  END IF;
  definition:=replace(definition,anchor,replacement);
  anchor:='PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());';
  replacement:=$capture_video$IF NEW.type='video_generation_debit' AND NEW.source_type='video_generation_operation'
    AND NEW.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NEW.idempotency_key='credit:video_generation_debit:'||NEW.source_id THEN
    INSERT INTO workspace_video_allowance_allocations
      (ledger_id,account_id,workspace_id,operation_id,period_key,human_subject_id,
        amount,included_used,grants_used,grant_allocations)
    VALUES(NEW.id,NEW.account_id,NEW.workspace_id,NEW.source_id::uuid,p.period_key,human,
      amount,included,grant_used,grant_allocations);
  END IF;
  PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());$capture_video$;
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0543 unexpected allowance debit settlement boundary' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $video_allocation_capture$;
ALTER TABLE workspace_video_allowance_allocations FORCE ROW LEVEL SECURITY;

CREATE FUNCTION reverse_video_allowance_refund() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  allocation workspace_video_allowance_allocations%ROWTYPE;
  grant_allocation jsonb;
  restored bigint:=0;
  affected integer;
  opened integer;
  cfg jsonb;
  grant_expiry timestamptz;
  original_snapshot_at timestamptz;
  existing_counted_debit boolean;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.type<>'video_generation_refund'
    OR NEW.source_type<>'video_generation_operation' OR NEW.amount_micros<=0
    OR NEW.idempotency_key IS DISTINCT FROM 'credit:video_generation_refund:'||NEW.source_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:'||NEW.workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened=ROW_COUNT;
  SELECT * INTO allocation FROM workspace_video_allowance_allocations
    WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
      AND operation_id::text=NEW.source_id FOR UPDATE;
  IF FOUND THEN
    IF allocation.reversed_by_ledger_id IS NOT NULL OR allocation.amount<>NEW.amount_micros THEN
      RAISE EXCEPTION 'Video allowance refund does not match its debit' USING ERRCODE='23514';
    END IF;
    UPDATE workspace_allowance_counters SET used=used-allocation.amount,
      included_used=included_used-allocation.included_used,
      grants_used=grants_used-allocation.grants_used
    WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
      AND period_key=allocation.period_key AND subject_id='';
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN
      RAISE EXCEPTION 'Video allowance refund counter unavailable' USING ERRCODE='23514';
    END IF;
    IF allocation.human_subject_id IS NOT NULL THEN
      UPDATE workspace_allowance_counters SET used=used-allocation.amount
      WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
        AND period_key=allocation.period_key AND subject_id=allocation.human_subject_id;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN
        RAISE EXCEPTION 'Video allowance refund member counter unavailable' USING ERRCODE='23514';
      END IF;
    END IF;
    FOR grant_allocation IN SELECT value FROM jsonb_array_elements(allocation.grant_allocations) LOOP
      UPDATE workspace_allowance_grants SET remaining=remaining+(grant_allocation->>'credits')::bigint
        WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
          AND operation_id=grant_allocation->>'operationId'
        RETURNING expires_at INTO grant_expiry;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN
        RAISE EXCEPTION 'Video allowance refund grant unavailable' USING ERRCODE='23514';
      END IF;
      restored:=restored+(grant_allocation->>'credits')::bigint;
      SELECT updated_at INTO original_snapshot_at FROM workspace_allowance_periods
        WHERE workspace_id=NEW.workspace_id AND period_key=allocation.period_key;
      IF original_snapshot_at IS NOT NULL THEN
        -- Preserve the original period's observed expiry boundary and policy;
        -- append only the restored portion, not today's unrelated grant pool.
        UPDATE workspace_allowance_periods SET
          grants_remaining=grants_remaining+CASE WHEN grant_expiry IS NULL
            OR grant_expiry>original_snapshot_at THEN (grant_allocation->>'credits')::bigint ELSE 0 END,
          grants_snapshot=grants_snapshot||jsonb_build_array(jsonb_build_object(
            'remaining',(grant_allocation->>'credits')::bigint,'expiresAt',grant_expiry))
        WHERE workspace_id=NEW.workspace_id AND period_key=allocation.period_key;
      END IF;
    END LOOP;
    IF restored<>allocation.grants_used THEN
      RAISE EXCEPTION 'Video allowance refund allocation mismatch' USING ERRCODE='23514';
    END IF;
    UPDATE workspace_video_allowance_allocations SET reversed_by_ledger_id=NEW.id
      WHERE ledger_id=allocation.ledger_id;
    -- Expired grants stay expired. Historical counters use their original
    -- period; only a still-current observed snapshot sees the restored pool.
    SELECT config INTO cfg FROM workspace_usage_allowances WHERE workspace_id=NEW.workspace_id;
    PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());
  ELSE
    -- A refund of an old pre-allowance operation has no counters to reverse.
    -- A debit committed while 0542 was active but before allocation capture
    -- is ambiguous: refuse atomic refund settlement instead of silently
    -- retaining phantom usage or guessing its included/grant allocation.
    SELECT EXISTS(SELECT 1 FROM credit_ledger_entries debit
      WHERE debit.account_id=NEW.account_id AND debit.workspace_id=NEW.workspace_id
        AND debit.source_type='video_generation_operation' AND debit.source_id=NEW.source_id
        AND debit.type='video_generation_debit' AND debit.amount_micros=-NEW.amount_micros
        AND EXISTS(SELECT 1 FROM workspace_allowance_counters
          WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND used>0))
      INTO existing_counted_debit;
    IF existing_counted_debit THEN
      RAISE EXCEPTION 'Video allowance refund has no original allocation receipt' USING ERRCODE='23514';
    END IF;
  END IF;
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=TG_TABLE_SCHEMA AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER credit_ledger_video_allowance_refund AFTER INSERT ON credit_ledger_entries
  FOR EACH ROW WHEN(NEW.amount_micros>0 AND NEW.type='video_generation_refund')
  EXECUTE FUNCTION reverse_video_allowance_refund();
REVOKE ALL ON FUNCTION reverse_video_allowance_refund() FROM PUBLIC;

DO $nonmodel_attribution_acl$
DECLARE target_schema text:=current_schema(); routine text; principal text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'knowledge_enqueue_index()','knowledge_index_attribution_immutable()',
    'sandbox_warm_attribution_immutable()','knowledge_query_billing_receipt_immutable()',
    'reverse_video_allowance_refund()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,routine,target_schema);
    FOR principal IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=format('%I.%s',target_schema,routine)::regprocedure AND acl.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,routine,principal); END LOOP;
  END LOOP;
  FOR principal IN SELECT DISTINCT r.rolname FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE c.oid='workspace_video_allowance_allocations'::regclass AND acl.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE workspace_video_allowance_allocations FROM %I',principal); END LOOP;
END $nonmodel_attribution_acl$;

CREATE OR REPLACE FUNCTION knowledge_index_claim(p_model text,p_dimensions integer,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE previous text:=current_setting('opengeni.knowledge_index_dispatcher',true); result jsonb;
BEGIN
  IF p_model IS NULL OR p_dimensions IS NULL OR p_limit IS NULL OR length(p_model) NOT BETWEEN 1 AND 512 OR p_dimensions NOT BETWEEN 1 AND 4096 OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid Knowledge indexing claim' USING ERRCODE='22023'; END IF;
  PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
  WITH candidates AS (
    SELECT j.revision_id FROM knowledge_index_jobs j WHERE j.state<>'obsolete' AND j.next_attempt_at<=clock_timestamp()
      AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
      AND (j.state<>'ready' OR j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions)
    ORDER BY j.next_attempt_at,j.revision_id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE knowledge_index_jobs j SET state='running',lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',
      generation=CASE WHEN j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions THEN j.generation+1 ELSE j.generation END,
      next_index=CASE WHEN j.model IS DISTINCT FROM p_model OR j.dimensions IS DISTINCT FROM p_dimensions THEN 0 ELSE j.next_index END,
      model=p_model,dimensions=p_dimensions,attempts=j.attempts+1
    FROM candidates c WHERE j.revision_id=c.revision_id RETURNING j.*
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',account_id,'entryId',entry_id,'revisionId',revision_id,
    'leaseId',lease_id,'model',model,'dimensions',dimensions,'generation',generation,'nextIndex',next_index,
    'billingAttribution',billing_attribution)),'[]'::jsonb) INTO result FROM claimed;
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge_enqueue_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge_index_attribution_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_warm_attribution_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge_query_billing_receipt_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge_index_claim(text,integer,integer) FROM PUBLIC;