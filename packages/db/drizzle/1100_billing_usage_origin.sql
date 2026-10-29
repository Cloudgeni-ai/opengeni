-- deployment-mode: rolling
-- App use is paid from monthly plan credit first; API use (keys, products on
-- the SDK, outside agents over MCP) is paid only from credits. Each accepted
-- turn freezes its funding origin, schedules freeze their creator's origin,
-- and each usage debit records the origin it was charged under. The monthly
-- plan allowance stops counting API debits, so plan credit never pays for API
-- work, and stops counting the bring-your-own-key platform fee on Free
-- periods (the fee is payable only from paid credit). See docs/billing-origin.md.
--
-- Rolling: three nullable columns (catalog-only; their checks are NOT VALID
-- and only constrain new writes) and two same-signature function bodies. The
-- previous release never writes the columns, and null keeps today's
-- behaviour: null origin is billed as app and counts against the plan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE session_turns ADD COLUMN IF NOT EXISTS billing_origin text;
ALTER TABLE session_turns
  ADD CONSTRAINT session_turns_billing_origin_valid
  CHECK (billing_origin IN ('app', 'api')) NOT VALID;
COMMENT ON COLUMN session_turns.billing_origin IS
  'Funding origin frozen at acceptance: app (plan credit first) or api (credits only). Null is legacy and billed as app.';

ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS billing_origin text;
ALTER TABLE scheduled_tasks
  ADD CONSTRAINT scheduled_tasks_billing_origin_valid
  CHECK (billing_origin IN ('app', 'api')) NOT VALID;
COMMENT ON COLUMN scheduled_tasks.billing_origin IS
  'Funding origin of whoever set the task up, inherited by its runs. Null is legacy and billed as app.';

ALTER TABLE credit_ledger_entries ADD COLUMN IF NOT EXISTS usage_origin text;
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_usage_origin_valid
  CHECK (usage_origin IN ('app', 'api')) NOT VALID;
COMMENT ON COLUMN credit_ledger_entries.usage_origin IS
  'Funding origin of a usage debit. api debits never count against the monthly plan allowance. Null is legacy or non-usage.';

-- A turn's funding origin is set once, when it is accepted.
CREATE OR REPLACE FUNCTION opengeni_private.prevent_session_turn_billing_origin_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF OLD.billing_origin IS DISTINCT FROM NEW.billing_origin THEN
    RAISE EXCEPTION 'session turn billing origin is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS session_turns_billing_origin_immutable ON session_turns;
CREATE TRIGGER session_turns_billing_origin_immutable
  BEFORE UPDATE OF billing_origin ON session_turns
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_session_turn_billing_origin_change();

-- Work that enters without a request of its own keeps the origin of whoever
-- set it up. A schedule or automation run is billed as its task (a task
-- from before this column was set up in the app). Continuations, compaction,
-- machine and voice turns, and writers from the previous release keep their
-- chat's latest decided origin, else for a chat's first turn the parent
-- chat's: a sub-agent is billed like the chat it runs in. Nothing to inherit
-- stays null, which is billed as app.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.inherit_session_turn_billing_origin()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    BEGIN
      IF NEW.scheduled_task_run_id IS NOT NULL THEN
        SELECT coalesce(task.billing_origin, 'app') INTO NEW.billing_origin
          FROM scheduled_task_runs run JOIN scheduled_tasks task
            ON task.workspace_id = run.workspace_id AND task.id = run.task_id
          WHERE run.workspace_id = NEW.workspace_id AND run.id = NEW.scheduled_task_run_id;
        IF NEW.billing_origin IS NOT NULL THEN RETURN NEW; END IF;
      END IF;
      SELECT turn.billing_origin INTO NEW.billing_origin FROM session_turns turn
        WHERE turn.workspace_id = NEW.workspace_id AND turn.session_id = NEW.session_id
          AND turn.billing_origin IS NOT NULL
        ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1;
      IF NEW.billing_origin IS NULL THEN
        SELECT turn.billing_origin INTO NEW.billing_origin
          FROM sessions child JOIN session_turns turn
            ON turn.workspace_id = child.workspace_id AND turn.session_id = child.parent_session_id
          WHERE child.workspace_id = NEW.workspace_id AND child.id = NEW.session_id
            AND turn.billing_origin IS NOT NULL
          ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1;
      END IF;
      RETURN NEW;
    END $body$;
  $create$, data_schema);
