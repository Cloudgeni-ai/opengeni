-- deployment-mode: maintenance
--
-- Activate organization-owned Codex subscription pools. A shared workspace has
-- exactly one effective pool at a time: its own workspace credentials, the
-- organization's credentials, or disabled. Personal workspaces are always
-- workspace-local. Organization credentials keep one quota/refresh/cooldown
-- row and one allocator serialization point across every inheriting workspace.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

LOCK TABLE "codex_subscription_credentials" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "codex_credential_leases" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "codex_rotation_settings" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN "organization_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;

ALTER TABLE "codex_subscription_credentials"
  ALTER COLUMN "workspace_id" DROP NOT NULL;

ALTER TABLE "codex_subscription_credentials"
  DROP CONSTRAINT "codex_credentials_authority_scope_chk",
  DROP CONSTRAINT "codex_credentials_authority_shape_chk";

ALTER TABLE "codex_subscription_credentials"
  ADD CONSTRAINT "codex_credentials_authority_scope_chk" CHECK (
    "authority_scope" IN ('workspace', 'user', 'organization')
  ),
  ADD CONSTRAINT "codex_credentials_authority_shape_chk" CHECK (
    (
      "authority_scope" = 'workspace'
      AND "workspace_id" IS NOT NULL
      AND "organization_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
      AND "organization_user_resource_authority_id" IS NULL
      AND "organization_user_resource_kind" IS NULL
      AND "organization_user_resource_authority_generation" IS NULL
    ) OR (
      "authority_scope" = 'user'
      AND "workspace_id" IS NOT NULL
      AND "organization_id" IS NULL
      AND "owner_organization_membership_id" IS NOT NULL
      AND "organization_user_resource_authority_id" IS NOT NULL
      AND "organization_user_resource_kind" = 'codex_subscription'
      AND "organization_user_resource_authority_generation" IS NOT NULL
      AND "organization_user_resource_authority_generation" > 0
    ) OR (
      "authority_scope" = 'organization'
      AND "workspace_id" IS NULL
      AND "organization_id" = "account_id"
      AND "owner_organization_membership_id" IS NULL
      AND "organization_user_resource_authority_id" IS NULL
      AND "organization_user_resource_kind" IS NULL
      AND "organization_user_resource_authority_generation" IS NULL
    )
  );

CREATE UNIQUE INDEX "codex_subscription_credentials_organization_account_idx"
  ON "codex_subscription_credentials" ("organization_id", "chatgpt_account_id")
  WHERE "authority_scope" = 'organization' AND "chatgpt_account_id" IS NOT NULL;
CREATE UNIQUE INDEX "codex_subscription_credentials_account_id_idx"
  ON "codex_subscription_credentials" ("account_id", "id");
CREATE INDEX "codex_subscription_credentials_organization_lookup_idx"
  ON "codex_subscription_credentials" ("organization_id", "created_at", "id")
  WHERE "authority_scope" = 'organization';

CREATE TABLE "workspace_codex_subscription_preferences" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'automatic',
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_codex_subscription_preferences_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_codex_subscription_preferences_mode_chk"
    CHECK ("mode" IN ('automatic', 'workspace', 'organization', 'disabled'))
);

ALTER TABLE "workspace_codex_subscription_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_codex_subscription_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_codex_subscription_preferences"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $codex_scope_visibility_schema$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_organization_scope_visible(
      p_account_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      workspace_value uuid := opengeni_private.current_workspace_id();
      subject_value text := opengeni_private.current_subject_id();
      visible boolean := false;
      previous_lifecycle text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
      THEN
        RETURN false;
      END IF;
      IF workspace_value IS NOT NULL THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true
        );
        SELECT EXISTS (
          SELECT 1 FROM %1$I.workspaces workspace
          WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
        ) AND NOT EXISTS (
          SELECT 1 FROM %1$I.organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.personal_workspace_id = workspace_value
        ) INTO visible;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
        );
        RETURN coalesce(visible, false);
      END IF;
      IF subject_value IS NULL OR subject_value NOT LIKE 'user:%%' THEN
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true
      );
      SELECT EXISTS (
        SELECT 1 FROM %1$I.organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = subject_value
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
      ) INTO visible;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RETURN coalesce(visible, false);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RAISE;
    END
    $function$
  $ddl$, data_schema);
