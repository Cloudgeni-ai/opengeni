-- deployment-mode: maintenance
-- Canonical immutable BrowserIdentity revisions and encrypted browser-state artifacts.
-- The application and controller cut over together; there is no mutable-profile
-- compatibility path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "browser_identities" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "default_revision_id" uuid,
  "head_generation" bigint NOT NULL DEFAULT 0,
  "revision_count" bigint NOT NULL DEFAULT 0,
  "create_operation_id" uuid NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "browser_identities_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "browser_identities_status_check"
    CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "browser_identities_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND "head_generation" >= 0
    AND "revision_count" >= 0
    AND "head_generation" <= "revision_count"
    AND (
      ("head_generation" = 0 AND "default_revision_id" IS NULL)
      OR ("head_generation" > 0 AND "default_revision_id" IS NOT NULL)
    )
  ),
  CONSTRAINT "browser_identities_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "browser_identities_workspace_create_operation_uq"
    UNIQUE ("workspace_id", "create_operation_id")
);

CREATE UNIQUE INDEX "browser_identities_workspace_active_name_uq"
  ON "browser_identities" ("workspace_id", lower("name"))
  WHERE "status" = 'active';
CREATE INDEX "browser_identities_workspace_status_updated_idx"
  ON "browser_identities" ("workspace_id", "status", "updated_at", "id");

