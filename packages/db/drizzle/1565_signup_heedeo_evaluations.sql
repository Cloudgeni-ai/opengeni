-- deployment-mode: rolling
-- Heedeo signup scoring (docs/signup-abuse-protection.md, "Heedeo shadow
-- scoring"). Inert until an operator sets heedeoSignupMode and the deployment
-- configures both Heedeo keys.
--
-- 1. signup_heedeo_mode_revisions: the deployment-wide, append-only switch
--    (off, shadow or enforce). No row means off. Operators change it through
--    the existing audited, revision-fenced set_signup_network_velocity setter
--    with {"heedeoSignupMode": "off"|"shadow"|"enforce"}, which appends a row
--    when the mode changes. Runtime roles read only this table (the mode), not
--    the private velocity settings.
-- 2. signup_heedeo_evaluations: one row per signup the API evaluated (or
--    refused, or skipped) while the mode was not off. Codes, numbers and
--    UUIDs only: no email, no address, no reason text. Runtime roles insert
--    rows and delete rows older than 180 days (bounded retention); they never
--    read or change them. Operators and analytics read them as owner.
--
-- Rolling: two new private tables with FORCE row-level security (the posture
-- check's securely shaped unknown private table, so the previous release
-- accepts them), and CREATE OR REPLACE of the 1494 settings reader and setter
-- with the same signatures (owners and ACLs stay). The previous release never
-- reads the new tables or the new setting.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE opengeni_private.signup_heedeo_mode_revisions (
  data_schema text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  mode text NOT NULL CHECK (mode IN ('off', 'shadow', 'enforce')),
  changed_by text NOT NULL CHECK (octet_length(changed_by) BETWEEN 1 AND 1000),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, revision)
);
COMMENT ON TABLE opengeni_private.signup_heedeo_mode_revisions IS 'Append-only operator switch for Heedeo signup scoring: off, shadow (record only) or enforce (refuse flagged signups).';

CREATE TABLE opengeni_private.signup_heedeo_evaluations (
  data_schema text NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- auth_users.id; null when enforce refused the signup before the user existed.
  user_id text CHECK (user_id IS NULL OR octet_length(user_id) BETWEEN 1 AND 1019),
  signup_method text NOT NULL CHECK (signup_method IN ('email', 'google', 'github', 'passkey', 'other')),
  mode text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  outcome text NOT NULL CHECK (outcome IN ('evaluated', 'error', 'skipped', 'refused')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  token_present boolean NOT NULL,
  no_token boolean,
  -- Heedeo's event_id.
  evaluation_id text CHECK (evaluation_id IS NULL OR octet_length(evaluation_id) BETWEEN 1 AND 200),
  score integer,
  -- Heedeo's suggested band.
  band text CHECK (band IS NULL OR band ~ '^[a-z_]{1,32}$'),
  flagged boolean,
  -- Reason codes only, never their text.
  reason_codes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reason_codes) <= 64),
  -- Heedeo's visitor.id as returned (Heedeo's own opaque id, no personal data).
  visitor_id text CHECK (visitor_id IS NULL OR octet_length(visitor_id) BETWEEN 1 AND 200)
);
CREATE INDEX signup_heedeo_evaluations_user ON opengeni_private.signup_heedeo_evaluations (data_schema, user_id);
CREATE INDEX signup_heedeo_evaluations_created ON opengeni_private.signup_heedeo_evaluations (data_schema, created_at);
-- The retention delete matches on created_at alone.
CREATE INDEX signup_heedeo_evaluations_expiry ON opengeni_private.signup_heedeo_evaluations (created_at);
COMMENT ON TABLE opengeni_private.signup_heedeo_evaluations IS 'Heedeo signup verdicts while scoring is on: codes, numbers and ids only (no email, no address). Kept 180 days.';