END
$codex_scope_visibility_schema$;

CREATE OR REPLACE FUNCTION opengeni_private.codex_organization_admin_visible(
  p_account_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
  SELECT opengeni_private.current_workspace_id() IS NULL
    AND opengeni_private.codex_organization_scope_visible(p_account_id)
$body$;

DROP POLICY workspace_isolation ON "codex_subscription_credentials";
CREATE POLICY workspace_isolation ON "codex_subscription_credentials"
  USING (
    authority_scope IN ('workspace', 'user')
    AND workspace_id IS NOT NULL
    AND opengeni_private.workspace_rls_visible(account_id, workspace_id)
  )
  WITH CHECK (
    authority_scope IN ('workspace', 'user')
    AND workspace_id IS NOT NULL
    AND opengeni_private.workspace_rls_visible(account_id, workspace_id)
  );
CREATE POLICY organization_scope_select ON "codex_subscription_credentials"
  FOR SELECT USING (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.codex_organization_scope_visible(account_id)
  );
CREATE POLICY organization_scope_update_admin ON "codex_subscription_credentials"
  FOR UPDATE USING (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.codex_organization_admin_visible(account_id)
  ) WITH CHECK (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_scope_update_runtime ON "codex_subscription_credentials"
  FOR UPDATE USING (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.current_workspace_id() IS NOT NULL
    AND opengeni_private.codex_organization_scope_visible(account_id)
  ) WITH CHECK (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.current_workspace_id() IS NOT NULL
    AND opengeni_private.codex_organization_scope_visible(account_id)
  );
CREATE POLICY organization_scope_insert ON "codex_subscription_credentials"
  FOR INSERT WITH CHECK (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_scope_delete ON "codex_subscription_credentials"
  FOR DELETE USING (
    authority_scope = 'organization'
    AND organization_id = account_id
    AND opengeni_private.codex_organization_admin_visible(account_id)
  );

-- Shared-workspace runtime paths must refresh tokens and maintain health,
-- quota, cooldown, and fairness metadata on the inherited organization row.
-- RLS selects the exact organization pool; this trigger keeps that runtime
-- exception column- and transition-limited so workspace-context code cannot
-- mutate organization ownership, provider identity, labels, or allocator
-- administration. Organization owner/admin writes run without a workspace GUC
-- and are governed by organization_scope_update_admin instead.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_organization_codex_runtime_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF OLD.authority_scope IS DISTINCT FROM 'organization'
    OR opengeni_private.current_workspace_id() IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
    OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.organization_user_resource_authority_id IS DISTINCT FROM OLD.organization_user_resource_authority_id
    OR NEW.organization_user_resource_kind IS DISTINCT FROM OLD.organization_user_resource_kind
    OR NEW.organization_user_resource_authority_generation IS DISTINCT FROM OLD.organization_user_resource_authority_generation
    OR NEW.chatgpt_account_id IS DISTINCT FROM OLD.chatgpt_account_id
    OR NEW.scopes IS DISTINCT FROM OLD.scopes
    OR NEW.plan_type IS DISTINCT FROM OLD.plan_type
    OR NEW.is_fedramp IS DISTINCT FROM OLD.is_fedramp
    OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.account_email IS DISTINCT FROM OLD.account_email
    OR NEW.allocator_enabled IS DISTINCT FROM OLD.allocator_enabled
    OR NEW.allocator_version IS DISTINCT FROM OLD.allocator_version
    OR NEW.allocator_updated_by_subject_id IS DISTINCT FROM OLD.allocator_updated_by_subject_id
    OR NEW.allocator_updated_at IS DISTINCT FROM OLD.allocator_updated_at
    OR NEW.connected_by_subject_id IS DISTINCT FROM OLD.connected_by_subject_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'organization Codex credential management requires organization administration'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.credential_encrypted IS DISTINCT FROM OLD.credential_encrypted
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.last_refresh_at IS DISTINCT FROM OLD.last_refresh_at
    OR NEW.version IS DISTINCT FROM OLD.version
  THEN
    IF NEW.credential_encrypted IS NOT DISTINCT FROM OLD.credential_encrypted
      OR NEW.version IS DISTINCT FROM OLD.version + 1
      OR NEW.last_refresh_at IS NULL
      OR NEW.last_refresh_at IS NOT DISTINCT FROM OLD.last_refresh_at
      OR NEW.status IS DISTINCT FROM 'active'
      OR NEW.last_error IS NOT NULL
      OR NEW.primary_used_percent IS DISTINCT FROM OLD.primary_used_percent
      OR NEW.primary_reset_at IS DISTINCT FROM OLD.primary_reset_at
      OR NEW.secondary_used_percent IS DISTINCT FROM OLD.secondary_used_percent
      OR NEW.secondary_reset_at IS DISTINCT FROM OLD.secondary_reset_at
      OR NEW.usage_checked_at IS DISTINCT FROM OLD.usage_checked_at
      OR NEW.exhausted_until IS DISTINCT FROM OLD.exhausted_until
      OR NEW.reset_credit_available_count IS DISTINCT FROM OLD.reset_credit_available_count
      OR NEW.reset_credits_checked_at IS DISTINCT FROM OLD.reset_credits_checked_at
      OR NEW.selection_count IS DISTINCT FROM OLD.selection_count
      OR NEW.last_selected_at IS DISTINCT FROM OLD.last_selected_at
    THEN
      RAISE EXCEPTION 'organization Codex runtime token refresh has an invalid mutation shape'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$body$;

CREATE TABLE "organization_codex_rotation_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "active_credential_id" uuid,
  "rotation_enabled" boolean NOT NULL DEFAULT false,
  "lease_rotation_enabled" boolean NOT NULL DEFAULT false,
  "rotation_strategy" text NOT NULL DEFAULT 'sharded',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_codex_rotation_settings_active_fk"
    FOREIGN KEY ("active_credential_id")
    REFERENCES "codex_subscription_credentials"("id")
    ON DELETE SET NULL
);
CREATE UNIQUE INDEX "organization_codex_rotation_settings_account_idx"
  ON "organization_codex_rotation_settings" ("account_id");

ALTER TABLE "organization_codex_rotation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_codex_rotation_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON "organization_codex_rotation_settings"
  USING (opengeni_private.codex_organization_scope_visible(account_id))
  WITH CHECK (opengeni_private.codex_organization_scope_visible(account_id));

CREATE OR REPLACE FUNCTION resolve_workspace_codex_subscription_source(
  p_account_id uuid,
  p_workspace_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $body$
DECLARE
  mode_value text := 'automatic';
  workspace_kind text;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'Codex workspace source authority required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  workspace_kind := get_workspace_kind(p_account_id, p_workspace_id);
  IF workspace_kind = 'personal' THEN
    RETURN 'workspace';
  END IF;
  SELECT preference.mode INTO mode_value
  FROM workspace_codex_subscription_preferences preference
  WHERE preference.account_id = p_account_id
    AND preference.workspace_id = p_workspace_id;
  mode_value := coalesce(mode_value, 'automatic');
  IF mode_value <> 'automatic' THEN
    RETURN mode_value;
  END IF;
  IF EXISTS (
    SELECT 1 FROM codex_subscription_credentials credential
    WHERE credential.account_id = p_account_id
      AND credential.workspace_id = p_workspace_id
      AND credential.authority_scope IN ('workspace', 'user')
  ) THEN
    RETURN 'workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM codex_subscription_credentials credential
    WHERE credential.account_id = p_account_id
      AND credential.organization_id = p_account_id
      AND credential.authority_scope = 'organization'
  ) THEN
    RETURN 'organization';
  END IF;
  RETURN 'workspace';
END
$body$;

CREATE OR REPLACE FUNCTION validate_personal_codex_credential_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE exact_authority boolean;
BEGIN
  IF NEW.authority_scope IN ('workspace', 'organization') THEN
    RETURN NEW;
  END IF;
  SELECT true INTO exact_authority
  FROM organization_memberships membership
  INNER JOIN organization_user_resource_authorities authority
    ON authority.id = NEW.organization_user_resource_authority_id
   AND authority.account_id = membership.account_id
   AND authority.organization_membership_id = membership.id
  WHERE membership.id = NEW.owner_organization_membership_id
    AND membership.account_id = NEW.account_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND authority.resource_kind = 'codex_subscription'
    AND authority.resource_id = NEW.id
    AND authority.generation = NEW.organization_user_resource_authority_generation
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR KEY SHARE OF membership, authority;
  IF exact_authority IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'personal Codex credential authority tuple is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$body$;

-- Organization credentials may serve turns in many workspaces. Keep the turn
-- workspace FK, but validate the credential/source relation in a trigger.
ALTER TABLE "codex_credential_leases"
  DROP CONSTRAINT "codex_credential_leases_workspace_credential_fk";
ALTER TABLE "codex_credential_leases"
  ADD CONSTRAINT "codex_credential_leases_account_credential_fk"
    FOREIGN KEY ("account_id", "credential_id")
    REFERENCES "codex_subscription_credentials"("account_id", "id")
    ON DELETE CASCADE;
DROP INDEX "codex_credential_leases_active_credential_idx";
CREATE INDEX "codex_credential_leases_active_credential_idx"
  ON "codex_credential_leases" ("credential_id", "leased_until");

DO $codex_reference_guards$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_credential_serves_workspace(
      p_account_id uuid,
      p_workspace_id uuid,
      p_credential_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    DECLARE credential codex_subscription_credentials%%ROWTYPE;
    BEGIN
      SELECT * INTO credential
      FROM codex_subscription_credentials candidate
      WHERE candidate.account_id = p_account_id AND candidate.id = p_credential_id;
      IF NOT FOUND THEN RETURN false; END IF;
      IF credential.authority_scope IN ('workspace', 'user') THEN
        RETURN credential.workspace_id = p_workspace_id
          AND resolve_workspace_codex_subscription_source(p_account_id, p_workspace_id) = 'workspace';
      END IF;
      RETURN credential.authority_scope = 'organization'
        AND credential.organization_id = p_account_id
        AND resolve_workspace_codex_subscription_source(p_account_id, p_workspace_id) = 'organization';
    END
    $function$;

    CREATE OR REPLACE FUNCTION opengeni_private.enforce_codex_lease_source()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    BEGIN
      IF NOT opengeni_private.codex_credential_serves_workspace(
        NEW.account_id, NEW.workspace_id, NEW.credential_id
      ) THEN
        RAISE EXCEPTION 'Codex credential is outside the workspace effective pool'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE OR REPLACE FUNCTION opengeni_private.enforce_codex_credential_workspace()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    DECLARE candidate uuid;
    BEGIN
      IF TG_TABLE_NAME = 'codex_rotation_settings' THEN
        candidate := NEW.active_credential_id;
        IF candidate IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM codex_subscription_credentials credential
          WHERE credential.id = candidate
            AND credential.account_id = NEW.account_id
            AND credential.workspace_id = NEW.workspace_id
            AND credential.authority_scope IN ('workspace', 'user')
        ) THEN
          RAISE EXCEPTION 'Codex rotation credential must remain workspace-owned'
            USING ERRCODE = '23514';
        END IF;
      ELSIF TG_TABLE_NAME = 'organization_codex_rotation_settings' THEN
        candidate := NEW.active_credential_id;
        IF candidate IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM codex_subscription_credentials credential
          WHERE credential.id = candidate
            AND credential.account_id = NEW.account_id
            AND credential.organization_id = NEW.account_id
            AND credential.authority_scope = 'organization'
        ) THEN
          RAISE EXCEPTION 'Codex rotation credential must remain organization-owned'
            USING ERRCODE = '23514';
        END IF;
      ELSIF TG_ARGV[0] = 'pinned' THEN
        candidate := NEW.codex_pinned_credential_id;
      ELSE
        candidate := NEW.codex_last_credential_id;
      END IF;
      IF candidate IS NULL OR TG_TABLE_NAME IN (
        'codex_rotation_settings', 'organization_codex_rotation_settings'
      ) THEN
        RETURN NEW;
      END IF;
      IF NOT opengeni_private.codex_credential_serves_workspace(
        NEW.account_id, NEW.workspace_id, candidate
      ) THEN
        RAISE EXCEPTION 'Codex session credential is outside the workspace effective pool'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE OR REPLACE FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I
    AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM codex_credential_leases lease
        WHERE lease.account_id = OLD.account_id
          AND lease.credential_id = OLD.id
          AND lease.leased_until > now()
      ) THEN
        RAISE EXCEPTION 'Codex subscription cannot disconnect while active turns are using it'
          USING ERRCODE = '55006';
      END IF;
      RETURN OLD;
    END
    $function$;
  $ddl$, data_schema);
