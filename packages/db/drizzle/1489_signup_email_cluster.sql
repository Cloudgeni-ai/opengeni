-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the CHECKs are on new nullable columns of the small owner-only settings history table, as in 1368 and 1471.
-- Signup email clusters (rule email-cluster-v1): hold new self-serve
-- organizations that arrive as a farm, whatever network they come from.
--
-- The network rules (1354, 1368, 1471) key on the setup request's network
-- and the owners' sign-in networks. A farm that rotates networks but signs
-- every owner up with one mail domain (a throwaway domain or an alias relay)
-- or scripts many setups in the same seconds was never held. Every new
-- self-serve organization (first organizations through the setup receipt,
-- additional ones through create_additional_managed_organization, 1484)
-- records its setup in signup_network_owner_setups; from this migration a
-- trigger on that table also records the class of the owner's mail domain
-- and, for a non-public domain, a keyed hash of it (never the address or
-- the domain itself).
--
-- Domain classes: reserved (documentation and testing names, never
-- counted), public (a large mail provider), relay (a shared alias relay
-- such as SimpleLogin, Firefox Relay, DuckDuckGo or Apple's private relay:
-- many unrelated people share it), personal_relay (a per-person subdomain
-- of addy.io, anonaddy or 33mail, or of a dynamic DNS host such as DuckDNS,
-- No-IP or Dynu: one person, grouped on the full subdomain, never on the
-- shared parent), academic (.edu, .ac.*), company (anything else) or
-- unknown. Relay and per-person relay setups also record a keyed hash of
-- their provider (the shared suffix).
--
-- Three legs, each with its own mode (off, observe, enforce):
--
-- 1. Burst (burstMode, enforce): burstHoldThreshold (4) organizations set
--    up within burstWindowSeconds (10) of each other through the same
--    provider (a shared relay, a per-person relay service or a dynamic DNS
--    host: a same-second batch through one is a farm), or with the same
--    domain group and the same signup network. A burst that shares only a
--    network, or only a company or academic domain (a workshop, a
--    classroom, an office onboarding colleagues), and a burst of unrelated
--    public or unknown domains are observed, never held.
-- 2. Denied domain (deniedDomainMode, enforce): at least
--    deniedDomainHoldThreshold (2) distinct denied organizations set up
--    within deniedDomainLookbackDays (30) before this one on the same
--    company, academic or personal relay domain; for a per-person relay or
--    dynamic DNS name (one person) one denied organization is enough.
--    Public providers and shared relays never propagate a denial (the
--    network rules already cover a shared network), and an academic domain
--    is observed only (one university's students are unrelated people).
-- 3. Domain (emailDomainMode, observe): distinct owners on the same company
--    or personal relay domain within emailDomainWindowMinutes (60).
--    Reaches emailDomainHoldThreshold (3). Observed by default: a company
--    or a workshop can sign several colleagues up in an hour. Public
--    providers, shared relays and academic domains never group here.
--
-- Sized from hosted production (60 to 90 days of self-serve setups): no
-- legitimate non-public domain set up more than 2 organizations in an hour,
-- every domain with 3 or more in an hour was a throwaway farm, and outside
-- one abuse incident no 10 seconds ever saw more than 2 setups.
--
-- Evaluated after setup (the API evaluates the
-- organizations listed in opengeni.signup_email_cluster_evaluate_accounts:
-- this one first, then its recent domain and burst peers, so the first
-- members of a burst are held too) and lazily through
-- free_plan_credit_eligible, like the network rules: the current account
-- only, manual decisions and operator releases never overwritten, a hold
-- released like any other detector hold, every step bounded and failing
-- open. Records are kept 45 days.
--
-- Rolling: new nullable columns, a new table, new owner-only routines and a
-- trigger; CREATE OR REPLACE of known routines with the same signatures. The
-- previous release sets only the settings it knows and does not read the new
-- evaluation list; its setups are still recorded and lazily evaluated.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE opengeni_private.signup_network_velocity_revisions
  ADD COLUMN email_domain_mode text CHECK (email_domain_mode IN ('off','observe','enforce')),
  ADD COLUMN email_domain_hold_threshold integer CHECK (email_domain_hold_threshold BETWEEN 2 AND 500),
  ADD COLUMN email_domain_window_minutes integer CHECK (email_domain_window_minutes BETWEEN 1 AND 10080),
  ADD COLUMN burst_mode text CHECK (burst_mode IN ('off','observe','enforce')),
  ADD COLUMN burst_hold_threshold integer CHECK (burst_hold_threshold BETWEEN 2 AND 500),
  ADD COLUMN burst_window_seconds integer CHECK (burst_window_seconds BETWEEN 1 AND 3600),
  ADD COLUMN denied_domain_mode text CHECK (denied_domain_mode IN ('off','observe','enforce')),
  ADD COLUMN denied_domain_hold_threshold integer CHECK (denied_domain_hold_threshold BETWEEN 1 AND 50),
  ADD COLUMN denied_domain_lookback_days integer CHECK (denied_domain_lookback_days BETWEEN 0 AND 90);

-- One row per new self-serve organization: the owner, the class of the
-- owner's mail domain and, for a non-public domain, its keyed hash.
CREATE TABLE opengeni_private.signup_owner_email_domains (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  owner_auth_user_id text CHECK (octet_length(owner_auth_user_id) BETWEEN 1 AND 1019),
  domain_kind text NOT NULL CHECK (domain_kind IN
    ('public','relay','personal_relay','academic','company','reserved','unknown')),
  domain_hash text CHECK (domain_hash ~ '^[0-9a-f]{64}$'),
  -- Keyed hash of the relay, per-person relay service or dynamic DNS host.
  provider_hash text CHECK (provider_hash ~ '^[0-9a-f]{64}$'),
  set_up_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, account_id)
);
CREATE INDEX signup_owner_email_domains_domain
  ON opengeni_private.signup_owner_email_domains (data_schema, domain_hash, set_up_at)
  WHERE domain_hash IS NOT NULL;
