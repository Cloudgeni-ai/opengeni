-- deployment-mode: maintenance
-- Connection policies are additional restrictions, never workspace grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $columns$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['codex_subscription_credentials', 'xai_subscription_credentials',
    'organization_model_provider_connections', 'connections'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN allowed_model_ids text[],
      ADD COLUMN allowed_workspace_ids uuid[],
      ADD COLUMN allow_personal_workspaces boolean NOT NULL DEFAULT true,
      ADD COLUMN access_policy_version integer NOT NULL DEFAULT 1,
      ADD COLUMN access_policy_updated_by text,
      ADD COLUMN access_policy_updated_at timestamptz,
      ADD CONSTRAINT %I CHECK (access_policy_version > 0
        AND coalesce(cardinality(allowed_model_ids), 0) <= 500
        AND coalesce(cardinality(allowed_workspace_ids), 0) <= 500
        AND array_position(allowed_model_ids, NULL) IS NULL
        AND array_position(allowed_workspace_ids, NULL) IS NULL)',
      relation, relation || '_access_policy_shape');
  END LOOP;
END
$columns$;

-- Even a workspace administrator cannot edit an inherited account's policy.
CREATE FUNCTION opengeni_private.enforce_model_connection_access_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF (NEW.allowed_model_ids, NEW.allowed_workspace_ids, NEW.allow_personal_workspaces,
      NEW.access_policy_version, NEW.access_policy_updated_by, NEW.access_policy_updated_at)
    IS NOT DISTINCT FROM
     (OLD.allowed_model_ids, OLD.allowed_workspace_ids, OLD.allow_personal_workspaces,
      OLD.access_policy_version, OLD.access_policy_updated_by, OLD.access_policy_updated_at)
  THEN RETURN NEW; END IF;
  IF (TG_TABLE_NAME = 'organization_model_provider_connections'
      OR to_jsonb(OLD)->>'authority_scope' = 'organization')
    AND NOT opengeni_private.codex_organization_admin_visible(OLD.account_id) THEN
    RAISE EXCEPTION 'organization connection access requires organization administration'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.access_policy_version <> OLD.access_policy_version + 1
    OR NEW.access_policy_updated_by IS DISTINCT FROM current_setting('opengeni.subject_id', true)
    OR nullif(NEW.access_policy_updated_by, '') IS NULL
    OR NEW.access_policy_updated_at IS NULL THEN
    RAISE EXCEPTION 'connection access policy revision required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.enforce_model_connection_access_update() FROM PUBLIC;

DO $guards$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['codex_subscription_credentials', 'xai_subscription_credentials',
    'organization_model_provider_connections', 'connections'] LOOP
    EXECUTE format('CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update()', relation);
  END LOOP;
END
$guards$;

-- Metadata administration keeps its existing authority. Runtime reads must
-- additionally be assigned to the current workspace. No personal inventory is exposed.
DO $policies$
DECLARE relation text; organization_test text; data_schema text := current_schema();
BEGIN
  FOREACH relation IN ARRAY ARRAY['codex_subscription_credentials', 'xai_subscription_credentials',
    'organization_model_provider_connections'] LOOP
    organization_test := CASE WHEN relation = 'organization_model_provider_connections'
      THEN 'true' ELSE 'authority_scope = ''organization''' END;
    EXECUTE format('CREATE POLICY model_connection_workspace_access ON %I AS RESTRICTIVE
      FOR SELECT USING (CASE
        WHEN account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN false
        WHEN NOT (%s) THEN true
        WHEN opengeni_private.current_workspace_id() IS NULL THEN opengeni_private.codex_organization_admin_visible(account_id)
        ELSE CASE WHEN %I.get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = ''personal''
            THEN allow_personal_workspaces
            ELSE allowed_workspace_ids IS NULL OR opengeni_private.current_workspace_id() = ANY(allowed_workspace_ids)
          END END)', relation, organization_test, data_schema);
  END LOOP;
END
$policies$;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_xai_credential_pool_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE credential_id uuid; column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    -- Existing receipts remain history after workspace assignment is revoked.
    -- Check new references; allow unpin/cleanup to preserve an unchanged last account.
    IF TG_OP = 'UPDATE'
      AND (NEW.account_id, NEW.workspace_id, NEW.authority_scope, NEW.owner_organization_membership_id)
        IS NOT DISTINCT FROM
        (OLD.account_id, OLD.workspace_id, OLD.authority_scope, OLD.owner_organization_membership_id)
      AND to_jsonb(NEW)->column_name IS NOT DISTINCT FROM to_jsonb(OLD)->column_name
    THEN CONTINUE; END IF;
    credential_id := (to_jsonb(NEW) ->> column_name)::uuid;
    IF credential_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM xai_subscription_credentials credential
      WHERE credential.id = credential_id AND credential.account_id = NEW.account_id
        AND credential.authority_scope = NEW.authority_scope
        AND credential.owner_organization_membership_id IS NOT DISTINCT FROM NEW.owner_organization_membership_id
        AND ((NEW.authority_scope = 'organization' AND credential.workspace_id IS NULL)
          OR credential.workspace_id = NEW.workspace_id)
    ) THEN
      RAISE EXCEPTION 'xAI credential is outside the authorized account pool' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$body$;