CREATE TABLE "browser_revisions" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "identity_id" uuid NOT NULL,
  "parent_revision_id" uuid,
  "ordinal" bigint NOT NULL,
  "source_browser_session_id" uuid NOT NULL,
  "publication_operation_id" uuid NOT NULL,
  "expected_head_generation" bigint NOT NULL,
  "advance_default_requested" boolean NOT NULL,
  "default_advanced" boolean NOT NULL,
  "result_head_generation" bigint NOT NULL,
  "manifest_digest" text NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "browser_revisions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "browser_revisions_identity_fk"
    FOREIGN KEY ("workspace_id", "identity_id")
    REFERENCES "browser_identities"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_revisions_source_session_fk"
    FOREIGN KEY ("workspace_id", "source_browser_session_id")
    REFERENCES "browser_sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_revisions_publication_operation_fk"
    FOREIGN KEY ("workspace_id", "publication_operation_id")
    REFERENCES "interaction_operations"("workspace_id", "operation_id") ON DELETE RESTRICT,
  CONSTRAINT "browser_revisions_values_check" CHECK (
    "ordinal" > 0
    AND "expected_head_generation" >= 0
    AND "result_head_generation" >= 0
    AND (NOT "default_advanced" OR "advance_default_requested")
    AND (NOT "default_advanced" OR "result_head_generation" = "expected_head_generation" + 1)
    AND "manifest_digest" ~ '^[0-9a-f]{64}$'
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND "parent_revision_id" IS DISTINCT FROM "id"
  ),
  CONSTRAINT "browser_revisions_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "browser_revisions_identity_id_uq" UNIQUE ("identity_id", "id"),
  CONSTRAINT "browser_revisions_workspace_identity_id_uq"
    UNIQUE ("workspace_id", "identity_id", "id"),
  CONSTRAINT "browser_revisions_workspace_identity_source_id_uq"
    UNIQUE ("workspace_id", "identity_id", "id", "source_browser_session_id"),
  CONSTRAINT "browser_revisions_identity_ordinal_uq" UNIQUE ("identity_id", "ordinal"),
  CONSTRAINT "browser_revisions_workspace_publication_operation_uq"
    UNIQUE ("workspace_id", "publication_operation_id"),
  CONSTRAINT "browser_revisions_parent_fk"
    FOREIGN KEY ("identity_id", "parent_revision_id")
    REFERENCES "browser_revisions"("identity_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "browser_revisions_identity_history_idx"
  ON "browser_revisions" ("workspace_id", "identity_id", "ordinal");

ALTER TABLE "browser_identities"
  ADD CONSTRAINT "browser_identities_default_revision_fk"
  FOREIGN KEY ("id", "default_revision_id")
  REFERENCES "browser_revisions"("identity_id", "id") ON DELETE RESTRICT;

CREATE TABLE "browser_state_artifacts" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_browser_session_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "kind" text NOT NULL,
  "format" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "content_digest" text NOT NULL,
  "manifest_digest" text NOT NULL,
  "object_key" text NOT NULL,
  "encrypted_data_key" text,
  "size_bytes" bigint NOT NULL,
  "materialization" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'available',
  "retained_until" timestamptz,
  "delete_claim_id" uuid,
  "delete_claimed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "browser_state_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "browser_state_artifacts_source_session_fk"
    FOREIGN KEY ("workspace_id", "source_browser_session_id")
    REFERENCES "browser_sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_state_artifacts_purpose_check"
    CHECK ("purpose" IN ('revision_component', 'private_checkpoint')),
  CONSTRAINT "browser_state_artifacts_kind_check"
    CHECK ("kind" IN ('chromium_profile', 'normalized_web_state', 'provider_snapshot')),
  CONSTRAINT "browser_state_artifacts_state_check"
    CHECK ("state" IN ('available', 'delete_pending', 'deleting', 'deleted')),
  CONSTRAINT "browser_state_artifacts_values_check" CHECK (
    octet_length("format") BETWEEN 1 AND 512
    AND "format" = btrim("format")
    AND "artifact_digest" ~ '^[0-9a-f]{64}$'
    AND "content_digest" ~ '^[0-9a-f]{64}$'
    AND "manifest_digest" ~ '^[0-9a-f]{64}$'
    AND octet_length("object_key") BETWEEN 1 AND 2048
    AND "object_key" ~ (
      '^workspaces/' || "workspace_id"::text ||
      '/browser-state/[A-Za-z0-9._=-]+(/[A-Za-z0-9._=-]+)*$'
    )
    AND (
      "encrypted_data_key" IS NULL
      OR octet_length("encrypted_data_key") BETWEEN 16 AND 8192
    )
    AND "size_bytes" > 0
    AND jsonb_typeof("materialization") = 'object'
    AND octet_length("materialization"::text) BETWEEN 2 AND 65536
    AND (
      "purpose" <> 'revision_component'
      OR (
        "state" = 'available'
        AND "retained_until" IS NULL
        AND "delete_claim_id" IS NULL
        AND "delete_claimed_at" IS NULL
        AND "deleted_at" IS NULL
        AND "encrypted_data_key" IS NOT NULL
      )
    )
  ),
  CONSTRAINT "browser_state_artifacts_lifecycle_check" CHECK (
    (
      "state" = 'available'
      AND "retained_until" IS NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NULL
      AND "encrypted_data_key" IS NOT NULL
    ) OR (
      "state" = 'delete_pending'
      AND "retained_until" IS NOT NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NULL
      AND "encrypted_data_key" IS NOT NULL
    ) OR (
      "state" = 'deleting'
      AND "retained_until" IS NOT NULL
      AND "delete_claim_id" IS NOT NULL
      AND "delete_claimed_at" IS NOT NULL
      AND "deleted_at" IS NULL
      AND "encrypted_data_key" IS NOT NULL
    ) OR (
      "state" = 'deleted'
      AND "retained_until" IS NOT NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NOT NULL
      AND "encrypted_data_key" IS NULL
    )
  ),
  CONSTRAINT "browser_state_artifacts_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "browser_state_artifacts_commit_authority_uq"
    UNIQUE ("workspace_id", "id", "purpose", "source_browser_session_id"),
  CONSTRAINT "browser_state_artifacts_component_authority_uq"
    UNIQUE ("workspace_id", "id", "purpose", "source_browser_session_id", "kind"),
  CONSTRAINT "browser_state_artifacts_object_key_uq" UNIQUE ("object_key")
);

CREATE INDEX "browser_state_artifacts_source_idx"
  ON "browser_state_artifacts" ("workspace_id", "source_browser_session_id", "created_at");
CREATE INDEX "browser_state_artifacts_gc_idx"
  ON "browser_state_artifacts" (
    "state", "retained_until", "delete_claimed_at", "created_at"
  );