CREATE INDEX signup_owner_email_domains_set_up
  ON opengeni_private.signup_owner_email_domains (data_schema, set_up_at);
REVOKE ALL ON opengeni_private.signup_owner_email_domains FROM PUBLIC;

-- The class of a mail domain (see the header).
CREATE OR REPLACE FUNCTION opengeni_private.signup_email_domain_kind(p_domain text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE mail_domain text := lower(rtrim(btrim(coalesce(p_domain, '')), '.'));
  first_label text; tld text;
BEGIN
  IF mail_domain = '' OR mail_domain !~ '^[a-z0-9.-]+$' OR position('.' in mail_domain) = 0 THEN RETURN 'unknown'; END IF;
  tld := substring(mail_domain from '[^.]+$');
  IF tld IN ('test','example','invalid','localhost','local')
    OR mail_domain ~ '(^|\.)example\.(com|net|org)$' THEN RETURN 'reserved'; END IF;
  -- A per-person subdomain of a relay or of a dynamic DNS host is one
  -- person; the relay itself is shared, and a dynamic DNS host's own name
  -- is no one's mail domain.
  IF mail_domain ~ '\.(anonaddy\.(com|me)|addy\.io|33mail\.com|duckdns\.org|freeddns\.org|mywire\.org|ddnsfree\.com|ddnsgeek\.com|dynu\.net|giize\.com|gleeze\.com|kozow\.com|loseyourip\.com|ooguy\.com|theworkpc\.com|webredirect\.org|accesscam\.org|camdvr\.org|casacam\.net|ddns\.net|ddns\.me|no-ip\.(com|org|biz|info)|noip\.me|hopto\.org|zapto\.org|sytes\.net|myftp\.(org|biz)|serveftp\.com|servebeer\.com|servehttp\.com|redirectme\.net|ddnsking\.com|dyndns\.(org|biz|info)|homeip\.net|dynv6\.net|dedyn\.io|nsupdate\.info|dynamic-dns\.net|mooo\.com|chickenkiller\.com|us\.to|strangled\.net|crabdance\.com|ignorelist\.com|jumpingcrab\.com|twilightparadox\.com)$' THEN RETURN 'personal_relay'; END IF;
  IF mail_domain ~ '^(duckdns\.org|freeddns\.org|mywire\.org|ddnsfree\.com|ddnsgeek\.com|dynu\.net|giize\.com|gleeze\.com|kozow\.com|loseyourip\.com|ooguy\.com|theworkpc\.com|webredirect\.org|accesscam\.org|camdvr\.org|casacam\.net|ddns\.net|ddns\.me|no-ip\.(com|org|biz|info)|noip\.me|hopto\.org|zapto\.org|sytes\.net|myftp\.(org|biz)|serveftp\.com|servebeer\.com|servehttp\.com|redirectme\.net|ddnsking\.com|dyndns\.(org|biz|info)|homeip\.net|dynv6\.net|dedyn\.io|nsupdate\.info|dynamic-dns\.net|mooo\.com|chickenkiller\.com|us\.to|strangled\.net|crabdance\.com|ignorelist\.com|jumpingcrab\.com|twilightparadox\.com)$' THEN RETURN 'unknown'; END IF;
  IF mail_domain ~ '(^|\.)(simplelogin\.(com|fr|co|io)|aleeas\.com|slmail\.me|slmails\.com|8alias\.com|silomails\.com|mozmail\.com|relay\.firefox\.com|duck\.com|anonaddy\.(com|me)|addy\.io|privaterelay\.appleid\.com|passmail\.(net|com)|passinbox\.com|33mail\.com)$' THEN
    RETURN 'relay';
  END IF;
  IF mail_domain ~ '(^|\.)edu(\.[a-z]{2})?$' OR mail_domain ~ '\.ac\.[a-z]{2}$' THEN RETURN 'academic'; END IF;
  first_label := split_part(mail_domain, '.', 1);
  IF first_label IN ('gmail','googlemail','hotmail','outlook','live','msn','yahoo','ymail','gmx','yandex','icloud')
    OR mail_domain IN ('me.com','mac.com','aol.com','proton.me','protonmail.com','protonmail.ch','pm.me',
      'rocketmail.com','web.de','ya.ru','mail.ru','inbox.ru','list.ru','bk.ru','rambler.ru','ukr.net',
      'qq.com','163.com','126.com','yeah.net','sina.com','sina.cn','foxmail.com','aliyun.com',
      'zoho.com','zohomail.com','fastmail.com','hey.com','tutanota.com','tutanota.de','tuta.io',
      'tutamail.com','naver.com','hanmail.net','daum.net','kakao.com','seznam.cz','libero.it',
      'orange.fr','free.fr','laposte.net','t-online.de','freenet.de','wp.pl','o2.pl','interia.pl',
      'rediffmail.com','mail.com','email.com','comcast.net','verizon.net','att.net','sbcglobal.net',
      'btinternet.com','shaw.ca','rogers.com','bigpond.com','optusnet.com.au','virginmedia.com',
      'sky.com','bluewin.ch','telenet.be','skynet.be','ziggo.nl','kpnmail.nl','online.no',
      'uol.com.br','bol.com.br','terra.com.br','139.com','sohu.com',
      'posteo.de','mailbox.org','mail.de','aim.com','cox.net','charter.net','earthlink.net','juno.com',
      'sfr.fr','wanadoo.fr','virgilio.it','alice.it','tiscali.it','onet.pl','op.pl','centrum.cz',
      'email.cz','abv.bg','xs4all.nl','telia.com') THEN
    RETURN 'public';
  END IF;
  RETURN 'company';
END $$;
REVOKE ALL ON FUNCTION opengeni_private.signup_email_domain_kind(text) FROM PUBLIC;

-- The provider of a relay or per-person relay domain (the shared suffix: a
-- relay, a per-person relay service or a dynamic DNS host), else null.
CREATE OR REPLACE FUNCTION opengeni_private.signup_email_domain_provider(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT substring(lower(rtrim(btrim(coalesce(p_domain, '')), '.'))
    from '(?:^|\.)((?:simplelogin\.(?:com|fr|co|io)|aleeas\.com|slmail\.me|slmails\.com|8alias\.com|silomails\.com|mozmail\.com|relay\.firefox\.com|duck\.com|privaterelay\.appleid\.com|passmail\.(?:net|com)|passinbox\.com|anonaddy\.(?:com|me)|addy\.io|33mail\.com|duckdns\.org|freeddns\.org|mywire\.org|ddnsfree\.com|ddnsgeek\.com|dynu\.net|giize\.com|gleeze\.com|kozow\.com|loseyourip\.com|ooguy\.com|theworkpc\.com|webredirect\.org|accesscam\.org|camdvr\.org|casacam\.net|ddns\.net|ddns\.me|no-ip\.(?:com|org|biz|info)|noip\.me|hopto\.org|zapto\.org|sytes\.net|myftp\.(?:org|biz)|serveftp\.com|servebeer\.com|servehttp\.com|redirectme\.net|ddnsking\.com|dyndns\.(?:org|biz|info)|homeip\.net|dynv6\.net|dedyn\.io|nsupdate\.info|dynamic-dns\.net|mooo\.com|chickenkiller\.com|us\.to|strangled\.net|crabdance\.com|ignorelist\.com|jumpingcrab\.com|twilightparadox\.com))$')
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_email_domain_provider(text) FROM PUBLIC;

-- The grouping key of a mail domain: the normalized domain (a per-person
-- relay subdomain keeps its full subdomain).
CREATE OR REPLACE FUNCTION opengeni_private.signup_email_domain_key(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT lower(rtrim(btrim(coalesce(p_domain, '')), '.'))
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_email_domain_key(text) FROM PUBLIC;

-- HMAC-SHA256 of a domain key under the schema's key (1368); null without one.
CREATE OR REPLACE FUNCTION opengeni_private.signup_email_domain_hash(p_data_schema text, p_domain_key text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(k.outer_pad || sha256(k.inner_pad || convert_to('email-domain:' || p_domain_key, 'UTF8'))), 'hex')
  FROM opengeni_private.signup_network_session_keys k
  WHERE k.data_schema = p_data_schema AND coalesce(p_domain_key, '') <> ''
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_email_domain_hash(text,text) FROM PUBLIC;

-- 1471 settings plus the email cluster settings (burst and denied domain
-- enforce, domain observes, unless set).
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
    'operator', current.operator,
    'changedAt', current.changed_at)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT * FROM opengeni_private.signup_network_velocity_revisions r
    WHERE r.data_schema = p_data_schema ORDER BY r.revision DESC LIMIT 1
  ) AS current ON true
$$;
REVOKE ALL ON FUNCTION opengeni_private.signup_network_velocity_settings(text) FROM PUBLIC;

-- Same as 1471, plus the email cluster settings.
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
      'deniedDomainHoldThreshold','deniedDomainLookbackDays');
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
    denied_domain_lookback_days, operator, reason)
  VALUES (target, (previous->>'revision')::bigint + 1, merged->>'mode', (merged->>'windowHours')::integer,
    (merged->>'exactHoldThreshold')::integer, (merged->>'prefixHoldThreshold')::integer,
    (merged->>'rateLimitEnabled')::boolean, (merged->>'rateLimitMax')::integer,
    merged->>'deniedNetworkMode', merged->>'signInNetworkMode', merged->>'emailDomainMode',
    (merged->>'emailDomainHoldThreshold')::integer, (merged->>'emailDomainWindowMinutes')::integer,
    merged->>'burstMode', (merged->>'burstHoldThreshold')::integer, (merged->>'burstWindowSeconds')::integer,
    merged->>'deniedDomainMode', (merged->>'deniedDomainHoldThreshold')::integer,
    (merged->>'deniedDomainLookbackDays')::integer, p_operator, p_reason)
  RETURNING * INTO result;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- Records the owner's mail domain of a new self-serve organization and lists
