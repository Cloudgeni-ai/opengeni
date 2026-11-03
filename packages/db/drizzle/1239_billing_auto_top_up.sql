-- deployment-mode: rolling
-- Additive FORCE-RLS tables and invoker-only guards. No new SECURITY DEFINER
-- capability and no changed existing contract; pinned previous-binary readiness
-- must remain green. No account is enrolled by this migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE billing_auto_top_up_settings (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  threshold_micros bigint NOT NULL DEFAULT 10000000,
  amount_micros bigint NOT NULL DEFAULT 25000000,
  monthly_cap_micros bigint NOT NULL DEFAULT 100000000,
  consent_subject text,
  consent_version text,
  consent_at timestamptz,
  provider text CHECK (provider IN ('stripe:test', 'stripe:live')),
  customer_id text,
  payment_method_id text,
  payment_method_brand text,
  payment_method_last4 text,
  setup_key uuid,
  setup_subject text,
  failure_reason text,
  cap_required_micros bigint,
  revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (threshold_micros BETWEEN 0 AND 10000000000 AND threshold_micros % 10000 = 0),
  CHECK (amount_micros BETWEEN 5000000 AND 10000000000 AND amount_micros % 10000 = 0),
  CHECK (monthly_cap_micros BETWEEN amount_micros AND 10000000000 AND monthly_cap_micros % 10000 = 0),
  CHECK (NOT enabled OR (consent_subject IS NOT NULL AND consent_version = 'off_session_threshold_v1' AND consent_at IS NOT NULL)),
  CHECK (payment_method_id IS NULL OR (customer_id IS NOT NULL AND provider IS NOT NULL AND payment_method_brand IS NOT NULL AND payment_method_last4 IS NOT NULL))
);
CREATE TABLE billing_auto_top_up_mutations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_key uuid NOT NULL,
  actor_subject text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, operation_key)
);
CREATE TABLE billing_auto_top_up_operations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'failed')),
  reservation_month date NOT NULL,
  credit_micros bigint NOT NULL CHECK (credit_micros BETWEEN 5000000 AND 10000000000 AND credit_micros % 10000 = 0),
  charge_micros bigint NOT NULL CHECK (charge_micros >= credit_micros AND charge_micros <= 10000000000 AND charge_micros % 10000 = 0),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  payment_intent_id text,
  confirmation_started_at timestamptz,
  charged_at timestamptz,
  failure_reason text,
  notification_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, operation_key),
  UNIQUE (payment_intent_id),
  CHECK ((state = 'pending') = (completed_at IS NULL)),
  CHECK (state <> 'succeeded' OR (charged_at IS NOT NULL AND payment_intent_id IS NOT NULL)),
  CHECK (confirmation_started_at IS NULL OR payment_intent_id IS NOT NULL)
);
CREATE UNIQUE INDEX billing_auto_top_up_one_pending ON billing_auto_top_up_operations(account_id) WHERE state = 'pending';
CREATE INDEX billing_auto_top_up_month ON billing_auto_top_up_operations(account_id, reservation_month);

ALTER TABLE billing_auto_top_up_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_top_up_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_top_up_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_top_up_mutations FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_top_up_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_top_up_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_auto_top_up_settings, billing_auto_top_up_mutations, billing_auto_top_up_operations FROM PUBLIC;
CREATE POLICY account_isolation ON billing_auto_top_up_settings USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));
CREATE POLICY account_isolation ON billing_auto_top_up_mutations USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));
CREATE POLICY account_isolation ON billing_auto_top_up_operations USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE FUNCTION guard_billing_auto_top_up() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE settings billing_auto_top_up_settings%ROWTYPE; spent bigint; month_start date;
BEGIN
  IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Automatic top-up account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  month_start := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date;
  SELECT coalesce(sum(charge_micros), 0) INTO spent FROM billing_auto_top_up_operations
    WHERE account_id = NEW.account_id AND state <> 'failed'
      AND (reservation_month = month_start OR state = 'pending'
        OR date_trunc('month', charged_at AT TIME ZONE 'UTC')::date = month_start);
  IF TG_TABLE_NAME = 'billing_auto_top_up_settings' THEN
    IF NEW.monthly_cap_micros < spent THEN
      RAISE EXCEPTION 'The cap cannot be lower than this month''s charges and reservations' USING ERRCODE = 'P0T01';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'Automatic top-up account is immutable' USING ERRCODE = '23505';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT * INTO settings FROM billing_auto_top_up_settings WHERE account_id = NEW.account_id;
    IF settings.account_id IS NULL OR NOT settings.enabled OR settings.payment_method_id IS NULL THEN
      RAISE EXCEPTION 'Automatic top-up is not ready' USING ERRCODE = 'P0T02';
    END IF;
    IF NEW.reservation_month <> month_start OR NEW.state <> 'pending'
      OR NEW.credit_micros <> settings.amount_micros OR NEW.charge_micros + spent > settings.monthly_cap_micros
      OR NEW.payment_intent_id IS NOT NULL OR NEW.confirmation_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'Automatic top-up monthly cap or reservation mismatch' USING ERRCODE = 'P0T01';
    END IF;
  ELSE
    IF (NEW.account_id, NEW.operation_key, NEW.reservation_month, NEW.credit_micros, NEW.charge_micros, NEW.intent, NEW.created_at)
      IS DISTINCT FROM (OLD.account_id, OLD.operation_key, OLD.reservation_month, OLD.credit_micros, OLD.charge_micros, OLD.intent, OLD.created_at)
      OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id)
      OR (OLD.confirmation_started_at IS NOT NULL AND NEW.confirmation_started_at IS DISTINCT FROM OLD.confirmation_started_at)
      OR (OLD.state <> 'pending' AND (NEW.state, NEW.charged_at, NEW.completed_at, NEW.failure_reason)
        IS DISTINCT FROM (OLD.state, OLD.charged_at, OLD.completed_at, OLD.failure_reason)) THEN
      RAISE EXCEPTION 'Automatic top-up intent and terminal receipt are immutable' USING ERRCODE = '23505';
    END IF;
    -- A confirmation resumed after UTC rollover must pass the current cap too.
    IF OLD.confirmation_started_at IS NULL AND NEW.confirmation_started_at IS NOT NULL THEN
      SELECT * INTO settings FROM billing_auto_top_up_settings WHERE account_id = NEW.account_id;
      IF NOT settings.enabled OR spent > settings.monthly_cap_micros THEN
        RAISE EXCEPTION 'Automatic top-up is disabled or capped' USING ERRCODE = 'P0T02';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_billing_auto_top_up() FROM PUBLIC;
CREATE TRIGGER billing_auto_top_up_settings_guard BEFORE INSERT OR UPDATE ON billing_auto_top_up_settings FOR EACH ROW EXECUTE FUNCTION guard_billing_auto_top_up();
CREATE TRIGGER billing_auto_top_up_operations_guard BEFORE INSERT OR UPDATE ON billing_auto_top_up_operations FOR EACH ROW EXECUTE FUNCTION guard_billing_auto_top_up();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON billing_auto_top_up_settings, billing_auto_top_up_operations TO opengeni_app;
    GRANT SELECT, INSERT ON billing_auto_top_up_mutations TO opengeni_app;
  END IF;
END $$;
