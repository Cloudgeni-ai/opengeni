-- deployment-mode: rolling
-- Deployment-level runtime kill switch for the one-time verified signup trial
-- credit (0509). OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED stays the
-- master opt-in; a grant now also requires the newest revision below to allow
-- it. The seed revision allows grants, so this migration changes nothing until
-- an operator calls set_verified_signup_trial_credits_enabled. Flipping it
-- takes effect for the next setup transaction without a deploy or restart.
SET LOCAL lock_timeout = '5s';

-- Append-only: every row is one audited switch revision, and the newest row is
-- the current state. Runtime roles get SELECT only (via provisionRoles) for the
-- operator gauge; nothing but the owner-only setter below writes here.
CREATE TABLE opengeni_private.verified_signup_trial_switch_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grants_enabled boolean NOT NULL,
  previous_grants_enabled boolean,
  operator text NOT NULL CHECK (
    operator = pg_catalog.btrim(operator)
    AND pg_catalog.char_length(operator) BETWEEN 1 AND 200
  ),
  reason text NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.char_length(reason) BETWEEN 6 AND 1000
  ),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON opengeni_private.verified_signup_trial_switch_revisions FROM PUBLIC;

INSERT INTO opengeni_private.verified_signup_trial_switch_revisions (
  grants_enabled, previous_grants_enabled, operator, reason
) VALUES (
  true, NULL, 'migration:0521',
  'Initial state: the runtime switch allows grants; the deployment flag remains the master switch.'
);

CREATE FUNCTION reject_verified_signup_trial_switch_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION 'verified signup trial switch revisions are append-only'
    USING ERRCODE = '55000';
END
$body$;
REVOKE ALL ON FUNCTION reject_verified_signup_trial_switch_revision_mutation() FROM PUBLIC;

CREATE TRIGGER verified_signup_trial_switch_revisions_immutable
BEFORE UPDATE OR DELETE ON opengeni_private.verified_signup_trial_switch_revisions
FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();
CREATE TRIGGER verified_signup_trial_switch_revisions_no_truncate
BEFORE TRUNCATE ON opengeni_private.verified_signup_trial_switch_revisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

-- Operator-only audited setter. It lives in the data schema so its EXECUTE ACL
-- is not swept by the opengeni_private runtime grant; PUBLIC and every runtime
-- role stay revoked (provisionRoles converges late roles, and runtime posture
-- fails if either gains EXECUTE). The exclusive advisory lock orders it against
-- the shared lock each grant takes: once this call commits, no setup that
-- commits later can observe the previous revision.
CREATE FUNCTION set_verified_signup_trial_credits_enabled(
  p_enabled boolean,
  p_operator text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET lock_timeout = '10s'
AS $body$
DECLARE
  previous_enabled boolean;
  written opengeni_private.verified_signup_trial_switch_revisions%ROWTYPE;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'verified signup trial switch requires an explicit enabled value'
      USING ERRCODE = '22023';
  END IF;
  IF p_operator IS NULL OR p_operator <> pg_catalog.btrim(p_operator)
    OR pg_catalog.char_length(p_operator) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'verified signup trial switch operator must be 1-200 trimmed characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason <> pg_catalog.btrim(p_reason)
    OR pg_catalog.char_length(p_reason) NOT BETWEEN 6 AND 1000
  THEN
    RAISE EXCEPTION 'verified signup trial switch reason must be 6-1000 trimmed characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('verified-signup-trial-switch', 0)
  );
  SELECT revision.grants_enabled
  INTO previous_enabled
  FROM opengeni_private.verified_signup_trial_switch_revisions revision
  ORDER BY revision.revision DESC
  LIMIT 1;

  INSERT INTO opengeni_private.verified_signup_trial_switch_revisions (
    grants_enabled, previous_grants_enabled, operator, reason, database_role
  ) VALUES (
    p_enabled, previous_enabled, p_operator, p_reason, session_user
  )
  RETURNING * INTO written;

  RETURN pg_catalog.jsonb_build_object(
    'revision', written.revision,
    'grantsEnabled', written.grants_enabled,
    'previousGrantsEnabled', written.previous_grants_enabled,
    'changed', written.previous_grants_enabled IS DISTINCT FROM written.grants_enabled,
    'operator', written.operator,
    'reason', written.reason,
    'databaseRole', written.database_role,
    'changedAt', written.changed_at
  );
END
$body$;

REVOKE ALL ON FUNCTION set_verified_signup_trial_credits_enabled(boolean, text, text) FROM PUBLIC;

-- The grant keeps every 0509 invariant and adds the runtime switch after the
-- per-request deployment opt-in, so a disabled master switch never touches it.
CREATE OR REPLACE FUNCTION opengeni_private.grant_verified_signup_trial_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  verified_owner boolean;
  account_owner boolean;
  runtime_enabled boolean;
  inserted_count integer;
BEGIN
  IF pg_catalog.current_setting('opengeni.verified_signup_trial_enabled', true)
      IS DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;

  -- Shared against the setter's exclusive lock; a missing revision fails closed.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('verified-signup-trial-switch', 0)
  );
  SELECT revision.grants_enabled
  INTO runtime_enabled
  FROM opengeni_private.verified_signup_trial_switch_revisions revision
  ORDER BY revision.revision DESC
  LIMIT 1;
  IF runtime_enabled IS DISTINCT FROM TRUE THEN
    RETURN NEW;
  END IF;

  -- This is a defense in depth check: the sole receipt writer already checks
  -- the canonical verified human and the absence of prior memberships.
  SELECT candidate.email_verified IS TRUE
  INTO verified_owner
  FROM auth_users candidate
  WHERE candidate.id = NEW.auth_user_id;
  SELECT account.external_source = 'better-auth:user'
    AND account.external_id = NEW.auth_user_id
  INTO account_owner
  FROM managed_accounts account
  WHERE account.id = NEW.account_id;
  IF verified_owner IS DISTINCT FROM TRUE
    OR account_owner IS DISTINCT FROM TRUE
    OR opengeni_private.current_subject_id() IS DISTINCT FROM 'user:' || NEW.auth_user_id
    OR opengeni_private.current_account_id() IS DISTINCT FROM NEW.account_id
    OR NEW.result ->> 'organizationId' IS DISTINCT FROM NEW.account_id::text
  THEN
    RAISE EXCEPTION 'verified signup trial requires an exact new owner'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO credit_ledger_entries (
    account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata
  ) VALUES (
    NEW.account_id, NULL, 'grant', 10000000, 'verified_signup_trial',
    NEW.auth_user_id, 'verified-signup-trial:v1:' || NEW.auth_user_id,
    pg_catalog.jsonb_build_object('campaign', 'verified_signup_trial_v1')
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'verified signup trial credit idempotency collision'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$body$;

-- CREATE OR REPLACE resets SET search_path FROM CURRENT: re-pin both definers.
DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.grant_verified_signup_trial_credit() '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.set_verified_signup_trial_credits_enabled(boolean, text, text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
END
$posture$;
