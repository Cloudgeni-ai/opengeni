-- deployment-mode: rolling
-- Add the inert, expand-only personal Codex provider-account authority
-- foundation. Existing credentials and accepted work are explicitly
-- workspace-scoped. No runtime path discovers, creates, selects, leases,
-- materializes, consumes, or reports a user-scoped credential in this slice.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Stable tuple lookup for the credential-side validation trigger. This adds no
-- privilege and does not change the FORCE-RLS lifecycle of the authority table.
CREATE UNIQUE INDEX IF NOT EXISTS "organization_user_resource_authorities_codex_tuple_idx"
  ON "organization_user_resource_authorities" (
    "id",
    "account_id",
    "organization_membership_id",
    "resource_kind",
    "resource_id",
    "generation"
  );

ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN "authority_scope" text,
  ADD COLUMN "owner_organization_membership_id" uuid,
  ADD COLUMN "organization_user_resource_authority_id" uuid,
  ADD COLUMN "organization_user_resource_kind" text,
  ADD COLUMN "organization_user_resource_authority_generation" bigint;

-- This UPDATE is intentionally explicit rather than relying on an ADD COLUMN
-- default: every pre-foundation provider account is classified workspace-only.
UPDATE "codex_subscription_credentials"
SET "authority_scope" = 'workspace'
WHERE "authority_scope" IS NULL;

ALTER TABLE "codex_subscription_credentials"
  ALTER COLUMN "authority_scope" SET DEFAULT 'workspace',
  ALTER COLUMN "authority_scope" SET NOT NULL,
  ADD CONSTRAINT "codex_credentials_authority_scope_chk" CHECK (
    "authority_scope" IN ('workspace', 'user')
  ) NOT VALID,
  ADD CONSTRAINT "codex_credentials_authority_shape_chk" CHECK (
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
      AND "organization_user_resource_kind" = 'codex_subscription'
      AND "organization_user_resource_authority_generation" IS NOT NULL
      AND "organization_user_resource_authority_generation" > 0
    )
  ) NOT VALID,
  ADD CONSTRAINT "codex_credentials_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id")
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "codex_credentials_user_authority_fk"
    FOREIGN KEY (
      "organization_user_resource_authority_id",
      "account_id",
      "owner_organization_membership_id",
      "organization_user_resource_kind",
      "id",
      "organization_user_resource_authority_generation"
    )
    REFERENCES "organization_user_resource_authorities"(
      "id",
      "account_id",
      "organization_membership_id",
      "resource_kind",
      "resource_id",
      "generation"
    )
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE "codex_subscription_credentials"
  VALIDATE CONSTRAINT "codex_credentials_authority_scope_chk",
  VALIDATE CONSTRAINT "codex_credentials_authority_shape_chk",
  VALIDATE CONSTRAINT "codex_credentials_owner_membership_fk",
  VALIDATE CONSTRAINT "codex_credentials_user_authority_fk";

DO $personal_codex_authority_validation$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.validate_personal_codex_credential_authority()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    DECLARE
      exact_authority boolean;
    BEGIN
      IF NEW.authority_scope = 'workspace' THEN
        RETURN NEW;
      END IF;

      -- Invoker rights are deliberate in this inert slice. The ordinary app
      -- role has no direct visibility into either organization authority table,
      -- so it cannot manufacture a user-scoped credential. A later activation
      -- slice must introduce a separately reviewed narrow lifecycle capability.
      SELECT true
      INTO exact_authority
      FROM %1$I.organization_memberships membership
      INNER JOIN %1$I.organization_user_resource_authorities authority
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
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'DROP TRIGGER IF EXISTS codex_credentials_validate_user_authority_trg ON %I.codex_subscription_credentials',
    data_schema
  );
  EXECUTE format($ddl$
    CREATE TRIGGER codex_credentials_validate_user_authority_trg
    BEFORE INSERT OR UPDATE OF
      id,
      account_id,
      authority_scope,
      owner_organization_membership_id,
      organization_user_resource_authority_id,
      organization_user_resource_kind,
      organization_user_resource_authority_generation
    ON %1$I.codex_subscription_credentials
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.validate_personal_codex_credential_authority()
  $ddl$, data_schema);
