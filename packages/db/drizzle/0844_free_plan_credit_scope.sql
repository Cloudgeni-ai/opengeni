-- deployment-mode: maintenance
-- maintenance-justification: old debit writers treat scoped monthly allowance as
--   general funding and cannot allocate it or project pending expiry correctly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Existing receipts remain immutable. Only newly issued Free periods are scoped.
ALTER TABLE credit_ledger_entries DROP CONSTRAINT credit_ledger_scope_valid;
ALTER TABLE credit_ledger_entries ADD CONSTRAINT credit_ledger_scope_valid CHECK (
  eligible_model_ids IS NULL OR (type IN ('grant', 'plan_credit_grant') AND amount_micros > 0
    AND cardinality(eligible_model_ids) BETWEEN 1 AND 40
    AND array_position(eligible_model_ids, NULL) IS NULL
    AND array_position(eligible_model_ids, '') IS NULL)
);

CREATE OR REPLACE FUNCTION opengeni_private.plan_period_usage(p_period plan_credit_periods, p_until timestamptz)
RETURNS bigint LANGUAGE sql STABLE SET search_path FROM CURRENT AS $body$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM credit_ledger_entries
    WHERE id = p_period.grant_entry_id AND eligible_model_ids IS NOT NULL)
  THEN (SELECT coalesce(sum(a.amount_micros), 0)::bigint
    FROM credit_debit_allocations a JOIN credit_ledger_entries debit ON debit.id = a.debit_entry_id
    WHERE a.account_id = p_period.account_id AND a.grant_entry_id = p_period.grant_entry_id
      AND debit.type <> 'plan_credit_expiry'
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
      AND (entry.type <> 'video_generation_refund' OR EXISTS (
        SELECT 1 FROM credit_ledger_entries debit
        WHERE debit.account_id = entry.account_id AND debit.type = 'video_generation_debit'
          AND debit.source_type = entry.source_type AND debit.source_id = entry.source_id
          AND debit.created_at >= greatest(p_period.period_start, p_period.granted_at)
          AND debit.created_at < least(p_period.period_end, p_until)))
  ) END
$body$;

CREATE OR REPLACE FUNCTION expire_plan_credit_period(p_account_id uuid, p_period_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE period plan_credit_periods%ROWTYPE; usage bigint; remaining bigint; balance bigint;
  expiry uuid; expiry_time timestamptz; scoped boolean;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  SELECT * INTO period FROM plan_credit_periods WHERE account_id = p_account_id AND id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan credit period not found' USING ERRCODE = 'P0002'; END IF;
  IF period.expired_at IS NOT NULL THEN RETURN to_jsonb(period); END IF;
  expiry_time := clock_timestamp();
  IF NOT p_force AND period.period_end > expiry_time THEN
    RAISE EXCEPTION 'Plan credit period has not ended' USING ERRCODE = '55000';
  END IF;
  SELECT eligible_model_ids IS NOT NULL INTO scoped FROM credit_ledger_entries WHERE id = period.grant_entry_id;
  usage := opengeni_private.plan_period_usage(period, expiry_time);
  remaining := greatest(0, period.granted_micros - period.opening_debt_micros - usage);
  -- Scoped funding never repays general debt. Consume its exact remainder via
  -- allocation so neither signup promotions nor purchased funds are removed.
  balance := CASE WHEN scoped THEN remaining ELSE greatest(0, opengeni_private.plan_general_balance(p_account_id)) END;
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, occurred_at, created_at)
  VALUES (p_account_id, NULL, 'plan_credit_expiry', -least(remaining, balance), 'plan_credit_period', period.id::text,
    'plan-credit-expiry:' || period.id::text, jsonb_build_object('planKey',period.plan_key,'usageMicros',usage), expiry_time, expiry_time)
  RETURNING id INTO expiry;
  IF scoped AND remaining > 0 THEN
    INSERT INTO credit_debit_allocations(account_id, debit_entry_id, grant_entry_id, amount_micros)
      VALUES (p_account_id, expiry, period.grant_entry_id, remaining);
  END IF;
  UPDATE plan_credit_periods SET expired_at = expiry_time, expiry_entry_id = expiry, usage_at_expiry_micros = usage
    WHERE id = period.id RETURNING * INTO period;
  RETURN to_jsonb(period);
END $body$;

