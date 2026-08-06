-- deployment-mode: rolling
-- Account-level governance lock and human-custodian recovery. Sensitive
-- approval evidence is stored only as an authenticated AES-GCM envelope by the
-- application; the database exposes account-scoped metadata under FORCE RLS.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Capture the migration target once. Runtime-sensitive checks below use this
-- immutable session value rather than re-resolving current_setting('opengeni.migration_target_schema').
DO $$
BEGIN
  PERFORM set_config('opengeni.migration_target_schema', current_schema(), true);
END $$;


ALTER TABLE "managed_accounts"
  ADD COLUMN IF NOT EXISTS "organization_kind" text,
  ADD COLUMN IF NOT EXISTS "governance_state" text,
  ADD COLUMN IF NOT EXISTS "governance_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_policy_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_quorum" integer,
  ADD COLUMN IF NOT EXISTS "governance_authority_subject_id" text,
  ADD COLUMN IF NOT EXISTS "authorization_invalidated_at" timestamptz;

UPDATE "managed_accounts"
SET
  "organization_kind" = coalesce(
    "organization_kind",
    CASE WHEN "external_source" = 'better-auth:user' THEN 'personal' ELSE 'team' END
  ),
  "governance_state" = coalesce("governance_state", 'active'),
  "governance_revision" = coalesce("governance_revision", 0),
  "recovery_policy_revision" = coalesce("recovery_policy_revision", 0),
  "governance_authority_subject_id" = coalesce(
    "governance_authority_subject_id",
    CASE
      WHEN "external_source" = 'better-auth:user' AND "external_id" IS NOT NULL
      THEN 'user:' || "external_id"
      ELSE NULL
    END
  );