END
$codex_reference_guards$;

DROP TRIGGER codex_credentials_validate_user_authority_trg
  ON "codex_subscription_credentials";
CREATE TRIGGER codex_credentials_validate_user_authority_trg
BEFORE INSERT OR UPDATE OF
  id, account_id, workspace_id, organization_id, authority_scope,
  owner_organization_membership_id, organization_user_resource_authority_id,
  organization_user_resource_kind, organization_user_resource_authority_generation
ON "codex_subscription_credentials"
FOR EACH ROW EXECUTE FUNCTION validate_personal_codex_credential_authority();

CREATE TRIGGER codex_credentials_organization_runtime_update_guard
BEFORE UPDATE ON "codex_subscription_credentials"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_codex_runtime_update();

CREATE TRIGGER codex_credentials_organization_live_lease_disconnect_guard
BEFORE DELETE ON "codex_subscription_credentials"
FOR EACH ROW WHEN (OLD.authority_scope = 'organization')
EXECUTE FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases();

CREATE TRIGGER codex_credential_leases_source_guard
BEFORE INSERT OR UPDATE OF account_id, workspace_id, credential_id
ON "codex_credential_leases"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_lease_source();

CREATE TRIGGER organization_codex_rotation_settings_credential_guard
BEFORE INSERT OR UPDATE OF active_credential_id, account_id
ON "organization_codex_rotation_settings"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace();