CREATE TABLE "browser_state_uploads" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "source_browser_session_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "object_key" text NOT NULL,
  "state" text NOT NULL DEFAULT 'prepared',
  "cleanup_after" timestamptz,
  "committed_artifact_id" uuid,
  "delete_claim_id" uuid,
  "delete_claimed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "browser_state_uploads_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "browser_state_uploads_operation_fk"
    FOREIGN KEY ("workspace_id", "operation_id")
    REFERENCES "interaction_operations"("workspace_id", "operation_id") ON DELETE RESTRICT,
  CONSTRAINT "browser_state_uploads_source_session_fk"
    FOREIGN KEY ("workspace_id", "source_browser_session_id")
    REFERENCES "browser_sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_state_uploads_committed_artifact_fk"
    FOREIGN KEY (
      "workspace_id", "committed_artifact_id", "purpose", "source_browser_session_id"
    ) REFERENCES "browser_state_artifacts"(
      "workspace_id", "id", "purpose", "source_browser_session_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "browser_state_uploads_purpose_check"
    CHECK ("purpose" IN ('revision_component', 'private_checkpoint')),
  CONSTRAINT "browser_state_uploads_state_check"
    CHECK ("state" IN ('prepared', 'delete_pending', 'deleting', 'committed', 'deleted')),
  CONSTRAINT "browser_state_uploads_values_check" CHECK (
    octet_length("object_key") BETWEEN 1 AND 2048
    AND "object_key" ~ (
      '^workspaces/' || "workspace_id"::text ||
      '/browser-state/[A-Za-z0-9._=-]+(/[A-Za-z0-9._=-]+)*$'
    )
    AND "updated_at" >= "created_at"
  ),
  CONSTRAINT "browser_state_uploads_lifecycle_check" CHECK (
    (
      "state" = 'prepared'
      AND "cleanup_after" IS NOT NULL
      AND "committed_artifact_id" IS NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NULL
    ) OR (
      "state" = 'delete_pending'
      AND "cleanup_after" IS NOT NULL
      AND "committed_artifact_id" IS NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NULL
    ) OR (
      "state" = 'deleting'
      AND "cleanup_after" IS NOT NULL
      AND "committed_artifact_id" IS NULL
      AND "delete_claim_id" IS NOT NULL
      AND "delete_claimed_at" IS NOT NULL
      AND "deleted_at" IS NULL
    ) OR (
      "state" = 'committed'
      AND "cleanup_after" IS NULL
      AND "committed_artifact_id" IS NOT NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NULL
    ) OR (
      "state" = 'deleted'
      AND "cleanup_after" IS NOT NULL
      AND "committed_artifact_id" IS NULL
      AND "delete_claim_id" IS NULL
      AND "delete_claimed_at" IS NULL
      AND "deleted_at" IS NOT NULL
    )
  ),
  CONSTRAINT "browser_state_uploads_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "browser_state_uploads_operation_object_uq"
    UNIQUE ("workspace_id", "operation_id", "object_key"),
  CONSTRAINT "browser_state_uploads_object_key_uq" UNIQUE ("object_key")
);

CREATE INDEX "browser_state_uploads_gc_idx"
  ON "browser_state_uploads" (
    "state", "cleanup_after", "delete_claimed_at", "created_at"
  );

CREATE TABLE "browser_revision_components" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "identity_id" uuid NOT NULL,
  "revision_id" uuid NOT NULL,
  "artifact_id" uuid NOT NULL,
  "source_browser_session_id" uuid NOT NULL,
  "artifact_purpose" text NOT NULL DEFAULT 'revision_component',
  "kind" text NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "browser_revision_components_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "browser_revision_components_revision_fk"
    FOREIGN KEY (
      "workspace_id", "identity_id", "revision_id", "source_browser_session_id"
    )
    REFERENCES "browser_revisions"(
      "workspace_id", "identity_id", "id", "source_browser_session_id"
    ) ON DELETE CASCADE,
  CONSTRAINT "browser_revision_components_artifact_fk"
    FOREIGN KEY (
      "workspace_id", "artifact_id", "artifact_purpose", "source_browser_session_id", "kind"
    )
    REFERENCES "browser_state_artifacts"(
      "workspace_id", "id", "purpose", "source_browser_session_id", "kind"
    ) ON DELETE RESTRICT,
  CONSTRAINT "browser_revision_components_values_check" CHECK (
    "position" BETWEEN 0 AND 15
    AND "artifact_purpose" = 'revision_component'
    AND "kind" IN ('chromium_profile', 'normalized_web_state', 'provider_snapshot')
  ),
  CONSTRAINT "browser_revision_components_workspace_id_uq"
    UNIQUE ("workspace_id", "id"),
  CONSTRAINT "browser_revision_components_revision_position_uq"
    UNIQUE ("revision_id", "position"),
  CONSTRAINT "browser_revision_components_revision_kind_uq"
    UNIQUE ("revision_id", "kind"),
  CONSTRAINT "browser_revision_components_artifact_uq" UNIQUE ("artifact_id")
);

CREATE INDEX "browser_revision_components_revision_idx"
  ON "browser_revision_components" ("workspace_id", "revision_id", "position");

