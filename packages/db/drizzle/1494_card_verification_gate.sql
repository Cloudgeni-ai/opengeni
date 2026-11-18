-- deployment-mode: rolling
-- Card verification gate (docs/signup-abuse-protection.md, "Card
-- verification"). Free credit and new sandbox boxes of an unpaid organization
-- need a card its owner verified with a Stripe SetupIntent (no charge), and
-- one card (and one person) gets Free credit for one organization only.
--
-- 1. card_verification_gate_revisions: the deployment-wide, append-only
--    switch. No row (or a false newest row) leaves the gate off, so this
--    migration changes no behavior. Operators turn it on and off through the
--    existing audited, revision-fenced set_signup_network_velocity setter
--    with {"cardVerificationMode":"enforce"|"off"}. Runtime roles read it.
-- 2. billing_card_verifications: one verified card per organization (the
--    newest replaces it), with the owner who verified it and the card's
--    Stripe fingerprint. FORCE-RLS, account scoped, like 1257.
-- 3. opengeni_private.free_trial_card_claims: owner-only. The first
--    organization whose verified card reaches Free issuance claims the card's
--    fingerprint and the verifying person; no other organization gets Free
--    credit through either.
-- 4. free_plan_credit_eligible and the subscription maintenance inventory
--    apply it while the gate is on, for organizations that never bought
--    credit or had a Stripe subscription. Nothing is deleted, no ledger is
--    touched and the Free catalog is unchanged.
--
-- Rolling: new tables (RLS secure shape; the private one owner-only), a new
-- owner-only invoker helper, and CREATE OR REPLACE of known routines with the
-- same signatures. The previous release never reads the new tables; with the
-- gate off every routine behaves as before.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE card_verification_gate_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled boolean NOT NULL,
  changed_by text NOT NULL CHECK (changed_by = btrim(changed_by) AND char_length(changed_by) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE card_verification_gate_revisions IS 'Append-only operator switch: while the newest row is enabled, unpaid organizations need a verified card for Free credit and new sandbox boxes.';

CREATE TABLE billing_card_verifications (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 1019),
  provider text NOT NULL CHECK (provider IN ('stripe:test', 'stripe:live')),
  customer_id text NOT NULL CHECK (char_length(customer_id) BETWEEN 1 AND 255),
  payment_method_id text NOT NULL CHECK (char_length(payment_method_id) BETWEEN 1 AND 255),
  setup_intent_id text NOT NULL CHECK (char_length(setup_intent_id) BETWEEN 1 AND 255),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 255),
  brand text NOT NULL CHECK (char_length(brand) BETWEEN 1 AND 64),
  last4 text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX billing_card_verifications_subject ON billing_card_verifications (subject_id);

CREATE TABLE opengeni_private.free_trial_card_claims (
  data_schema text NOT NULL,
  -- 'card': provider:fingerprint; 'person': the verifying subject.
  claim_kind text NOT NULL CHECK (claim_kind IN ('card', 'person')),
  claim_key text NOT NULL CHECK (char_length(claim_key) BETWEEN 1 AND 1100),
  account_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, claim_kind, claim_key)
);
CREATE INDEX free_trial_card_claims_account ON opengeni_private.free_trial_card_claims (data_schema, account_id);
REVOKE ALL ON opengeni_private.free_trial_card_claims FROM PUBLIC;

