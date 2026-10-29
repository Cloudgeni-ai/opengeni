-- deployment-mode: rolling
-- App use is paid from monthly plan credit first; API use (keys, products on
-- the SDK, outside agents over MCP) is paid only from credits. Each accepted
-- turn freezes its funding origin, schedules freeze their creator's origin,
-- and each usage debit records the origin it was charged under. The monthly
-- plan allowance stops counting API debits, so plan credit never pays for API
-- work, and plan credit never repays debt that API work ran up (period
-- expiry, the next period's opening debt). Document and index-job billing
-- records may carry the origin. See docs/billing-origin.md.
--
-- Rolling: three nullable columns (catalog-only; their checks are NOT VALID
-- and only constrain new writes), new private trigger functions and helper,
-- and same-signature replacements of existing function bodies. The previous
-- release never writes the columns, and null keeps today's behaviour: null
-- origin is billed as app and counts against the plan.
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
        -- A task from before origins is app; a task this writer cannot see
        -- is never billed to plan credit.
        SELECT coalesce(task.billing_origin, 'app') INTO NEW.billing_origin
          FROM scheduled_task_runs run JOIN scheduled_tasks task
            ON task.workspace_id = run.workspace_id AND task.id = run.task_id
          WHERE run.workspace_id = NEW.workspace_id AND run.id = NEW.scheduled_task_run_id;
        NEW.billing_origin := coalesce(NEW.billing_origin, 'api');
        RETURN NEW;
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

-- Plan credit never repays API debt. Credits can go negative when API work
-- settles past them; that debt stays credit debt for the next top-up. Debt up
-- to the account's API spending counts as API debt, so period expiry removes
-- the whole unused allowance, a new period's opening debt only nets older app
-- debt, and the pending-expiry read agrees. Accounts with no API use keep
-- today's behaviour exactly (funding reversals still cap the allowance).
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.plan_app_general_balance(p_account_id uuid, p_plan_remaining bigint) RETURNS bigint
        LANGUAGE sql STABLE
        SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
        AS $$
      SELECT general + least(greatest(0, p_plan_remaining - general), api_spent)
      FROM (SELECT opengeni_private.plan_general_balance(p_account_id) AS general,
        greatest(0, coalesce((SELECT sum(-amount_micros) FROM credit_ledger_entries
          WHERE account_id = p_account_id AND usage_origin = 'api'), 0)) AS api_spent) balances
    $$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION expire_plan_credit_period(p_account_id uuid, p_period_id uuid, p_force boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
DECLARE period plan_credit_periods%%ROWTYPE; usage bigint; remaining bigint; balance bigint;
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
  -- API debt is never repaid from plan credit: it stays as credit debt.
  balance := CASE WHEN scoped THEN remaining ELSE greatest(0, opengeni_private.plan_app_general_balance(p_account_id, remaining)) END;
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
END $$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION grant_plan_credit_period(p_account_id uuid, p_plan_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_stripe_subscription_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
DECLARE state organization_plans%%ROWTYPE; period plan_credit_periods%%ROWTYPE; previous plan_credit_periods%%ROWTYPE;
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
    -- Only debt beyond what API work ran up is repaid from plan credit.
    ELSE least(amount, greatest(0, -opengeni_private.plan_app_general_balance(p_account_id, 0))) END;
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
END $$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION read_organization_plan_balance(p_account_id uuid, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
DECLARE state organization_plans%%ROWTYPE; definition jsonb; period plan_credit_periods%%ROWTYPE;
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
      ELSE greatest(0, opengeni_private.plan_app_general_balance(p_account_id,
        greatest(0, ended.granted_micros - ended.opening_debt_micros
          - opengeni_private.plan_period_usage(ended, as_of)))) END) INTO pending
    FROM plan_credit_periods ended JOIN credit_ledger_entries grant_row ON grant_row.id = ended.grant_entry_id
    WHERE ended.account_id = p_account_id AND ended.expired_at IS NULL AND ended.period_end <= as_of;
  RETURN jsonb_build_object('key',state.plan_key,'label',coalesce(definition->>'label',state.plan_key),'status',state.status,
    'creditGrantedMicros',coalesce(period.granted_micros,0),'creditRemainingMicros',remaining,
    'creditPendingExpiryMicros',coalesce(pending,0),'creditScoped',coalesce(scoped,false),
    'periodResetAt',coalesce(period.period_end,state.current_period_end),'seatLimit',definition->'seatLimit','seatsUsed',organization_plan_seats_used(p_account_id),
    'cancelAtPeriodEnd',state.cancel_at_period_end);
END $$;
  $create$, data_schema);
END $install$;
REVOKE ALL ON FUNCTION opengeni_private.plan_app_general_balance(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prevent_session_turn_billing_origin_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.inherit_session_turn_billing_origin() FROM PUBLIC;

-- A key's or service's billing record may carry its origin (API keys are
-- api; a trusted dispatcher such as a bot may fix app). The previous release
-- writes the exact old record, which still passes; NOT VALID leaves existing
-- rows unscanned.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_billing_attribution_check,
  ADD CONSTRAINT documents_billing_attribution_check CHECK (((jsonb_typeof(billing_attribution) = 'object'::text) AND COALESCE(
CASE (billing_attribution ->> 'kind'::text)
    WHEN 'unknown'::text THEN (billing_attribution = '{"kind": "unknown"}'::jsonb)
    WHEN 'service'::text THEN ((billing_attribution - 'billingOrigin'::text) = '{"kind": "service"}'::jsonb
      AND COALESCE(billing_attribution ->> 'billingOrigin'::text, 'app'::text) = ANY (ARRAY['app'::text, 'api'::text]))
    WHEN 'human'::text THEN ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))
    WHEN 'turn'::text THEN ((COALESCE((billing_attribution ->> 'turnId'::text), ''::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) AND (((billing_attribution -> 'initiatingHumanSubjectId'::text) = 'null'::jsonb) OR ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))))
    ELSE false
END, false))) NOT VALID;
ALTER TABLE knowledge_index_jobs DROP CONSTRAINT IF EXISTS knowledge_index_billing_attribution_check,
  ADD CONSTRAINT knowledge_index_billing_attribution_check CHECK (((jsonb_typeof(billing_attribution) = 'object'::text) AND COALESCE(
CASE (billing_attribution ->> 'kind'::text)
    WHEN 'unknown'::text THEN (billing_attribution = '{"kind": "unknown"}'::jsonb)
    WHEN 'service'::text THEN ((billing_attribution - 'billingOrigin'::text) = '{"kind": "service"}'::jsonb
      AND COALESCE(billing_attribution ->> 'billingOrigin'::text, 'app'::text) = ANY (ARRAY['app'::text, 'api'::text]))
    WHEN 'human'::text THEN ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))
    WHEN 'turn'::text THEN ((COALESCE((billing_attribution ->> 'turnId'::text), ''::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) AND (((billing_attribution -> 'initiatingHumanSubjectId'::text) = 'null'::jsonb) OR ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))))
    ELSE false