END
$personal_codex_authority_validation$;

-- One strict identifier-free snapshot shape is shared by the accepted turn,
-- scheduled task, and internal-update boundaries. The user variant stores only
-- the positive authority generation; it is not executable authority by itself.
DO $codex_provider_account_snapshot_validator$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.codex_provider_account_authority_snapshot_v1_valid(
      snapshot jsonb
    )
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $body$
      SELECT
        snapshot = '{"version":1,"scope":"workspace"}'::jsonb
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
END
$codex_provider_account_snapshot_validator$;

ALTER TABLE "session_turns"
  ADD COLUMN "codex_provider_account_authority_snapshot" jsonb;
ALTER TABLE "scheduled_tasks"
  ADD COLUMN "codex_provider_account_authority_snapshot" jsonb;
ALTER TABLE "session_system_updates"
  ADD COLUMN "codex_provider_account_authority_snapshot" jsonb;
ALTER TABLE "session_system_update_outbox"
  ADD COLUMN "codex_provider_account_authority_snapshot" jsonb;

UPDATE "session_turns"
SET "codex_provider_account_authority_snapshot" = '{"version":1,"scope":"workspace"}'::jsonb
WHERE "codex_provider_account_authority_snapshot" IS NULL;
UPDATE "scheduled_tasks"
SET "codex_provider_account_authority_snapshot" = '{"version":1,"scope":"workspace"}'::jsonb
WHERE "codex_provider_account_authority_snapshot" IS NULL;
UPDATE "session_system_updates"
SET "codex_provider_account_authority_snapshot" = '{"version":1,"scope":"workspace"}'::jsonb
WHERE "codex_provider_account_authority_snapshot" IS NULL;
UPDATE "session_system_update_outbox"
SET "codex_provider_account_authority_snapshot" = '{"version":1,"scope":"workspace"}'::jsonb
WHERE "codex_provider_account_authority_snapshot" IS NULL;

ALTER TABLE "session_turns"
  ALTER COLUMN "codex_provider_account_authority_snapshot"
    SET DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ALTER COLUMN "codex_provider_account_authority_snapshot" SET NOT NULL,
  ADD CONSTRAINT "session_turns_codex_authority_snapshot_chk" CHECK (
    codex_provider_account_authority_snapshot_v1_valid(
      "codex_provider_account_authority_snapshot"
    )
  ) NOT VALID;
ALTER TABLE "scheduled_tasks"
  ALTER COLUMN "codex_provider_account_authority_snapshot"
    SET DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ALTER COLUMN "codex_provider_account_authority_snapshot" SET NOT NULL,
  ADD CONSTRAINT "scheduled_tasks_codex_authority_snapshot_chk" CHECK (
    codex_provider_account_authority_snapshot_v1_valid(
      "codex_provider_account_authority_snapshot"
    )
  ) NOT VALID;
ALTER TABLE "session_system_updates"
  ALTER COLUMN "codex_provider_account_authority_snapshot"
    SET DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ALTER COLUMN "codex_provider_account_authority_snapshot" SET NOT NULL,
  ADD CONSTRAINT "session_updates_codex_authority_snapshot_chk" CHECK (
    codex_provider_account_authority_snapshot_v1_valid(
      "codex_provider_account_authority_snapshot"
    )
  ) NOT VALID;
ALTER TABLE "session_system_update_outbox"
  ALTER COLUMN "codex_provider_account_authority_snapshot"
    SET DEFAULT '{"version":1,"scope":"workspace"}'::jsonb,
  ALTER COLUMN "codex_provider_account_authority_snapshot" SET NOT NULL,
  ADD CONSTRAINT "system_update_outbox_codex_authority_snapshot_chk" CHECK (
    codex_provider_account_authority_snapshot_v1_valid(
      "codex_provider_account_authority_snapshot"
    )
  ) NOT VALID;