CREATE FUNCTION opengeni_private.browser_identities_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.create_operation_id,
    NEW.created_by_subject_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.create_operation_id,
    OLD.created_by_subject_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'BrowserIdentity immutable authority cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision_count < OLD.revision_count
     OR NEW.revision_count > OLD.revision_count + 1 THEN
    RAISE EXCEPTION 'BrowserIdentity revision count must advance monotonically by one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.default_revision_id IS DISTINCT FROM OLD.default_revision_id THEN
    IF NEW.head_generation <> OLD.head_generation + 1 THEN
      RAISE EXCEPTION 'BrowserIdentity default change must advance its head generation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.head_generation <> OLD.head_generation THEN
    RAISE EXCEPTION 'BrowserIdentity head generation requires a default change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'BrowserIdentity updated time cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "browser_identities_update_guard_trg"
BEFORE UPDATE ON "browser_identities"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_identities_update_guard();

CREATE FUNCTION opengeni_private.browser_state_artifacts_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.source_browser_session_id,
    NEW.purpose, NEW.kind, NEW.format, NEW.artifact_digest, NEW.content_digest,
    NEW.manifest_digest, NEW.object_key, NEW.size_bytes, NEW.materialization,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.source_browser_session_id,
    OLD.purpose, OLD.kind, OLD.format, OLD.artifact_digest, OLD.content_digest,
    OLD.manifest_digest, OLD.object_key, OLD.size_bytes, OLD.materialization,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Browser state artifact immutable authority cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.purpose = 'revision_component'
     AND ROW(
       NEW.state, NEW.retained_until, NEW.delete_claim_id, NEW.delete_claimed_at,
       NEW.deleted_at, NEW.encrypted_data_key
     ) IS DISTINCT FROM ROW(
       OLD.state, OLD.retained_until, OLD.delete_claim_id, OLD.delete_claimed_at,
       OLD.deleted_at, OLD.encrypted_data_key
     ) THEN
    RAISE EXCEPTION 'Published BrowserRevision artifact immutable authority cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'available' AND NEW.state = 'delete_pending')
       OR (OLD.state = 'delete_pending' AND NEW.state = 'deleting')
       OR (OLD.state = 'deleting' AND NEW.state = 'deleted')
     ) THEN
    RAISE EXCEPTION 'Browser state artifact lifecycle cannot move backwards or skip a phase'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state AND NEW.state <> 'deleting'
     AND ROW(
       NEW.retained_until, NEW.delete_claim_id, NEW.delete_claimed_at,
       NEW.deleted_at, NEW.encrypted_data_key
     ) IS DISTINCT FROM ROW(
       OLD.retained_until, OLD.delete_claim_id, OLD.delete_claimed_at,
       OLD.deleted_at, OLD.encrypted_data_key
     ) THEN
    RAISE EXCEPTION 'Browser state artifact lifecycle authority cannot change in place'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state AND NEW.state = 'deleting'
     AND (
       NEW.retained_until IS DISTINCT FROM OLD.retained_until
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.encrypted_data_key IS DISTINCT FROM OLD.encrypted_data_key
       OR NEW.delete_claimed_at < OLD.delete_claimed_at
     ) THEN
    RAISE EXCEPTION 'Browser state artifact delete claim cannot weaken authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "browser_state_artifacts_update_guard_trg"
BEFORE UPDATE ON "browser_state_artifacts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_state_artifacts_update_guard();

