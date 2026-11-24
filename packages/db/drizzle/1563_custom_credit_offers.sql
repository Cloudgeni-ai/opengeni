-- deployment-mode: rolling
-- Custom credit offers (docs/custom-credit-offers.md): an operator assigns an
-- organization a personal offer (amount, model allowlist, validity in days and
-- an optional activation deadline); an organization billing manager chooses
-- when to activate it. Activation writes one model-scoped promotional grant
-- (credit_ledger_entries type 'grant', source_type 'credit_offer') that
-- expires validity days later. There is no renewal and no overage: what is
-- left at expiry is removed by a 'credit_offer_expiry' row allocated to the
-- grant, so neither general credit nor plan allowance usage changes.
--
-- 1. credit_offers: FORCE-RLS, account scoped. Runtime roles only read it;
--    every change goes through the definers below.
-- 2. assign_credit_offer / revoke_credit_offer: owner-only operator setters
--    (scripts/operator/credit-offers.ts). Revoking an active offer expires it
--    now.
-- 3. opengeni_private.activate_credit_offer_v1: idempotent, under the
--    account lock. The runtime role's EXECUTE is withheld for one release
--    (DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release refuses a
--    runtime grant on a definer it does not know. Until a later migration
--    grants it, operators activate offers (credits:offers activate) and the
--    billing page asks the organization to contact support.
-- 4. expire_credit_offer: owner-only; begin_plan_credit_settlement settles
--    ended offers under the account lock before any post-use debit. Balance
--    reads exclude ended offers without waiting for settlement.
--
-- Rolling: a new table, new owner-only routines (the runtime can call none of
-- them yet), and a same-signature replacement of begin_plan_credit_settlement
-- that only adds offer settlement. The previous release never reads the new
-- table and no offer exists until an operator assigns one.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE credit_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 120),
  -- Up to $1,000,000 per offer.
  amount_micros bigint NOT NULL CHECK (amount_micros BETWEEN 1 AND 1000000000000),
  eligible_model_ids text[] NOT NULL CHECK (
    cardinality(eligible_model_ids) BETWEEN 1 AND 40
    AND array_position(eligible_model_ids, NULL) IS NULL
    AND array_position(eligible_model_ids, '') IS NULL),
  valid_days integer NOT NULL CHECK (valid_days BETWEEN 1 AND 730),
  activate_by timestamptz,
  assigned_by text NOT NULL CHECK (assigned_by = btrim(assigned_by) AND char_length(assigned_by) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  activated_by text CHECK (char_length(activated_by) BETWEEN 1 AND 1019),
  grant_entry_id uuid UNIQUE,
  expires_at timestamptz,
  expired_at timestamptz,
  expiry_entry_id uuid UNIQUE,
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by = btrim(revoked_by) AND char_length(revoked_by) BETWEEN 1 AND 1000),
  revoke_reason text CHECK (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 6 AND 1000),
  CONSTRAINT credit_offers_grant FOREIGN KEY (grant_entry_id, account_id)
    REFERENCES credit_ledger_entries(id, account_id),
  CONSTRAINT credit_offers_expiry FOREIGN KEY (expiry_entry_id, account_id)
    REFERENCES credit_ledger_entries(id, account_id),
  CONSTRAINT credit_offers_activation_shape CHECK (
    (activated_at IS NULL) = (grant_entry_id IS NULL)
    AND (activated_at IS NULL) = (expires_at IS NULL)
    AND (activated_at IS NULL) = (activated_by IS NULL)
    AND (expires_at IS NULL OR expires_at > activated_at)),
  CONSTRAINT credit_offers_expiry_shape CHECK (
    (expired_at IS NULL) = (expiry_entry_id IS NULL)
    AND (expired_at IS NULL OR activated_at IS NOT NULL)),
  CONSTRAINT credit_offers_revoke_shape CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL)
    AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE credit_offers IS 'Operator-assigned custom credit offers: model-scoped promotional credit an organization activates once and that expires valid_days later.';
CREATE INDEX credit_offers_account ON credit_offers (account_id, created_at);
CREATE INDEX credit_offers_due ON credit_offers (account_id, expires_at)
  WHERE activated_at IS NOT NULL AND expired_at IS NULL;

