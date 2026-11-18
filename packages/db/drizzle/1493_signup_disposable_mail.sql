-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the CHECKs are on new nullable columns of the small owner-only settings history table, as in 1368, 1471 and 1489.
-- Signup email clusters, two more legs (rule email-cluster-v1, 1489).
--
-- 4. Disposable mail (disposableMailMode, enforce): the owner's mail domain,
--    or one of its MX hosts, is a temporary-inbox service. The API resolves
--    the MX at setup (bounded, cached, failing open) and hands only the flag
--    to the setup trigger through opengeni.signup_owner_mail_signal
--    ('disposable' or 'clear'; unset records nothing). Anyone can read such
--    an inbox, so the address proves no person. Recorded on every new
--    self-serve organization (first and additional).
-- 5. Slow domain (slowDomainMode, enforce): at least slowDomainHoldThreshold
--    (3) distinct owners on the same company or personal relay domain within
--    slowDomainWindowHours (24) of this setup, and none of them (this one
--    included) ever admitted a model call. A farm signs owners up one a
--    minute over hours and never uses them; a company's colleagues start
--    working, and once one of them has, the group is not held. Public
--    providers, shared relays and academic domains never group here.
--
-- Usage: a model-call admission (getSpendableCreditBalance) sets
-- opengeni.signup_usage_admission for its free_plan_credit_eligible call, and
-- the evaluation stamps first_admitted_at on its own record once. Nothing
-- reads other organizations' usage.
--
-- Sized from hosted production (person lifecycle since June 2026): 3 or more
-- owners on one non-public domain within 24 hours with no earlier use by any
-- of them happened on 38 domains, all throwaway (none legitimate); the
-- largest real company group was set up with usage from its first members.
-- Of about 720 non-public owner domains, about 560 received mail at
-- temporary-inbox MX hosts. Verification
-- speed is not a signal: two thirds of all email signups verify within 10
-- seconds.
--
-- Rolling: new nullable columns; CREATE OR REPLACE of known routines with the
-- same signatures. The previous release sets neither setting: its setups
-- record no mail signal and its admissions stamp no usage (a group whose
-- members only used the product through previous-release pods during the
-- rollout looks unused).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE opengeni_private.signup_network_velocity_revisions
  ADD COLUMN disposable_mail_mode text CHECK (disposable_mail_mode IN ('off','observe','enforce')),
  ADD COLUMN slow_domain_mode text CHECK (slow_domain_mode IN ('off','observe','enforce')),
  ADD COLUMN slow_domain_hold_threshold integer CHECK (slow_domain_hold_threshold BETWEEN 2 AND 500),
  ADD COLUMN slow_domain_window_hours integer CHECK (slow_domain_window_hours BETWEEN 1 AND 168);

ALTER TABLE opengeni_private.signup_owner_email_domains
  ADD COLUMN mail_signal text CHECK (mail_signal IN ('disposable','clear')),
  ADD COLUMN first_admitted_at timestamptz;

-- 1489 settings plus the disposable mail and slow domain settings (both
-- enforce unless set).
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
    'operator', current.operator,
    'changedAt', current.changed_at)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT * FROM opengeni_private.signup_network_velocity_revisions r
    WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
  ) AS current ON true
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

-- Same as 1489, plus the disposable mail and slow domain settings.
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
      'slowDomainHoldThreshold','slowDomainWindowHours');
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
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- Same as 1489, plus the owner's mail signal from the API, and on a company
-- or personal relay domain it also lists the same-domain organizations of the
-- slow domain window, so the first members of a slow group are held too.
CREATE OR REPLACE FUNCTION opengeni_private.record_signup_owner_email_domain() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE owner_user text; email text; mail_domain text; kind text; hash_value text; settings jsonb;
  provider_value text; mail_signal_value text; domain_reach interval;
  evaluate_ids text; existing text; subject text;