ALTER TABLE "managed_accounts"
  ALTER COLUMN "organization_kind" SET DEFAULT 'team',
  ALTER COLUMN "organization_kind" SET NOT NULL,
  ALTER COLUMN "governance_state" SET DEFAULT 'active',
  ALTER COLUMN "governance_state" SET NOT NULL,
  ALTER COLUMN "governance_revision" SET DEFAULT 0,
  ALTER COLUMN "governance_revision" SET NOT NULL,
  ALTER COLUMN "recovery_policy_revision" SET DEFAULT 0,
  ALTER COLUMN "recovery_policy_revision" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_organization_kind_check'
      AND n.nspname = current_setting('opengeni.migration_target_schema')
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("organization_kind" IN (''personal'', ''team''))',
      current_setting('opengeni.migration_target_schema'), 'managed_accounts', 'managed_accounts_organization_kind_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_governance_state_check'
      AND n.nspname = current_setting('opengeni.migration_target_schema')
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("governance_state" IN (''active'', ''governance_locked''))',
      current_setting('opengeni.migration_target_schema'), 'managed_accounts', 'managed_accounts_governance_state_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_governance_revision_check'
      AND n.nspname = current_setting('opengeni.migration_target_schema')
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("governance_revision" >= 0 AND "recovery_policy_revision" >= 0)',
      current_setting('opengeni.migration_target_schema'), 'managed_accounts', 'managed_accounts_governance_revision_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_recovery_quorum_check'
      AND n.nspname = current_setting('opengeni.migration_target_schema')
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("recovery_quorum" IS NULL OR "recovery_quorum" BETWEEN 1 AND 10)',
      current_setting('opengeni.migration_target_schema'), 'managed_accounts', 'managed_accounts_recovery_quorum_check'
    );
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS "organization_recovery_custodians" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "subject_label" text,
  "canonical_user_id" text,
  "enrollment_state" text NOT NULL DEFAULT 'pending',
  "accepted_at" timestamptz,
  "policy_revision" bigint NOT NULL CHECK ("policy_revision" > 0),
  "enrolled_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_custodians_enrollment_state_check"
    CHECK ("enrollment_state" IN ('pending', 'accepted')),
  CONSTRAINT "organization_recovery_custodians_accepted_at_shape_check"
    CHECK (("enrollment_state" = 'pending' AND "accepted_at" IS NULL)
      OR ("enrollment_state" = 'accepted' AND "accepted_at" IS NOT NULL)),
  CONSTRAINT "organization_recovery_custodians_account_subject_uq"
    UNIQUE ("account_id", "subject_id")
);
ALTER TABLE "organization_recovery_custodians"
  ADD COLUMN IF NOT EXISTS "canonical_user_id" text,
  ADD COLUMN IF NOT EXISTS "enrollment_state" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_recovery_custodians_enrollment_state_check'
      AND conrelid = 'organization_recovery_custodians'::regclass
  ) THEN
    ALTER TABLE "organization_recovery_custodians"
      ADD CONSTRAINT "organization_recovery_custodians_enrollment_state_check"
      CHECK ("enrollment_state" IN ('pending', 'accepted'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_recovery_custodians_accepted_at_shape_check'
      AND conrelid = 'organization_recovery_custodians'::regclass
  ) THEN
    ALTER TABLE "organization_recovery_custodians"
      ADD CONSTRAINT "organization_recovery_custodians_accepted_at_shape_check"
      CHECK (("enrollment_state" = 'pending' AND "accepted_at" IS NULL)
        OR ("enrollment_state" = 'accepted' AND "accepted_at" IS NOT NULL));
  END IF;
END $$;
DO $$
DECLARE target_schema text := current_setting('opengeni.migration_target_schema');
BEGIN
  IF to_regclass(format('%I.%I', target_schema, 'auth_users')) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'organization_recovery_custodians_canonical_user_fk'
        AND conrelid = 'organization_recovery_custodians'::regclass
    )
  THEN
    EXECUTE format(
      'ALTER TABLE %I.organization_recovery_custodians
         ADD CONSTRAINT organization_recovery_custodians_canonical_user_fk
         FOREIGN KEY (canonical_user_id) REFERENCES %I.auth_users(id) ON DELETE SET NULL',
      target_schema,
      target_schema
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "organization_recovery_custodians_account_policy_idx"
  ON "organization_recovery_custodians" ("account_id", "policy_revision");

CREATE TABLE IF NOT EXISTS "organization_recovery_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'pending',
  "governance_revision" bigint NOT NULL,
  "policy_revision" bigint NOT NULL,
  "quorum" integer NOT NULL,
  "requested_by_subject_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "finalized_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_operations_state_check"
    CHECK ("state" IN ('pending', 'finalized', 'cancelled')),
  CONSTRAINT "organization_recovery_operations_revisions_check"
    CHECK ("governance_revision" >= 0 AND "policy_revision" > 0 AND "quorum" BETWEEN 1 AND 10),
  CONSTRAINT "organization_recovery_operations_id_account_uq" UNIQUE ("id", "account_id")
);
CREATE INDEX IF NOT EXISTS "organization_recovery_operations_account_state_idx"
  ON "organization_recovery_operations" ("account_id", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "organization_recovery_operations_one_pending_uq"
  ON "organization_recovery_operations" ("account_id") WHERE "state" = 'pending';

CREATE TABLE IF NOT EXISTS "organization_recovery_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "canonical_user_id" text,
  "auth_session_id" text,
  "evidence_ciphertext" text NOT NULL,
  "evidence_key_version" text NOT NULL,
  "evidence_expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_approvals_operation_subject_uq"
    UNIQUE ("operation_id", "subject_id"),
  CONSTRAINT "organization_recovery_approvals_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE CASCADE
);
ALTER TABLE "organization_recovery_approvals"
  ADD COLUMN IF NOT EXISTS "canonical_user_id" text,
  ADD COLUMN IF NOT EXISTS "auth_session_id" text;
CREATE INDEX IF NOT EXISTS "organization_recovery_approvals_account_operation_idx"
  ON "organization_recovery_approvals" ("account_id", "operation_id");

