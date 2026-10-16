-- deployment-mode: rolling
-- Additive and inert until an organization_plans row is explicitly created.
-- Deploy all debit writers before activating plans. No organizations are enrolled here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.subscription_plan_catalog_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog jsonb NOT NULL,
  operator text NOT NULL CHECK (operator = btrim(operator) AND length(operator) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER subscription_plan_catalog_immutable BEFORE UPDATE OR DELETE
  ON opengeni_private.subscription_plan_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();
CREATE TRIGGER subscription_plan_catalog_no_truncate BEFORE TRUNCATE
  ON opengeni_private.subscription_plan_catalog_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TABLE organization_plans (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  plan_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','unpaid','paused','incomplete','incomplete_expired')),
  stripe_subscription_id text UNIQUE,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_plans_period CHECK (
    (current_period_start IS NULL AND current_period_end IS NULL) OR
    (current_period_start IS NOT NULL AND current_period_end IS NOT NULL
      AND isfinite(current_period_start) AND isfinite(current_period_end)
      AND current_period_end > current_period_start)),
  CONSTRAINT organization_plans_subscription CHECK (
    stripe_subscription_id IS NULL OR length(btrim(stripe_subscription_id)) BETWEEN 1 AND 200)
);
ALTER TABLE organization_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_plans_account_isolation ON organization_plans
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE TABLE plan_credit_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  plan_key text NOT NULL,
  catalog_revision bigint NOT NULL REFERENCES opengeni_private.subscription_plan_catalog_revisions(revision),
  stripe_subscription_id text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  granted_micros bigint NOT NULL CHECK (granted_micros >= 0),
  grant_entry_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expired_at timestamptz,
  expiry_entry_id uuid UNIQUE,
  usage_at_expiry_micros bigint,
  CONSTRAINT plan_credit_period_bounds CHECK (isfinite(period_start) AND isfinite(period_end) AND period_end > period_start),
  CONSTRAINT plan_credit_period_expiry CHECK (
    (expired_at IS NULL AND expiry_entry_id IS NULL AND usage_at_expiry_micros IS NULL) OR
    (expired_at IS NOT NULL AND expiry_entry_id IS NOT NULL AND usage_at_expiry_micros IS NOT NULL)),
  FOREIGN KEY (grant_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id),
  FOREIGN KEY (expiry_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id)
);
CREATE UNIQUE INDEX plan_credit_periods_open_idx ON plan_credit_periods(account_id) WHERE expired_at IS NULL;
CREATE INDEX plan_credit_periods_due_idx ON plan_credit_periods(period_end, account_id) WHERE expired_at IS NULL;
ALTER TABLE plan_credit_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_credit_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_credit_periods_account_isolation ON plan_credit_periods
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE FUNCTION set_subscription_plan_catalog(p_catalog jsonb, p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE entry jsonb; written bigint;
BEGIN
  IF jsonb_typeof(p_catalog) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Plan catalog must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_catalog) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Plan catalog requires 1-100 plans' USING ERRCODE = '22023';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_catalog) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT entry ?& ARRAY['key','label','stripePriceId','monthlyPriceMicros','monthlyCreditMicros','seatLimit','freeCredit']
      OR entry - ARRAY['key','label','stripePriceId','monthlyPriceMicros','monthlyCreditMicros','seatLimit','freeCredit'] <> '{}'::jsonb
      OR coalesce(entry->>'key', '') !~ '^[a-z][a-z0-9_-]{0,39}$'
      OR jsonb_typeof(entry->'label') IS DISTINCT FROM 'string'
      OR length(btrim(entry->>'label')) NOT BETWEEN 1 AND 120
      OR (entry->'stripePriceId' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'stripePriceId') <> 'string' OR length(btrim(entry->>'stripePriceId')) NOT BETWEEN 1 AND 200))
      OR jsonb_typeof(entry->'monthlyCreditMicros') IS DISTINCT FROM 'number'
      OR (entry->>'monthlyCreditMicros')::numeric NOT BETWEEN 0 AND 9007199254740991
      OR (entry->>'monthlyCreditMicros')::numeric <> trunc((entry->>'monthlyCreditMicros')::numeric)
      OR (entry->'monthlyPriceMicros' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'monthlyPriceMicros') <> 'number'
          OR (entry->>'monthlyPriceMicros')::numeric NOT BETWEEN 0 AND 9007199254740991
          OR (entry->>'monthlyPriceMicros')::numeric <> trunc((entry->>'monthlyPriceMicros')::numeric)))
      OR (entry->'seatLimit' <> 'null'::jsonb AND
        (jsonb_typeof(entry->'seatLimit') <> 'number' OR (entry->>'seatLimit')::numeric NOT BETWEEN 1 AND 1000000
          OR (entry->>'seatLimit')::numeric <> trunc((entry->>'seatLimit')::numeric)))
      OR jsonb_typeof(entry->'freeCredit') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid plan catalog entry' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT value->>'key') FROM jsonb_array_elements(p_catalog))
    OR (SELECT count(value->>'stripePriceId') <> count(DISTINCT value->>'stripePriceId') FROM jsonb_array_elements(p_catalog)) THEN
    RAISE EXCEPTION 'Plan keys and non-null Stripe prices must be unique' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('subscription-plan-catalog', 0));
  -- Catalog keys are stable runtime identities. Keeping old keys prevents a
  -- catalog edit from accidentally dropping an enrolled organization's cap.
  IF EXISTS (SELECT 1 FROM opengeni_private.subscription_plan_catalog_revisions revision,
    LATERAL jsonb_array_elements(revision.catalog) old_entry
    WHERE revision.revision = (SELECT max(revision) FROM opengeni_private.subscription_plan_catalog_revisions)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_catalog) candidate WHERE candidate->>'key' = old_entry->>'key')) THEN
    RAISE EXCEPTION 'Existing plan keys cannot be removed from the catalog' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.subscription_plan_catalog_revisions(catalog, operator, reason)
    VALUES (p_catalog, p_operator, p_reason) RETURNING revision INTO written;
  RETURN written;