REVOKE ALL ON opengeni_private.signup_heedeo_mode_revisions, opengeni_private.signup_heedeo_evaluations FROM PUBLIC;
ALTER TABLE opengeni_private.signup_heedeo_mode_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.signup_heedeo_mode_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.signup_heedeo_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.signup_heedeo_evaluations FORCE ROW LEVEL SECURITY;
-- The mode is not secret: whoever has SELECT reads every revision.
CREATE POLICY mode_read ON opengeni_private.signup_heedeo_mode_revisions FOR SELECT USING (true);
-- Verdicts: whoever has SELECT (the owner, an analytics reader granted it)
-- reads all; the runtime has no SELECT. The runtime inserts any verdict and
-- deletes only expired ones.
CREATE POLICY evaluation_read ON opengeni_private.signup_heedeo_evaluations FOR SELECT USING (true);
CREATE POLICY evaluation_append ON opengeni_private.signup_heedeo_evaluations FOR INSERT WITH CHECK (true);
CREATE POLICY evaluation_expiry ON opengeni_private.signup_heedeo_evaluations FOR DELETE
  USING (created_at < clock_timestamp() - interval '180 days');

DO $signup_heedeo$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  -- Only the owner appends mode revisions (through the setter).
  EXECUTE format('CREATE POLICY owner_append ON opengeni_private.signup_heedeo_mode_revisions FOR INSERT TO %I WITH CHECK (true)', owner_name);
  -- The owner may prune any verdict (for example a deletion request).
  EXECUTE format('CREATE POLICY owner_delete ON opengeni_private.signup_heedeo_evaluations FOR DELETE TO %I USING (true)', owner_name);

  -- 1494's settings plus the Heedeo signup mode (off unless set).
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
        'heedeoSignupMode', coalesce((SELECT heedeo.mode FROM opengeni_private.signup_heedeo_mode_revisions heedeo
          WHERE heedeo.data_schema = p_data_schema ORDER BY heedeo.revision DESC LIMIT 1), 'off'),
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
END $signup_heedeo$;

-- 1494's setter, plus heedeoSignupMode ('off', 'shadow' or 'enforce'), which
-- appends a signup_heedeo_mode_revisions row when it changes.
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
      'slowDomainHoldThreshold','slowDomainWindowHours','cardVerificationMode','heedeoSignupMode');
  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown signup network velocity settings: %', array_to_string(unknown_keys, ', ')
      USING ERRCODE = '22023';
  END IF;
  IF p_changes ? 'cardVerificationMode' AND (jsonb_typeof(p_changes->'cardVerificationMode') <> 'string'
    OR p_changes->>'cardVerificationMode' NOT IN ('off', 'enforce')) THEN
    RAISE EXCEPTION 'cardVerificationMode must be off or enforce' USING ERRCODE = '22023';
  END IF;
  IF p_changes ? 'heedeoSignupMode' AND (jsonb_typeof(p_changes->'heedeoSignupMode') <> 'string'
    OR p_changes->>'heedeoSignupMode' NOT IN ('off', 'shadow', 'enforce')) THEN
    RAISE EXCEPTION 'heedeoSignupMode must be off, shadow or enforce' USING ERRCODE = '22023';
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
  IF p_changes ? 'heedeoSignupMode'
    AND (p_changes->>'heedeoSignupMode') IS DISTINCT FROM (previous->>'heedeoSignupMode') THEN
    INSERT INTO opengeni_private.signup_heedeo_mode_revisions (data_schema, revision, mode, changed_by, reason)
      VALUES (target, coalesce((SELECT max(heedeo.revision) FROM opengeni_private.signup_heedeo_mode_revisions heedeo
          WHERE heedeo.data_schema = target), 0) + 1,
        p_changes->>'heedeoSignupMode', btrim(p_operator), btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('previous', previous - 'operator' - 'changedAt',
    'current', opengeni_private.signup_network_velocity_settings(target));
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_signup_network_velocity(jsonb,text,text,bigint) FROM PUBLIC;

-- CREATE OR REPLACE keeps owners and ACLs. Pin the search path, as 1494, and
-- grant the runtime roles their table privileges (provisioning converges the
-- same grants when the roles are created later).
DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure; application_role text;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname = 'set_signup_network_velocity'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE opengeni_private.signup_heedeo_mode_revisions TO %I', application_role);
    EXECUTE format('GRANT INSERT, DELETE ON TABLE opengeni_private.signup_heedeo_evaluations TO %I', application_role);
  END LOOP;
END $install$;