CREATE TABLE IF NOT EXISTS "organization_governance_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_governance_commands_account_subject_key_uq"
    UNIQUE ("account_id", "subject_id", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "organization_authorization_invalidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "operation_id" uuid,
  "governance_revision" bigint NOT NULL,
  "reason" text NOT NULL,
  "invalidated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_authorization_invalidations_account_revision_uq"
    UNIQUE ("account_id", "governance_revision"),
  CONSTRAINT "organization_authorization_invalidations_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "organization_recovery_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "operation_id" uuid,
  "subject_id" text NOT NULL,
  "action" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_audit_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "organization_recovery_audit_account_created_idx"
  ON "organization_recovery_audit" ("account_id", "created_at");

-- The governance plane is schema-isolated. Record the exact target relation
-- OIDs once so a later search_path spoof, same-named decoy relation, or replay
-- against a different target cannot silently move the authority boundary.
CREATE TABLE IF NOT EXISTS "organization_governance_target_authority" (
  "target_schema" text PRIMARY KEY,
  "managed_accounts_relid" oid NOT NULL,
  "auth_users_relid" oid,
  "auth_sessions_relid" oid,
  "custodians_relid" oid NOT NULL,
  "operations_relid" oid NOT NULL,
  "approvals_relid" oid NOT NULL,
  "commands_relid" oid NOT NULL,
  "invalidations_relid" oid NOT NULL,
  "audit_relid" oid NOT NULL,
  "registered_at" timestamptz NOT NULL DEFAULT now(),
  "activated_at" timestamptz,
  "activated_by" name,
  "target_database" name NOT NULL DEFAULT current_database(),
  "legacy_role" name NOT NULL DEFAULT 'opengeni_app',
  "v2_role" name NOT NULL DEFAULT 'opengeni_governance_app'
);
ALTER TABLE "organization_governance_target_authority"
  ADD COLUMN IF NOT EXISTS "auth_users_relid" oid,
  ADD COLUMN IF NOT EXISTS "auth_sessions_relid" oid,
  ADD COLUMN IF NOT EXISTS "target_database" name,
  ADD COLUMN IF NOT EXISTS "legacy_role" name,
  ADD COLUMN IF NOT EXISTS "v2_role" name;
UPDATE "organization_governance_target_authority"
SET target_database = coalesce(target_database, current_database()),
    legacy_role = coalesce(legacy_role, 'opengeni_app'),
    v2_role = coalesce(v2_role, 'opengeni_governance_app');
ALTER TABLE "organization_governance_target_authority"
  ALTER COLUMN "target_database" SET DEFAULT current_database(),
  ALTER COLUMN "target_database" SET NOT NULL,
  ALTER COLUMN "legacy_role" SET DEFAULT 'opengeni_app',
  ALTER COLUMN "legacy_role" SET NOT NULL,
  ALTER COLUMN "v2_role" SET DEFAULT 'opengeni_governance_app',
  ALTER COLUMN "v2_role" SET NOT NULL;

DO $$
DECLARE
  target_schema text := current_setting('opengeni.migration_target_schema');
  managed_accounts_relid oid := to_regclass(format('%I.%I', target_schema, 'managed_accounts'));
  auth_users_relid oid := to_regclass(format('%I.%I', target_schema, 'auth_users'));
  auth_sessions_relid oid := to_regclass(format('%I.%I', target_schema, 'auth_sessions'));
  custodians_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_recovery_custodians'));
  operations_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_recovery_operations'));
  approvals_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_recovery_approvals'));
  commands_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_governance_commands'));
  invalidations_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_authorization_invalidations'));
  audit_relid oid := to_regclass(format('%I.%I', target_schema, 'organization_recovery_audit'));
  registered record;
BEGIN
  IF managed_accounts_relid IS NULL OR custodians_relid IS NULL OR operations_relid IS NULL
    OR approvals_relid IS NULL OR commands_relid IS NULL OR invalidations_relid IS NULL
    OR audit_relid IS NULL THEN
    RAISE EXCEPTION 'organization governance target relation registration is incomplete'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format(
    'SELECT * FROM %I.organization_governance_target_authority WHERE target_schema = $1 FOR UPDATE',
    target_schema
  ) INTO registered USING target_schema;
  IF registered IS NULL THEN
    EXECUTE format(
      'INSERT INTO %I.organization_governance_target_authority (
         target_schema, managed_accounts_relid, auth_users_relid, auth_sessions_relid,
         custodians_relid, operations_relid, approvals_relid, commands_relid,
         invalidations_relid, audit_relid, target_database, legacy_role, v2_role
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_database(), $11, $12)',
      target_schema
    ) USING target_schema, managed_accounts_relid, auth_users_relid, auth_sessions_relid,
      custodians_relid, operations_relid, approvals_relid, commands_relid,
      invalidations_relid, audit_relid, 'opengeni_app', 'opengeni_governance_app';
  ELSIF registered.managed_accounts_relid IS DISTINCT FROM managed_accounts_relid
    OR registered.auth_users_relid IS DISTINCT FROM auth_users_relid
    OR registered.auth_sessions_relid IS DISTINCT FROM auth_sessions_relid
    OR registered.custodians_relid IS DISTINCT FROM custodians_relid
    OR registered.operations_relid IS DISTINCT FROM operations_relid
    OR registered.approvals_relid IS DISTINCT FROM approvals_relid
    OR registered.commands_relid IS DISTINCT FROM commands_relid
    OR registered.invalidations_relid IS DISTINCT FROM invalidations_relid
    OR registered.audit_relid IS DISTINCT FROM audit_relid THEN
    RAISE EXCEPTION 'organization governance target relation authority changed'
      USING ERRCODE = '55000';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.assert_organization_governance_target_authority(
  p_target_schema text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, opengeni_private AS $$
DECLARE registered record;
BEGIN
  IF p_target_schema IS NULL OR p_target_schema !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid organization governance target schema' USING ERRCODE = '22023';
  END IF;
  EXECUTE format(
    'SELECT * FROM %I.organization_governance_target_authority WHERE target_schema = $1',
    p_target_schema
  ) INTO registered USING p_target_schema;
  IF registered IS NULL
    OR registered.managed_accounts_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'managed_accounts'))
    OR registered.auth_users_relid IS NULL
    OR registered.auth_sessions_relid IS NULL
    OR registered.auth_users_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'auth_users'))
    OR registered.auth_sessions_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'auth_sessions'))
    OR registered.custodians_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_recovery_custodians'))
    OR registered.operations_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_recovery_operations'))
    OR registered.approvals_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_recovery_approvals'))
    OR registered.commands_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_governance_commands'))
    OR registered.invalidations_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_authorization_invalidations'))
    OR registered.audit_relid IS DISTINCT FROM to_regclass(format('%I.%I', p_target_schema, 'organization_recovery_audit')) THEN
    RAISE EXCEPTION 'organization governance target relation authority is not registered'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.assert_organization_governance_target_authority(text) FROM PUBLIC;