CREATE OR REPLACE FUNCTION opengeni_private.clear_workspace_codex_session_affinity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  UPDATE sessions
  SET codex_pinned_credential_id = NULL,
      codex_pin_source = NULL,
      codex_last_credential_id = NULL,
      updated_at = now()
  WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
    AND (codex_pinned_credential_id IS NOT NULL OR codex_last_credential_id IS NOT NULL);
  RETURN NEW;
END
$body$;
CREATE TRIGGER workspace_codex_subscription_preference_affinity_reset
AFTER INSERT OR UPDATE OF mode ON "workspace_codex_subscription_preferences"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.clear_workspace_codex_session_affinity();

-- Organization credentials are intentionally excluded from workspace Apps and
-- reset-credit mutation authority. Those existing composite FKs still require
-- a non-null matching workspace_id.

DO $organization_codex_grants$
DECLARE data_schema text := current_schema();
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.codex_organization_scope_visible(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.codex_organization_admin_visible(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.enforce_organization_codex_runtime_update() FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases()
    FROM PUBLIC;
  REVOKE ALL ON FUNCTION resolve_workspace_codex_subscription_source(uuid,uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.codex_credential_serves_workspace(uuid,uuid,uuid)
    FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %1$I.workspace_codex_subscription_preferences, %1$I.organization_codex_rotation_settings TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %1$I.resolve_workspace_codex_subscription_source(uuid,uuid) TO opengeni_app',
      data_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.codex_organization_scope_visible(uuid)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.codex_organization_admin_visible(uuid)
      TO opengeni_app;
  END IF;
END
$organization_codex_grants$;

COMMENT ON COLUMN "codex_subscription_credentials"."organization_id" IS
  'Organization owner for authority_scope=organization; workspace_id is null for these rows.';
COMMENT ON TABLE "workspace_codex_subscription_preferences" IS
  'One effective Codex source per workspace. Absent means automatic; personal workspaces remain local.';
COMMENT ON TABLE "organization_codex_rotation_settings" IS
  'Organization-wide Codex allocator serialization point and active cursor.';