CREATE FUNCTION opengeni_private.browser_state_uploads_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.operation_id,
    NEW.source_browser_session_id, NEW.purpose, NEW.object_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.operation_id,
    OLD.source_browser_session_id, OLD.purpose, OLD.object_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Browser state upload immutable authority cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'prepared' AND NEW.state IN ('delete_pending', 'deleting', 'committed'))
       OR (OLD.state = 'delete_pending' AND NEW.state = 'deleting')
       OR (OLD.state = 'deleting' AND NEW.state = 'deleted')
     ) THEN
    RAISE EXCEPTION 'Browser state upload lifecycle cannot move backwards or skip authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state AND NEW.state = 'prepared'
     AND (
       NEW.cleanup_after < OLD.cleanup_after
       OR NEW.committed_artifact_id IS DISTINCT FROM OLD.committed_artifact_id
       OR NEW.delete_claim_id IS DISTINCT FROM OLD.delete_claim_id
       OR NEW.delete_claimed_at IS DISTINCT FROM OLD.delete_claimed_at
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     ) THEN
    RAISE EXCEPTION 'Browser state upload lease cannot weaken authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state AND NEW.state NOT IN ('prepared', 'deleting')
     AND ROW(
       NEW.cleanup_after, NEW.committed_artifact_id, NEW.delete_claim_id,
       NEW.delete_claimed_at, NEW.deleted_at
     ) IS DISTINCT FROM ROW(
       OLD.cleanup_after, OLD.committed_artifact_id, OLD.delete_claim_id,
       OLD.delete_claimed_at, OLD.deleted_at
     ) THEN
    RAISE EXCEPTION 'Browser state upload lifecycle authority cannot change in place'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state AND NEW.state = 'deleting'
     AND (
       NEW.cleanup_after IS DISTINCT FROM OLD.cleanup_after
       OR NEW.committed_artifact_id IS DISTINCT FROM OLD.committed_artifact_id
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.delete_claimed_at < OLD.delete_claimed_at
     ) THEN
    RAISE EXCEPTION 'Browser state upload delete claim cannot weaken authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Browser state upload time cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "browser_state_uploads_update_guard_trg"
BEFORE UPDATE ON "browser_state_uploads"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_state_uploads_update_guard();

