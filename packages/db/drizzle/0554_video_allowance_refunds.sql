-- deployment-mode: rolling
-- Tighten 0548's receipts for the existing prepaid video/refund protocol.
-- No reservation, repricing, ledger replay, or provider lifecycle change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE opengeni_private.workspace_video_allowance_allocations
  ADD CONSTRAINT workspace_video_allowance_allocations_debit_fk
    FOREIGN KEY (ledger_id) REFERENCES credit_ledger_entries(id) ON DELETE CASCADE,
  ADD CONSTRAINT workspace_video_allowance_allocations_refund_fk
    FOREIGN KEY (reversed_by_ledger_id) REFERENCES credit_ledger_entries(id);
CREATE UNIQUE INDEX workspace_video_allowance_allocations_refund_idx
  ON opengeni_private.workspace_video_allowance_allocations(reversed_by_ledger_id)
  WHERE reversed_by_ledger_id IS NOT NULL;

-- Read the exact original ledger through the existing owner capability. This
-- policy is SELECT-only: the refund never locks or mutates the original debit.
DO $video_ledger_policy$
DECLARE owner_name text:=current_user; target_schema text:=current_schema();
BEGIN
  EXECUTE format('CREATE POLICY video_allowance_owner_read ON credit_ledger_entries
    FOR SELECT USING(current_user=%L AND %I.usage_allowance_capability_active(account_id,workspace_id))',
    owner_name,target_schema);
END $video_ledger_policy$;

CREATE OR REPLACE FUNCTION reverse_video_allowance_refund() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  allocation opengeni_private.workspace_video_allowance_allocations%ROWTYPE;
  debit credit_ledger_entries%ROWTYPE;
  grant_allocation jsonb;
  restored bigint:=0;
  affected integer;
  opened integer;
  cfg jsonb;
  grant_expiry timestamptz;
  snapshot_boundary timestamptz;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.type<>'video_generation_refund'
    OR NEW.source_type IS DISTINCT FROM 'video_generation_operation' OR NEW.amount_micros<=0
    OR NEW.source_id IS NULL
    OR NEW.idempotency_key IS DISTINCT FROM 'credit:video_generation_refund:'||NEW.source_id THEN
    RETURN NULL;
  END IF;
  -- Match the debit writer's workspace prefix and serialize against admission,
  -- grants, policy edits, rollover snapshots, and another refund.
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND account_id=NEW.account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Video allowance refund workspace mismatch' USING ERRCODE='23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:'||NEW.workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened=ROW_COUNT;
  SELECT * INTO allocation FROM opengeni_private.workspace_video_allowance_allocations
    WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
      AND operation_id::text=NEW.source_id FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO debit FROM credit_ledger_entries WHERE id=allocation.ledger_id;
    IF NOT FOUND OR debit.account_id IS DISTINCT FROM NEW.account_id
      OR debit.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR debit.type IS DISTINCT FROM 'video_generation_debit'
      OR debit.source_type IS DISTINCT FROM 'video_generation_operation'
      OR debit.source_id IS DISTINCT FROM NEW.source_id
      OR debit.idempotency_key IS DISTINCT FROM 'credit:video_generation_debit:'||NEW.source_id
      OR debit.amount_micros IS DISTINCT FROM -allocation.amount
      OR NEW.amount_micros IS DISTINCT FROM allocation.amount THEN
      RAISE EXCEPTION 'Video allowance refund does not match its original debit' USING ERRCODE='23514';
    END IF;
    IF allocation.reversed_by_ledger_id IS NOT NULL THEN
      IF allocation.reversed_by_ledger_id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Video allowance debit already reversed by another refund' USING ERRCODE='23514';
      END IF;
      -- Same committed ledger replay has no second accounting effect.
    ELSE
      UPDATE opengeni_private.workspace_allowance_counters SET used=used-allocation.amount,
        included_used=included_used-allocation.included_used,
        grants_used=grants_used-allocation.grants_used
      WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
        AND period_key=allocation.period_key AND subject_id='';
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN
        RAISE EXCEPTION 'Video allowance refund counter unavailable' USING ERRCODE='23514';
      END IF;
      IF allocation.human_subject_id IS NOT NULL THEN
        UPDATE opengeni_private.workspace_allowance_counters SET used=used-allocation.amount
        WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
          AND period_key=allocation.period_key AND subject_id=allocation.human_subject_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN
          RAISE EXCEPTION 'Video allowance refund member counter unavailable' USING ERRCODE='23514';
        END IF;
      END IF;
      SELECT coalesce(end_at,updated_at) INTO snapshot_boundary FROM opengeni_private.workspace_allowance_periods
        WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND period_key=allocation.period_key;
      FOR grant_allocation IN SELECT value FROM jsonb_array_elements(allocation.grant_allocations) LOOP
        UPDATE opengeni_private.workspace_allowance_grants SET remaining=remaining+(grant_allocation->>'credits')::bigint
          WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id
            AND operation_id=grant_allocation->>'operationId'
          RETURNING expires_at INTO grant_expiry;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN
          RAISE EXCEPTION 'Video allowance refund grant unavailable' USING ERRCODE='23514';
        END IF;
        restored:=restored+(grant_allocation->>'credits')::bigint;
        -- Historical snapshots are observed facts, not today's grant pool.
        -- Append just this restored portion using the original period's
        -- historical expiry boundary, without changing its policy/member facts.
        IF snapshot_boundary IS NOT NULL THEN
          UPDATE opengeni_private.workspace_allowance_periods SET
            grants_remaining=grants_remaining+CASE WHEN grant_expiry IS NULL
              OR grant_expiry>snapshot_boundary THEN (grant_allocation->>'credits')::bigint ELSE 0 END,
            grants_snapshot=grants_snapshot||jsonb_build_array(jsonb_build_object(
              'remaining',(grant_allocation->>'credits')::bigint,'expiresAt',grant_expiry))
          WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND period_key=allocation.period_key;
        END IF;
      END LOOP;
      IF restored<>allocation.grants_used THEN
        RAISE EXCEPTION 'Video allowance refund allocation mismatch' USING ERRCODE='23514';
      END IF;
      UPDATE opengeni_private.workspace_video_allowance_allocations SET reversed_by_ledger_id=NEW.id
        WHERE ledger_id=allocation.ledger_id;
      -- Current admission excludes expired grants even after their remaining
      -- balance is restored. Original-period counters are never moved forward.
      SELECT config INTO cfg FROM opengeni_private.workspace_usage_allowances WHERE workspace_id=NEW.workspace_id;
      PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());
    END IF;
  END IF;
  -- No receipt means a pre-recording debit. Never fabricate allocations from
  -- usage-event totals or reverse another period's counters.
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=TG_TABLE_SCHEMA AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION reverse_video_allowance_refund() FROM PUBLIC;

DO $video_refund_acl$
DECLARE target_schema text:=current_schema(); principal text;
BEGIN
  EXECUTE format('ALTER FUNCTION %I.reverse_video_allowance_refund() SET search_path=pg_catalog,%I,pg_temp',
    target_schema,target_schema);
  FOR principal IN SELECT DISTINCT r.rolname FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE p.oid='reverse_video_allowance_refund()'::regprocedure AND acl.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.reverse_video_allowance_refund() FROM %I',target_schema,principal); END LOOP;
END $video_refund_acl$;