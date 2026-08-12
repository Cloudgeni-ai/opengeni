-- deployment-mode: rolling
-- Add explicit workspace/user xAI subscription authority, encrypted multi-account
-- persistence, exact-turn leases, session pins, quota/cooldown metadata, durable
-- capacity waiters, and immutable identifier-free acceptance snapshots. This
-- migration activates no API, worker, SDK, or provider transport implementation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.xai_subscription_runtime_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "xai_subscription_runtime_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('lifecycle', 'resolve')
  ),
  CONSTRAINT "xai_subscription_runtime_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.xai_subscription_runtime_capabilities FROM PUBLIC;

DO $xai_capability_revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.xai_subscription_runtime_capabilities
      FROM opengeni_app;
  END IF;
END
$xai_capability_revoke$;

CREATE UNIQUE INDEX IF NOT EXISTS "organization_user_resource_authorities_xai_tuple_uq"
  ON "organization_user_resource_authorities" (
    "id", "account_id", "organization_membership_id", "resource_kind",
    "resource_id", "generation"
  );

-- Add a separate permissive policy used only by the exact xAI SECURITY DEFINER
-- routines. Existing organization-tenancy lifecycle/resource policies remain
-- intact, so this is compatible with either protected main or PR #1373 first.
DROP POLICY IF EXISTS xai_subscription_capability_read ON "organization_memberships";
CREATE POLICY xai_subscription_capability_read ON "organization_memberships"
  FOR SELECT USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relation.relowner FROM pg_catalog.pg_class relation
       WHERE relation.oid = 'organization_memberships'::pg_catalog.regclass)
    )
    AND EXISTS (
      SELECT 1 FROM opengeni_private.xai_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('lifecycle', 'resolve')
    )
  );

DROP POLICY IF EXISTS xai_subscription_capability_read
  ON "organization_user_resource_authorities";
CREATE POLICY xai_subscription_capability_read ON "organization_user_resource_authorities"
  FOR SELECT USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relation.relowner FROM pg_catalog.pg_class relation
       WHERE relation.oid = 'organization_user_resource_authorities'::pg_catalog.regclass)
    )
    AND EXISTS (
      SELECT 1 FROM opengeni_private.xai_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('lifecycle', 'resolve')
    )
  );

DROP POLICY IF EXISTS xai_subscription_capability_insert
  ON "organization_user_resource_authorities";
CREATE POLICY xai_subscription_capability_insert ON "organization_user_resource_authorities"
  FOR INSERT WITH CHECK (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relation.relowner FROM pg_catalog.pg_class relation
       WHERE relation.oid = 'organization_user_resource_authorities'::pg_catalog.regclass)
    )
    AND EXISTS (
      SELECT 1 FROM opengeni_private.xai_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle'
    )
  );