CREATE OR REPLACE FUNCTION grant_plan_credit_period(p_account_id uuid, p_plan_key text,
  p_period_start timestamptz, p_period_end timestamptz, p_stripe_subscription_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE state organization_plans%ROWTYPE; period plan_credit_periods%ROWTYPE; previous plan_credit_periods%ROWTYPE;
  definition jsonb; catalog_version bigint; amount bigint; opening_debt bigint; grant_id uuid;
  granted_time timestamptz; grant_key text; model_ids jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR p_period_end <= p_period_start OR p_period_start > clock_timestamp() THEN
    RAISE EXCEPTION 'Invalid plan credit period' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  grant_key := CASE WHEN p_stripe_subscription_id IS NOT NULL
    THEN 'plan-credit:stripe:' || p_stripe_subscription_id || ':' || extract(epoch FROM p_period_start)::text || ':' || p_plan_key
    ELSE 'plan-credit:free:' || p_account_id::text || ':' || to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM') END;
  SELECT * INTO period FROM plan_credit_periods WHERE idempotency_key = grant_key;
  IF FOUND THEN
    IF period.account_id IS DISTINCT FROM p_account_id OR period.plan_key IS DISTINCT FROM p_plan_key
      OR period.period_start IS DISTINCT FROM p_period_start OR period.period_end IS DISTINCT FROM p_period_end
      OR period.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id THEN
      RAISE EXCEPTION 'Plan grant idempotency key conflicts with different terms' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(period);
  END IF;
  SELECT * INTO state FROM organization_plans WHERE account_id = p_account_id;
  IF NOT FOUND OR state.plan_key IS DISTINCT FROM p_plan_key OR state.status NOT IN ('active','trialing')
    OR state.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
    OR state.current_period_start IS DISTINCT FROM p_period_start OR state.current_period_end IS DISTINCT FROM p_period_end THEN
    RAISE EXCEPTION 'Grant requires matching active organization plan state' USING ERRCODE = '55000';
  END IF;
  SELECT revision, entry INTO catalog_version, definition
  FROM (SELECT revision, catalog FROM opengeni_private.subscription_plan_catalog_revisions ORDER BY revision DESC LIMIT 1) revision,
    jsonb_array_elements(revision.catalog) entry WHERE entry->>'key' = p_plan_key;
  IF definition IS NULL THEN RAISE EXCEPTION 'Unknown subscription plan' USING ERRCODE = '22023'; END IF;
  IF (definition->>'freeCredit')::boolean THEN
    IF p_stripe_subscription_id IS NOT NULL OR NOT free_plan_credit_eligible(p_account_id) THEN
      RAISE EXCEPTION 'Organization is not eligible for Free monthly credit' USING ERRCODE = '42501';
    END IF;
  ELSIF p_stripe_subscription_id IS NULL THEN
    RAISE EXCEPTION 'Paid plan credit requires a subscription identity' USING ERRCODE = '22023';
  END IF;
  FOR previous IN SELECT * FROM plan_credit_periods WHERE account_id = p_account_id AND expired_at IS NULL LOOP
    IF previous.period_end > p_period_start THEN
      RAISE EXCEPTION 'Active plan period overlaps; use replace_plan_credit_period for an upgrade' USING ERRCODE = '55000';
    END IF;
    PERFORM expire_plan_credit_period(p_account_id, previous.id, false);
  END LOOP;
  amount := (definition->>'monthlyCreditMicros')::bigint;
  IF p_plan_key = 'free' AND amount > 0 THEN
    SELECT coalesce(policy->'signupModelIds', policy->'defaultModelIds') INTO model_ids
      FROM opengeni_private.credit_promotion_policy_revisions ORDER BY revision DESC LIMIT 1;
    -- Bootstrap deployments may have issued the signup receipt from the env
    -- policy before a runtime revision exists. Preserve that receipt's scope.
    IF model_ids IS NULL THEN
      SELECT to_jsonb(eligible_model_ids) INTO model_ids FROM credit_ledger_entries
        WHERE account_id = p_account_id AND source_type = 'verified_signup_trial'
          AND eligible_model_ids IS NOT NULL ORDER BY created_at, id LIMIT 1;
    END IF;
    IF model_ids IS NULL THEN
      RAISE EXCEPTION 'Free monthly credit requires a configured free-credit model policy' USING ERRCODE = '55000';
    END IF;
  END IF;
  opening_debt := CASE WHEN model_ids IS NOT NULL THEN 0
    ELSE least(amount, greatest(0, -opengeni_private.plan_general_balance(p_account_id))) END;
  granted_time := clock_timestamp();
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, eligible_model_ids, occurred_at, created_at)
  VALUES (p_account_id, NULL, 'plan_credit_grant', amount, 'subscription_plan', p_stripe_subscription_id,
    grant_key, jsonb_build_object('planKey',p_plan_key,'catalogRevision',catalog_version,
      'creditOfferLabel','Monthly plan credit'),
    CASE WHEN model_ids IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(model_ids)) END,
    granted_time, granted_time)
  RETURNING id INTO grant_id;
  INSERT INTO plan_credit_periods(account_id, plan_key, catalog_revision, stripe_subscription_id, period_start, period_end,
    granted_micros, opening_debt_micros, grant_entry_id, idempotency_key, granted_at)
  VALUES (p_account_id, p_plan_key, catalog_version, p_stripe_subscription_id, p_period_start, p_period_end,
    amount, opening_debt, grant_id, grant_key, granted_time) RETURNING * INTO period;
  IF p_period_end <= clock_timestamp() THEN
    RETURN expire_plan_credit_period(p_account_id, period.id, false);
  END IF;
  RETURN to_jsonb(period);