-- Activation is deliberately separate from migration replay. An operator with
-- the explicit role may activate a registered target after verifying the v2
-- database/role rollout; replay never clears or rewrites activation state.
CREATE OR REPLACE FUNCTION opengeni_private.activate_organization_governance_target(
  p_target_schema text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, opengeni_private AS $$
DECLARE
  operator_role name := 'opengeni_governance_operator';
  registered record;
  v2 record;
  legacy_exists boolean;
  table_name text;
  privilege_name text;
  relation_info record;
BEGIN
  IF NOT pg_has_role(session_user, operator_role, 'member') AND session_user <> operator_role THEN
    RAISE EXCEPTION 'organization governance operator activation is not authorized'
      USING ERRCODE = '42501';
  END IF;
  PERFORM opengeni_private.assert_organization_governance_target_authority(p_target_schema);
  EXECUTE format(
    'SELECT * FROM %I.organization_governance_target_authority
      WHERE target_schema = $1 FOR UPDATE',
    p_target_schema
  ) INTO registered USING p_target_schema;
  IF registered IS NULL OR registered.target_database IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'organization governance target database is not the active database'
      USING ERRCODE = '55000';
  END IF;
  SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
    INTO v2
    FROM pg_roles r
   WHERE r.rolname = registered.v2_role;
  IF v2 IS NULL OR NOT v2.rolcanlogin OR v2.rolsuper OR v2.rolbypassrls
     OR v2.rolcreaterole OR v2.rolcreatedb THEN
    RAISE EXCEPTION 'organization governance v2 role is not a restricted LOGIN principal'
      USING ERRCODE = '55000';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = registered.legacy_role)
    INTO legacy_exists;
  IF NOT legacy_exists THEN
    RAISE EXCEPTION 'organization governance legacy role is missing'
      USING ERRCODE = '55000';
  END IF;
  IF registered.legacy_role IN (registered.v2_role, operator_role)
    OR registered.v2_role = operator_role THEN
    RAISE EXCEPTION 'organization governance roles must remain distinct'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    WITH RECURSIVE reachable(oid) AS (
      SELECT oid FROM pg_roles WHERE rolname = registered.v2_role
      UNION
      SELECT membership.roleid
        FROM pg_auth_members membership
        JOIN reachable member ON member.oid = membership.member
    )
    SELECT 1
      FROM pg_roles role
     WHERE role.oid IN (SELECT oid FROM reachable)
       AND role.rolname IN (registered.legacy_role, operator_role)
  ) THEN
    RAISE EXCEPTION 'organization governance v2 role reaches forbidden authority'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    WITH RECURSIVE reachable(oid) AS (
      SELECT oid FROM pg_roles WHERE rolname = registered.legacy_role
      UNION
      SELECT membership.roleid
        FROM pg_auth_members membership
        JOIN reachable member ON member.oid = membership.member
    )
    SELECT 1
      FROM pg_roles role
     WHERE role.oid IN (SELECT oid FROM reachable)
       AND role.rolname IN (registered.v2_role, operator_role)
  ) THEN
    RAISE EXCEPTION 'organization governance legacy role reaches v2/operator authority'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND usename = registered.legacy_role
       AND pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'organization governance activation requires all legacy sessions to be drained'
      USING ERRCODE = '55000';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'managed_accounts', 'workspaces', 'workspace_memberships', 'api_keys',
    'auth_users', 'auth_sessions', 'organization_recovery_custodians',
    'organization_recovery_operations', 'organization_recovery_approvals',
    'organization_governance_commands', 'organization_authorization_invalidations',
    'organization_recovery_audit'
  ] LOOP
    IF to_regclass(format('%I.%I', p_target_schema, table_name)) IS NULL THEN
      RAISE EXCEPTION 'organization governance activation relation is missing: %.%',
        p_target_schema, table_name
        USING ERRCODE = '55000';
    END IF;
    SELECT c.relrowsecurity, c.relforcerowsecurity, owner_role.rolname AS owner_name
      INTO relation_info
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles owner_role ON owner_role.oid = c.relowner
     WHERE n.nspname = p_target_schema
       AND c.relname = table_name
       AND c.relkind IN ('r', 'p');
    IF relation_info IS NULL
      OR relation_info.relrowsecurity IS DISTINCT FROM true
      OR relation_info.relforcerowsecurity IS DISTINCT FROM true
      OR relation_info.owner_name = registered.v2_role THEN
      RAISE EXCEPTION 'organization governance relation is not FORCE-RLS and non-owned: %.%',
        p_target_schema, table_name
        USING ERRCODE = '55000';
    END IF;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
      p_target_schema, table_name, registered.legacy_role
    );
    FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(
        registered.legacy_role,
        format('%I.%I', p_target_schema, table_name),
        privilege_name
      ) THEN
        RAISE EXCEPTION 'organization governance legacy role retains % privilege on %.%',
          privilege_name, p_target_schema, table_name
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END LOOP;
  EXECUTE format('ALTER ROLE %I NOLOGIN', registered.legacy_role);
  EXECUTE format(
    'UPDATE %I.organization_governance_target_authority
        SET activated_at = coalesce(activated_at, clock_timestamp()),
            activated_by = coalesce(activated_by, session_user)
      WHERE target_schema = $1',
    p_target_schema
  ) USING p_target_schema;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.activate_organization_governance_target(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_governance_operator') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.activate_organization_governance_target(text)
      TO opengeni_governance_operator;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.require_organization_governance_target_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, opengeni_private AS $$
BEGIN
  PERFORM opengeni_private.assert_organization_governance_target_authority(TG_TABLE_SCHEMA);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.require_organization_governance_target_trigger() FROM PUBLIC;

DO $$
DECLARE
  target_schema text := current_setting('opengeni.migration_target_schema');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'managed_accounts',
    'organization_recovery_custodians',
    'organization_recovery_operations',
    'organization_recovery_approvals',
    'organization_governance_commands',
    'organization_authorization_invalidations',
    'organization_recovery_audit'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS organization_governance_target_authority_guard ON %I.%I',
      target_schema, table_name
    );
    EXECUTE format(
      'CREATE TRIGGER organization_governance_target_authority_guard
       BEFORE INSERT OR UPDATE OR DELETE ON %I.%I
       FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_organization_governance_target_trigger()',
      target_schema, table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.reject_organization_recovery_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, opengeni_private
AS $$
BEGIN
  RAISE EXCEPTION 'organization recovery history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.reject_organization_recovery_history_mutation() FROM PUBLIC;

DO $$
DECLARE target_schema text := current_setting('opengeni.migration_target_schema');
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS organization_recovery_audit_append_only ON %I.organization_recovery_audit', target_schema);
  EXECUTE format(
    'CREATE TRIGGER organization_recovery_audit_append_only
       BEFORE UPDATE OR DELETE ON %I.organization_recovery_audit
       FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_organization_recovery_history_mutation()',
    target_schema
  );
  EXECUTE format('DROP TRIGGER IF EXISTS organization_authorization_invalidations_append_only ON %I.organization_authorization_invalidations', target_schema);
  EXECUTE format(
    'CREATE TRIGGER organization_authorization_invalidations_append_only
       BEFORE UPDATE OR DELETE ON %I.organization_authorization_invalidations
       FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_organization_recovery_history_mutation()',
    target_schema
  );
END $$;

DO $$
DECLARE
  target_schema text := current_setting('opengeni.migration_target_schema');
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_recovery_custodians',
    'organization_recovery_operations',
    'organization_recovery_approvals',
    'organization_governance_commands',
    'organization_authorization_invalidations',
    'organization_recovery_audit'
  ] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target_schema, table_name);
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_setting('opengeni.migration_target_schema')
        AND tablename = table_name
        AND policyname = 'organization_account_isolation'
    ) THEN
      EXECUTE format('DROP POLICY organization_account_isolation ON %I.%I', target_schema, table_name);
    END IF;
    EXECUTE format(
      'CREATE POLICY organization_account_isolation ON %I.%I USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id))',
      target_schema, table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE target_schema text := current_setting('opengeni.migration_target_schema');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_governance_app') THEN
    EXECUTE format(
      'GRANT USAGE ON SCHEMA %I TO opengeni_governance_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.managed_accounts, %I.workspace_memberships, %I.workspaces, %I.api_keys TO opengeni_governance_app',
      target_schema, target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.organization_recovery_custodians, %I.organization_recovery_operations, %I.organization_recovery_approvals TO opengeni_governance_app',
      target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON %I.organization_governance_commands TO opengeni_governance_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON %I.organization_authorization_invalidations, %I.organization_recovery_audit TO opengeni_governance_app',
      target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT ON %I.auth_users, %I.auth_sessions TO opengeni_governance_app',
      target_schema, target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.reject_organization_recovery_history_mutation()
      TO opengeni_governance_app;
    IF to_regprocedure('opengeni_private.account_rls_visible(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION opengeni_private.account_rls_visible(uuid)
        TO opengeni_governance_app;
    END IF;
  END IF;
END $$;