ALTER TABLE credit_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_offers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON credit_offers FROM PUBLIC;
CREATE POLICY account_isolation ON credit_offers
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  -- Owner-only: settle one activated offer. Removes the unspent remainder
  -- with a 'credit_offer_expiry' row allocated to the offer's grant, so the
  -- remainder never becomes general credit and no plan allowance counts it.
  EXECUTE format($create$
    CREATE FUNCTION expire_credit_offer(p_account_id uuid, p_offer_id uuid, p_force boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $body$
    DECLARE offer credit_offers%%ROWTYPE; used bigint; remaining bigint; expiry uuid; expiry_time timestamptz;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Credit offer account scope mismatch' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
      SELECT * INTO offer FROM credit_offers WHERE account_id = p_account_id AND id = p_offer_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit offer not found' USING ERRCODE = 'P0002'; END IF;
      IF offer.activated_at IS NULL OR offer.expired_at IS NOT NULL THEN RETURN to_jsonb(offer); END IF;
      expiry_time := clock_timestamp();
      IF NOT p_force AND offer.expires_at > expiry_time THEN
        RAISE EXCEPTION 'Credit offer has not ended' USING ERRCODE = '55000';
      END IF;
      SELECT coalesce(sum(amount_micros), 0) INTO used FROM credit_debit_allocations
        WHERE account_id = p_account_id AND grant_entry_id = offer.grant_entry_id;
      remaining := greatest(0, offer.amount_micros - used);
      INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
        idempotency_key, metadata, occurred_at, created_at)
      VALUES (p_account_id, NULL, 'credit_offer_expiry', -remaining, 'credit_offer', offer.id::text,
        'credit-offer-expiry:' || offer.id::text,
        jsonb_build_object('customCreditOfferId', offer.id, 'usedMicros', used, 'revoked', offer.revoked_at IS NOT NULL),
        expiry_time, expiry_time)
      RETURNING id INTO expiry;
      IF remaining > 0 THEN
        INSERT INTO credit_debit_allocations(account_id, debit_entry_id, grant_entry_id, amount_micros)
          VALUES (p_account_id, expiry, offer.grant_entry_id, remaining);
      END IF;
      UPDATE credit_offers SET expired_at = expiry_time, expiry_entry_id = expiry
        WHERE id = offer.id RETURNING * INTO offer;
      RETURN to_jsonb(offer);
    END $body$;
  $create$, data_schema);

  -- Activate once. Replays return the activated offer unchanged.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.activate_credit_offer_v1(p_account_id uuid, p_offer_id uuid, p_subject_id text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $body$
    DECLARE offer credit_offers%%ROWTYPE; grant_id uuid; activation_time timestamptz; ends_at timestamptz;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Credit offer account scope mismatch' USING ERRCODE = '42501';
      END IF;
      IF p_subject_id IS NULL OR char_length(p_subject_id) NOT BETWEEN 1 AND 1019 THEN
        RAISE EXCEPTION 'Invalid credit offer activation subject' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
      SELECT * INTO offer FROM credit_offers WHERE account_id = p_account_id AND id = p_offer_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit offer not found' USING ERRCODE = 'P0002'; END IF;
      IF offer.activated_at IS NOT NULL THEN RETURN to_jsonb(offer); END IF;
      IF offer.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Credit offer was withdrawn' USING ERRCODE = '55000';
      END IF;
      activation_time := clock_timestamp();
      IF offer.activate_by IS NOT NULL AND offer.activate_by <= activation_time THEN
        RAISE EXCEPTION 'Credit offer activation deadline has passed' USING ERRCODE = '55000';
      END IF;
      ends_at := activation_time + make_interval(days => offer.valid_days);
      INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, eligible_model_ids,
        source_type, source_id, idempotency_key, metadata, occurred_at, created_at)
      VALUES (p_account_id, NULL, 'grant', offer.amount_micros, offer.eligible_model_ids,
        'credit_offer', offer.id::text, 'credit-offer:' || offer.id::text,
        jsonb_build_object('creditOfferLabel', offer.label, 'customCreditOfferId', offer.id,
          'expiresAt', ends_at, 'activatedBy', p_subject_id),
        activation_time, activation_time)
      RETURNING id INTO grant_id;
      UPDATE credit_offers SET activated_at = activation_time, activated_by = p_subject_id,
        grant_entry_id = grant_id, expires_at = ends_at
        WHERE id = offer.id RETURNING * INTO offer;
      RETURN to_jsonb(offer);
    END $body$;
  $create$, data_schema);

  -- Owner-only operator setter. Model ids are validated against the live
  -- catalog by the operator script; the database checks their shape.
  EXECUTE format($create$
    CREATE FUNCTION assign_credit_offer(p_account_id uuid, p_label text, p_amount_micros bigint,
      p_eligible_model_ids text[], p_valid_days integer, p_activate_by timestamptz, p_operator text, p_reason text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $body$
    DECLARE offer credit_offers%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Credit offer account scope mismatch' USING ERRCODE = '42501';
      END IF;
      IF p_activate_by IS NOT NULL AND (NOT isfinite(p_activate_by) OR p_activate_by <= clock_timestamp()) THEN
        RAISE EXCEPTION 'Credit offer activation deadline must be in the future' USING ERRCODE = '22023';
      END IF;
      INSERT INTO credit_offers(account_id, label, amount_micros, eligible_model_ids, valid_days,
        activate_by, assigned_by, reason)
      VALUES (p_account_id, btrim(p_label),  p_amount_micros,
        ARRAY(SELECT DISTINCT btrim(id) FROM unnest(p_eligible_model_ids) id ORDER BY 1),
        p_valid_days, p_activate_by, btrim(p_operator), btrim(p_reason))
      RETURNING * INTO offer;
      RETURN to_jsonb(offer);
    END $body$;
  $create$, data_schema);

  -- Owner-only: withdraw an offer. An active offer expires now.
  EXECUTE format($create$
    CREATE FUNCTION revoke_credit_offer(p_account_id uuid, p_offer_id uuid, p_operator text, p_reason text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $body$
    DECLARE offer credit_offers%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Credit offer account scope mismatch' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
      SELECT * INTO offer FROM credit_offers WHERE account_id = p_account_id AND id = p_offer_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit offer not found' USING ERRCODE = 'P0002'; END IF;
      IF offer.revoked_at IS NULL AND offer.expired_at IS NULL THEN
        UPDATE credit_offers SET revoked_at = clock_timestamp(), revoked_by = btrim(p_operator),
          revoke_reason = btrim(p_reason) WHERE id = offer.id;
        IF offer.activated_at IS NOT NULL THEN
          PERFORM expire_credit_offer(p_account_id, p_offer_id, true);
        END IF;
      END IF;
      SELECT * INTO offer FROM credit_offers WHERE id = p_offer_id;
      RETURN to_jsonb(offer);
    END $body$;
  $create$, data_schema);

  -- Baseline body, plus: ended offers settle first under the same lock and
  -- cutoff, so a debit never allocates to an expired offer.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION begin_plan_credit_settlement(p_account_id uuid) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $body$
    DECLARE settled_at timestamptz; period_id uuid; offer_id uuid;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
      settled_at := clock_timestamp();
      FOR offer_id IN SELECT id FROM credit_offers WHERE account_id = p_account_id
        AND activated_at IS NOT NULL AND expired_at IS NULL AND expires_at <= settled_at LOOP
        PERFORM expire_credit_offer(p_account_id, offer_id, true);
      END LOOP;
      FOR period_id IN SELECT id FROM plan_credit_periods WHERE account_id = p_account_id
        AND expired_at IS NULL AND period_end <= settled_at LOOP
        PERFORM expire_plan_credit_period(p_account_id, period_id, false);
      END LOOP;
      -- Expiry, promotional allocation and ledger attribution all use this one
      -- post-lock cutoff, even if driver latency crosses the period end later.
      RETURN settled_at;
    END $body$;
  $create$, data_schema);

  REVOKE ALL ON FUNCTION expire_credit_offer(uuid, uuid, boolean) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.activate_credit_offer_v1(uuid, uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION assign_credit_offer(uuid, text, bigint, text[], integer, timestamptz, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION revoke_credit_offer(uuid, uuid, text, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- The migration owner can have default runtime grants from prior
    -- provisioning. Establish the exact posture, as 1494.
    REVOKE ALL ON credit_offers FROM opengeni_app;
    GRANT SELECT ON credit_offers TO opengeni_app;
    REVOKE ALL ON FUNCTION expire_credit_offer(uuid, uuid, boolean) FROM opengeni_app;
    REVOKE ALL ON FUNCTION assign_credit_offer(uuid, text, bigint, text[], integer, timestamptz, text, text) FROM opengeni_app;
    REVOKE ALL ON FUNCTION revoke_credit_offer(uuid, uuid, text, text) FROM opengeni_app;
    REVOKE ALL ON FUNCTION opengeni_private.activate_credit_offer_v1(uuid, uuid, text) FROM opengeni_app;
  END IF;
END $install$;