END, false))) NOT VALID;

-- A task's funding origin is billing, not execution: marking a task API
-- (an API caller's edit or manual run) must not change its execution digest
-- or advance a personal-resource task's authority revision, which would leave
-- it without an authority snapshot. Same-signature bodies with
-- billing_origin excluded; digests from before the column existed never
-- included it, so stored digests stay valid.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION set_scheduled_task_execution_digest() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
BEGIN
  NEW.execution_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (
        ((pg_catalog.to_jsonb(NEW) - 'subscription_authority') - 'authority_inserted_at')
          - ARRAY[
            'name',
            'status',
            'updated_at',
            'authority_revision',
            'execution_digest', 'owner_subject_id', 'visibility', 'billing_origin'
          ]::text[]
          - (CASE WHEN NEW.creator_first_party_mcp_tools IS NULL
              THEN ARRAY['creator_first_party_mcp_tools'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN NEW.creator_first_party_mcp_permissions IS NULL
              THEN ARRAY['creator_first_party_mcp_permissions'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN NEW.creator_session_policy IS NULL
              THEN ARRAY['creator_session_policy'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN NEW.vault_policy = '{"mode":"all"}'::jsonb
              THEN ARRAY['vault_policy'] ELSE ARRAY[]::text[] END)
      )::text,
      'UTF8'
    )),
    'hex'
  );
  RETURN NEW;
END
$$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION scheduled_task_execution_digest(p_task scheduled_tasks) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (
        ((pg_catalog.to_jsonb(p_task) - 'subscription_authority') - 'authority_inserted_at')
          - ARRAY[
            'name',
            'status',
            'updated_at',
            'authority_revision',
            'execution_digest', 'owner_subject_id', 'visibility', 'billing_origin'
          ]::text[]
          - (CASE WHEN p_task.creator_first_party_mcp_tools IS NULL
              THEN ARRAY['creator_first_party_mcp_tools'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN p_task.creator_first_party_mcp_permissions IS NULL
              THEN ARRAY['creator_first_party_mcp_permissions'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN p_task.creator_session_policy IS NULL
              THEN ARRAY['creator_session_policy'] ELSE ARRAY[]::text[] END)
          - (CASE WHEN p_task.vault_policy = '{"mode":"all"}'::jsonb
              THEN ARRAY['vault_policy'] ELSE ARRAY[]::text[] END)
      )::text,
      'UTF8'
    )),
    'hex'
  )
