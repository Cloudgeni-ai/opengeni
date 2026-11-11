-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: signup_network_velocity_revisions holds a handful of append-only operator settings rows and the new column is null on all of them, so validating its check here is instant.
-- Denied network: hold the Free credit of a new self-serve owner whose exact
-- network (IPv4 address or IPv6 /64) was used, within the last 90 days, by an
-- account with a denied decision or a currently held account (except holds
-- placed by this rule, so holds never cascade), however few signups came
-- from it in the velocity window (rule denied-network-v1).
-- Additive and inert by default: its own setting, deniedNetworkMode, is off.
--
-- 1. Session networks. Sign-in addresses are already stored by Better Auth
--    (auth_sessions.ip_address). The database reduces them to the exact
--    network and keeps only an HMAC-SHA256 under a random per-schema key
--    stored in an owner-only table. Recorded for each new self-serve owner
--    at setup; for the owner of an account when it becomes denied or held;
--    and at every later sign-in of such an owner, so the networks are kept
--    after their sessions end. Invited members are never recorded. Session
--    use is the session's creation (sign-in) time.
-- 2. Signup networks. The API-keyed address hash of 1354
--    (signup_network_sources) of denied and held accounts is matched too.
-- 3. Detect and hold. free_plan_credit_eligible evaluates the current account
--    only. /24 and /48 prefixes never take part. Manual decisions and
--    operator releases are never overwritten. Failures fail open.
-- 4. Backfill. Every account denied or held now (including the accounts
--    denied before 1354) is captured account by account.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE opengeni_private.signup_network_velocity_revisions
  ADD COLUMN denied_network_mode text
    CHECK (denied_network_mode IN ('off','observe','enforce'));

-- One random HMAC key per data schema, stored as its SHA-256 block pads.
-- Owner-only; runtime roles can neither read it nor compute hashes with it.
CREATE TABLE opengeni_private.signup_network_session_keys (
  data_schema text PRIMARY KEY,
  inner_pad bytea NOT NULL CHECK (octet_length(inner_pad) = 64),
  outer_pad bytea NOT NULL CHECK (octet_length(outer_pad) = 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON opengeni_private.signup_network_session_keys FROM PUBLIC;

-- Keyed hashes of the exact networks account owners signed in from. One row
-- per account and network: the first and last sign-in from it.
CREATE TABLE opengeni_private.signup_network_owner_addresses (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, account_id, address_hash)
);
CREATE INDEX signup_network_owner_addresses_address
  ON opengeni_private.signup_network_owner_addresses (data_schema, address_hash, last_seen_at);
CREATE INDEX signup_network_owner_addresses_last_seen
  ON opengeni_private.signup_network_owner_addresses (data_schema, last_seen_at);
REVOKE ALL ON opengeni_private.signup_network_owner_addresses FROM PUBLIC;

-- Owners of accounts that were denied or held, so their later sign-ins are
-- recorded too. Written when the decision is made; never invited members.
CREATE TABLE opengeni_private.signup_network_flagged_owners (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  auth_user_id text NOT NULL CHECK (octet_length(auth_user_id) BETWEEN 1 AND 1019),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, account_id)
);
CREATE INDEX signup_network_flagged_owners_user
  ON opengeni_private.signup_network_flagged_owners (data_schema, auth_user_id);
REVOKE ALL ON opengeni_private.signup_network_flagged_owners FROM PUBLIC;

-- When each new self-serve organization was set up, also without the API's
-- signup network record. Only the last few days are kept.
CREATE TABLE opengeni_private.signup_network_owner_setups (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  set_up_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, account_id)
);
CREATE INDEX signup_network_owner_setups_set_up
  ON opengeni_private.signup_network_owner_setups (data_schema, set_up_at);
REVOKE ALL ON opengeni_private.signup_network_owner_setups FROM PUBLIC;