ALTER TABLE card_verification_gate_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_verification_gate_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_card_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_card_verifications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON card_verification_gate_revisions, billing_card_verifications FROM PUBLIC;
CREATE POLICY deployment_read ON card_verification_gate_revisions FOR SELECT USING (true);
CREATE POLICY account_isolation ON billing_card_verifications
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $card_verification_gate$
DECLARE data_schema text := current_schema(); owner_name text := current_user; routine regprocedure;
BEGIN
  -- Only the owner appends switch revisions (through the setter).
  EXECUTE format('CREATE POLICY owner_append ON card_verification_gate_revisions FOR INSERT TO %I WITH CHECK (true)', owner_name);
  -- The subscription maintenance inventory reads cards across organizations
  -- under its owner fence, like the tables it already reads (baseline 21).
  EXECUTE format(
    'CREATE POLICY subscription_plan_maintenance_inventory_read ON %1$I.billing_card_verifications '
    'FOR SELECT USING (%1$I.session_tenancy_fence_owner_policy_active('
    '(CURRENT_USER)::text, %2$L::text, %3$s::oid, NULL::uuid, true))',
    data_schema, owner_name, data_schema::regnamespace::oid);

  -- Whether an organization's card allows Free credit: true while the gate is
  -- off and for an organization that bought credit or had a Stripe
  -- subscription; otherwise it needs its own verified card, and neither the
  -- card nor the person who verified it may have been claimed by another
  -- organization. With p_claim the organization claims both first (the
  -- first one wins). Owner-only; called by the owner's definers.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.free_credit_card_ok(p_account_id uuid, p_claim boolean)
    RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $body$
    DECLARE card %1$I.billing_card_verifications%%ROWTYPE; card_key text;
    BEGIN
      IF NOT coalesce((SELECT gate.enabled FROM %1$I.card_verification_gate_revisions gate
          ORDER BY gate.revision DESC LIMIT 1), false) THEN
        RETURN true;
      END IF;
      IF EXISTS (SELECT 1 FROM %1$I.organization_plans plan
          WHERE plan.account_id = p_account_id AND plan.stripe_subscription_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM %1$I.credit_ledger_entries entry
          WHERE entry.account_id = p_account_id AND entry.type = 'credit_topup' AND entry.amount_micros > 0) THEN
        RETURN true;
      END IF;
      SELECT * INTO card FROM %1$I.billing_card_verifications v WHERE v.account_id = p_account_id;
      IF NOT FOUND THEN RETURN false; END IF;
      card_key := card.provider || ':' || card.fingerprint;
      IF p_claim AND NOT EXISTS (SELECT 1 FROM opengeni_private.free_trial_card_claims claim
          WHERE claim.data_schema = %2$L AND claim.account_id = p_account_id
            AND ((claim.claim_kind = 'card' AND claim.claim_key = card_key)
              OR (claim.claim_kind = 'person' AND claim.claim_key = card.subject_id))) THEN
        INSERT INTO opengeni_private.free_trial_card_claims (data_schema, claim_kind, claim_key, account_id)
          VALUES (%2$L, 'card', card_key, p_account_id), (%2$L, 'person', card.subject_id, p_account_id)
          ON CONFLICT DO NOTHING;
      END IF;
      RETURN NOT EXISTS (SELECT 1 FROM opengeni_private.free_trial_card_claims claim
        WHERE claim.data_schema = %2$L AND claim.account_id <> p_account_id
          AND ((claim.claim_kind = 'card' AND claim.claim_key = card_key)
            OR (claim.claim_kind = 'person' AND claim.claim_key = card.subject_id)));
    END $body$;
  $create$, data_schema, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.free_credit_card_ok(uuid, boolean) FROM PUBLIC;

  -- 1119's inventory, plus the card: a Free organization the gate refuses is
  -- not listed, so it never fills a maintenance batch.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
    RETURNS TABLE (account_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid; sweep_time timestamptz := clock_timestamp(); signup_not_before timestamptz;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid subscription plan maintenance bound' USING ERRCODE = '22023';
      END IF;
      SELECT cutoff.not_before INTO signup_not_before FROM opengeni_private.free_credit_signup_cutoff_revisions cutoff
        WHERE cutoff.data_schema = %1$I.session_tenancy_fence_target_schema()::regnamespace::text
        ORDER BY cutoff.revision DESC LIMIT 1;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
        SELECT candidate.account_id FROM (
          (SELECT period.account_id FROM %1$I.plan_credit_periods period
            WHERE period.expired_at IS NULL AND period.period_end <= sweep_time
            ORDER BY period.period_end, period.account_id LIMIT p_limit)
          UNION
          (SELECT account.id AS account_id FROM %1$I.managed_accounts account
            LEFT JOIN %1$I.organization_plans state ON state.account_id = account.id
            CROSS JOIN LATERAL opengeni_private.subscription_plan_free_anniversary(account.created_at, greatest(account.created_at, sweep_time)) anniversary
            WHERE account.created_at <= sweep_time
              AND (state.account_id IS NULL
                OR (state.plan_key IN ('pro', 'max') AND state.status IN ('canceled', 'unpaid', 'incomplete_expired') AND state.current_period_end <= sweep_time)
                OR (state.plan_key = 'free' AND state.status IN ('active', 'trialing') AND state.stripe_subscription_id IS NULL
                  AND (opengeni_private.subscription_plan_definition('free')->>'freeCredit')::boolean
                  AND NOT EXISTS (SELECT 1 FROM %1$I.promotion_decisions hold
                    WHERE hold.account_id=account.id AND hold.decision <> 'eligible'
                    AND EXISTS (SELECT 1 FROM %1$I.promotion_enforcement WHERE enabled))
                  AND EXISTS (SELECT 1 FROM %1$I.credit_ledger_entries trial
                    WHERE trial.account_id = account.id AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
                      AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
                      AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM %1$I.auth_users signup_owner
                        WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before)))
                  AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods receipt
                    WHERE receipt.account_id = account.id
                      AND receipt.idempotency_key = 'plan-credit:free:' || account.id::text || ':' || to_char(anniversary.period_start AT TIME ZONE 'UTC', 'YYYY-MM'))
                  AND opengeni_private.free_credit_card_ok(account.id, false)))
              AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods live
                WHERE live.account_id = account.id AND live.expired_at IS NULL AND live.period_end > sweep_time)
            ORDER BY account.id LIMIT p_limit)
        ) candidate ORDER BY candidate.account_id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);

  -- 1493's settings plus the card verification gate (off unless set).
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.signup_network_velocity_settings(p_data_schema text)
    RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $body$
      SELECT jsonb_build_object(
        'revision', coalesce(current.revision, 0),
        'mode', coalesce(current.mode, 'off'),
        'windowHours', coalesce(current.window_hours, 24),
        'exactHoldThreshold', coalesce(current.exact_hold_threshold, 3),
        'prefixHoldThreshold', CASE WHEN current.revision IS NULL THEN NULL ELSE current.prefix_hold_threshold END,
        'rateLimitEnabled', coalesce(current.rate_limit_enabled, false),
        'rateLimitMax', coalesce(current.rate_limit_max, 5),
        'rateLimitWindowHours', 1,
        'deniedNetworkMode', coalesce(current.denied_network_mode, 'off'),
        'deniedNetworkLookbackDays', 90,
        'signInNetworkMode', coalesce(current.sign_in_network_mode, 'off'),
        'emailDomainMode', coalesce(current.email_domain_mode, 'observe'),
        'emailDomainHoldThreshold', coalesce(current.email_domain_hold_threshold, 3),
        'emailDomainWindowMinutes', coalesce(current.email_domain_window_minutes, 60),
        'burstMode', coalesce(current.burst_mode, 'enforce'),
        'burstHoldThreshold', coalesce(current.burst_hold_threshold, 4),
        'burstWindowSeconds', coalesce(current.burst_window_seconds, 10),
        'deniedDomainMode', coalesce(current.denied_domain_mode, 'enforce'),
        'deniedDomainHoldThreshold', coalesce(current.denied_domain_hold_threshold, 2),
        'deniedDomainLookbackDays', coalesce(current.denied_domain_lookback_days, 30),
        'disposableMailMode', coalesce(current.disposable_mail_mode, 'enforce'),
        'slowDomainMode', coalesce(current.slow_domain_mode, 'enforce'),
        'slowDomainHoldThreshold', coalesce(current.slow_domain_hold_threshold, 3),
        'slowDomainWindowHours', coalesce(current.slow_domain_window_hours, 24),
        'cardVerificationMode', CASE WHEN coalesce((SELECT gate.enabled FROM %1$I.card_verification_gate_revisions gate
          ORDER BY gate.revision DESC LIMIT 1), false) THEN 'enforce' ELSE 'off' END,
        'operator', current.operator,
        'changedAt', current.changed_at)
      FROM (SELECT 1) AS one
      LEFT JOIN LATERAL (
        SELECT * FROM opengeni_private.signup_network_velocity_revisions r
        WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
      ) AS current ON true
    $body$;
  $create$, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname = 'free_credit_card_ok'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END $card_verification_gate$;