$$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION scheduled_task_execution_state(p_task scheduled_tasks) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT pg_catalog.to_jsonb(p_task) - ARRAY[
    'name', 'status', 'deleted_at', 'updated_at', 'authority_revision', 'execution_digest', 'owner_subject_id', 'visibility', 'billing_origin'
  ]::text[]
$$;
  $create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION fence_scheduled_task_personal_resource_execution_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $$
DECLARE
  execution_changed boolean;
  has_personal_authority boolean := false;
  capability_inserted boolean := false;
  affected integer;
BEGIN
  IF NEW.authority_revision IS DISTINCT FROM OLD.authority_revision
    AND NEW.authority_revision <> OLD.authority_revision + 1
  THEN
    RAISE EXCEPTION 'scheduled personal-resource authority revision update is invalid'
      USING ERRCODE = '22023';
  END IF;

  execution_changed := (
    pg_catalog.to_jsonb(NEW) - ARRAY[
      'name',
      'status',
      'updated_at',
      'authority_revision',
      'execution_digest', 'owner_subject_id', 'visibility', 'billing_origin'
    ]::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD) - ARRAY[
      'name',
      'status',
      'updated_at',
      'authority_revision',
      'execution_digest', 'owner_subject_id', 'visibility', 'billing_origin'
    ]::text[]
  );

  IF NOT execution_changed THEN
    RETURN NEW;
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;
  capability_inserted := affected = 1;

  SELECT EXISTS (
    SELECT 1
    FROM scheduled_task_personal_resource_authorities authority
    WHERE authority.task_id = OLD.id
  ) INTO has_personal_authority;

  IF capability_inserted THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    capability_inserted := false;
  END IF;

  IF has_personal_authority THEN
    -- A current writer already supplies OLD + 1 and freezes/clones that exact
    -- revision in the same transaction. A rolling legacy writer supplies no
    -- revision, so advance it here and leave no matching snapshot: run
    -- admission then fails closed instead of reusing stale personal authority.
    NEW.authority_revision := OLD.authority_revision + 1;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF capability_inserted THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
  END IF;
  RAISE;
END
$$;
  $create$, data_schema);
END
$install$;