DO $key$
DECLARE secret bytea; inner_value bytea; outer_value bytea; position integer;
BEGIN
  -- 32 random bytes (three random UUIDs through SHA-256), zero-padded to the
  -- 64-byte SHA-256 block as HMAC requires.
  secret := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())
    || uuid_send(gen_random_uuid())) || decode(repeat('00', 32), 'hex');
  inner_value := secret;
  outer_value := secret;
  FOR position IN 0..63 LOOP
    inner_value := set_byte(inner_value, position, get_byte(secret, position) # 54);
    outer_value := set_byte(outer_value, position, get_byte(secret, position) # 92);
  END LOOP;
  INSERT INTO opengeni_private.signup_network_session_keys(data_schema, inner_pad, outer_pad)
    VALUES (current_schema(), inner_value, outer_value)
    ON CONFLICT (data_schema) DO NOTHING;
END $key$;

-- The exact network of a stored client address: the IPv4 address (also for
-- an IPv4-mapped IPv6 address) or the IPv6 /64, the unit of 1354. Null for
-- anything that is not an address.
CREATE OR REPLACE FUNCTION opengeni_private.signup_network_exact_unit(p_address text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE candidate text; value inet;
BEGIN
  candidate := btrim(split_part(coalesce(p_address, ''), ',', 1));
  IF candidate = '' OR candidate !~ '^[0-9A-Fa-f:.]+$' THEN RETURN NULL; END IF;
  value := candidate::inet;
  IF family(value) = 4 THEN RETURN host(value); END IF;
  IF value << '::ffff:0.0.0.0/96'::inet THEN
    RETURN host('0.0.0.0'::inet + (value - '::ffff:0.0.0.0'::inet));
  END IF;
  RETURN network(set_masklen(value, 64))::text;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_exact_unit(text) FROM PUBLIC;

-- HMAC-SHA256 of the exact network under the schema's key; null without one.
CREATE OR REPLACE FUNCTION opengeni_private.signup_network_session_hash(p_data_schema text, p_address text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(k.outer_pad || sha256(k.inner_pad || convert_to('address:' || unit.value, 'UTF8'))), 'hex')
  FROM opengeni_private.signup_network_session_keys k
  CROSS JOIN LATERAL (SELECT opengeni_private.signup_network_exact_unit(p_address) AS value) unit
  WHERE k.data_schema = p_data_schema AND unit.value IS NOT NULL
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_session_hash(text,text) FROM PUBLIC;

-- One user's session networks in the last 90 days (newest 200 sessions) for
-- one account, by sign-in time. Rows of that account only are written, and
-- unchanged rows are filtered out before they are touched. Owner context.
CREATE OR REPLACE FUNCTION opengeni_private.record_signup_owner_session_networks(
  p_data_schema text, p_account_id uuid, p_auth_user_id text
) RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE recorded integer;
BEGIN
  INSERT INTO opengeni_private.signup_network_owner_addresses AS existing(data_schema, account_id,
    address_hash, first_seen_at, last_seen_at)
  SELECT p_data_schema, p_account_id, grouped.address_hash, grouped.first_seen, grouped.last_seen
  FROM (
    SELECT used.address_hash, min(used.created_at) AS first_seen, max(used.created_at) AS last_seen
    FROM (
      SELECT opengeni_private.signup_network_session_hash(p_data_schema, s.ip_address) AS address_hash,
        s.created_at
      FROM auth_sessions s
      WHERE s.user_id = p_auth_user_id AND s.ip_address IS NOT NULL
        AND s.created_at >= clock_timestamp() - interval '90 days'
      ORDER BY s.created_at DESC LIMIT 200
    ) used
    WHERE used.address_hash IS NOT NULL
    GROUP BY used.address_hash
  ) grouped
  WHERE NOT EXISTS (SELECT 1 FROM opengeni_private.signup_network_owner_addresses known
    WHERE known.data_schema = p_data_schema AND known.account_id = p_account_id
      AND known.address_hash = grouped.address_hash
      AND known.first_seen_at <= grouped.first_seen AND known.last_seen_at >= grouped.last_seen)
  ON CONFLICT (data_schema, account_id, address_hash) DO UPDATE
    SET first_seen_at = least(existing.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(existing.last_seen_at, excluded.last_seen_at);
  GET DIAGNOSTICS recorded = ROW_COUNT;
  RETURN recorded;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.record_signup_owner_session_networks(text,uuid,text) FROM PUBLIC;

-- Captures the owner (never invited members) of one denied or held account:
-- remembers the owner so later sign-ins are recorded, and records their
-- current session networks. Returns false when the account has no
-- self-serve owner. Owner context only.
CREATE OR REPLACE FUNCTION opengeni_private.capture_flagged_owner_session_networks(
  p_data_schema text, p_account_id uuid
) RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE inventory uuid; owner_user text;
BEGIN
  inventory := opengeni_private.open_session_tenancy_fence_inventory(p_data_schema::regnamespace::oid);
  SELECT a.external_id INTO owner_user FROM managed_accounts a
    WHERE a.id = p_account_id AND a.external_source = 'better-auth:user';
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
  inventory := NULL;
  IF owner_user IS NULL THEN RETURN false; END IF;
  INSERT INTO opengeni_private.signup_network_flagged_owners(data_schema, account_id, auth_user_id)
    VALUES (p_data_schema, p_account_id, owner_user)
    ON CONFLICT (data_schema, account_id) DO NOTHING;
  PERFORM opengeni_private.record_signup_owner_session_networks(p_data_schema, p_account_id, owner_user);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  IF inventory IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
  END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.capture_flagged_owner_session_networks(text,uuid) FROM PUBLIC;

-- Captures every account that is denied or held now, one account at a time,
-- each in its own subtransaction. Used by the backfill below; operators can
-- run it again at any time. Owner context only.
CREATE OR REPLACE FUNCTION opengeni_private.capture_all_flagged_owner_session_networks(p_data_schema text)
RETURNS jsonb LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE flagged record; accounts integer := 0; captured integer := 0; failed integer := 0;
BEGIN
  FOR flagged IN SELECT d.account_id FROM promotion_decisions d
    WHERE d.decision IN ('denied', 'held') ORDER BY d.account_id
  LOOP
    accounts := accounts + 1;
    BEGIN
      IF opengeni_private.capture_flagged_owner_session_networks(p_data_schema, flagged.account_id) THEN
        captured := captured + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      RAISE WARNING 'denied network capture failed for one account (%)', SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('flaggedAccounts', accounts, 'capturedOwners', captured, 'failed', failed);
END $$;
REVOKE ALL ON FUNCTION opengeni_private.capture_all_flagged_owner_session_networks(text) FROM PUBLIC;

-- A decision becoming denied or held captures that account's owner.
-- Best-effort: a capture failure never blocks the decision.
CREATE OR REPLACE FUNCTION opengeni_private.capture_flagged_owner_on_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  BEGIN
    PERFORM opengeni_private.capture_flagged_owner_session_networks(TG_TABLE_SCHEMA, NEW.account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'denied network capture skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.capture_flagged_owner_on_decision() FROM PUBLIC;

-- A sign-in of a captured owner whose account is still denied or held
-- records its network. One indexed lookup for everyone else. Best-effort: a
-- failure never blocks the sign-in.
CREATE OR REPLACE FUNCTION opengeni_private.record_flagged_owner_sign_in() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE flagged record; address_hash_value text;
BEGIN
  BEGIN
    FOR flagged IN SELECT f.account_id FROM opengeni_private.signup_network_flagged_owners f
      JOIN promotion_decisions d ON d.account_id = f.account_id AND d.decision IN ('denied', 'held')
      WHERE f.data_schema = TG_TABLE_SCHEMA AND f.auth_user_id = NEW.user_id
    LOOP
      address_hash_value := coalesce(address_hash_value,
        opengeni_private.signup_network_session_hash(TG_TABLE_SCHEMA, NEW.ip_address));
      EXIT WHEN address_hash_value IS NULL;
      INSERT INTO opengeni_private.signup_network_owner_addresses AS existing(data_schema, account_id,
        address_hash, first_seen_at, last_seen_at)
      VALUES (TG_TABLE_SCHEMA, flagged.account_id, address_hash_value,
        coalesce(NEW.created_at, clock_timestamp()), coalesce(NEW.created_at, clock_timestamp()))
      ON CONFLICT (data_schema, account_id, address_hash) DO UPDATE
        SET first_seen_at = least(existing.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(existing.last_seen_at, excluded.last_seen_at);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'denied network sign-in record skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.record_flagged_owner_sign_in() FROM PUBLIC;

CREATE TRIGGER signup_network_capture_flagged_owner
  AFTER INSERT OR UPDATE OF decision ON promotion_decisions
  FOR EACH ROW WHEN (NEW.decision IN ('denied', 'held'))
  EXECUTE FUNCTION opengeni_private.capture_flagged_owner_on_decision();
CREATE TRIGGER signup_network_flagged_owner_sign_in
  AFTER INSERT ON auth_sessions
  FOR EACH ROW WHEN (NEW.ip_address IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.record_flagged_owner_sign_in();

-- 1354 settings plus deniedNetworkMode (off unless set).
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
    'operator', current.operator,
    'changedAt', current.changed_at)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT * FROM opengeni_private.signup_network_velocity_revisions r
    WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
  ) AS current ON true
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

-- Same as 1354, plus deniedNetworkMode.
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
      'rateLimitMax','deniedNetworkMode');
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
    operator, reason)
  VALUES (target, (previous->>'revision')::bigint + 1, merged->>'mode', (merged->>'windowHours')::integer,
    (merged->>'exactHoldThreshold')::integer, (merged->>'prefixHoldThreshold')::integer,
    (merged->>'rateLimitEnabled')::boolean, (merged->>'rateLimitMax')::integer,
    merged->>'deniedNetworkMode', p_operator, p_reason)
  RETURNING * INTO result;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- Evaluates ONLY the current account (its own credit fence through
-- set_promotion_decision); other accounts' rows are read, never locked. For
-- an organization set up within the last seven days, finds denied or
-- currently held accounts that used the same exact network in the 90 days up
-- to the setup: through their signup (1354 address hash) or their owner's
-- sign-ins (session network hash). Exact networks only; never prefixes.
-- Holds placed by this rule do not count, so a hold never spreads further.
CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_denied_network(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text;
  settings jsonb; rule_mode text; source opengeni_private.signup_network_sources%ROWTYPE;
  setup_time timestamptz; lookback interval := interval '90 days'; found_matches record;
  facts jsonb; decision_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Signup denied network scope mismatch' USING ERRCODE = '42501';
  END IF;
  settings := opengeni_private.signup_network_velocity_settings(target);
  rule_mode := coalesce(settings->>'deniedNetworkMode', 'off');
  IF rule_mode NOT IN ('observe', 'enforce') THEN RETURN; END IF;
  SELECT * INTO source FROM opengeni_private.signup_network_sources
    WHERE data_schema = target AND account_id = p_account_id;
  setup_time := source.set_up_at;
  IF setup_time IS NULL THEN
    SELECT setup.set_up_at INTO setup_time FROM opengeni_private.signup_network_owner_setups setup
      WHERE setup.data_schema = target AND setup.account_id = p_account_id;
  END IF;
  IF setup_time IS NULL OR setup_time < statement_timestamp() - interval '7 days' THEN RETURN; END IF;
  WITH used AS (
    SELECT peer.account_id, 'signup'::text AS via, peer.set_up_at AS used_at
    FROM opengeni_private.signup_network_sources peer
    WHERE source.address_hash IS NOT NULL AND peer.data_schema = target
      AND peer.address_hash = source.address_hash AND peer.account_id <> p_account_id
      AND peer.set_up_at BETWEEN setup_time - lookback AND setup_time
    UNION ALL
    SELECT peer.account_id, 'sign-in'::text, least(peer.last_seen_at, setup_time)
    FROM opengeni_private.signup_network_owner_addresses own
    JOIN opengeni_private.signup_network_owner_addresses peer
      ON peer.data_schema = own.data_schema AND peer.address_hash = own.address_hash
      AND peer.account_id <> own.account_id
    WHERE own.data_schema = target AND own.account_id = p_account_id
      AND peer.first_seen_at <= setup_time AND peer.last_seen_at >= setup_time - lookback
  ), flagged AS (
    SELECT used.account_id, d.decision, array_agg(DISTINCT used.via) AS vias, max(used.used_at) AS last_used_at
    FROM used JOIN promotion_decisions d ON d.account_id = used.account_id AND d.decision IN ('denied', 'held')
    WHERE d.decision = 'denied' OR NOT EXISTS (SELECT 1 FROM opengeni_private.promotion_decision_history h
      WHERE h.data_schema = target AND h.account_id = d.account_id AND h.revision = d.revision
        AND h.policy_version = 'denied-network-v1')
    GROUP BY used.account_id, d.decision
    ORDER BY max(used.used_at) DESC, used.account_id LIMIT 501
  )
  SELECT count(*) FILTER (WHERE decision = 'denied')::integer AS denied,
    count(*) FILTER (WHERE decision = 'held')::integer AS held,
    count(*) > 500 AS at_least,
    coalesce((SELECT jsonb_agg(DISTINCT via ORDER BY via) FROM flagged, unnest(flagged.vias) AS via), '[]'::jsonb) AS vias,
    max(last_used_at) AS last_used_at,
    coalesce((SELECT jsonb_agg(ranked.account_id ORDER BY ranked.position) FROM (
      SELECT f.account_id, row_number() OVER (ORDER BY f.last_used_at DESC, f.account_id) AS position
      FROM flagged f) ranked WHERE ranked.position <= 20), '[]'::jsonb) AS account_ids
    INTO found_matches FROM flagged;
  IF found_matches.denied + found_matches.held = 0 THEN RETURN; END IF;
  facts := jsonb_build_object(
    'ruleId', 'denied-network-exact-v1',
    'deniedAccounts', found_matches.denied, 'heldAccounts', found_matches.held,
    'groupSizeAtLeast', found_matches.at_least, 'matchedVia', found_matches.vias,
    'matchedAccountIds', found_matches.account_ids,
    'lastFlaggedUseAt', to_char(found_matches.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
    'lookbackDays', 90, 'mode', rule_mode, 'settingsRevision', (settings->>'revision')::bigint,
    'addressGroup', left(source.address_hash, 16),
    'setUpAt', to_char(setup_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'));
  -- Unchanged evidence writes nothing, so admission reads do not churn rows.
  INSERT INTO opengeni_private.promotion_detector_observations(data_schema, account_id, policy_version, evidence)
    VALUES (target, p_account_id, 'denied-network-v1', facts)
    ON CONFLICT (data_schema, account_id, policy_version) DO UPDATE
      SET evidence = excluded.evidence, last_seen_at = clock_timestamp()
      WHERE promotion_detector_observations.evidence IS DISTINCT FROM excluded.evidence;
  IF rule_mode = 'enforce' THEN
    -- Same precedence as the other rules: manual decisions (including an
    -- operator release) are never overwritten, and a detector hold is kept.
    SELECT * INTO decision_row FROM promotion_decisions WHERE account_id = p_account_id;
    IF NOT FOUND OR (decision_row.actor = 'service:promotion-detector' AND decision_row.decision = 'eligible') THEN
      PERFORM opengeni_private.set_promotion_decision(p_account_id, 'held', 'denied-network-v1',
        'denied-network-exact-v1', facts, 'service:promotion-detector', coalesce(decision_row.revision, 0));
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.evaluate_signup_denied_network(uuid) FROM PUBLIC;

-- The 1354 setup-receipt trigger (body unchanged first), plus the setup time
-- and the owner's own session networks, and evaluation after commit when
-- only the denied network rule is on. The 1354 steps still need the API's
-- address hash; the new steps do not. Only this account's rows are written.
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
        WHERE o.data_schema = target AND o.set_up_at < clock_timestamp() - interval '8 days'
        ORDER BY o.set_up_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup network retention skipped (%)', SQLSTATE;
  END;
  RETURN NEW;
END $$;

-- Same body as 1354, plus the denied network rule.
CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE signup_not_before timestamptz;
BEGIN
  PERFORM opengeni_private.evaluate_promotion_abuse(p_account_id);
  -- Fail open: an unexpected network rule failure never blocks admission or
  -- Free issuance; the next evaluation retries.
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

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search paths.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible')
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('grant_verified_signup_trial_credit',
        'set_signup_network_velocity', 'evaluate_signup_denied_network',
        'record_signup_owner_session_networks', 'capture_flagged_owner_session_networks',
        'capture_all_flagged_owner_session_networks', 'capture_flagged_owner_on_decision',
        'record_flagged_owner_sign_in'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN ('set_signup_network_velocity',
      'signup_network_velocity_settings', 'evaluate_signup_denied_network', 'signup_network_exact_unit',
      'signup_network_session_hash', 'record_signup_owner_session_networks',
      'capture_flagged_owner_session_networks', 'capture_all_flagged_owner_session_networks',
      'capture_flagged_owner_on_decision', 'record_flagged_owner_sign_in')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END $install$;

-- Backfill: the owners of every account denied or held now (including those
-- decided before 1354), account by account, and the setups of the last
-- seven days, which can still be evaluated. A failure is reported as a
-- warning with counts; capture_all_flagged_owner_session_networks can be run
-- again by an operator.
DO $backfill$
DECLARE target_schema text := current_schema(); recent record; outcome jsonb;
BEGIN
  outcome := opengeni_private.capture_all_flagged_owner_session_networks(target_schema);
  IF (outcome->>'failed')::integer > 0 THEN
    RAISE WARNING 'denied network backfill incomplete: %', outcome;
  ELSE
    RAISE NOTICE 'denied network backfill: %', outcome;
  END IF;
  FOR recent IN SELECT s.account_id, s.owner_auth_user_id, s.set_up_at FROM opengeni_private.signup_network_sources s
    WHERE s.data_schema = target_schema AND s.set_up_at >= clock_timestamp() - interval '7 days'
    ORDER BY s.set_up_at DESC LIMIT 5000
  LOOP
    BEGIN
      INSERT INTO opengeni_private.signup_network_owner_setups(data_schema, account_id, set_up_at)
        VALUES (target_schema, recent.account_id, recent.set_up_at) ON CONFLICT (data_schema, account_id) DO NOTHING;
      PERFORM opengeni_private.record_signup_owner_session_networks(target_schema, recent.account_id,
        recent.owner_auth_user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recent owner session networks skipped (%)', SQLSTATE;
    END;
  END LOOP;
END $backfill$;
