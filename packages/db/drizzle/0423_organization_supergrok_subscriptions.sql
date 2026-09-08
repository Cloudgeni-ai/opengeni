-- deployment-mode: maintenance
-- Organization SuperGrok pools use the same encrypted credential lifecycle as
-- workspace subscriptions. New accepted work freezes the organization scope;
-- existing workspace/private snapshots never acquire organization authority.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE xai_subscription_credentials ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE xai_rotation_settings ALTER COLUMN workspace_id DROP NOT NULL;

-- Widen the explicit shared scope while retaining all private authority checks.
DO $constraints$
DECLARE item record;
BEGIN
  FOR item IN SELECT c.conname, c.conrelid::regclass relation,
    pg_get_constraintdef(c.oid) definition
    FROM pg_constraint c
    WHERE c.conrelid IN ('xai_subscription_credentials'::regclass,
      'xai_rotation_settings'::regclass, 'xai_credential_leases'::regclass,
      'xai_session_account_pins'::regclass, 'xai_capacity_waiters'::regclass)
      AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%authority_scope%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.relation, item.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.relation, item.conname,
      replace(replace(item.definition,
        '(authority_scope = ''workspace''::text)',
        '(authority_scope IN (''workspace''::text, ''organization''::text))'),
        'ARRAY[''workspace''::text, ''user''::text]',
        'ARRAY[''workspace''::text, ''user''::text, ''organization''::text]'));
  END LOOP;
END
$constraints$;
ALTER TABLE xai_subscription_credentials ADD CONSTRAINT xai_credential_scope_workspace_shape
  CHECK ((authority_scope = 'organization') = (workspace_id IS NULL));
ALTER TABLE xai_rotation_settings ADD CONSTRAINT xai_rotation_scope_workspace_shape
  CHECK ((authority_scope = 'organization') = (workspace_id IS NULL));

DROP INDEX xai_subscription_credentials_provider_identity_uq;
CREATE UNIQUE INDEX xai_subscription_credentials_provider_identity_uq
  ON xai_subscription_credentials(account_id, workspace_id, authority_scope,
    owner_organization_membership_id, provider_account_id) NULLS NOT DISTINCT
  WHERE provider_account_id IS NOT NULL;
DROP INDEX xai_rotation_settings_workspace_pool_uq;
CREATE UNIQUE INDEX xai_rotation_settings_workspace_pool_uq
  ON xai_rotation_settings(account_id, workspace_id, authority_scope,
    owner_organization_membership_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX xai_subscription_credentials_account_identity_uq
  ON xai_subscription_credentials(account_id, id);

-- A credential may be owned by the organization while its leases and pins
-- stay workspace-owned. The trigger below enforces the exact scope/pool tuple.
ALTER TABLE xai_rotation_settings DROP CONSTRAINT xai_rotation_settings_active_credential_fk;
ALTER TABLE xai_rotation_settings ADD CONSTRAINT xai_rotation_settings_active_credential_fk
  FOREIGN KEY (account_id, active_credential_id) REFERENCES xai_subscription_credentials(account_id, id)
  ON DELETE SET NULL (active_credential_id);
ALTER TABLE xai_credential_leases DROP CONSTRAINT xai_credential_leases_credential_fk;
ALTER TABLE xai_credential_leases ADD CONSTRAINT xai_credential_leases_credential_fk
  FOREIGN KEY (account_id, credential_id) REFERENCES xai_subscription_credentials(account_id, id)
  ON DELETE CASCADE;
ALTER TABLE xai_session_account_pins DROP CONSTRAINT xai_session_account_pins_pinned_credential_fk;
ALTER TABLE xai_session_account_pins ADD CONSTRAINT xai_session_account_pins_pinned_credential_fk
  FOREIGN KEY (account_id, pinned_credential_id) REFERENCES xai_subscription_credentials(account_id, id)
  ON DELETE SET NULL (pinned_credential_id);
ALTER TABLE xai_session_account_pins DROP CONSTRAINT xai_session_account_pins_last_credential_fk;
ALTER TABLE xai_session_account_pins ADD CONSTRAINT xai_session_account_pins_last_credential_fk
  FOREIGN KEY (account_id, last_credential_id) REFERENCES xai_subscription_credentials(account_id, id)
  ON DELETE SET NULL (last_credential_id);

-- Reuse the established organization subscription boundary, including Personal
-- workspace inheritance and the exact local administrator exception. Credentials
-- are still provider-specific and are never copied between pools.
CREATE POLICY organization_scope_select ON xai_subscription_credentials FOR SELECT
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id));
CREATE POLICY organization_scope_insert ON xai_subscription_credentials FOR INSERT
  WITH CHECK (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id));
CREATE POLICY organization_scope_update ON xai_subscription_credentials FOR UPDATE
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id)) WITH CHECK (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id));
CREATE POLICY organization_scope_delete ON xai_subscription_credentials FOR DELETE
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id));
CREATE POLICY organization_scope_select ON xai_rotation_settings FOR SELECT
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id));
CREATE POLICY organization_scope_insert ON xai_rotation_settings FOR INSERT
  WITH CHECK (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id));
CREATE POLICY organization_scope_update ON xai_rotation_settings FOR UPDATE
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id)) WITH CHECK (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_scope_visible(account_id));
CREATE POLICY organization_scope_delete ON xai_rotation_settings FOR DELETE
  USING (authority_scope = 'organization' AND workspace_id IS NULL
    AND opengeni_private.codex_organization_admin_visible(account_id));