END $body$;
SELECT set_subscription_plan_catalog('[
  {"key":"free","label":"Free","stripePriceId":null,"monthlyPriceMicros":0,"monthlyCreditMicros":10000000,"seatLimit":5,"freeCredit":true},
  {"key":"pro","label":"Pro","stripePriceId":null,"monthlyPriceMicros":20000000,"monthlyCreditMicros":200000000,"seatLimit":10,"freeCredit":false},
  {"key":"max","label":"Max","stripePriceId":null,"monthlyPriceMicros":200000000,"monthlyCreditMicros":2000000000,"seatLimit":null,"freeCredit":false},
  {"key":"enterprise","label":"Enterprise","stripePriceId":null,"monthlyPriceMicros":null,"monthlyCreditMicros":0,"seatLimit":null,"freeCredit":false}
]'::jsonb, 'migration', 'Seed subscription plans without activating organizations');

CREATE FUNCTION opengeni_private.subscription_plan_definition(p_key text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $body$
  SELECT entry FROM (SELECT catalog FROM opengeni_private.subscription_plan_catalog_revisions ORDER BY revision DESC LIMIT 1) revision,
    jsonb_array_elements(revision.catalog) entry WHERE entry->>'key' = p_key
$body$;

-- A settled signup-credit ledger receipt is the eligibility witness. Merely
-- owning an organization or having a verified email does not create eligibility.
CREATE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries WHERE account_id = p_account_id
    AND type = 'grant' AND source_type = 'verified_signup_trial'
    AND idempotency_key = 'verified-signup-trial:v1:' || source_id AND amount_micros > 0);
END $body$;

CREATE FUNCTION organization_plan_seats_used(p_account_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE seats integer; previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  SELECT (SELECT count(*) FROM organization_memberships WHERE account_id = p_account_id
    AND subject_id LIKE 'user:%' AND status IN ('active','provisioning')) +
    (SELECT count(*) FROM organization_membership_invitations invitation
      WHERE invitation.account_id = p_account_id AND invitation.status = 'pending'
        AND invitation.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = p_account_id AND membership.subject_id = invitation.target_subject_id
            AND membership.subject_id LIKE 'user:%' AND membership.status IN ('active','provisioning'))) INTO seats;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RETURN seats;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RAISE;
END $body$;