CREATE TABLE "xai_subscription_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credential_encrypted" text NOT NULL,
  "provider_account_id" text,
  "label" text,
  "account_email" text,
  "plan_type" text,
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamptz,
  "last_refresh_at" timestamptz,
  "last_error" text,
  "version" integer NOT NULL DEFAULT 1,
  "allocator_enabled" boolean NOT NULL DEFAULT true,
  "allocator_version" integer NOT NULL DEFAULT 1,
  "quota_used_percent" integer,
  "quota_reset_at" timestamptz,
  "quota_checked_at" timestamptz,
  "exhausted_until" timestamptz,
  "selection_count" integer NOT NULL DEFAULT 0,
  "last_selected_at" timestamptz,
  "authority_scope" text NOT NULL DEFAULT 'workspace',
  "owner_organization_membership_id" uuid,
  "organization_user_resource_authority_id" uuid,
  "organization_user_resource_kind" text,
  "organization_user_resource_authority_generation" bigint,
  "connected_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xai_subscription_credentials_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "xai_subscription_credentials_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "xai_subscription_credentials_user_authority_fk"
    FOREIGN KEY (
      "organization_user_resource_authority_id", "account_id",
      "owner_organization_membership_id", "organization_user_resource_kind",
      "id", "organization_user_resource_authority_generation"
    ) REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id", "resource_kind",
      "resource_id", "generation"
    ) ON DELETE RESTRICT,
  CONSTRAINT "xai_subscription_credentials_authority_scope_chk" CHECK (
    "authority_scope" IN ('workspace', 'user')
  ),
  CONSTRAINT "xai_subscription_credentials_authority_shape_chk" CHECK (
    (
      "authority_scope" = 'workspace'
      AND "owner_organization_membership_id" IS NULL
      AND "organization_user_resource_authority_id" IS NULL
      AND "organization_user_resource_kind" IS NULL
      AND "organization_user_resource_authority_generation" IS NULL
    ) OR (
      "authority_scope" = 'user'
      AND "owner_organization_membership_id" IS NOT NULL
      AND "organization_user_resource_authority_id" IS NOT NULL
      AND "organization_user_resource_kind" = 'xai_subscription'
      AND "organization_user_resource_authority_generation" > 0
    )
  ),
  CONSTRAINT "xai_subscription_credentials_status_chk" CHECK (
    "status" IN ('active', 'needs_relogin', 'error', 'disabled')
  ),
  CONSTRAINT "xai_subscription_credentials_versions_chk" CHECK (
    "version" > 0 AND "allocator_version" > 0
  ),
  CONSTRAINT "xai_subscription_credentials_quota_chk" CHECK (
    "quota_used_percent" IS NULL OR "quota_used_percent" BETWEEN 0 AND 100
  ),
  CONSTRAINT "xai_subscription_credentials_selection_chk" CHECK (
    "selection_count" >= 0
  ),
  CONSTRAINT "xai_subscription_credentials_subject_chk" CHECK (
    "connected_by_subject_id" IS NULL
    OR length(btrim("connected_by_subject_id")) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "xai_subscription_credentials_workspace_id_uq"
  ON "xai_subscription_credentials" ("workspace_id", "id");
CREATE UNIQUE INDEX "xai_subscription_credentials_workspace_account_id_uq"
  ON "xai_subscription_credentials" ("workspace_id", "account_id", "id");
CREATE UNIQUE INDEX "xai_subscription_credentials_provider_identity_uq"
  ON "xai_subscription_credentials" (
    "workspace_id", "authority_scope", "owner_organization_membership_id",
    "provider_account_id"
  ) WHERE "provider_account_id" IS NOT NULL;
CREATE INDEX "xai_subscription_credentials_workspace_status_idx"
  ON "xai_subscription_credentials" ("workspace_id", "status", "allocator_enabled");

CREATE TABLE "xai_rotation_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "authority_scope" text NOT NULL DEFAULT 'workspace',
  "owner_organization_membership_id" uuid,
  "active_credential_id" uuid,
  "rotation_enabled" boolean NOT NULL DEFAULT true,
  "fairness_cursor" bigint NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xai_rotation_settings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "xai_rotation_settings_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "xai_rotation_settings_active_credential_fk"
    FOREIGN KEY ("workspace_id", "account_id", "active_credential_id")
    REFERENCES "xai_subscription_credentials"("workspace_id", "account_id", "id")
    ON DELETE SET NULL ("active_credential_id"),
  CONSTRAINT "xai_rotation_settings_scope_chk" CHECK (
    ("authority_scope" = 'workspace' AND "owner_organization_membership_id" IS NULL)
    OR ("authority_scope" = 'user' AND "owner_organization_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "xai_rotation_settings_counters_chk" CHECK (
    "fairness_cursor" >= 0 AND "version" > 0
  )
);
CREATE UNIQUE INDEX "xai_rotation_settings_workspace_pool_uq"
  ON "xai_rotation_settings" (
    "workspace_id", "authority_scope", "owner_organization_membership_id"
  );

CREATE TABLE "xai_credential_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "authority_scope" text NOT NULL,
  "owner_organization_membership_id" uuid,
  "credential_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "holder_id" text NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "leased_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xai_credential_leases_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "xai_credential_leases_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "xai_credential_leases_credential_fk"
    FOREIGN KEY ("workspace_id", "account_id", "credential_id")
    REFERENCES "xai_subscription_credentials"("workspace_id", "account_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "xai_credential_leases_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "xai_credential_leases_scope_chk" CHECK (
    ("authority_scope" = 'workspace' AND "owner_organization_membership_id" IS NULL)
    OR ("authority_scope" = 'user' AND "owner_organization_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "xai_credential_leases_generation_chk" CHECK ("generation" > 0),
  CONSTRAINT "xai_credential_leases_holder_chk" CHECK (
    length(btrim("holder_id")) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "xai_credential_leases_workspace_turn_uq"
  ON "xai_credential_leases" ("workspace_id", "turn_id");
CREATE INDEX "xai_credential_leases_active_credential_idx"
  ON "xai_credential_leases" ("workspace_id", "credential_id", "leased_until");
CREATE INDEX "xai_credential_leases_expiry_idx"
  ON "xai_credential_leases" ("leased_until");

CREATE TABLE "xai_session_account_pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "authority_scope" text NOT NULL DEFAULT 'workspace',
  "owner_organization_membership_id" uuid,
  "pinned_credential_id" uuid,
  "pin_source" text,
  "last_credential_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xai_session_account_pins_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "xai_session_account_pins_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "xai_session_account_pins_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "xai_session_account_pins_pinned_credential_fk"
    FOREIGN KEY ("workspace_id", "account_id", "pinned_credential_id")
    REFERENCES "xai_subscription_credentials"("workspace_id", "account_id", "id")
    ON DELETE SET NULL ("pinned_credential_id"),
  CONSTRAINT "xai_session_account_pins_last_credential_fk"
    FOREIGN KEY ("workspace_id", "account_id", "last_credential_id")
    REFERENCES "xai_subscription_credentials"("workspace_id", "account_id", "id")
    ON DELETE SET NULL ("last_credential_id"),
  CONSTRAINT "xai_session_account_pins_scope_chk" CHECK (
    ("authority_scope" = 'workspace' AND "owner_organization_membership_id" IS NULL)
    OR ("authority_scope" = 'user' AND "owner_organization_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "xai_session_account_pins_pin_chk" CHECK (
    ("pinned_credential_id" IS NULL AND "pin_source" IS NULL)
    OR ("pinned_credential_id" IS NOT NULL AND "pin_source" IN ('manual', 'policy'))
  ),
  CONSTRAINT "xai_session_account_pins_version_chk" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "xai_session_account_pins_workspace_session_uq"
  ON "xai_session_account_pins" ("workspace_id", "session_id");

CREATE TABLE "xai_capacity_waiters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "blocked_turn_id" uuid NOT NULL,
  "blocked_turn_generation" integer NOT NULL,
  "workflow_id" text NOT NULL,
  "authority_scope" text NOT NULL,
  "owner_organization_membership_id" uuid,
  "status" text NOT NULL DEFAULT 'waiting',
  "generation" integer NOT NULL DEFAULT 1,
  "earliest_reset_at" timestamptz,
  "next_check_at" timestamptz NOT NULL,
  "wake_revision" integer NOT NULL DEFAULT 1,
  "observed_wake_revision" integer NOT NULL DEFAULT 0,
  "last_wake_reason" text NOT NULL DEFAULT 'capacity_wait_armed',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xai_capacity_waiters_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "xai_capacity_waiters_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "xai_capacity_waiters_turn_fk"
    FOREIGN KEY ("workspace_id", "blocked_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "xai_capacity_waiters_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "xai_capacity_waiters_scope_chk" CHECK (
    ("authority_scope" = 'workspace' AND "owner_organization_membership_id" IS NULL)
    OR ("authority_scope" = 'user' AND "owner_organization_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "xai_capacity_waiters_status_chk" CHECK (
    "status" IN ('waiting', 'resumed', 'superseded')
  ),
  CONSTRAINT "xai_capacity_waiters_counters_chk" CHECK (
    "blocked_turn_generation" >= 0 AND "generation" > 0
    AND "wake_revision" > 0 AND "observed_wake_revision" >= 0
    AND "observed_wake_revision" <= "wake_revision"
  ),
  CONSTRAINT "xai_capacity_waiters_workflow_chk" CHECK (
    length(btrim("workflow_id")) BETWEEN 1 AND 1024
    AND length(btrim("last_wake_reason")) BETWEEN 1 AND 256
  )
);
CREATE UNIQUE INDEX "xai_capacity_waiters_workspace_session_uq"
  ON "xai_capacity_waiters" ("workspace_id", "session_id");
CREATE INDEX "xai_capacity_waiters_pending_idx"
  ON "xai_capacity_waiters" ("workspace_id", "status", "next_check_at");

DO $xai_authority_functions$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.xai_provider_account_authority_snapshot_v1_valid(
      snapshot jsonb
    ) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $body$
      SELECT snapshot = '{"version":1,"scope":"workspace"}'::jsonb
        OR (
          jsonb_typeof(snapshot) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(snapshot)) = 3
          AND snapshot ?& ARRAY['version', 'scope', 'authorityGeneration']
          AND snapshot -> 'version' = '1'::jsonb
          AND snapshot ->> 'scope' = 'user'
          AND jsonb_typeof(snapshot -> 'authorityGeneration') = 'number'
          AND snapshot ->> 'authorityGeneration' ~ '^[1-9][0-9]*$'
          AND (snapshot ->> 'authorityGeneration')::numeric <= 9007199254740991
        )
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.xai_subscription_authority_live(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_credential_id uuid,
      p_authority_scope text,
      p_owner_membership_id uuid,
      p_authority_id uuid,
      p_authority_generation bigint
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE exact_count integer;
    BEGIN
      IF p_authority_scope = 'workspace' THEN
        RETURN p_owner_membership_id IS NULL
          AND p_authority_id IS NULL
          AND p_authority_generation IS NULL;
      END IF;
      IF p_authority_scope <> 'user' OR p_subject_id IS NULL THEN RETURN false; END IF;
      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;
      SELECT count(*) INTO exact_count
      FROM organization_memberships membership
      INNER JOIN workspace_memberships workspace_grant
        ON workspace_grant.account_id = membership.account_id
       AND workspace_grant.subject_id = membership.subject_id
       AND workspace_grant.workspace_id = p_workspace_id
      INNER JOIN organization_user_resource_authorities authority
        ON authority.account_id = membership.account_id
       AND authority.organization_membership_id = membership.id
      WHERE membership.id = p_owner_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = p_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND authority.id = p_authority_id
        AND authority.resource_kind = 'xai_subscription'
        AND authority.resource_id = p_credential_id
        AND authority.generation = p_authority_generation
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL;
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN exact_count = 1;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.xai_subscription_pool_visible(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_authority_scope text,
      p_owner_membership_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE exact_count integer;
    BEGIN
      IF p_authority_scope = 'workspace' THEN
        RETURN p_owner_membership_id IS NULL;
      END IF;
      IF p_authority_scope <> 'user' OR p_subject_id IS NULL THEN RETURN false; END IF;
      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;
      SELECT count(*) INTO exact_count
      FROM organization_memberships membership
      INNER JOIN workspace_memberships workspace_grant
        ON workspace_grant.account_id = membership.account_id
       AND workspace_grant.subject_id = membership.subject_id
       AND workspace_grant.workspace_id = p_workspace_id
      WHERE membership.id = p_owner_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = p_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL;
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN exact_count = 1;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.create_xai_subscription_credential(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_authority_scope text,
      p_credential_encrypted text,
      p_provider_account_id text,
      p_label text,
      p_account_email text,
      p_plan_type text,
      p_expires_at timestamptz
    ) RETURNS TABLE (credential_id uuid, authority_generation bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      membership_row record;
      created_credential_id uuid := gen_random_uuid();
      authority_row record;
    BEGIN
      IF p_account_id IS DISTINCT FROM NULLIF(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM NULLIF(current_setting('opengeni.subject_id', true), '')
        OR p_authority_scope NOT IN ('workspace', 'user')
        OR p_credential_encrypted IS NULL
        OR length(p_credential_encrypted) < 1
      THEN
        RAISE EXCEPTION 'xAI credential lifecycle authority denied' USING ERRCODE = '42501';
      END IF;
      IF NOT opengeni_private.workspace_rls_visible(p_account_id, p_workspace_id) THEN
        RAISE EXCEPTION 'xAI credential workspace authority denied' USING ERRCODE = '42501';
      END IF;

      IF p_authority_scope = 'workspace' THEN
        INSERT INTO xai_subscription_credentials (
          id, account_id, workspace_id, credential_encrypted,
          provider_account_id, label, account_email, plan_type, expires_at,
          authority_scope, connected_by_subject_id
        ) VALUES (
          created_credential_id, p_account_id, p_workspace_id, p_credential_encrypted,
          p_provider_account_id, p_label, p_account_email, p_plan_type, p_expires_at,
          'workspace', p_subject_id
        );
        credential_id := created_credential_id;
        authority_generation := NULL;
        RETURN NEXT;
        RETURN;
      END IF;

      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle');
      SELECT membership.id INTO membership_row
      FROM organization_memberships membership
      INNER JOIN workspace_memberships workspace_grant
        ON workspace_grant.account_id = membership.account_id
       AND workspace_grant.subject_id = membership.subject_id
       AND workspace_grant.workspace_id = p_workspace_id
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR UPDATE OF membership;
      IF membership_row.id IS NULL THEN
        RAISE EXCEPTION 'active organization membership and workspace grant required'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id
      ) VALUES (
        p_account_id, membership_row.id, 'xai_subscription', created_credential_id,
        p_workspace_id
      ) RETURNING id, generation INTO authority_row;

      INSERT INTO xai_subscription_credentials (
        id, account_id, workspace_id, credential_encrypted,
        provider_account_id, label, account_email, plan_type, expires_at,
        authority_scope, owner_organization_membership_id,
        organization_user_resource_authority_id, organization_user_resource_kind,
        organization_user_resource_authority_generation, connected_by_subject_id
      ) VALUES (
        created_credential_id, p_account_id, p_workspace_id, p_credential_encrypted,
        p_provider_account_id, p_label, p_account_email, p_plan_type, p_expires_at,
        'user', membership_row.id, authority_row.id, 'xai_subscription',
        authority_row.generation, p_subject_id
      );
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      credential_id := created_credential_id;
      authority_generation := authority_row.generation;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.resolve_xai_authority_pool(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_snapshot jsonb
    ) RETURNS TABLE (organization_membership_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE snapshot_generation bigint;
    BEGIN
      IF NOT xai_provider_account_authority_snapshot_v1_valid(p_snapshot)
        OR p_snapshot ->> 'scope' <> 'user'
        OR p_account_id IS DISTINCT FROM NULLIF(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM NULLIF(current_setting('opengeni.subject_id', true), '')
      THEN RETURN; END IF;
      snapshot_generation := (p_snapshot ->> 'authorityGeneration')::bigint;
      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;
      RETURN QUERY
      SELECT membership.id
      FROM organization_memberships membership
      INNER JOIN workspace_memberships workspace_grant
        ON workspace_grant.account_id = membership.account_id
       AND workspace_grant.subject_id = membership.subject_id
       AND workspace_grant.workspace_id = p_workspace_id
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM organization_user_resource_authorities authority
          WHERE authority.account_id = membership.account_id
            AND authority.organization_membership_id = membership.id
            AND authority.resource_kind = 'xai_subscription'
            AND authority.generation = snapshot_generation
            AND authority.status = 'active'
            AND authority.revoked_at IS NULL
        );
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.revalidate_xai_subscription_authority(
      p_workspace_id uuid,
      p_subject_id text,
      p_credential_id uuid,
      p_snapshot jsonb
    ) RETURNS TABLE (id uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT credential.id
      FROM xai_subscription_credentials credential
      WHERE credential.workspace_id = p_workspace_id
        AND credential.id = p_credential_id
        AND credential.status = 'active'
        AND xai_provider_account_authority_snapshot_v1_valid(p_snapshot)
        AND (
          (p_snapshot ->> 'scope' = 'workspace'
            AND credential.authority_scope = 'workspace')
          OR
          (p_snapshot ->> 'scope' = 'user'
            AND credential.authority_scope = 'user'
            AND credential.organization_user_resource_authority_generation =
              (p_snapshot ->> 'authorityGeneration')::bigint
            AND xai_subscription_authority_live(
              credential.account_id, credential.workspace_id, p_subject_id,
              credential.id, credential.authority_scope,
              credential.owner_organization_membership_id,
              credential.organization_user_resource_authority_id,
              credential.organization_user_resource_authority_generation
            ))
        )
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.disconnect_xai_subscription_credential(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_credential_id uuid,
      p_snapshot jsonb
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      credential_row record;
    BEGIN
      IF p_account_id IS DISTINCT FROM NULLIF(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM NULLIF(current_setting('opengeni.subject_id', true), '')
      THEN
        RAISE EXCEPTION 'xAI credential lifecycle authority denied' USING ERRCODE = '42501';
      END IF;

      SELECT credential.* INTO credential_row
      FROM revalidate_xai_subscription_authority(
        p_workspace_id, p_subject_id, p_credential_id, p_snapshot
      ) authorized
      INNER JOIN xai_subscription_credentials credential ON credential.id = authorized.id
      FOR UPDATE OF credential;
      IF credential_row.id IS NULL THEN RETURN false; END IF;

      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle')
      ON CONFLICT DO NOTHING;

      DELETE FROM xai_subscription_credentials WHERE id = credential_row.id;
      IF credential_row.authority_scope = 'user' THEN
        UPDATE organization_user_resource_authorities
        SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE id = credential_row.organization_user_resource_authority_id
          AND account_id = credential_row.account_id
          AND organization_membership_id = credential_row.owner_organization_membership_id
          AND resource_kind = 'xai_subscription'
          AND resource_id = credential_row.id
          AND generation = credential_row.organization_user_resource_authority_generation;
      END IF;

      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$xai_authority_functions$;

-- Exact-subject RLS for user pools. Workspace scope preserves the default
-- shared behavior for any caller with the ordinary workspace grant.
DO $xai_rls$
DECLARE
  data_schema text := current_schema();
  table_name text;
  policy_expression text;
BEGIN
  ALTER TABLE "xai_subscription_credentials" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "xai_subscription_credentials" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "xai_rotation_settings" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "xai_rotation_settings" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "xai_credential_leases" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "xai_credential_leases" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "xai_session_account_pins" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "xai_session_account_pins" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "xai_capacity_waiters" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "xai_capacity_waiters" FORCE ROW LEVEL SECURITY;

  EXECUTE format($policy$
    CREATE POLICY xai_subscription_scope ON %1$I.xai_subscription_credentials
    USING (
      opengeni_private.workspace_rls_visible(account_id, workspace_id)
      AND (
        authority_scope = 'workspace'
        OR %1$I.xai_subscription_authority_live(
          account_id, workspace_id,
          NULLIF(current_setting('opengeni.subject_id', true), ''),
          id, authority_scope, owner_organization_membership_id,
          organization_user_resource_authority_id,
          organization_user_resource_authority_generation
        )
      )
    )
    WITH CHECK (
      opengeni_private.workspace_rls_visible(account_id, workspace_id)
      AND (
        authority_scope = 'workspace'
        OR %1$I.xai_subscription_authority_live(
          account_id, workspace_id,
          NULLIF(current_setting('opengeni.subject_id', true), ''),
          id, authority_scope, owner_organization_membership_id,
          organization_user_resource_authority_id,
          organization_user_resource_authority_generation
        )
      )
    )
  $policy$, data_schema);

  FOREACH table_name IN ARRAY ARRAY[
    'xai_rotation_settings', 'xai_credential_leases',
    'xai_session_account_pins', 'xai_capacity_waiters'
  ] LOOP
    EXECUTE format($policy$
      CREATE POLICY xai_subscription_pool_scope ON %1$I.%2$I
      USING (
        opengeni_private.workspace_rls_visible(account_id, workspace_id)
        AND %1$I.xai_subscription_pool_visible(
          account_id, workspace_id,
          NULLIF(current_setting('opengeni.subject_id', true), ''),
          authority_scope, owner_organization_membership_id
        )
      )
      WITH CHECK (
        opengeni_private.workspace_rls_visible(account_id, workspace_id)
        AND %1$I.xai_subscription_pool_visible(
          account_id, workspace_id,
          NULLIF(current_setting('opengeni.subject_id', true), ''),
          authority_scope, owner_organization_membership_id
        )
      )
    $policy$, data_schema, table_name);
  END LOOP;
END
$xai_rls$;

DO $xai_immutability$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.prevent_xai_authority_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
        OR NEW.owner_organization_membership_id
          IS DISTINCT FROM OLD.owner_organization_membership_id
        OR NEW.organization_user_resource_authority_id
          IS DISTINCT FROM OLD.organization_user_resource_authority_id
        OR NEW.organization_user_resource_kind
          IS DISTINCT FROM OLD.organization_user_resource_kind
        OR NEW.organization_user_resource_authority_generation
          IS DISTINCT FROM OLD.organization_user_resource_authority_generation
      THEN
        RAISE EXCEPTION 'xAI credential authority is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $body$;
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE TRIGGER xai_subscription_credentials_authority_immutable_trg
    BEFORE UPDATE OF authority_scope, owner_organization_membership_id,
      organization_user_resource_authority_id, organization_user_resource_kind,
      organization_user_resource_authority_generation
    ON %1$I.xai_subscription_credentials
    FOR EACH ROW EXECUTE FUNCTION %1$I.prevent_xai_authority_mutation()
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.prevent_xai_snapshot_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.xai_provider_account_authority_snapshot
        IS DISTINCT FROM OLD.xai_provider_account_authority_snapshot
      THEN
        RAISE EXCEPTION '%% xAI provider-account authority snapshot is immutable', TG_TABLE_NAME
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $body$;
  $ddl$, data_schema);
END
$xai_immutability$;

ALTER TABLE "session_turns"
  ADD COLUMN "xai_provider_account_authority_snapshot" jsonb
    NOT NULL DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ADD CONSTRAINT "session_turns_xai_authority_snapshot_chk" CHECK (
    xai_provider_account_authority_snapshot_v1_valid(
      "xai_provider_account_authority_snapshot"
    )
  );
ALTER TABLE "scheduled_tasks"
  ADD COLUMN "xai_provider_account_authority_snapshot" jsonb
    NOT NULL DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ADD CONSTRAINT "scheduled_tasks_xai_authority_snapshot_chk" CHECK (
    xai_provider_account_authority_snapshot_v1_valid(
      "xai_provider_account_authority_snapshot"
    )
  );
ALTER TABLE "session_system_updates"
  ADD COLUMN "xai_provider_account_authority_snapshot" jsonb
    NOT NULL DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ADD CONSTRAINT "session_system_updates_xai_authority_snapshot_chk" CHECK (
    xai_provider_account_authority_snapshot_v1_valid(
      "xai_provider_account_authority_snapshot"
    )
  );
ALTER TABLE "session_system_update_outbox"
  ADD COLUMN "xai_provider_account_authority_snapshot" jsonb
    NOT NULL DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ADD CONSTRAINT "session_system_update_outbox_xai_authority_snapshot_chk" CHECK (
    xai_provider_account_authority_snapshot_v1_valid(
      "xai_provider_account_authority_snapshot"
    )
  );

CREATE TRIGGER session_turns_xai_authority_snapshot_immutable_trg
BEFORE UPDATE OF xai_provider_account_authority_snapshot ON "session_turns"
FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();
CREATE TRIGGER scheduled_tasks_xai_authority_snapshot_immutable_trg
BEFORE UPDATE OF xai_provider_account_authority_snapshot ON "scheduled_tasks"
FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();
CREATE TRIGGER session_system_updates_xai_authority_snapshot_immutable_trg
BEFORE UPDATE OF xai_provider_account_authority_snapshot ON "session_system_updates"
FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();
CREATE TRIGGER session_system_update_outbox_xai_authority_snapshot_immutable_trg
BEFORE UPDATE OF xai_provider_account_authority_snapshot ON "session_system_update_outbox"
FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

-- Preserve the immutable snapshot through the existing global child-result
-- outbox claim without changing any producer or runtime implementation.
DROP FUNCTION opengeni_private.claim_session_system_update_outbox(integer);
CREATE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, summary_codec_version integer,
  payload jsonb, payload_codec_version integer, lineage jsonb,
  personal_connection_delegations jsonb,
  xai_provider_account_authority_snapshot jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    )
    UPDATE session_system_update_outbox o
    SET attempts = o.attempts + 1, updated_at = now()
    FROM claimed c WHERE o.id = c.id
    RETURNING o.id, o.account_id, o.workspace_id, o.source_session_id,
      o.target_session_id, o.dedupe_key, o.kind, o.classification,
      o.source_id, o.summary, o.summary_codec_version,
      o.payload, o.payload_codec_version, o.lineage,
      o.personal_connection_delegations,
      o.xai_provider_account_authority_snapshot;
END
$function$;

REVOKE ALL ON FUNCTION create_xai_subscription_credential(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_xai_authority_pool(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION revalidate_xai_subscription_authority(uuid, text, uuid, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION disconnect_xai_subscription_credential(uuid, uuid, text, uuid, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
  FROM PUBLIC;

DO $xai_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "xai_subscription_credentials", "xai_rotation_settings",
      "xai_credential_leases", "xai_session_account_pins", "xai_capacity_waiters"
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION create_xai_subscription_credential(
      uuid, uuid, text, text, text, text, text, text, text, timestamptz
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION resolve_xai_authority_pool(uuid, uuid, text, jsonb)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION revalidate_xai_subscription_authority(
      uuid, text, uuid, jsonb
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION disconnect_xai_subscription_credential(
      uuid, uuid, text, uuid, jsonb
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
      TO opengeni_app;
  END IF;
END
$xai_runtime_grants$;

COMMENT ON COLUMN "xai_subscription_credentials"."credential_encrypted" IS
  'Authenticated-encrypted xAI credential JSON; never returned by metadata list/read APIs.';
COMMENT ON COLUMN "xai_subscription_credentials"."connected_by_subject_id" IS
  'Connection audit attribution only; never ownership or executable authority.';
COMMENT ON COLUMN "session_turns"."xai_provider_account_authority_snapshot" IS
  'Immutable identifier-free xAI provider-account authority snapshot for the accepted logical turn.';
COMMENT ON COLUMN "scheduled_tasks"."xai_provider_account_authority_snapshot" IS
  'Immutable identifier-free xAI provider-account authority snapshot for accepted schedule work.';
COMMENT ON COLUMN "session_system_updates"."xai_provider_account_authority_snapshot" IS
  'Immutable identifier-free xAI provider-account authority snapshot for accepted internal input.';
COMMENT ON COLUMN "session_system_update_outbox"."xai_provider_account_authority_snapshot" IS
  'Immutable identifier-free xAI provider-account authority snapshot preserved through child-result delivery.';