DO $functions$
DECLARE definition text; before_definition text;
BEGIN
  definition := pg_get_functiondef('xai_provider_account_authority_snapshot_v1_valid(jsonb)'::regprocedure);
  before_definition := definition;
  definition := replace(definition,
    'SELECT snapshot = ''{"version":1,"scope":"workspace"}''::jsonb',
    'SELECT snapshot = ''{"version":1,"scope":"organization"}''::jsonb OR snapshot = ''{"version":1,"scope":"workspace"}''::jsonb');
  IF definition = before_definition THEN RAISE EXCEPTION 'unexpected xAI snapshot validator'; END IF;
  EXECUTE definition;

  definition := pg_get_functiondef('xai_subscription_pool_visible(uuid,uuid,text,text,uuid)'::regprocedure);
  before_definition := definition;
  definition := replace(definition, 'IF p_authority_scope = ''workspace'' THEN',
    'IF p_authority_scope = ''organization'' THEN
      RETURN p_owner_membership_id IS NULL
        AND opengeni_private.codex_organization_scope_visible(p_account_id);
    END IF;
    IF p_authority_scope = ''workspace'' THEN');
  IF definition = before_definition THEN RAISE EXCEPTION 'unexpected xAI pool visibility'; END IF;
  EXECUTE definition;

  definition := pg_get_functiondef('revalidate_xai_subscription_authority(uuid,text,uuid,jsonb)'::regprocedure);
  before_definition := definition;
  definition := replace(definition, 'WHERE credential.workspace_id = p_workspace_id',
    'WHERE (credential.workspace_id = p_workspace_id OR
      (credential.workspace_id IS NULL AND credential.authority_scope = ''organization''))');
  definition := replace(definition, '(p_snapshot ->> ''scope'' = ''workspace''',
    '(p_snapshot ->> ''scope'' = ''organization''
      AND credential.authority_scope = ''organization''
      AND opengeni_private.codex_organization_scope_visible(credential.account_id))
    OR (p_snapshot ->> ''scope'' = ''workspace''');
  IF definition = before_definition THEN RAISE EXCEPTION 'unexpected xAI revalidation'; END IF;
  EXECUTE definition;
END
$functions$;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_xai_organization_runtime_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF OLD.account_id IS DISTINCT FROM NEW.account_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'xAI credential ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.authority_scope <> 'organization'
    OR opengeni_private.codex_organization_admin_visible(OLD.account_id) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'xai_subscription_credentials' THEN
    IF (to_jsonb(NEW) - ARRAY['credential_encrypted','expires_at','last_refresh_at',
      'last_error','status','version','quota_used_percent','quota_reset_at',
      'quota_checked_at','exhausted_until','selection_count','last_selected_at','updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['credential_encrypted','expires_at','last_refresh_at',
      'last_error','status','version','quota_used_percent','quota_reset_at',
      'quota_checked_at','exhausted_until','selection_count','last_selected_at','updated_at']) THEN
      RAISE EXCEPTION 'manage organization subscriptions in organization settings' USING ERRCODE = '42501';
    END IF;
    IF NEW.credential_encrypted IS DISTINCT FROM OLD.credential_encrypted
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.last_refresh_at IS DISTINCT FROM OLD.last_refresh_at
      OR NEW.version IS DISTINCT FROM OLD.version THEN
      IF NEW.credential_encrypted IS NOT DISTINCT FROM OLD.credential_encrypted
        OR NEW.version IS DISTINCT FROM OLD.version + 1
        OR NEW.last_refresh_at IS NULL
        OR NEW.last_refresh_at IS NOT DISTINCT FROM OLD.last_refresh_at
        OR NEW.status IS DISTINCT FROM 'active'
        OR NEW.last_error IS NOT NULL THEN
        RAISE EXCEPTION 'organization SuperGrok token refresh has an invalid mutation shape' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['fairness_cursor','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['fairness_cursor','updated_at']) THEN
      RAISE EXCEPTION 'manage organization subscriptions in organization settings' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER xai_organization_runtime_update_guard BEFORE UPDATE ON xai_subscription_credentials
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_xai_organization_runtime_update();
CREATE TRIGGER xai_organization_rotation_update_guard BEFORE UPDATE ON xai_rotation_settings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_xai_organization_runtime_update();

CREATE FUNCTION opengeni_private.enforce_xai_credential_pool_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE credential_id uuid; column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
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
CREATE TRIGGER xai_rotation_credential_pool_guard BEFORE INSERT OR UPDATE ON xai_rotation_settings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_xai_credential_pool_reference('active_credential_id');
CREATE TRIGGER xai_lease_credential_pool_guard BEFORE INSERT OR UPDATE ON xai_credential_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_xai_credential_pool_reference('credential_id');
CREATE TRIGGER xai_pin_credential_pool_guard BEFORE INSERT OR UPDATE ON xai_session_account_pins
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_xai_credential_pool_reference('pinned_credential_id','last_credential_id');

-- A management disconnect cannot invalidate another workspace's live lease.
CREATE POLICY organization_lease_lifecycle_read ON xai_credential_leases FOR SELECT USING (
  authority_scope = 'organization'
  AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'xai_credential_leases'::regclass))
  AND opengeni_private.codex_organization_admin_visible(account_id)
);
CREATE FUNCTION opengeni_private.prevent_organization_xai_live_disconnect()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF OLD.authority_scope = 'organization' AND EXISTS (
    SELECT 1 FROM xai_credential_leases lease
    WHERE lease.account_id = OLD.account_id AND lease.credential_id = OLD.id AND lease.leased_until > now()
  ) THEN RAISE EXCEPTION 'active turns are using this SuperGrok subscription' USING ERRCODE = '55000'; END IF;
  RETURN OLD;
END
$body$;
CREATE TRIGGER xai_organization_live_disconnect_guard BEFORE DELETE ON xai_subscription_credentials
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_organization_xai_live_disconnect();