CREATE FUNCTION upsert_organization_plan(p_account_id uuid, p_plan_key text, p_status text,
  p_stripe_subscription_id text, p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE state organization_plans%ROWTYPE;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  IF opengeni_private.subscription_plan_definition(p_plan_key) IS NULL THEN
    RAISE EXCEPTION 'Unknown subscription plan' USING ERRCODE = '22023';
  END IF;
  INSERT INTO organization_plans(account_id, plan_key, status, stripe_subscription_id,
    current_period_start, current_period_end, cancel_at_period_end)
  VALUES (p_account_id, p_plan_key, p_status, p_stripe_subscription_id, p_period_start, p_period_end, p_cancel_at_period_end)
  ON CONFLICT (account_id) DO UPDATE SET plan_key = excluded.plan_key, status = excluded.status,
    stripe_subscription_id = excluded.stripe_subscription_id, current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
    updated_at = CASE WHEN (organization_plans.plan_key, organization_plans.status, organization_plans.stripe_subscription_id,
      organization_plans.current_period_start, organization_plans.current_period_end, organization_plans.cancel_at_period_end)
      IS DISTINCT FROM (excluded.plan_key, excluded.status, excluded.stripe_subscription_id, excluded.current_period_start,
        excluded.current_period_end, excluded.cancel_at_period_end) THEN clock_timestamp() ELSE organization_plans.updated_at END
  RETURNING * INTO state;
  RETURN to_jsonb(state);
END $body$;

-- Funding/adjustment types are an exclusion list, not a charge allowlist. New
-- resource types automatically count; positive video_generation_refund nets
-- against usage. Promotional allocations are subtracted from gross usage.
-- Settlement time (created_at), not provider/backdated occurred_at, assigns a
-- charge to a period. All debit/refund writers timestamp AFTER the account lock.
CREATE FUNCTION opengeni_private.plan_period_usage(p_period plan_credit_periods, p_until timestamptz)
RETURNS bigint LANGUAGE sql STABLE SET search_path FROM CURRENT AS $body$
  SELECT greatest(0, coalesce(sum(-entry.amount_micros - coalesce(allocated.amount, 0)), 0))::bigint
  FROM credit_ledger_entries entry
  LEFT JOIN LATERAL (SELECT sum(amount_micros) amount FROM credit_debit_allocations
    WHERE account_id = entry.account_id AND debit_entry_id = entry.id) allocated ON true
  WHERE entry.account_id = p_period.account_id
    AND entry.created_at >= greatest(p_period.period_start, p_period.granted_at)
    AND entry.created_at < least(p_period.period_end, p_until)
    AND entry.type NOT IN ('credit_topup','grant','manual_credit_grant','plan_credit_grant','plan_credit_expiry',
      'credit_refund','credit_dispute_hold','credit_dispute_release')
$body$;

CREATE FUNCTION expire_plan_credit_period(p_account_id uuid, p_period_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE period plan_credit_periods%ROWTYPE; usage bigint; remaining bigint; balance bigint; expiry uuid; expiry_time timestamptz;
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
  usage := opengeni_private.plan_period_usage(period, expiry_time);
  remaining := greatest(0, period.granted_micros - usage);
  -- The ledger total also includes model-scoped promotional remainders. They
  -- are not plan credit: do not turn a negative general balance more negative
  -- (or remove promotional funding) just because that total is still positive.
  SELECT coalesce(sum(amount_micros), 0) - coalesce((
    SELECT sum(grant_row.amount_micros - coalesce(allocated.amount, 0))
    FROM credit_ledger_entries grant_row LEFT JOIN LATERAL (
      SELECT sum(amount_micros) amount FROM credit_debit_allocations
      WHERE account_id = p_account_id AND grant_entry_id = grant_row.id
    ) allocated ON true
    WHERE grant_row.account_id = p_account_id AND grant_row.eligible_model_ids IS NOT NULL
      AND grant_row.amount_micros > coalesce(allocated.amount, 0)
  ), 0) INTO balance FROM credit_ledger_entries WHERE account_id = p_account_id;
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, occurred_at, created_at)
  VALUES (p_account_id, NULL, 'plan_credit_expiry', -least(remaining, greatest(0, balance)), 'plan_credit_period', period.id::text,
    'plan-credit-expiry:' || period.id::text, jsonb_build_object('planKey',period.plan_key,'usageMicros',usage), expiry_time, expiry_time)
  RETURNING id INTO expiry;
  UPDATE plan_credit_periods SET expired_at = expiry_time, expiry_entry_id = expiry, usage_at_expiry_micros = usage
    WHERE id = period.id RETURNING * INTO period;
  RETURN to_jsonb(period);
END $body$;

CREATE FUNCTION grant_plan_credit_period(p_account_id uuid, p_plan_key text,
  p_period_start timestamptz, p_period_end timestamptz, p_stripe_subscription_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE state organization_plans%ROWTYPE; period plan_credit_periods%ROWTYPE; previous plan_credit_periods%ROWTYPE;
  definition jsonb; catalog_version bigint; amount bigint; grant_id uuid; granted_time timestamptz; grant_key text;
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
    THEN 'plan-credit:stripe:' || p_stripe_subscription_id || ':' || extract(epoch FROM p_period_start)::text
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
  granted_time := clock_timestamp();
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, eligible_model_ids, occurred_at, created_at)
  VALUES (p_account_id, NULL, 'plan_credit_grant', amount, 'subscription_plan', p_stripe_subscription_id,
    grant_key, jsonb_build_object('planKey',p_plan_key,'catalogRevision',catalog_version), NULL, granted_time, granted_time)
  RETURNING id INTO grant_id;
  INSERT INTO plan_credit_periods(account_id, plan_key, catalog_revision, stripe_subscription_id, period_start, period_end,
    granted_micros, grant_entry_id, idempotency_key, granted_at)
  VALUES (p_account_id, p_plan_key, catalog_version, p_stripe_subscription_id, p_period_start, p_period_end,
    amount, grant_id, grant_key, granted_time) RETURNING * INTO period;
  -- A late invoice must never resurrect an already-ended allowance.
  IF p_period_end <= clock_timestamp() THEN
    RETURN expire_plan_credit_period(p_account_id, period.id, false);
  END IF;
  RETURN to_jsonb(period);
END $body$;

CREATE FUNCTION replace_plan_credit_period(p_account_id uuid, p_plan_key text,
  p_period_start timestamptz, p_period_end timestamptz, p_stripe_subscription_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE previous plan_credit_periods%ROWTYPE;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  -- Replay BEFORE touching the successor: a duplicated upgrade must not expire
  -- its own allowance (or a newer period that has already replaced it).
  IF EXISTS (SELECT 1 FROM plan_credit_periods WHERE account_id = p_account_id AND plan_key = p_plan_key
    AND period_start = p_period_start AND stripe_subscription_id IS NOT DISTINCT FROM p_stripe_subscription_id) THEN
    RETURN grant_plan_credit_period(p_account_id, p_plan_key, p_period_start, p_period_end, p_stripe_subscription_id);
  END IF;
  FOR previous IN SELECT * FROM plan_credit_periods WHERE account_id = p_account_id AND expired_at IS NULL LOOP
    IF previous.period_start >= p_period_start THEN
      RAISE EXCEPTION 'Upgrade cannot replace a newer plan period' USING ERRCODE = '55000';
    END IF;
    PERFORM expire_plan_credit_period(p_account_id, previous.id, true);
  END LOOP;
  RETURN grant_plan_credit_period(p_account_id, p_plan_key, p_period_start, p_period_end, p_stripe_subscription_id);
END $body$;

CREATE FUNCTION read_organization_plan_balance(p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE state organization_plans%ROWTYPE; definition jsonb; period plan_credit_periods%ROWTYPE; remaining bigint := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO state FROM organization_plans WHERE account_id = p_account_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  definition := opengeni_private.subscription_plan_definition(state.plan_key);
  SELECT * INTO period FROM plan_credit_periods WHERE account_id = p_account_id
    AND period_start = state.current_period_start AND plan_key = state.plan_key ORDER BY granted_at DESC LIMIT 1;
  IF period.id IS NOT NULL AND period.expired_at IS NULL AND period.period_end > clock_timestamp() THEN
    remaining := greatest(0, period.granted_micros - opengeni_private.plan_period_usage(period, clock_timestamp()));
  END IF;
  RETURN jsonb_build_object('key',state.plan_key,'label',coalesce(definition->>'label',state.plan_key),'status',state.status,
    'creditGrantedMicros',coalesce(period.granted_micros,0),'creditRemainingMicros',remaining,
    'periodResetAt',state.current_period_end,'seatLimit',definition->'seatLimit','seatsUsed',organization_plan_seats_used(p_account_id),
    'cancelAtPeriodEnd',state.cancel_at_period_end);
END $body$;

CREATE FUNCTION opengeni_private.enforce_organization_plan_seats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE seat_limit integer; seats integer; reserved boolean := false;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    IF NEW.subject_id NOT LIKE 'user:%' OR NEW.status NOT IN ('active','provisioning') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.subject_id = NEW.subject_id
      AND OLD.status IN ('active','provisioning') THEN RETURN NEW; END IF;
  ELSE
    IF NEW.status <> 'pending' OR NEW.expires_at <= clock_timestamp() THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.status = 'pending'
      AND OLD.expires_at > clock_timestamp() AND OLD.target_subject_id IS NOT DISTINCT FROM NEW.target_subject_id THEN RETURN NEW; END IF;
  END IF;
  -- The existing membership lifecycle already owns this lock. Reuse its exact
  -- key/order; do not add an account row FOR UPDATE or a second membership lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  SELECT (opengeni_private.subscription_plan_definition(plan_key)->>'seatLimit')::integer INTO seat_limit
    FROM organization_plans WHERE account_id = NEW.account_id;
  IF seat_limit IS NULL THEN RETURN NEW; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    SELECT EXISTS (SELECT 1 FROM organization_membership_invitations WHERE account_id = NEW.account_id
      AND target_subject_id = NEW.subject_id AND status = 'pending' AND expires_at > clock_timestamp()) INTO reserved;
    -- Acceptance converts an already-counted reservation, even after a downgrade.
    IF reserved THEN
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
      RETURN NEW;
    END IF;
  ELSE
    SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE account_id = NEW.account_id
      AND subject_id = NEW.target_subject_id AND subject_id LIKE 'user:%' AND status IN ('active','provisioning')) INTO reserved;
    IF reserved THEN
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
      RETURN NEW;
    END IF;
  END IF;
  seats := organization_plan_seats_used(NEW.account_id);
  IF TG_TABLE_NAME = 'organization_membership_invitations' THEN
    IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.status = 'pending' AND OLD.expires_at > clock_timestamp() THEN
      seats := seats - 1;
    END IF;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  IF seats >= seat_limit THEN
    RAISE EXCEPTION 'Organization seat limit reached; upgrade your plan to add people'
      USING ERRCODE = 'P0S01', DETAIL = jsonb_build_object('seatLimit',seat_limit,'seatsUsed',seats,'action','upgrade')::text;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  RAISE;
END $body$;
CREATE TRIGGER organization_memberships_plan_seat_limit BEFORE INSERT OR UPDATE OF status, subject_id, account_id
  ON organization_memberships FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_plan_seats();
CREATE TRIGGER organization_invitations_plan_seat_limit BEFORE INSERT OR UPDATE OF status, expires_at, target_subject_id, account_id
  ON organization_membership_invitations FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_plan_seats();

-- Plan credits deliberately do not enter the signup-trial trigger (0613),
-- credits.granted analytics or acquisition/lifecycle observations (0566).
-- They are recurring funding, not a new signup/coupon/manual acquisition grant.
-- Expiries always have workspace_id NULL, bypassing allowance debits (0552).

DO $posture$
DECLARE data_schema text := current_schema(); routine regprocedure; role_name text; relation regclass;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname IN ('set_subscription_plan_catalog','free_plan_credit_eligible',
      'organization_plan_seats_used','upsert_organization_plan','expire_plan_credit_period','grant_plan_credit_period',
      'replace_plan_credit_period','read_organization_plan_balance'))
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('subscription_plan_definition','plan_period_usage','enforce_organization_plan_seats'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE p.oid = routine AND a.grantee <> p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_name); END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
      AND routine::text NOT LIKE '%set_subscription_plan_catalog%'
      AND routine::text NOT LIKE '%opengeni_private.%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO opengeni_app',routine);
    END IF;
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['organization_plans'::regclass,'plan_credit_periods'::regclass,
    'opengeni_private.subscription_plan_catalog_revisions'::regclass] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',relation);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE c.oid = relation AND a.grantee <> c.relowner
    LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',relation,role_name); END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT SELECT ON TABLE %s TO opengeni_app',relation);
    END IF;
  END LOOP;
END $posture$;