-- the organizations to evaluate after commit: this one, then (newest first,
-- 50 at most) the ones set up within the burst window or, on a company or
-- personal relay domain, with the same domain within the domain window. The
-- owner is the account's
-- self-serve owner, else the acting person (an additional organization).
-- Never raises: a failure records and refuses nothing.
CREATE OR REPLACE FUNCTION opengeni_private.record_signup_owner_email_domain() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE owner_user text; email text; mail_domain text; kind text; hash_value text; settings jsonb;
  provider_value text;
  evaluate_ids text; existing text; subject text;
BEGIN
  BEGIN
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
      domain_kind, domain_hash, provider_hash, set_up_at)
    VALUES (NEW.data_schema, NEW.account_id, owner_user, kind, hash_value, provider_value, NEW.set_up_at)
    ON CONFLICT (data_schema, account_id) DO NOTHING;
    settings := opengeni_private.signup_network_velocity_settings(NEW.data_schema);
    IF kind <> 'reserved' AND (settings->>'emailDomainMode' <> 'off' OR settings->>'burstMode' <> 'off'
        OR settings->>'deniedDomainMode' <> 'off') THEN
      SELECT string_agg(listed.account_id::text, ',' ORDER BY listed.self DESC, listed.set_up_at DESC)
        INTO evaluate_ids FROM (
          SELECT peer.account_id, peer.set_up_at, peer.account_id = NEW.account_id AS self
          FROM opengeni_private.signup_owner_email_domains peer
          WHERE peer.data_schema = NEW.data_schema AND peer.domain_kind <> 'reserved'
            AND peer.set_up_at >= NEW.set_up_at
              - make_interval(mins => (settings->>'emailDomainWindowMinutes')::integer)
              - make_interval(secs => (settings->>'burstWindowSeconds')::integer)
            AND (peer.account_id = NEW.account_id
              OR peer.set_up_at >= NEW.set_up_at - make_interval(secs => (settings->>'burstWindowSeconds')::integer)
              OR (kind IN ('company', 'personal_relay') AND peer.domain_hash = hash_value
                AND peer.set_up_at >= NEW.set_up_at
                  - make_interval(mins => (settings->>'emailDomainWindowMinutes')::integer)))
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

CREATE TRIGGER signup_network_owner_setups_email_domain
  AFTER INSERT ON opengeni_private.signup_network_owner_setups
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.record_signup_owner_email_domain();

-- Evaluates ONLY the current account (its own credit fence through
-- set_promotion_decision); other accounts' rows are read, never locked.
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
  facts jsonb; decision_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Signup email cluster scope mismatch' USING ERRCODE = '42501';
  END IF;
  settings := opengeni_private.signup_network_velocity_settings(target);
  domain_mode := coalesce(settings->>'emailDomainMode', 'observe');
  burst_mode := coalesce(settings->>'burstMode', 'enforce');
  denied_mode := coalesce(settings->>'deniedDomainMode', 'enforce');
  IF domain_mode = 'off' AND burst_mode = 'off' AND denied_mode = 'off' THEN RETURN; END IF;
  SELECT * INTO own FROM opengeni_private.signup_owner_email_domains
    WHERE data_schema = target AND account_id = p_account_id;
  IF NOT FOUND OR own.domain_kind = 'reserved'
    OR own.set_up_at < statement_timestamp() - interval '7 days' THEN RETURN; END IF;
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
  IF domain_count < 2 AND burst_count < 2 AND denied_count = 0 THEN RETURN; END IF;
  domain_match := domain_count >= domain_threshold;
  burst_match := related_burst_count >= burst_threshold;
  -- A per-person relay or dynamic DNS name is one person: one of their
  -- organizations denied is enough.
  IF own.domain_kind = 'personal_relay' THEN denied_threshold := 1; END IF;
  denied_match := denied_count >= denied_threshold;
  burst_enforceable := enforceable_burst_count >= burst_threshold;
  denied_enforceable := denied_match AND own.domain_kind <> 'academic';
  enforced := (denied_enforceable AND denied_mode = 'enforce') OR (burst_enforceable AND burst_mode = 'enforce')
    OR (domain_match AND domain_mode = 'enforce');
  rule := CASE
    WHEN denied_enforceable AND denied_mode = 'enforce' THEN 'email-denied-domain-v1'
    WHEN burst_enforceable AND burst_mode = 'enforce' THEN 'signup-burst-v1'
    WHEN domain_match AND domain_mode = 'enforce' THEN 'email-domain-v1'
    WHEN denied_match THEN 'email-denied-domain-v1'
    WHEN burst_match THEN 'signup-burst-v1'
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
    SELECT * INTO decision_row FROM promotion_decisions WHERE account_id = p_account_id;
    IF NOT FOUND OR (decision_row.actor = 'service:promotion-detector' AND decision_row.decision = 'eligible') THEN
      PERFORM opengeni_private.set_promotion_decision(p_account_id, 'held', 'email-cluster-v1',
        facts->>'ruleId', facts, 'service:promotion-detector', coalesce(decision_row.revision, 0));
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.evaluate_signup_email_cluster(uuid) FROM PUBLIC;

-- Same body as 1368, plus the email cluster rule.
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
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries trial WHERE trial.account_id = p_account_id
    AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
    AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
    AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM auth_users signup_owner
      WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before)));
END $body$;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search paths; the new
-- routines are owner-only.
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible')
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('set_signup_network_velocity',
        'record_signup_owner_email_domain', 'evaluate_signup_email_cluster'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN ('signup_email_domain_kind',
      'signup_email_domain_key', 'signup_email_domain_hash', 'signup_email_domain_provider',
      'record_signup_owner_email_domain',
      'evaluate_signup_email_cluster')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END $install$;