END $body$;

CREATE OR REPLACE FUNCTION read_organization_plan_balance(p_account_id uuid, p_as_of timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE state organization_plans%ROWTYPE; definition jsonb; period plan_credit_periods%ROWTYPE;
  remaining bigint := 0; pending bigint := 0; as_of timestamptz := coalesce(p_as_of, clock_timestamp()); scoped boolean := false;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO state FROM organization_plans WHERE account_id = p_account_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  definition := opengeni_private.subscription_plan_definition(state.plan_key);
  SELECT * INTO period FROM plan_credit_periods WHERE account_id = p_account_id
    AND (expired_at IS NULL OR (plan_key = state.plan_key AND period_start = state.current_period_start))
    ORDER BY expired_at DESC NULLS FIRST, granted_at DESC LIMIT 1;
  SELECT eligible_model_ids IS NOT NULL INTO scoped FROM credit_ledger_entries WHERE id = period.grant_entry_id;
  IF period.id IS NOT NULL AND period.expired_at IS NULL AND period.period_end > as_of THEN
    remaining := greatest(0, period.granted_micros - period.opening_debt_micros - opengeni_private.plan_period_usage(period, as_of));
  END IF;
  SELECT least(greatest(0, ended.granted_micros - ended.opening_debt_micros
      - opengeni_private.plan_period_usage(ended, as_of)),
    CASE WHEN grant_row.eligible_model_ids IS NOT NULL THEN ended.granted_micros
      ELSE greatest(0, opengeni_private.plan_general_balance(p_account_id)) END) INTO pending
    FROM plan_credit_periods ended JOIN credit_ledger_entries grant_row ON grant_row.id = ended.grant_entry_id
    WHERE ended.account_id = p_account_id AND ended.expired_at IS NULL AND ended.period_end <= as_of;
  RETURN jsonb_build_object('key',state.plan_key,'label',coalesce(definition->>'label',state.plan_key),'status',state.status,
    'creditGrantedMicros',coalesce(period.granted_micros,0),'creditRemainingMicros',remaining,
    'creditPendingExpiryMicros',coalesce(pending,0),'creditScoped',coalesce(scoped,false),
    'periodResetAt',coalesce(period.period_end,state.current_period_end),'seatLimit',definition->'seatLimit','seatsUsed',organization_plan_seats_used(p_account_id),
    'cancelAtPeriodEnd',state.cancel_at_period_end);
END $body$;

-- Scoped Free credit never funds video. A video reversal in its date range is
-- general credit, not restored monthly allowance (including after expiry).
CREATE OR REPLACE FUNCTION opengeni_private.expire_refunded_plan_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE debit credit_ledger_entries%ROWTYPE; period plan_credit_periods%ROWTYPE;
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
END $body$;

-- Replacement keeps existing ACLs; re-pin the search path after each definition.
DO $posture$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname IN ('expire_plan_credit_period','grant_plan_credit_period','read_organization_plan_balance'))
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('plan_period_usage','expire_refunded_plan_credit'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
END $posture$;
