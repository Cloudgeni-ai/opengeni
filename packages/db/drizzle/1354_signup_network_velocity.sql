-- deployment-mode: rolling
-- Signup network velocity. Additive and inert by default: mode off,
-- rate limit off. Free-credit farms create many self-serve organizations from
-- one network; a real company normally has one person set up an organization
-- and invite colleagues, and invited members never get a setup receipt.
--
-- 1. Record. The API passes keyed hashes (HMAC, never the address) of the
--    trusted client address and of its /24 (IPv4) or /48 (IPv6) prefix in the
--    transaction-local setting opengeni.signup_network_source. The existing
--    setup-receipt trigger records one row per new self-serve organization,
--    best-effort, in every detector mode. No setting means nothing recorded.
-- 2. Settings. Owner-only, revision-fenced revisions like 1119.
-- 3. Detect and hold. free_plan_credit_eligible also evaluates an exact-network
--    velocity rule for the current account only (ip-velocity-v1).
-- 4. Rate limit. When enabled, the same trigger refuses a new self-serve
--    organization (SQLSTATE OG429) once the exact network already set up the
--    maximum in the last hour. Reads fail open; replays insert no receipt.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.signup_network_sources (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  owner_auth_user_id text NOT NULL CHECK (octet_length(owner_auth_user_id) BETWEEN 1 AND 1019),
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  prefix_hash text NOT NULL CHECK (prefix_hash ~ '^[0-9a-f]{64}$'),
  set_up_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, account_id)
);
CREATE INDEX IF NOT EXISTS signup_network_sources_address
  ON opengeni_private.signup_network_sources (data_schema, address_hash, set_up_at);
CREATE INDEX IF NOT EXISTS signup_network_sources_prefix
  ON opengeni_private.signup_network_sources (data_schema, prefix_hash, set_up_at);
CREATE INDEX IF NOT EXISTS signup_network_sources_set_up
  ON opengeni_private.signup_network_sources (data_schema, set_up_at);
REVOKE ALL ON opengeni_private.signup_network_sources FROM PUBLIC;

-- Append-only, owner-only. The newest revision is current; none means defaults.
CREATE TABLE opengeni_private.signup_network_velocity_revisions (
  data_schema text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mode text NOT NULL CHECK (mode IN ('off','observe','enforce')),
  window_hours integer NOT NULL CHECK (window_hours BETWEEN 1 AND 168),
  exact_hold_threshold integer NOT NULL CHECK (exact_hold_threshold BETWEEN 2 AND 10000),
  prefix_hold_threshold integer CHECK (prefix_hold_threshold BETWEEN 2 AND 10000),
  rate_limit_enabled boolean NOT NULL,
  rate_limit_max integer NOT NULL CHECK (rate_limit_max BETWEEN 1 AND 10000),
  operator text NOT NULL CHECK (octet_length(operator) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, revision)
);
REVOKE ALL ON opengeni_private.signup_network_velocity_revisions FROM PUBLIC;

-- Current settings with defaults. Invoker: callers are owner-run definers.
CREATE OR REPLACE FUNCTION opengeni_private.signup_network_velocity_settings(p_data_schema text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'revision', coalesce(current.revision, 0),
    'mode', coalesce(current.mode, 'off'),
    'windowHours', coalesce(current.window_hours, 24),
    'exactHoldThreshold', coalesce(current.exact_hold_threshold, 3),
    'prefixHoldThreshold', CASE WHEN current.revision IS NULL THEN NULL ELSE current.prefix_hold_threshold END,
    'rateLimitEnabled', coalesce(current.rate_limit_enabled, false),
    'rateLimitMax', coalesce(current.rate_limit_max, 5),
    'rateLimitWindowHours', 1,
    'operator', current.operator,
    'changedAt', current.changed_at)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT * FROM opengeni_private.signup_network_velocity_revisions r
    WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
  ) AS current ON true
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