-- 1493's setter, plus cardVerificationMode ('off' or 'enforce'), which
-- appends a card_verification_gate_revisions row.
CREATE OR REPLACE FUNCTION opengeni_private.set_signup_network_velocity(
  p_changes jsonb, p_operator text, p_reason text, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE target text := session_tenancy_fence_target_schema()::regnamespace::text;
  previous jsonb; merged jsonb; unknown_keys text[]; result opengeni_private.signup_network_velocity_revisions%ROWTYPE;
BEGIN
  IF p_expected_revision IS NULL OR p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'Signup network velocity settings need a change object and the expected revision'
      USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(key) INTO unknown_keys FROM jsonb_object_keys(p_changes) AS key
    WHERE key NOT IN ('mode','windowHours','exactHoldThreshold','prefixHoldThreshold','rateLimitEnabled',
      'rateLimitMax','deniedNetworkMode','signInNetworkMode','emailDomainMode','emailDomainHoldThreshold',
      'emailDomainWindowMinutes','burstMode','burstHoldThreshold','burstWindowSeconds','deniedDomainMode',
      'deniedDomainHoldThreshold','deniedDomainLookbackDays','disposableMailMode','slowDomainMode',
      'slowDomainHoldThreshold','slowDomainWindowHours','cardVerificationMode');
  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown signup network velocity settings: %', array_to_string(unknown_keys, ', ')
      USING ERRCODE = '22023';
  END IF;
  IF p_changes ? 'cardVerificationMode' AND (jsonb_typeof(p_changes->'cardVerificationMode') <> 'string'
    OR p_changes->>'cardVerificationMode' NOT IN ('off', 'enforce')) THEN
    RAISE EXCEPTION 'cardVerificationMode must be off or enforce' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('signup-network-velocity:' || target, 0));
  previous := opengeni_private.signup_network_velocity_settings(target);
  IF p_expected_revision <> (previous->>'revision')::bigint THEN
    RAISE EXCEPTION 'Signup network velocity settings changed' USING ERRCODE = '40001';
  END IF;
  merged := previous || p_changes;
  INSERT INTO opengeni_private.signup_network_velocity_revisions(data_schema, revision, mode, window_hours,
    exact_hold_threshold, prefix_hold_threshold, rate_limit_enabled, rate_limit_max, denied_network_mode,
    sign_in_network_mode, email_domain_mode, email_domain_hold_threshold, email_domain_window_minutes,
    burst_mode, burst_hold_threshold, burst_window_seconds, denied_domain_mode, denied_domain_hold_threshold,
    denied_domain_lookback_days, disposable_mail_mode, slow_domain_mode, slow_domain_hold_threshold,
    slow_domain_window_hours, operator, reason)
  VALUES (target, (previous->>'revision')::bigint + 1, merged->>'mode', (merged->>'windowHours')::integer,
    (merged->>'exactHoldThreshold')::integer, (merged->>'prefixHoldThreshold')::integer,
    (merged->>'rateLimitEnabled')::boolean, (merged->>'rateLimitMax')::integer,
    merged->>'deniedNetworkMode', merged->>'signInNetworkMode', merged->>'emailDomainMode',
    (merged->>'emailDomainHoldThreshold')::integer, (merged->>'emailDomainWindowMinutes')::integer,
    merged->>'burstMode', (merged->>'burstHoldThreshold')::integer, (merged->>'burstWindowSeconds')::integer,
    merged->>'deniedDomainMode', (merged->>'deniedDomainHoldThreshold')::integer,
    (merged->>'deniedDomainLookbackDays')::integer, merged->>'disposableMailMode', merged->>'slowDomainMode',
    (merged->>'slowDomainHoldThreshold')::integer, (merged->>'slowDomainWindowHours')::integer,
    p_operator, p_reason)
  RETURNING * INTO result;
  IF p_changes ? 'cardVerificationMode'
    AND (p_changes->>'cardVerificationMode') IS DISTINCT FROM (previous->>'cardVerificationMode') THEN
    INSERT INTO card_verification_gate_revisions (enabled, changed_by, reason)
      VALUES (p_changes->>'cardVerificationMode' = 'enforce', btrim(p_operator), btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- 1489's eligibility, plus the card: the organization's verified card, not
-- claimed by another organization (and claimed by this one).
CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE signup_not_before timestamptz;
BEGIN
  PERFORM opengeni_private.evaluate_promotion_abuse(p_account_id);
  -- Fail open: an unexpected rule failure never blocks admission or Free
  -- issuance; the next evaluation retries.
  BEGIN
    PERFORM opengeni_private.evaluate_signup_network_velocity(p_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network velocity evaluation skipped (%)', SQLSTATE;
  END;
  BEGIN
    PERFORM opengeni_private.evaluate_signup_denied_network(p_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup denied network evaluation skipped (%)', SQLSTATE;
  END;
  BEGIN
    PERFORM opengeni_private.evaluate_signup_email_cluster(p_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup email cluster evaluation skipped (%)', SQLSTATE;
  END;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM promotion_enforcement WHERE enabled) AND EXISTS
    (SELECT 1 FROM promotion_decisions WHERE account_id=p_account_id AND decision <> 'eligible') THEN
    RETURN false;
  END IF;
  SELECT cutoff.not_before INTO signup_not_before FROM opengeni_private.free_credit_signup_cutoff_revisions cutoff
    WHERE cutoff.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
    ORDER BY cutoff.revision DESC LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM credit_ledger_entries trial WHERE trial.account_id = p_account_id
    AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
    AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
    AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM auth_users signup_owner
      WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before))) THEN
    RETURN false;
  END IF;
  RETURN opengeni_private.free_credit_card_ok(p_account_id, true);
END $body$;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search paths, as 1493.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible')
      OR (n.nspname = 'opengeni_private' AND p.proname = 'set_signup_network_velocity')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- The migration owner can have default runtime grants from prior
    -- provisioning. Establish the exact posture, as 1257.
    REVOKE ALL ON card_verification_gate_revisions, billing_card_verifications FROM opengeni_app;
    GRANT SELECT ON card_verification_gate_revisions TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE ON billing_card_verifications TO opengeni_app;
  END IF;
END $install$;
