-- deployment-mode: rolling
-- Only a newly completed, verified self-service organization setup can receive
-- this campaign's $10 account credit. The API explicitly opts in per request;
-- deploying this migration alone does not activate the offer. Older receipts,
-- invited users, and additional organizations are never backfilled.

CREATE FUNCTION opengeni_private.grant_verified_signup_trial_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  verified_owner boolean;
  account_owner boolean;
  inserted_count integer;
BEGIN
  IF pg_catalog.current_setting('opengeni.verified_signup_trial_enabled', true)
      IS DISTINCT FROM 'on' THEN
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

REVOKE ALL ON FUNCTION opengeni_private.grant_verified_signup_trial_credit() FROM PUBLIC;
DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.grant_verified_signup_trial_credit() '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
END
$posture$;

CREATE TRIGGER self_service_setup_trial_credit
AFTER INSERT ON self_service_organization_setup_receipts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.grant_verified_signup_trial_credit();