END $install$;
DROP TRIGGER IF EXISTS session_turns_billing_origin_inherit ON session_turns;
CREATE TRIGGER session_turns_billing_origin_inherit
  BEFORE INSERT ON session_turns
  FOR EACH ROW WHEN (NEW.billing_origin IS NULL)
  EXECUTE FUNCTION opengeni_private.inherit_session_turn_billing_origin();

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.plan_period_usage(p_period %1$I.plan_credit_periods, p_until timestamp with time zone) RETURNS bigint
        LANGUAGE sql STABLE
        SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
        AS $$
      SELECT CASE WHEN EXISTS (SELECT 1 FROM credit_ledger_entries
        WHERE id = p_period.grant_entry_id AND eligible_model_ids IS NOT NULL)
      THEN (SELECT coalesce(sum(a.amount_micros), 0)::bigint
        FROM credit_debit_allocations a JOIN credit_ledger_entries debit ON debit.id = a.debit_entry_id
        WHERE a.account_id = p_period.account_id AND a.grant_entry_id = p_period.grant_entry_id
          AND debit.type <> 'plan_credit_expiry'
          AND debit.usage_origin IS DISTINCT FROM 'api'
          AND debit.created_at < least(p_period.period_end, p_until))
      ELSE (
        SELECT greatest(0, coalesce(sum(-entry.amount_micros - coalesce(allocated.amount, 0)), 0))::bigint
        FROM credit_ledger_entries entry
        LEFT JOIN LATERAL (SELECT sum(amount_micros) amount FROM credit_debit_allocations
          WHERE account_id = entry.account_id AND debit_entry_id = entry.id) allocated ON true
        WHERE entry.account_id = p_period.account_id
          AND entry.created_at >= greatest(p_period.period_start, p_period.granted_at)
          AND entry.created_at < least(p_period.period_end, p_until)
          AND entry.type NOT IN ('credit_topup','grant','manual_credit_grant','plan_credit_grant','plan_credit_expiry',
            'credit_refund','credit_dispute_hold','credit_dispute_release')
          -- Plan credit never pays for API work.
          AND entry.usage_origin IS DISTINCT FROM 'api'
          -- The own-key platform fee is payable only from paid credit, never Free.
          AND NOT (entry.type = 'byok_platform_fee' AND p_period.plan_key = 'free')
          AND (entry.type <> 'video_generation_refund' OR EXISTS (
            SELECT 1 FROM credit_ledger_entries debit
            WHERE debit.account_id = entry.account_id AND debit.type = 'video_generation_debit'
              AND debit.source_type = entry.source_type AND debit.source_id = entry.source_id
              AND debit.usage_origin IS DISTINCT FROM 'api'
              AND debit.created_at >= greatest(p_period.period_start, p_period.granted_at)
              AND debit.created_at < least(p_period.period_end, p_until)))
      ) END
    $$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.expire_refunded_plan_credit() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
        AS $$
    DECLARE debit credit_ledger_entries%%ROWTYPE; period plan_credit_periods%%ROWTYPE;
      plan_paid bigint; already_expired bigint; late_refunds bigint; effective_grant bigint;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Plan refund account scope mismatch' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id::text));
      SELECT * INTO debit FROM credit_ledger_entries WHERE account_id = NEW.account_id
        AND type = 'video_generation_debit' AND source_type = NEW.source_type AND source_id = NEW.source_id
        ORDER BY created_at, id LIMIT 1;
      IF NOT FOUND THEN RETURN NEW; END IF;
      -- An API debit was never paid by plan credit, so its refund returns credits.
      IF debit.usage_origin = 'api' THEN RETURN NEW; END IF;
      SELECT * INTO period FROM plan_credit_periods WHERE account_id = NEW.account_id
        AND debit.created_at >= greatest(period_start, granted_at)
        AND debit.created_at < least(period_end, coalesce(expired_at, 'infinity'::timestamptz))
        ORDER BY granted_at DESC LIMIT 1;
      IF NOT FOUND OR (period.expired_at IS NULL AND period.period_end > NEW.created_at) THEN RETURN NEW; END IF;
      IF EXISTS (SELECT 1 FROM credit_ledger_entries WHERE id = period.grant_entry_id AND eligible_model_ids IS NOT NULL) THEN
        RETURN NEW;
      END IF;
      IF period.expired_at IS NULL THEN
        RAISE EXCEPTION 'Ended plan must be settled before a video refund' USING ERRCODE = '55000';
      END IF;
      SELECT coalesce(sum(refund.amount_micros), 0) INTO late_refunds FROM credit_ledger_entries refund
        WHERE refund.account_id = NEW.account_id AND refund.type = 'video_generation_refund'
          AND refund.created_at >= least(period.period_end, period.expired_at)
          AND EXISTS (SELECT 1 FROM credit_ledger_entries original
            WHERE original.account_id = NEW.account_id AND original.type = 'video_generation_debit'
              AND original.source_type = refund.source_type AND original.source_id = refund.source_id
              AND original.usage_origin IS DISTINCT FROM 'api'
              AND original.created_at >= greatest(period.period_start, period.granted_at)
              AND original.created_at < least(period.period_end, period.expired_at));
      effective_grant := period.granted_micros - period.opening_debt_micros;
      plan_paid := greatest(0, effective_grant - greatest(0, period.usage_at_expiry_micros - late_refunds))
        - greatest(0, effective_grant - period.usage_at_expiry_micros);
      SELECT coalesce(-sum(amount_micros), 0) INTO already_expired FROM credit_ledger_entries
        WHERE account_id = NEW.account_id AND type = 'plan_credit_expiry'
          AND source_type = 'plan_credit_video_refund' AND metadata->>'periodId' = period.id::text;
      plan_paid := least(NEW.amount_micros, greatest(0, plan_paid - already_expired));
      IF plan_paid > 0 THEN
        INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
          idempotency_key, metadata, occurred_at, created_at)
        VALUES (NEW.account_id, NULL, 'plan_credit_expiry', -plan_paid, 'plan_credit_video_refund', debit.id::text,
          'plan-credit-refund-expiry:' || NEW.id::text,
          jsonb_build_object('periodId',period.id,'refundEntryId',NEW.id), clock_timestamp(), clock_timestamp())
        ON CONFLICT (idempotency_key) DO NOTHING;
      END IF;
      RETURN NEW;
    END $$;
  $create$, data_schema);
END $install$;
