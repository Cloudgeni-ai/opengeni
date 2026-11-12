-- deployment-mode: rolling
-- Denied network (1368): also match the new owner's sign-ins after setup.
--
-- 1368 recorded a new owner's session networks once, when the organization
-- was set up. A farm that signs up and sets up from a fresh address and then
-- signs in from its usual (denied) network a minute later was never matched:
-- the later sign-in was not recorded, so every evaluation found nothing.
-- The evaluation now first records the owner's sign-ins that are newer than
-- what is recorded for the account, for as long as the setup can still be
-- evaluated (seven days). It costs one indexed look-up of the owner's newest
-- sessions; the networks are recorded only when a newer sign-in exists.
-- Everything else is unchanged: exact networks only, account owners only
-- (never invited members), keyed hashes only, manual decisions and operator
-- releases kept, holds placed by this rule never count, failures fail open
-- (a failed refresh still evaluates what is already recorded).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_denied_network(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text;
  settings jsonb; rule_mode text; source opengeni_private.signup_network_sources%ROWTYPE;
  setup_time timestamptz; lookback interval := interval '90 days'; found_matches record;
  facts jsonb; decision_row record; owner_user text; recorded_until timestamptz;
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
  -- The owner's sign-ins since the networks were last recorded (for example
  -- the first sign-in after email verification, or a later one). Owner only:
  -- the signup record's owner, else the account's self-serve owner. Checks at
  -- most the 20 newest newer sessions; records only when one has a network.
  BEGIN
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
            AND s.created_at >= clock_timestamp() - lookback
          ORDER BY s.created_at DESC LIMIT 20) newer
        WHERE opengeni_private.signup_network_session_hash(target, newer.ip_address) IS NOT NULL) THEN
        PERFORM opengeni_private.record_signup_owner_session_networks(target, p_account_id, owner_user);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup owner session networks were not refreshed (%)', SQLSTATE;
  END;
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

-- CREATE OR REPLACE keeps the owner and ACL. Pin the search path as 1368 did.
DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.evaluate_signup_denied_network(uuid) '
    'SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
END $install$;
