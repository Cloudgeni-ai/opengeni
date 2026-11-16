-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: the one DELETE removes only loopback, unspecified and link-local network hashes through the address index; only development and test servers record them.
-- online-safety-exception: constraint-validation: the CHECK is on a new nullable column of the small owner-only settings history table, as in 1368.
-- Signup network velocity (1354): also count the networks new owners sign in
-- from, and evaluate organizations whose setup had no signup network.
--
-- The velocity rule only counted the API's address hash of the request that
-- set the organization up (signup_network_sources). A setup without that
-- hash (the legacy POST /v1/organizations route, which writes the same setup
-- receipt, or any future path that forgets it) or from a rotating address
-- was never counted, observed or held, however many organizations the same
-- owners' sign-in network produced. Since 1368 the database records every new
-- owner's session networks at setup (keyed hashes, exact networks, owners
-- only) and the setup time of every new self-serve organization.
--
-- 0. Its own setting, signInNetworkMode (off, observe, enforce), off until
--    an operator sets it, as deniedNetworkMode in 1368: the threshold was
--    tuned on one address per setup, so the sign-in leg is observed before
--    it holds.
-- 1. Detect. ip-velocity-v1 also counts, for each exact network the owner
--    signed in from around the setup, the distinct new self-serve
--    organizations set up within the window whose owners signed in from that
--    network around their own setup (including this one). The largest such
--    group holds at the existing exactHoldThreshold (rule
--    ip-velocity-sign-in-v1). Before counting, the owner's sign-ins newer than
--    what is recorded are recorded (as 1375 does for the denied network rule),
--    so a sign-in after setup counts too. An organization without a signup
--    network is evaluated from its recorded setup time.
-- 2. Evaluate after setup. The setup trigger also lists recent organizations
--    whose owners signed in from this owner's networks, so reserve accounts
--    are held before they spend, and lists this organization even when the
--    request had no signup network.
-- 3. Setup times are kept 15 days (was 8), enough for the widest window
--    (168 hours) around a setup that can still be evaluated (seven days).
-- 4. Loopback, unspecified, link-local, private (RFC 1918, ULA) and shared
--    (100.64/10) session addresses are never a public client network (a
--    development server records 127.0.0.1 for every sign-in, and a
--    misconfigured proxy chain records the ingress address), so they are no
--    longer recorded: grouping on them would group every owner. Recorded
--    loopback and link-local units are removed; other recorded units age out.
-- 5. "Around the setup" is the overlap of a network's first and last
--    recorded sign-in with the window, an approximation: an owner who used a
--    network long before and again after the setup counts for it.
--
-- Unchanged: the same mode, window and threshold; the current account only;
-- manual decisions and operator releases are never overwritten; invited
-- members are never recorded or counted; /24 and /48 prefixes alone never
-- hold; keyed hashes only; every step is bounded and fails open. The two
-- hash keys (API and database) are never compared with each other.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

-- Remove recorded loopback and unspecified networks (hashed with the unit
-- the old function produced) before the unit stops producing them.
DELETE FROM opengeni_private.signup_network_owner_addresses o
  WHERE o.data_schema = current_schema()
    AND o.address_hash IN (
      SELECT opengeni_private.signup_network_session_hash(current_schema(), loopback.address)
      FROM (VALUES ('127.0.0.1'), ('0.0.0.0'), ('::1'), ('fe80::1')) loopback(address));

CREATE OR REPLACE FUNCTION opengeni_private.signup_network_exact_unit(p_address text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE candidate text; value inet;
BEGIN
  candidate := btrim(split_part(coalesce(p_address, ''), ',', 1));
  IF candidate = '' OR candidate !~ '^[0-9A-Fa-f:.]+$' THEN RETURN NULL; END IF;
  value := candidate::inet;
  IF value << '::ffff:0.0.0.0/96'::inet THEN
    value := '0.0.0.0'::inet + (value - '::ffff:0.0.0.0'::inet);
  END IF;
  IF family(value) = 4 THEN
    IF value << '127.0.0.0/8'::inet OR value << '0.0.0.0/8'::inet OR value << '169.254.0.0/16'::inet
      OR value << '10.0.0.0/8'::inet OR value << '172.16.0.0/12'::inet OR value << '192.168.0.0/16'::inet
      OR value << '100.64.0.0/10'::inet THEN RETURN NULL; END IF;
    RETURN host(value);
  END IF;
  IF value = '::'::inet OR value = '::1'::inet OR value << 'fe80::/10'::inet
    OR value << 'fc00::/7'::inet THEN RETURN NULL; END IF;
  RETURN network(set_masklen(value, 64))::text;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_exact_unit(text) FROM PUBLIC;

ALTER TABLE opengeni_private.signup_network_velocity_revisions
  ADD COLUMN sign_in_network_mode text
    CHECK (sign_in_network_mode IN ('off','observe','enforce'));

-- 1368 settings plus signInNetworkMode (off unless set).
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
    'deniedNetworkMode', coalesce(current.denied_network_mode, 'off'),
    'deniedNetworkLookbackDays', 90,
    'signInNetworkMode', coalesce(current.sign_in_network_mode, 'off'),
    'operator', current.operator,
    'changedAt', current.changed_at)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT * FROM opengeni_private.signup_network_velocity_revisions r
    WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
  ) AS current ON true
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