-- Owner-only, revision-fenced (0 before the first write; 40001 when stale).
-- p_changes holds only the fields to change; the rest keep their current value.
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
    WHERE key NOT IN ('mode','windowHours','exactHoldThreshold','prefixHoldThreshold','rateLimitEnabled','rateLimitMax');
  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown signup network velocity settings: %', array_to_string(unknown_keys, ', ')
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('signup-network-velocity:' || target, 0));
  previous := opengeni_private.signup_network_velocity_settings(target);
  IF p_expected_revision <> (previous->>'revision')::bigint THEN
    RAISE EXCEPTION 'Signup network velocity settings changed' USING ERRCODE = '40001';
  END IF;
  merged := previous || p_changes;
  INSERT INTO opengeni_private.signup_network_velocity_revisions(data_schema, revision, mode, window_hours,
    exact_hold_threshold, prefix_hold_threshold, rate_limit_enabled, rate_limit_max, operator, reason)
  VALUES (target, (previous->>'revision')::bigint + 1, merged->>'mode', (merged->>'windowHours')::integer,
    (merged->>'exactHoldThreshold')::integer, (merged->>'prefixHoldThreshold')::integer,
    (merged->>'rateLimitEnabled')::boolean, (merged->>'rateLimitMax')::integer, p_operator, p_reason)
  RETURNING * INTO result;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- Evaluates ONLY the current account (its own credit fence through
-- set_promotion_decision). Other accounts' rows are read, never locked. Counts
-- distinct self-serve organizations whose setup on the same exact network is
-- within the window of this account's setup, including itself. A scan bound
-- keeps evidence small; the count stays a lower bound, so a threshold match is
-- still exact. Never transitive: only this account is decided.
CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_network_velocity(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text;
  settings jsonb; source opengeni_private.signup_network_sources%ROWTYPE; window_size interval;
  exact_count integer; prefix_count integer; exact_times jsonb; exact_threshold integer;
  prefix_threshold integer; exact_match boolean; prefix_match boolean; facts jsonb; decision_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Signup network velocity scope mismatch' USING ERRCODE = '42501';
  END IF;
  settings := opengeni_private.signup_network_velocity_settings(target);
  IF settings->>'mode' = 'off' THEN RETURN; END IF;
  SELECT * INTO source FROM opengeni_private.signup_network_sources
    WHERE data_schema = target AND account_id = p_account_id;
  IF NOT FOUND OR source.set_up_at < statement_timestamp() - interval '7 days' THEN RETURN; END IF;
  window_size := make_interval(hours => (settings->>'windowHours')::integer);
  exact_threshold := (settings->>'exactHoldThreshold')::integer;
  prefix_threshold := (settings->>'prefixHoldThreshold')::integer;
  SELECT count(*)::integer, coalesce(jsonb_agg(to_char(peer.set_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')
      ORDER BY peer.set_up_at) FILTER (WHERE peer.position <= 20), '[]'::jsonb)
    INTO exact_count, exact_times FROM (
      SELECT s.set_up_at, row_number() OVER (ORDER BY s.set_up_at, s.account_id) AS position
      FROM opengeni_private.signup_network_sources s
      WHERE s.data_schema = target AND s.address_hash = source.address_hash
        AND s.set_up_at BETWEEN source.set_up_at - window_size AND source.set_up_at + window_size
      ORDER BY s.set_up_at, s.account_id LIMIT 501
    ) peer;
  SELECT count(*)::integer INTO prefix_count FROM (
      SELECT 1 FROM opengeni_private.signup_network_sources s
      WHERE s.data_schema = target AND s.prefix_hash = source.prefix_hash
        AND s.set_up_at BETWEEN source.set_up_at - window_size AND source.set_up_at + window_size
      LIMIT 501
    ) peer;
  IF exact_count < 2 AND prefix_count < 2 THEN RETURN; END IF;
  exact_match := exact_count >= exact_threshold;
  prefix_match := prefix_threshold IS NOT NULL AND prefix_count >= prefix_threshold;
  facts := jsonb_build_object(
    'ruleId', CASE WHEN exact_match THEN 'ip-velocity-exact-v1' WHEN prefix_match THEN 'ip-velocity-prefix-v1'
      ELSE 'ip-velocity-observed-v1' END,
    'exactGroupSize', exact_count, 'prefixGroupSize', prefix_count,
    'groupSizeAtLeast', exact_count > 500 OR prefix_count > 500,
    'exactHoldThreshold', exact_threshold, 'prefixHoldThreshold', prefix_threshold,
    'windowHours', (settings->>'windowHours')::integer, 'settingsRevision', (settings->>'revision')::bigint,
    'addressGroup', left(source.address_hash, 16), 'prefixGroup', left(source.prefix_hash, 16),
    'setUpAt', to_char(source.set_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
    'exactGroupSetupTimes', exact_times);
  -- Unchanged evidence writes nothing, so admission reads do not churn rows.
  INSERT INTO opengeni_private.promotion_detector_observations(data_schema, account_id, policy_version, evidence)
    VALUES (target, p_account_id, 'ip-velocity-v1', facts)
    ON CONFLICT (data_schema, account_id, policy_version) DO UPDATE
      SET evidence = excluded.evidence, last_seen_at = clock_timestamp()
      WHERE promotion_detector_observations.evidence IS DISTINCT FROM excluded.evidence;
  IF settings->>'mode' = 'enforce' AND (exact_match OR prefix_match) THEN
    -- Same precedence as the machine rule: manual decisions (including an
    -- operator release) are never overwritten, and a detector hold is kept.
    SELECT * INTO decision_row FROM promotion_decisions WHERE account_id = p_account_id;
    IF NOT FOUND OR (decision_row.actor = 'service:promotion-detector' AND decision_row.decision = 'eligible') THEN
      PERFORM opengeni_private.set_promotion_decision(p_account_id, 'held', 'ip-velocity-v1',
        facts->>'ruleId', facts, 'service:promotion-detector', coalesce(decision_row.revision, 0));
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.evaluate_signup_network_velocity(uuid) FROM PUBLIC;

-- The existing setup-receipt trigger (baseline body unchanged first), plus the
-- signup network record and rate limit. It fires only for a NEW receipt, so an
-- idempotent replay of a committed setup records and refuses nothing.
CREATE OR REPLACE FUNCTION opengeni_private.grant_verified_signup_trial_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE verified_owner boolean; account_owner boolean; inserted_count integer; model_ids jsonb;
  target text; network jsonb; address_hash_value text; prefix_hash_value text; settings jsonb;
  recent_count integer; refuse boolean := false; evaluate_ids text;
BEGIN
  -- The legacy environment flag and runtime money-grant switch no longer gate
  -- this non-monetary eligibility witness. Neither can re-enable a bonus.
  SELECT candidate.email_verified IS TRUE INTO verified_owner
    FROM auth_users candidate WHERE candidate.id = NEW.auth_user_id;
  SELECT account.external_source = 'better-auth:user' AND account.external_id = NEW.auth_user_id
    INTO account_owner FROM managed_accounts account WHERE account.id = NEW.account_id;
  IF verified_owner IS DISTINCT FROM TRUE OR account_owner IS DISTINCT FROM TRUE
    OR opengeni_private.current_subject_id() IS DISTINCT FROM 'user:' || NEW.auth_user_id
    OR opengeni_private.current_account_id() IS DISTINCT FROM NEW.account_id
    OR NEW.result ->> 'organizationId' IS DISTINCT FROM NEW.account_id::text THEN
    RAISE EXCEPTION 'verified signup eligibility requires an exact new owner' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(policy->'signupModelIds', policy->'defaultModelIds') INTO model_ids
    FROM opengeni_private.credit_promotion_policy_revisions ORDER BY revision DESC LIMIT 1;
  model_ids := coalesce(model_ids, nullif(pg_catalog.current_setting('opengeni.signup_credit_model_ids', true), '')::jsonb);
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, eligible_model_ids)
  VALUES (NEW.account_id, NULL, 'grant', 0, 'verified_signup_trial', NEW.auth_user_id,
    'verified-signup-trial:v1:' || NEW.auth_user_id,
    jsonb_build_object('campaign','free_plan_eligibility_v1','creditOfferLabel','Free plan eligibility'),
    CASE WHEN model_ids IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(model_ids)) END)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'verified signup eligibility idempotency collision' USING ERRCODE = '23505';
  END IF;

  -- Signup network. Every step is best-effort except the refusal.
  BEGIN
    network := nullif(pg_catalog.current_setting('opengeni.signup_network_source', true), '')::jsonb;
    address_hash_value := network->>'addressHash';
    prefix_hash_value := network->>'prefixHash';
    IF address_hash_value !~ '^[0-9a-f]{64}$' OR prefix_hash_value !~ '^[0-9a-f]{64}$' THEN
      address_hash_value := NULL;
    END IF;
    target := session_tenancy_fence_target_schema()::regnamespace::text;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network source ignored (%)', SQLSTATE;
    address_hash_value := NULL;
  END;
  IF address_hash_value IS NULL OR target IS NULL THEN RETURN NEW; END IF;
  BEGIN
    settings := opengeni_private.signup_network_velocity_settings(target);
    IF (settings->>'rateLimitEnabled')::boolean THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('signup-network-rate:' || target || ':' || address_hash_value, 0));
      SELECT count(*)::integer INTO recent_count FROM opengeni_private.signup_network_sources s
        WHERE s.data_schema = target AND s.address_hash = address_hash_value
          AND s.set_up_at > clock_timestamp() - interval '1 hour';
      refuse := recent_count >= (settings->>'rateLimitMax')::integer;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Fail open: a settings or count failure never refuses a signup.
    RAISE WARNING 'signup network rate limit skipped (%)', SQLSTATE;
    refuse := false;
  END;
  IF refuse THEN
    RAISE EXCEPTION 'too many new organizations from this network in the last hour'
      USING ERRCODE = 'OG429';
  END IF;
  BEGIN
    INSERT INTO opengeni_private.signup_network_sources(data_schema, account_id, owner_auth_user_id,
      address_hash, prefix_hash)
    VALUES (target, NEW.account_id, NEW.auth_user_id, address_hash_value, prefix_hash_value)
    ON CONFLICT (data_schema, account_id) DO NOTHING;
    -- Accounts the API evaluates after commit, each in its own transaction:
    -- this one first, then recent same-network accounts (newest first).
    IF settings->>'mode' IN ('observe', 'enforce') THEN
      SELECT string_agg(peer.account_id::text, ',' ORDER BY peer.self DESC, peer.set_up_at DESC)
        INTO evaluate_ids FROM (
          SELECT s.account_id, s.set_up_at, s.account_id = NEW.account_id AS self
          FROM opengeni_private.signup_network_sources s
          WHERE s.data_schema = target AND s.address_hash = address_hash_value
            AND s.set_up_at >= clock_timestamp() - make_interval(hours => (settings->>'windowHours')::integer)
          ORDER BY s.account_id = NEW.account_id DESC, s.set_up_at DESC LIMIT 51
        ) peer;
      PERFORM pg_catalog.set_config('opengeni.signup_network_evaluate_accounts', coalesce(evaluate_ids, ''), true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network source was not recorded (%)', SQLSTATE;
  END;
  -- Retention: records older than 90 days are removed a few at a time as new
  -- ones arrive, except for accounts still held, which stay reviewable.
  BEGIN
    DELETE FROM opengeni_private.signup_network_sources expired
      WHERE expired.data_schema = target AND expired.account_id IN (
        SELECT s.account_id FROM opengeni_private.signup_network_sources s
        WHERE s.data_schema = target AND s.set_up_at < clock_timestamp() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM promotion_decisions d
            WHERE d.account_id = s.account_id AND d.decision = 'held')
        ORDER BY s.set_up_at LIMIT 20);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network retention skipped (%)', SQLSTATE;
  END;
  RETURN NEW;
END $$;

-- Same body as 1119 (abuse evaluation first, then holds, then the signup
-- receipt and cutoff), plus the signup network velocity rule.
CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE signup_not_before timestamptz;
BEGIN
  PERFORM opengeni_private.evaluate_promotion_abuse(p_account_id);
  -- Fail open: an unexpected network velocity failure never blocks admission
  -- or Free issuance; the next evaluation retries.
  BEGIN
    PERFORM opengeni_private.evaluate_signup_network_velocity(p_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network velocity evaluation skipped (%)', SQLSTATE;
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
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries trial WHERE trial.account_id = p_account_id
    AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
    AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
    AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM auth_users signup_owner
      WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before)));
END $body$;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the definer search paths.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible')
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('grant_verified_signup_trial_credit',
        'set_signup_network_velocity', 'evaluate_signup_network_velocity'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN ('set_signup_network_velocity',
      'evaluate_signup_network_velocity', 'signup_network_velocity_settings')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END $install$;
