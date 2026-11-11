-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: organization_signup_use_cases holds one row per person and organization, so validating in this file is instant.
-- The signup question "How do you want to use OpenGeni?" gains a first
-- choice for someone on their own: get help with everyday things
-- (`everyday`). Keep that answer as itself instead of folding it into
-- `cloud`, since the first answer wins and can't be corrected later. Only
-- widens the closed list: every existing row already satisfies it, and older
-- binaries never send the new value. The function keeps its owner and grants;
-- only its accepted values change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.organization_signup_use_cases
  DROP CONSTRAINT organization_signup_use_cases_use_case_check;
ALTER TABLE opengeni_private.organization_signup_use_cases
  ADD CONSTRAINT organization_signup_use_cases_use_case_check
  CHECK (use_case IN ('everyday', 'embed', 'cloud')) NOT VALID;
ALTER TABLE opengeni_private.organization_signup_use_cases
  VALIDATE CONSTRAINT organization_signup_use_cases_use_case_check;

CREATE OR REPLACE FUNCTION opengeni_private.record_organization_signup_use_case(
  p_account uuid, p_subject text, p_use_case text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_use_case text;
BEGIN
  IF p_account IS NULL OR p_subject IS NULL OR p_use_case IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
  THEN RAISE EXCEPTION 'signup use case scope mismatch' USING ERRCODE = '42501'; END IF;
  IF p_subject !~ '^user:[A-Za-z0-9_-]{1,255}$' THEN
    RAISE EXCEPTION 'signup use case belongs to a managed person' USING ERRCODE = '42501';
  END IF;
  IF p_use_case NOT IN ('everyday', 'embed', 'cloud') THEN
    RAISE EXCEPTION 'invalid signup use case' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.organization_signup_use_cases (account_id, subject_id, use_case)
  VALUES (p_account, p_subject, p_use_case)
  ON CONFLICT (account_id, subject_id) DO NOTHING;
  SELECT u.use_case INTO v_use_case
  FROM opengeni_private.organization_signup_use_cases u
  WHERE u.account_id = p_account AND u.subject_id = p_subject;
  RETURN v_use_case;
END $body$;

DO $search_path$
BEGIN
  -- Explicit pg_temp LAST is load-bearing, as in 0595: the replaced function
  -- searches the captured data schema, never caller-controlled temporary
  -- relations ahead of it.
  EXECUTE format('ALTER FUNCTION opengeni_private.record_organization_signup_use_case(uuid,text,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $search_path$;