-- Same as 1368, plus signInNetworkMode.
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
      'rateLimitMax','deniedNetworkMode','signInNetworkMode');
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
    exact_hold_threshold, prefix_hold_threshold, rate_limit_enabled, rate_limit_max, denied_network_mode,
    sign_in_network_mode, operator, reason)
  VALUES (target, (previous->>'revision')::bigint + 1, merged->>'mode', (merged->>'windowHours')::integer,
    (merged->>'exactHoldThreshold')::integer, (merged->>'prefixHoldThreshold')::integer,
    (merged->>'rateLimitEnabled')::boolean, (merged->>'rateLimitMax')::integer,
    merged->>'deniedNetworkMode', merged->>'signInNetworkMode', p_operator, p_reason)
  RETURNING * INTO result;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- Evaluates ONLY the current account (its own credit fence through
-- set_promotion_decision); other accounts' rows are read, never locked.
CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_network_velocity(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text;
  settings jsonb; source opengeni_private.signup_network_sources%ROWTYPE; setup_time timestamptz;
  window_size interval; exact_count integer := 0; prefix_count integer := 0;
  exact_times jsonb := '[]'::jsonb; exact_threshold integer; prefix_threshold integer;
  sign_in_group text; sign_in_times jsonb; sign_in_count integer := 0; exact_match boolean; prefix_match boolean;
  sign_in_match boolean; facts jsonb; decision_row record; owner_user text; recorded_until timestamptz;
  velocity_mode text; sign_in_mode text; hold boolean;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Signup network velocity scope mismatch' USING ERRCODE = '42501';
  END IF;
  settings := opengeni_private.signup_network_velocity_settings(target);
  velocity_mode := coalesce(settings->>'mode', 'off');
  sign_in_mode := coalesce(settings->>'signInNetworkMode', 'off');
  IF velocity_mode = 'off' AND sign_in_mode = 'off' THEN RETURN; END IF;
  SELECT * INTO source FROM opengeni_private.signup_network_sources
    WHERE data_schema = target AND account_id = p_account_id;
  setup_time := source.set_up_at;
  IF setup_time IS NULL AND sign_in_mode <> 'off' THEN
    SELECT setup.set_up_at INTO setup_time FROM opengeni_private.signup_network_owner_setups setup
      WHERE setup.data_schema = target AND setup.account_id = p_account_id;
  END IF;
  IF setup_time IS NULL OR setup_time < statement_timestamp() - interval '7 days' THEN RETURN; END IF;
  window_size := make_interval(hours => (settings->>'windowHours')::integer);
  exact_threshold := (settings->>'exactHoldThreshold')::integer;
  prefix_threshold := (settings->>'prefixHoldThreshold')::integer;
  -- The owner's sign-ins since the networks were last recorded, as 1375:
  -- owner only (the signup record's owner, else the account's self-serve
  -- owner), one indexed look-up, written only when a newer sign-in has a
  -- network. A failure evaluates what is already recorded. Sign-in leg only.
  IF sign_in_mode <> 'off' THEN BEGIN
    owner_user := source.owner_auth_user_id;
    IF owner_user IS NULL THEN
      SELECT a.external_id INTO owner_user FROM managed_accounts a
        WHERE a.id = p_account_id AND a.external_source = 'better-auth:user';
    END IF;
    IF owner_user IS NOT NULL THEN
      SELECT max(known.last_seen_at) INTO recorded_until
        FROM opengeni_private.signup_network_owner_addresses known
        WHERE known.data_schema = target AND known.account_id = p_account_id;
      IF EXISTS (SELECT 1 FROM (
          SELECT s.ip_address FROM auth_sessions s
          WHERE s.user_id = owner_user AND s.ip_address IS NOT NULL
            AND s.created_at > coalesce(recorded_until, '-infinity'::timestamptz)
            AND s.created_at >= clock_timestamp() - interval '90 days'
            AND opengeni_private.signup_network_exact_unit(s.ip_address) IS NOT NULL
          ORDER BY s.created_at DESC LIMIT 1) newer
        WHERE opengeni_private.signup_network_session_hash(target, newer.ip_address) IS NOT NULL) THEN
        PERFORM opengeni_private.record_signup_owner_session_networks(target, p_account_id, owner_user);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup owner session networks were not refreshed (%)', SQLSTATE;
  END; END IF;
  -- Signup network (the API's hash of the setup request), as 1354.
  IF velocity_mode <> 'off' AND source.address_hash IS NOT NULL THEN
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
  END IF;
  -- Sign-in networks (the database's hash of the owners' session networks).
  -- For each exact network this owner signed in from within the window of
  -- the setup (newest 5), the organizations set up within the window whose
  -- owners signed in from it within the window of their own setup; the
  -- largest group counts. Bounded: 200 candidate rows per network. Its own
  -- failure block: an error counts nothing and never undoes the other legs.
  -- Skipped when the signup network already holds the account.
  IF sign_in_mode <> 'off' AND NOT (velocity_mode = 'enforce' AND exact_count >= exact_threshold) THEN
    BEGIN
      SELECT left(network.address_hash, 16), members.size, members.times
        INTO sign_in_group, sign_in_count, sign_in_times
      FROM (
        SELECT own.address_hash FROM opengeni_private.signup_network_owner_addresses own
        WHERE own.data_schema = target AND own.account_id = p_account_id
          AND own.first_seen_at <= setup_time + window_size AND own.last_seen_at >= setup_time - window_size
        ORDER BY own.last_seen_at DESC, own.address_hash LIMIT 5
      ) network
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS size,
          coalesce(jsonb_agg(to_char(member.set_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')
            ORDER BY member.set_up_at) FILTER (WHERE member.position <= 20), '[]'::jsonb) AS times
        FROM (
          SELECT candidate.set_up_at,
            row_number() OVER (ORDER BY candidate.set_up_at, candidate.account_id) AS position
          FROM (
            SELECT peer.account_id, peer.first_seen_at, peer.last_seen_at,
              coalesce(
                (SELECT s.set_up_at FROM opengeni_private.signup_network_sources s
                  WHERE s.data_schema = target AND s.account_id = peer.account_id),
                (SELECT o.set_up_at FROM opengeni_private.signup_network_owner_setups o
                  WHERE o.data_schema = target AND o.account_id = peer.account_id)) AS set_up_at
            FROM opengeni_private.signup_network_owner_addresses peer
            WHERE peer.data_schema = target AND peer.address_hash = network.address_hash
              AND peer.last_seen_at >= setup_time - 2 * window_size
              AND peer.first_seen_at <= setup_time + 2 * window_size
            ORDER BY peer.last_seen_at DESC LIMIT 200
          ) candidate
          WHERE candidate.set_up_at BETWEEN setup_time - window_size AND setup_time + window_size
            AND candidate.first_seen_at <= candidate.set_up_at + window_size
            AND candidate.last_seen_at >= candidate.set_up_at - window_size
          ORDER BY candidate.set_up_at, candidate.account_id LIMIT 501
        ) member
      ) members
      ORDER BY members.size DESC, network.address_hash LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'signup sign-in network velocity skipped (%)', SQLSTATE;
      sign_in_group := NULL; sign_in_count := 0; sign_in_times := NULL;
    END;
  END IF;
  sign_in_count := coalesce(sign_in_count, 0);
  IF exact_count < 2 AND prefix_count < 2 AND sign_in_count < 2 THEN RETURN; END IF;
  exact_match := exact_count >= exact_threshold;
  prefix_match := prefix_threshold IS NOT NULL AND prefix_count >= prefix_threshold;
  sign_in_match := sign_in_count >= exact_threshold;
  hold := (velocity_mode = 'enforce' AND (exact_match OR prefix_match))
    OR (sign_in_mode = 'enforce' AND sign_in_match);
  facts := jsonb_build_object(
    'ruleId', CASE WHEN exact_match THEN 'ip-velocity-exact-v1'
      WHEN prefix_match AND velocity_mode = 'enforce' THEN 'ip-velocity-prefix-v1'
      WHEN sign_in_match THEN 'ip-velocity-sign-in-v1'
      WHEN prefix_match THEN 'ip-velocity-prefix-v1'
      ELSE 'ip-velocity-observed-v1' END,
    'exactGroupSize', exact_count, 'prefixGroupSize', prefix_count,
    'signInGroupSize', sign_in_count,
    'groupSizeAtLeast', exact_count > 500 OR prefix_count > 500 OR sign_in_count > 500,
    'exactHoldThreshold', exact_threshold, 'prefixHoldThreshold', prefix_threshold,
    'windowHours', (settings->>'windowHours')::integer, 'settingsRevision', (settings->>'revision')::bigint,
    'signInNetworkMode', sign_in_mode,
    'addressGroup', left(source.address_hash, 16), 'prefixGroup', left(source.prefix_hash, 16),
    'signInGroup', sign_in_group,
    'setUpAt', to_char(setup_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
    'exactGroupSetupTimes', exact_times,
    'signInGroupSetupTimes', coalesce(sign_in_times, '[]'::jsonb));
  -- Unchanged evidence writes nothing, so admission reads do not churn rows.
  INSERT INTO opengeni_private.promotion_detector_observations(data_schema, account_id, policy_version, evidence)
    VALUES (target, p_account_id, 'ip-velocity-v1', facts)
    ON CONFLICT (data_schema, account_id, policy_version) DO UPDATE
      SET evidence = excluded.evidence, last_seen_at = clock_timestamp()
      WHERE promotion_detector_observations.evidence IS DISTINCT FROM excluded.evidence;
  IF hold THEN
    -- Same precedence as before: manual decisions (including an operator
    -- release) are never overwritten, and a detector hold is kept.
    SELECT * INTO decision_row FROM promotion_decisions WHERE account_id = p_account_id;
    IF NOT FOUND OR (decision_row.actor = 'service:promotion-detector' AND decision_row.decision = 'eligible') THEN
      PERFORM opengeni_private.set_promotion_decision(p_account_id, 'held', 'ip-velocity-v1',
        facts->>'ruleId', facts, 'service:promotion-detector', coalesce(decision_row.revision, 0));
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.evaluate_signup_network_velocity(uuid) FROM PUBLIC;

-- The 1368 setup-receipt trigger (body unchanged first), plus: recent
-- organizations whose owners signed in from this owner's networks are
-- evaluated after commit too, and this organization is listed even without
-- a signup network; setup times are kept 15 days.
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
    target := session_tenancy_fence_target_schema()::regnamespace::text;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network target unavailable (%)', SQLSTATE;
    target := NULL;
  END;
  IF target IS NULL THEN RETURN NEW; END IF;
  BEGIN
    network := nullif(pg_catalog.current_setting('opengeni.signup_network_source', true), '')::jsonb;
    address_hash_value := network->>'addressHash';
    prefix_hash_value := network->>'prefixHash';
    IF address_hash_value !~ '^[0-9a-f]{64}$' OR prefix_hash_value !~ '^[0-9a-f]{64}$' THEN
      address_hash_value := NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network source ignored (%)', SQLSTATE;
    address_hash_value := NULL;
  END;
  BEGIN
    settings := opengeni_private.signup_network_velocity_settings(target);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network settings unavailable (%)', SQLSTATE;
    settings := NULL;
  END;
  IF address_hash_value IS NOT NULL THEN
    BEGIN
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
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'signup network source was not recorded (%)', SQLSTATE;
    END;
  END IF;
  -- This owner's setup time and session networks, recorded in every mode so
  -- evidence exists before the rule is switched on.
  BEGIN
    INSERT INTO opengeni_private.signup_network_owner_setups(data_schema, account_id)
      VALUES (target, NEW.account_id) ON CONFLICT (data_schema, account_id) DO NOTHING;
    PERFORM opengeni_private.record_signup_owner_session_networks(target, NEW.account_id, NEW.auth_user_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup owner session networks were not recorded (%)', SQLSTATE;
  END;
  -- Velocity on sign-in networks: this organization (also without a signup
  -- network) and recent organizations whose owners signed in from this
  -- owner's networks within the window, newest first, after the signup
  -- network peers; at most 51 in all. Bounded per network; best-effort.
  -- Only while signInNetworkMode is observe or enforce.
  IF settings->>'signInNetworkMode' IN ('observe', 'enforce') THEN
    BEGIN
      SELECT string_agg(listed.id, ',' ORDER BY listed.position) INTO evaluate_ids FROM (
        SELECT candidate.id, min(candidate.position) AS position FROM (
          SELECT NEW.account_id::text AS id, 0::bigint AS position
          UNION ALL
          SELECT existing.id, existing.position
            FROM unnest(string_to_array(nullif(evaluate_ids, ''), ',')) WITH ORDINALITY AS existing(id, position)
          UNION ALL
          SELECT peer.account_id::text, 1000 + row_number() OVER (ORDER BY max(setup.set_up_at) DESC, peer.account_id)
          FROM (
            SELECT own.address_hash FROM opengeni_private.signup_network_owner_addresses own
            WHERE own.data_schema = target AND own.account_id = NEW.account_id
              AND own.last_seen_at >= clock_timestamp() - make_interval(hours => (settings->>'windowHours')::integer)
            ORDER BY own.last_seen_at DESC LIMIT 5
          ) network
          CROSS JOIN LATERAL (
            SELECT o.account_id FROM opengeni_private.signup_network_owner_addresses o
            WHERE o.data_schema = target AND o.address_hash = network.address_hash
              AND o.account_id <> NEW.account_id
              AND o.last_seen_at >= clock_timestamp() - make_interval(hours => (settings->>'windowHours')::integer)
            ORDER BY o.last_seen_at DESC LIMIT 50
          ) peer
          JOIN opengeni_private.signup_network_owner_setups setup
            ON setup.data_schema = target AND setup.account_id = peer.account_id
            AND setup.set_up_at >= clock_timestamp() - make_interval(hours => (settings->>'windowHours')::integer)
          GROUP BY peer.account_id
        ) candidate
        GROUP BY candidate.id ORDER BY min(candidate.position) LIMIT 51
      ) listed;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'signup network sign-in peers were not listed (%)', SQLSTATE;
    END;
  END IF;
  IF coalesce(evaluate_ids, '') = '' AND settings->>'deniedNetworkMode' IN ('observe', 'enforce') THEN
    evaluate_ids := NEW.account_id::text;
  END IF;
  BEGIN
    PERFORM pg_catalog.set_config('opengeni.signup_network_evaluate_accounts', coalesce(evaluate_ids, ''), true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network evaluation list was not set (%)', SQLSTATE;
  END;
  -- Retention: records older than 90 days are removed a few at a time as new
  -- ones arrive, except for accounts still held, which stay reviewable.
  -- Concurrent setups skip rows another setup is already removing.
  BEGIN
    DELETE FROM opengeni_private.signup_network_sources expired
      WHERE expired.data_schema = target AND expired.account_id IN (
        SELECT s.account_id FROM opengeni_private.signup_network_sources s
        WHERE s.data_schema = target AND s.set_up_at < clock_timestamp() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM promotion_decisions d
            WHERE d.account_id = s.account_id AND d.decision = 'held')
        ORDER BY s.set_up_at LIMIT 20 FOR UPDATE OF s SKIP LOCKED);
    -- Session networks last used more than 90 days before any setup that
    -- could still be evaluated (seven days) can never match again.
    DELETE FROM opengeni_private.signup_network_owner_addresses expired
      WHERE (expired.data_schema, expired.account_id, expired.address_hash) IN (
        SELECT o.data_schema, o.account_id, o.address_hash FROM opengeni_private.signup_network_owner_addresses o
        WHERE o.data_schema = target AND o.last_seen_at < clock_timestamp() - interval '97 days'
        ORDER BY o.last_seen_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED);
    -- Setup times are only needed while the setup can still be evaluated.
    DELETE FROM opengeni_private.signup_network_owner_setups expired
      WHERE (expired.data_schema, expired.account_id) IN (
        SELECT o.data_schema, o.account_id FROM opengeni_private.signup_network_owner_setups o
        WHERE o.data_schema = target AND o.set_up_at < clock_timestamp() - interval '15 days'
        ORDER BY o.set_up_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network retention skipped (%)', SQLSTATE;
  END;
  RETURN NEW;
END $$;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search paths as before.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN ('grant_verified_signup_trial_credit',
      'evaluate_signup_network_velocity', 'set_signup_network_velocity')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
END $install$;