REVOKE ALL ON FUNCTION opengeni_private.browser_identities_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.browser_state_artifacts_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.browser_state_uploads_update_guard() FROM PUBLIC;

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_identity_fk"
    FOREIGN KEY ("workspace_id", "identity_id")
    REFERENCES "browser_identities"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "browser_sessions_base_revision_fk"
    FOREIGN KEY ("identity_id", "base_revision_id")
    REFERENCES "browser_revisions"("identity_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "browser_sessions_private_checkpoint_fk"
    FOREIGN KEY ("workspace_id", "private_checkpoint_artifact_id")
    REFERENCES "browser_state_artifacts"("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "interaction_operations"
  DROP CONSTRAINT "interaction_operations_kind_check";
ALTER TABLE "interaction_operations"
  ADD CONSTRAINT "interaction_operations_kind_check"
    CHECK ("kind" IN ('create', 'resume', 'suspend', 'end', 'publish'));

ALTER TABLE "browser_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "browser_identities"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "browser_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "browser_revisions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "browser_state_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_state_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "browser_state_artifacts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "browser_state_uploads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_state_uploads" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "browser_state_uploads"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- This is the sole bounded FORCE-RLS bypass for browser artifact collection.
-- Claims are reclaimable after worker loss; provider deletes are idempotent.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(
      p_claim_timeout_ms bigint,
      p_limit integer
    )
    RETURNS TABLE (
      claim_id uuid,
      artifact_id uuid,
      account_id uuid,
      workspace_id uuid,
      object_key text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      WITH candidates AS (
        SELECT A.id, gen_random_uuid() AS claim_id
        FROM %1$I.browser_state_artifacts A
        WHERE A.purpose = 'private_checkpoint'
          AND (
            (
              A.state = 'delete_pending'
              AND A.retained_until <= clock_timestamp()
            )
            OR (
              A.state = 'deleting'
              AND A.delete_claimed_at <= clock_timestamp() - (
                greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
              )
            )
          )
        ORDER BY coalesce(A.delete_claimed_at, A.retained_until), A.id
        LIMIT least(greatest(p_limit, 0), 1000)
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE %1$I.browser_state_artifacts A
        SET state = 'deleting',
          delete_claim_id = C.claim_id,
          delete_claimed_at = clock_timestamp()
        FROM candidates C
        WHERE A.id = C.id
        RETURNING A.*, C.claim_id
      )
      SELECT C.claim_id, C.id, C.account_id, C.workspace_id, C.object_key
      FROM claimed C;
    $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(bigint, integer)
  FROM PUBLIC;

-- Fence orphan direct uploads before deleting their exact object. Expired live
-- operations fail before dispatch or become outcome-unknown after it in the
-- same transaction; suspension returns active only pre-dispatch, else lost.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_browser_state_upload_cleanup(
      p_claim_timeout_ms bigint,
      p_limit integer
    )
    RETURNS TABLE (
      claim_id uuid,
      upload_id uuid,
      account_id uuid,
      workspace_id uuid,
      object_key text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      WITH due AS MATERIALIZED (
        SELECT U.id, U.workspace_id, U.operation_id
        FROM %1$I.browser_state_uploads U
        WHERE (
            U.state IN ('prepared', 'delete_pending')
            AND U.cleanup_after <= clock_timestamp()
          ) OR (
            U.state = 'deleting'
            AND U.delete_claimed_at <= clock_timestamp() - (
              greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
            )
          )
        ORDER BY coalesce(U.delete_claimed_at, U.cleanup_after), U.id
        LIMIT least(greatest(p_limit, 0), 1000)
      ), locked_operations AS MATERIALIZED (
        SELECT O.workspace_id, O.operation_id,
          O.state AS operation_state, O.kind AS operation_kind
        FROM %1$I.interaction_operations O
        WHERE EXISTS (
          SELECT 1 FROM due D
          WHERE D.workspace_id = O.workspace_id
            AND D.operation_id = O.operation_id
        )
        FOR UPDATE OF O SKIP LOCKED
      ), candidates AS (
        SELECT U.id, gen_random_uuid() AS claim_id, U.state AS upload_state,
          O.operation_state, O.operation_kind
        FROM due D
        JOIN locked_operations O
          ON O.workspace_id = D.workspace_id
         AND O.operation_id = D.operation_id
        JOIN %1$I.browser_state_uploads U ON U.id = D.id
        WHERE (
            U.state IN ('prepared', 'delete_pending')
            AND U.cleanup_after <= clock_timestamp()
          ) OR (
            U.state = 'deleting'
            AND U.delete_claimed_at <= clock_timestamp() - (
              greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
            )
          )
        ORDER BY coalesce(U.delete_claimed_at, U.cleanup_after), U.id
        FOR UPDATE OF U SKIP LOCKED
      ), claimed AS (
        UPDATE %1$I.browser_state_uploads U
        SET state = 'deleting', delete_claim_id = C.claim_id,
          delete_claimed_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM candidates C
        WHERE U.id = C.id
        RETURNING U.*, C.claim_id, C.upload_state, C.operation_state, C.operation_kind
      ), timed_out_operations AS (
        UPDATE %1$I.interaction_operations O
        SET state = CASE
            WHEN C.operation_state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'failed'
          END,
          error_code = 'browser_state_upload_expired',
          error_message = CASE
            WHEN C.operation_state = 'dispatched'
              THEN 'Browser state upload outcome was not published before its authority expired'
            ELSE 'Browser state upload authority expired before dispatch'
          END,
          error_retryable = false, error_details = null,
          settled_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM claimed C
        WHERE C.upload_state = 'prepared'
          AND O.workspace_id = C.workspace_id
          AND O.operation_id = C.operation_id
          AND O.state IN ('prepared', 'dispatched')
        RETURNING O.account_id, O.workspace_id, O.resource_id, O.kind,
          C.operation_state
      ), timed_out_sessions AS (
        UPDATE %1$I.browser_sessions S
        SET lifecycle = CASE
            WHEN T.operation_state = 'dispatched' THEN 'lost'
            ELSE 'active'
          END,
          failure_code = CASE
            WHEN T.operation_state = 'dispatched' THEN 'browser_state_upload_expired'
            ELSE NULL
          END,
          updated_at = clock_timestamp()
        FROM timed_out_operations T
        WHERE T.kind = 'suspend'
          AND S.workspace_id = T.workspace_id
          AND S.id = T.resource_id
          AND S.lifecycle = 'suspending'
        RETURNING S.account_id, S.workspace_id
      ), advanced_revisions AS (
        UPDATE %1$I.workspace_interaction_revisions R
        SET revision = R.revision + 1, updated_at = clock_timestamp()
        FROM (
          SELECT DISTINCT account_id, workspace_id FROM timed_out_sessions
        ) S
        WHERE R.account_id = S.account_id AND R.workspace_id = S.workspace_id
        RETURNING R.workspace_id
      )
      SELECT C.claim_id, C.id, C.account_id, C.workspace_id, C.object_key
      FROM claimed C;
    $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_browser_state_upload_cleanup(bigint, integer)
  FROM PUBLIC;

ALTER TABLE "browser_revision_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_revision_components" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "browser_revision_components"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(bigint, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_browser_state_upload_cleanup(bigint, integer)
      TO opengeni_app;
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.browser_identities, %I.browser_revisions, %I.browser_state_artifacts, %I.browser_state_uploads, %I.browser_revision_components FROM opengeni_app',
      target_schema, target_schema, target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.browser_identities TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.browser_revisions TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.browser_state_artifacts TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.browser_state_uploads TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.browser_revision_components TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
