-- deployment-mode: rolling
-- Deploy every reader and debit writer before configuring scoped offers.
-- Existing grants keep NULL eligibility and remain unrestricted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE credit_ledger_entries ADD COLUMN eligible_model_ids text[];
ALTER TABLE credit_ledger_entries ADD CONSTRAINT credit_ledger_scope_valid CHECK (
  eligible_model_ids IS NULL OR (type = 'grant' AND amount_micros > 0
    AND cardinality(eligible_model_ids) BETWEEN 1 AND 40
    AND array_position(eligible_model_ids, NULL) IS NULL
    AND array_position(eligible_model_ids, '') IS NULL)
);
CREATE UNIQUE INDEX credit_ledger_entries_id_account_idx ON credit_ledger_entries (id, account_id);
CREATE INDEX credit_ledger_scoped_grants_idx ON credit_ledger_entries (account_id, created_at, id)
  WHERE eligible_model_ids IS NOT NULL;
CREATE FUNCTION opengeni_private.preserve_credit_grant_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF NEW.eligible_model_ids IS DISTINCT FROM OLD.eligible_model_ids
    OR (OLD.eligible_model_ids IS NOT NULL AND (
      NEW.amount_micros IS DISTINCT FROM OLD.amount_micros
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.metadata->>'creditOfferLabel' IS DISTINCT FROM OLD.metadata->>'creditOfferLabel'
      OR NEW.metadata->>'creditOfferId' IS DISTINCT FROM OLD.metadata->>'creditOfferId'
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
    )) THEN
    RAISE EXCEPTION 'Issued promotional credit terms are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.preserve_credit_grant_scope() FROM PUBLIC;
CREATE TRIGGER preserve_credit_grant_scope BEFORE UPDATE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.preserve_credit_grant_scope();

CREATE TABLE credit_debit_allocations (
  account_id uuid NOT NULL,
  debit_entry_id uuid NOT NULL,
  grant_entry_id uuid NOT NULL,
  amount_micros bigint NOT NULL CONSTRAINT credit_debit_allocations_positive CHECK (amount_micros > 0),
  PRIMARY KEY (debit_entry_id, grant_entry_id),
  FOREIGN KEY (debit_entry_id, account_id) REFERENCES credit_ledger_entries (id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_entry_id, account_id) REFERENCES credit_ledger_entries (id, account_id) ON DELETE CASCADE
);
CREATE INDEX credit_debit_allocations_grant_idx ON credit_debit_allocations (account_id, grant_entry_id);
ALTER TABLE credit_debit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_debit_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_debit_allocations_account_isolation ON credit_debit_allocations
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
REVOKE ALL ON credit_debit_allocations FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON credit_debit_allocations TO opengeni_app;
  END IF;
END $grants$;


-- Runtime policy: one deployment-wide default, with signup/coupon overrides.
-- Revisions stay available so an in-flight call can settle under its admitted policy.
CREATE TABLE opengeni_private.credit_promotion_policy_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy jsonb NOT NULL,
  operator text NOT NULL CHECK (operator = btrim(operator) AND length(operator) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON opengeni_private.credit_promotion_policy_revisions FROM PUBLIC;
CREATE TRIGGER credit_promotion_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON opengeni_private.credit_promotion_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();
CREATE TRIGGER credit_promotion_policy_revisions_no_truncate
  BEFORE TRUNCATE ON opengeni_private.credit_promotion_policy_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE FUNCTION set_credit_promotion_policy(p_policy jsonb, p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
DECLARE
  model_list jsonb;
  offer jsonb;
  written_revision bigint;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object'
    OR NOT p_policy ? 'defaultModelIds'
    OR p_policy - ARRAY['defaultModelIds', 'signupModelIds', 'offers'] <> '{}'::jsonb
    OR (p_policy ? 'offers' AND jsonb_typeof(p_policy->'offers') <> 'object') THEN
    RAISE EXCEPTION 'Policy requires defaultModelIds and optional signupModelIds/offers' USING ERRCODE = '22023';
  END IF;
  FOR offer IN SELECT value FROM jsonb_each(coalesce(p_policy->'offers', '{}'::jsonb)) LOOP
    IF jsonb_typeof(offer) <> 'object'
      OR offer - ARRAY['label', 'eligibleModelIds'] <> '{}'::jsonb
      OR jsonb_typeof(offer->'label') IS DISTINCT FROM 'string'
      OR length(btrim(offer->>'label')) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Invalid credit offer' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR model_list IN
    SELECT p_policy->'defaultModelIds'
    UNION ALL SELECT p_policy->'signupModelIds' WHERE p_policy ? 'signupModelIds'
    UNION ALL SELECT value->'eligibleModelIds'
      FROM jsonb_each(coalesce(p_policy->'offers', '{}'::jsonb)) WHERE value ? 'eligibleModelIds'
  LOOP
    IF jsonb_typeof(model_list) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Model list must be an array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(model_list) NOT BETWEEN 1 AND 40 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(model_list) id
      WHERE jsonb_typeof(id) <> 'string' OR length(btrim(id #>> '{}')) NOT BETWEEN 1 AND 200
        OR id #>> '{}' <> btrim(id #>> '{}')
    ) THEN
      RAISE EXCEPTION 'Model list requires 1-40 canonical model IDs' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- Serializes revision order across simultaneous operator updates.
  PERFORM pg_advisory_xact_lock(hashtextextended('credit-promotion-policy', 0));
  INSERT INTO opengeni_private.credit_promotion_policy_revisions (policy, operator, reason)
    VALUES (p_policy, p_operator, p_reason) RETURNING revision INTO written_revision;
  RETURN written_revision;
END $body$;
REVOKE ALL ON FUNCTION set_credit_promotion_policy(jsonb, text, text) FROM PUBLIC;
DO $policy_acl$
DECLARE grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = 'opengeni_private.credit_promotion_policy_revisions'::regclass AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON opengeni_private.credit_promotion_policy_revisions FROM %I', grantee_name);
  END LOOP;
  FOR grantee_name IN
    SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.oid = 'set_credit_promotion_policy(jsonb,text,text)'::regprocedure AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION set_credit_promotion_policy(jsonb,text,text) FROM %I', grantee_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT ON opengeni_private.credit_promotion_policy_revisions TO opengeni_app;
  END IF;
END $policy_acl$;

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
  model_ids jsonb;
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

  SELECT coalesce(policy->'signupModelIds', policy->'defaultModelIds') INTO model_ids
    FROM opengeni_private.credit_promotion_policy_revisions ORDER BY revision DESC LIMIT 1;
  model_ids := coalesce(model_ids, nullif(pg_catalog.current_setting('opengeni.signup_credit_model_ids', true), '')::jsonb);
  INSERT INTO credit_ledger_entries (
    account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, eligible_model_ids
  ) VALUES (
    NEW.account_id, NULL, 'grant', 10000000, 'verified_signup_trial',
    NEW.auth_user_id, 'verified-signup-trial:v1:' || NEW.auth_user_id,
    pg_catalog.jsonb_build_object('campaign', 'verified_signup_trial_v1',
      'creditOfferLabel', 'Signup credits'),
    CASE WHEN model_ids IS NULL THEN NULL
      ELSE ARRAY(SELECT pg_catalog.jsonb_array_elements_text(model_ids)) END
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