BEGIN
  BEGIN
    mail_signal_value := nullif(pg_catalog.current_setting('opengeni.signup_owner_mail_signal', true), '');
    IF mail_signal_value NOT IN ('disposable', 'clear') THEN mail_signal_value := NULL; END IF;
    SELECT a.external_id INTO owner_user FROM managed_accounts a
      WHERE a.id = NEW.account_id AND a.external_source = 'better-auth:user';
    subject := opengeni_private.current_subject_id();
    IF owner_user IS NULL AND subject LIKE 'user:%' THEN
      owner_user := substr(subject, 6);
    END IF;
    IF owner_user IS NOT NULL THEN
      SELECT u.email INTO email FROM auth_users u WHERE u.id = owner_user;
      IF NOT FOUND THEN owner_user := NULL; END IF;
    END IF;
    mail_domain := CASE WHEN position('@' in coalesce(email, '')) > 0
      THEN opengeni_private.signup_email_domain_key(split_part(email, '@', 2)) END;
    kind := opengeni_private.signup_email_domain_kind(mail_domain);
    IF kind IN ('relay', 'personal_relay', 'academic', 'company') THEN
      hash_value := opengeni_private.signup_email_domain_hash(NEW.data_schema, mail_domain);
    END IF;
    IF kind IN ('relay', 'personal_relay') THEN
      provider_value := opengeni_private.signup_email_domain_hash(NEW.data_schema,
        opengeni_private.signup_email_domain_provider(mail_domain));
    END IF;
    INSERT INTO opengeni_private.signup_owner_email_domains(data_schema, account_id, owner_auth_user_id,
      domain_kind, domain_hash, provider_hash, set_up_at, mail_signal)
    VALUES (NEW.data_schema, NEW.account_id, owner_user, kind, hash_value, provider_value, NEW.set_up_at,
      mail_signal_value)
    ON CONFLICT (data_schema, account_id) DO NOTHING;
    settings := opengeni_private.signup_network_velocity_settings(NEW.data_schema);
    IF kind <> 'reserved' AND (settings->>'emailDomainMode' <> 'off' OR settings->>'burstMode' <> 'off'
        OR settings->>'deniedDomainMode' <> 'off' OR settings->>'disposableMailMode' <> 'off'
        OR settings->>'slowDomainMode' <> 'off') THEN
      domain_reach := greatest(make_interval(mins => (settings->>'emailDomainWindowMinutes')::integer),
        CASE WHEN settings->>'slowDomainMode' <> 'off'
          THEN make_interval(hours => (settings->>'slowDomainWindowHours')::integer)
          ELSE interval '0' END);
      SELECT string_agg(listed.account_id::text, ',' ORDER BY listed.self DESC, listed.set_up_at DESC)
        INTO evaluate_ids FROM (
          SELECT peer.account_id, peer.set_up_at, peer.account_id = NEW.account_id AS self
          FROM opengeni_private.signup_owner_email_domains peer
          WHERE peer.data_schema = NEW.data_schema AND peer.domain_kind <> 'reserved'
            AND peer.set_up_at >= NEW.set_up_at - domain_reach
              - make_interval(secs => (settings->>'burstWindowSeconds')::integer)
            AND (peer.account_id = NEW.account_id
              OR peer.set_up_at >= NEW.set_up_at - make_interval(secs => (settings->>'burstWindowSeconds')::integer)
              OR (kind IN ('company', 'personal_relay') AND peer.domain_hash = hash_value
                AND peer.set_up_at >= NEW.set_up_at - domain_reach))
          ORDER BY peer.account_id = NEW.account_id DESC, peer.set_up_at DESC LIMIT 51
        ) listed;
      existing := nullif(pg_catalog.current_setting('opengeni.signup_email_cluster_evaluate_accounts', true), '');
      PERFORM pg_catalog.set_config('opengeni.signup_email_cluster_evaluate_accounts',
        concat_ws(',', existing, evaluate_ids), true);
    END IF;
    -- Retention: 45 days (the 30-day denied-domain lookback of a setup that
    -- can still be evaluated), a few rows at a time.
    DELETE FROM opengeni_private.signup_owner_email_domains expired
      WHERE (expired.data_schema, expired.account_id) IN (
        SELECT o.data_schema, o.account_id FROM opengeni_private.signup_owner_email_domains o
        WHERE o.data_schema = NEW.data_schema AND o.set_up_at < clock_timestamp() - interval '45 days'
        ORDER BY o.set_up_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup owner email domain was not recorded (%)', SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.record_signup_owner_email_domain() FROM PUBLIC;

-- Same as 1489, plus the disposable mail and slow domain legs, and a
-- model-call admission stamps this organization's first use. Evaluates ONLY
-- the current account (its own credit fence through set_promotion_decision);
-- other accounts' rows are read, never locked or written.
CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_email_cluster(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text;
  settings jsonb; own opengeni_private.signup_owner_email_domains%ROWTYPE; own_network record;
  domain_window interval; burst_window interval; lookback interval;
  domain_count integer := 0; burst_count integer := 0; related_burst_count integer := 0;
  enforceable_burst_count integer := 0; denied_count integer := 0;
  domain_threshold integer; burst_threshold integer; denied_threshold integer;
  domain_mode text; burst_mode text; denied_mode text;
  domain_match boolean; burst_match boolean; denied_match boolean; enforced boolean; rule text;
  burst_enforceable boolean; denied_enforceable boolean;
  disposable_mode text; slow_mode text; slow_window interval; slow_threshold integer;
  slow_count integer := 0; slow_used boolean := false; disposable_match boolean; slow_match boolean;
  facts jsonb; decision_row promotion_decisions%ROWTYPE; slow_held boolean := false;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Signup email cluster scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- A model-call admission: this organization is used. Stamped once.
  IF pg_catalog.current_setting('opengeni.signup_usage_admission', true) = 'on' THEN
    UPDATE opengeni_private.signup_owner_email_domains
      SET first_admitted_at = statement_timestamp()
      WHERE data_schema = target AND account_id = p_account_id AND first_admitted_at IS NULL;
  END IF;
  -- Is this organization held by this detector's slow domain leg alone (its
  -- current decision is that hold)? Such a hold is lifted below once the
  -- domain group is used, so real colleagues are never stuck.
  SELECT * INTO decision_row FROM promotion_decisions WHERE account_id = p_account_id;
  IF FOUND AND decision_row.decision = 'held' AND decision_row.actor = 'service:promotion-detector' THEN
    slow_held := EXISTS (SELECT 1 FROM opengeni_private.promotion_decision_history h
      WHERE h.data_schema = target AND h.account_id = p_account_id
        AND h.revision = decision_row.revision AND h.policy_version = 'email-cluster-v1'
        AND h.rule_id = 'email-slow-domain-v1');
  END IF;
  settings := opengeni_private.signup_network_velocity_settings(target);
  domain_mode := coalesce(settings->>'emailDomainMode', 'observe');
  burst_mode := coalesce(settings->>'burstMode', 'enforce');
  denied_mode := coalesce(settings->>'deniedDomainMode', 'enforce');
  disposable_mode := coalesce(settings->>'disposableMailMode', 'enforce');
  slow_mode := coalesce(settings->>'slowDomainMode', 'enforce');
  IF domain_mode = 'off' AND burst_mode = 'off' AND denied_mode = 'off' AND disposable_mode = 'off'
    AND slow_mode = 'off' AND NOT slow_held THEN RETURN; END IF;
  SELECT * INTO own FROM opengeni_private.signup_owner_email_domains
    WHERE data_schema = target AND account_id = p_account_id;
  IF NOT FOUND OR own.domain_kind = 'reserved'
    OR (own.set_up_at < statement_timestamp() - interval '7 days' AND NOT slow_held) THEN RETURN; END IF;
  domain_window := make_interval(mins => (settings->>'emailDomainWindowMinutes')::integer);
  burst_window := make_interval(secs => (settings->>'burstWindowSeconds')::integer);
  lookback := make_interval(days => (settings->>'deniedDomainLookbackDays')::integer);
  domain_threshold := (settings->>'emailDomainHoldThreshold')::integer;
  burst_threshold := (settings->>'burstHoldThreshold')::integer;
  denied_threshold := (settings->>'deniedDomainHoldThreshold')::integer;
  -- Domain leg: company and personal relay domains only.
  IF domain_mode <> 'off' AND own.domain_kind IN ('company', 'personal_relay') THEN
    -- Distinct owners: one person's additional organizations count once.
    SELECT count(DISTINCT coalesce(peer.owner_auth_user_id, peer.account_id::text))::integer
      INTO domain_count FROM (
        SELECT p.owner_auth_user_id, p.account_id FROM opengeni_private.signup_owner_email_domains p
        WHERE p.data_schema = target AND p.domain_hash = own.domain_hash
          AND p.set_up_at BETWEEN own.set_up_at - domain_window AND own.set_up_at + domain_window
        ORDER BY p.set_up_at LIMIT 501
      ) peer;
  END IF;
  -- Denied leg: company, academic and personal relay domains only; distinct
  -- denied organizations.
  IF denied_mode <> 'off' AND own.domain_kind IN ('company', 'academic', 'personal_relay')
      AND (settings->>'deniedDomainLookbackDays')::integer > 0 THEN
    SELECT count(*)::integer INTO denied_count FROM (
      SELECT 1 FROM opengeni_private.signup_owner_email_domains p
      JOIN promotion_decisions d ON d.account_id = p.account_id AND d.decision = 'denied'
      WHERE p.data_schema = target AND p.domain_hash = own.domain_hash
        AND p.account_id <> p_account_id
        AND p.set_up_at BETWEEN own.set_up_at - lookback AND own.set_up_at
      LIMIT 51
    ) denied;
  END IF;
  -- Burst leg: every setup in the window and those that share this one's
  -- domain group (relays included) or signup network (observed); only those
  -- through the same shared relay, or with the same domain group and the
  -- same network, can hold.
  IF burst_mode <> 'off' THEN
    SELECT s.address_hash, s.prefix_hash INTO own_network FROM opengeni_private.signup_network_sources s
      WHERE s.data_schema = target AND s.account_id = p_account_id;
    SELECT count(*)::integer,
        count(*) FILTER (WHERE peer.account_id = p_account_id OR peer.same_domain
          OR peer.same_provider OR peer.same_network)::integer,
        count(*) FILTER (WHERE peer.account_id = p_account_id OR peer.same_provider
          OR (peer.same_domain AND peer.same_network))::integer
      INTO burst_count, related_burst_count, enforceable_burst_count FROM (
        SELECT p.account_id,
          (own.domain_hash IS NOT NULL AND p.domain_hash = own.domain_hash) AS same_domain,
          (own.provider_hash IS NOT NULL AND p.provider_hash = own.provider_hash) AS same_provider,
          (own_network.prefix_hash IS NOT NULL AND EXISTS (
            SELECT 1 FROM opengeni_private.signup_network_sources ns
            WHERE ns.data_schema = target AND ns.account_id = p.account_id
              AND (ns.address_hash = own_network.address_hash OR ns.prefix_hash = own_network.prefix_hash))) AS same_network
        FROM opengeni_private.signup_owner_email_domains p
        WHERE p.data_schema = target AND p.domain_kind <> 'reserved'
          AND p.set_up_at BETWEEN own.set_up_at - burst_window AND own.set_up_at + burst_window
        ORDER BY p.set_up_at LIMIT 501
      ) peer;
  END IF;
  -- Slow domain leg: company and personal relay domains only; distinct
  -- owners within the slow window, and whether any of those organizations
  -- (this one included) ever admitted a model call.
  IF (slow_mode <> 'off' OR slow_held) AND own.domain_kind IN ('company', 'personal_relay') THEN
    slow_window := make_interval(hours => (settings->>'slowDomainWindowHours')::integer);
    SELECT count(DISTINCT coalesce(peer.owner_auth_user_id, peer.account_id::text))::integer,
        coalesce(bool_or(peer.first_admitted_at IS NOT NULL), false)
      INTO slow_count, slow_used FROM (
        SELECT p.owner_auth_user_id, p.account_id, p.first_admitted_at
        FROM opengeni_private.signup_owner_email_domains p
        WHERE p.data_schema = target AND p.domain_hash = own.domain_hash
          AND p.set_up_at BETWEEN own.set_up_at - slow_window AND own.set_up_at + slow_window
        ORDER BY p.set_up_at LIMIT 501
      ) peer;
  END IF;
  disposable_match := own.mail_signal IS NOT DISTINCT FROM 'disposable';
  IF domain_count < 2 AND burst_count < 2 AND denied_count = 0 AND slow_count < 2
    AND NOT disposable_match AND NOT slow_held THEN RETURN; END IF;
  slow_threshold := (settings->>'slowDomainHoldThreshold')::integer;
  slow_match := slow_mode <> 'off' AND slow_count >= slow_threshold AND NOT slow_used;
  domain_match := domain_count >= domain_threshold;
  burst_match := related_burst_count >= burst_threshold;
  -- A per-person relay or dynamic DNS name is one person: one of their
  -- organizations denied is enough.
  IF own.domain_kind = 'personal_relay' THEN denied_threshold := 1; END IF;
  denied_match := denied_count >= denied_threshold;
  burst_enforceable := enforceable_burst_count >= burst_threshold;
  denied_enforceable := denied_match AND own.domain_kind <> 'academic';
  enforced := (disposable_match AND disposable_mode = 'enforce')
    OR (denied_enforceable AND denied_mode = 'enforce') OR (burst_enforceable AND burst_mode = 'enforce')
    OR (slow_match AND slow_mode = 'enforce') OR (domain_match AND domain_mode = 'enforce');
  rule := CASE
    WHEN disposable_match AND disposable_mode = 'enforce' THEN 'disposable-mail-v1'
    WHEN denied_enforceable AND denied_mode = 'enforce' THEN 'email-denied-domain-v1'
    WHEN burst_enforceable AND burst_mode = 'enforce' THEN 'signup-burst-v1'
    WHEN slow_match AND slow_mode = 'enforce' THEN 'email-slow-domain-v1'
    WHEN domain_match AND domain_mode = 'enforce' THEN 'email-domain-v1'
    WHEN disposable_match AND disposable_mode <> 'off' THEN 'disposable-mail-v1'
    WHEN denied_match THEN 'email-denied-domain-v1'
    WHEN burst_match THEN 'signup-burst-v1'
    WHEN slow_match THEN 'email-slow-domain-v1'
    WHEN domain_match THEN 'email-domain-v1'
    ELSE 'email-cluster-observed-v1' END;
  facts := jsonb_build_object(
    'ruleId', rule,
    'domainKind', own.domain_kind,
    'domainGroup', left(own.domain_hash, 16),
    'domainGroupSize', domain_count, 'burstGroupSize', burst_count,
    'relatedBurstGroupSize', related_burst_count, 'enforceableBurstGroupSize', enforceable_burst_count,
    'deniedDomainAccounts', denied_count,
    'groupSizeAtLeast', domain_count > 500 OR burst_count > 500,
    'emailDomainMode', domain_mode, 'emailDomainHoldThreshold', domain_threshold,
    'emailDomainWindowMinutes', (settings->>'emailDomainWindowMinutes')::integer,
    'burstMode', burst_mode, 'burstHoldThreshold', burst_threshold,
    'burstWindowSeconds', (settings->>'burstWindowSeconds')::integer,
    'deniedDomainMode', denied_mode, 'deniedDomainHoldThreshold', denied_threshold,
    'deniedDomainLookbackDays', (settings->>'deniedDomainLookbackDays')::integer,
    'mailSignal', own.mail_signal, 'disposableMailMode', disposable_mode,
    'slowDomainGroupSize', slow_count, 'slowDomainGroupUsed', slow_used,
    'slowDomainMode', slow_mode, 'slowDomainHoldThreshold', (settings->>'slowDomainHoldThreshold')::integer,
    'slowDomainWindowHours', (settings->>'slowDomainWindowHours')::integer,
    'settingsRevision', (settings->>'revision')::bigint,
    'setUpAt', to_char(own.set_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  -- Unchanged evidence writes nothing, so admission reads do not churn rows.
  INSERT INTO opengeni_private.promotion_detector_observations(data_schema, account_id, policy_version, evidence)
    VALUES (target, p_account_id, 'email-cluster-v1', facts)
    ON CONFLICT (data_schema, account_id, policy_version) DO UPDATE
      SET evidence = excluded.evidence, last_seen_at = clock_timestamp()
      WHERE promotion_detector_observations.evidence IS DISTINCT FROM excluded.evidence;
  IF enforced THEN
    -- Manual decisions (including an operator release) are never
    -- overwritten, and a detector hold is kept.
    IF decision_row.account_id IS NULL OR (decision_row.actor = 'service:promotion-detector' AND decision_row.decision = 'eligible') THEN
      PERFORM opengeni_private.set_promotion_decision(p_account_id, 'held', 'email-cluster-v1',
        facts->>'ruleId', facts, 'service:promotion-detector', coalesce(decision_row.revision, 0));
    END IF;
  ELSIF slow_held THEN
    -- The slow domain hold no longer applies (the group was used, e.g. by
    -- this very admission, or the leg was turned off) and no other leg holds:
    -- release it, so this admission proceeds. Each colleague's organization
    -- releases itself the same way on its own next evaluation; holds from
    -- other rules and manual decisions are never touched.
    PERFORM opengeni_private.set_promotion_decision(p_account_id, 'eligible', 'email-cluster-v1',
      'email-slow-domain-released-v1', facts, 'service:promotion-detector', decision_row.revision);
  END IF;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.evaluate_signup_email_cluster(uuid) FROM PUBLIC;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search paths, as 1489.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN ('set_signup_network_velocity',
      'record_signup_owner_email_domain', 'evaluate_signup_email_cluster')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END $install$;