ALTER TABLE "session_turns"
  VALIDATE CONSTRAINT "session_turns_codex_authority_snapshot_chk";
ALTER TABLE "scheduled_tasks"
  VALIDATE CONSTRAINT "scheduled_tasks_codex_authority_snapshot_chk";
ALTER TABLE "session_system_updates"
  VALIDATE CONSTRAINT "session_updates_codex_authority_snapshot_chk";
ALTER TABLE "session_system_update_outbox"
  VALIDATE CONSTRAINT "system_update_outbox_codex_authority_snapshot_chk";

DO $codex_provider_account_snapshot_immutability$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.prevent_codex_provider_account_authority_snapshot_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      IF NEW.codex_provider_account_authority_snapshot
        IS DISTINCT FROM OLD.codex_provider_account_authority_snapshot
      THEN
        RAISE EXCEPTION '%% Codex provider-account authority snapshot is immutable', TG_TABLE_NAME
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE TRIGGER session_turns_codex_authority_snapshot_immutable_trg
    BEFORE UPDATE OF codex_provider_account_authority_snapshot
    ON %1$I.session_turns
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.prevent_codex_provider_account_authority_snapshot_mutation()
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE TRIGGER scheduled_tasks_codex_authority_snapshot_immutable_trg
    BEFORE UPDATE OF codex_provider_account_authority_snapshot
    ON %1$I.scheduled_tasks
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.prevent_codex_provider_account_authority_snapshot_mutation()
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE TRIGGER session_updates_codex_authority_snapshot_immutable_trg
    BEFORE UPDATE OF codex_provider_account_authority_snapshot
    ON %1$I.session_system_updates
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.prevent_codex_provider_account_authority_snapshot_mutation()
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE TRIGGER system_update_outbox_codex_authority_snapshot_immutable_trg
    BEFORE UPDATE OF codex_provider_account_authority_snapshot
    ON %1$I.session_system_update_outbox
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.prevent_codex_provider_account_authority_snapshot_mutation()
  $ddl$, data_schema);
END
$codex_provider_account_snapshot_immutability$;

-- Preserve the snapshot across the existing global child-result outbox claim.
-- Returning one additive column is rolling-safe for old consumers and gives a
-- future activation slice the exact stored boundary rather than a re-derived
-- ambient value.
DROP FUNCTION opengeni_private.claim_session_system_update_outbox(integer);
CREATE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, summary_codec_version integer,
  payload jsonb, payload_codec_version integer, lineage jsonb,
  personal_connection_delegations jsonb,
  codex_provider_account_authority_snapshot jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
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
      o.codex_provider_account_authority_snapshot;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;
DO $system_update_outbox_role_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
      TO opengeni_app;
  END IF;
END
$system_update_outbox_role_grant$;

COMMENT ON COLUMN "codex_subscription_credentials"."authority_scope" IS
  'Explicit workspace/user ownership fact. Existing and ordinary runtime-created rows remain workspace.';
COMMENT ON COLUMN "codex_subscription_credentials"."connected_by_subject_id" IS
  'Connection audit/redemption attribution only; never Codex credential ownership authority.';
COMMENT ON COLUMN "session_turns"."codex_provider_account_authority_snapshot" IS
  'Opaque identifier-free Codex provider-account authority snapshot; inert until a later activation slice.';
COMMENT ON COLUMN "scheduled_tasks"."codex_provider_account_authority_snapshot" IS
  'Opaque identifier-free Codex provider-account authority snapshot; legacy and current writers default workspace.';
COMMENT ON COLUMN "session_system_updates"."codex_provider_account_authority_snapshot" IS
  'Opaque identifier-free Codex provider-account authority snapshot for an accepted internal update.';
COMMENT ON COLUMN "session_system_update_outbox"."codex_provider_account_authority_snapshot" IS
  'Opaque identifier-free Codex provider-account authority snapshot for child-result delivery provenance.';
