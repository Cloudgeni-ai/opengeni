-- deployment-mode: rolling
-- Backend-only workspace instruction-policy foundation. This migration performs no
-- backfill: workspaces without an activation head retain legacy behavior.

CREATE SEQUENCE IF NOT EXISTS "workspace_instruction_policy_revision_seq" AS bigint;

CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL DEFAULT nextval('workspace_instruction_policy_revision_seq'),
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "role_key" text,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "provenance_source" text NOT NULL,
  "provenance_source_id" text,
  "supersedes_revision_id" uuid REFERENCES "workspace_instruction_policy_revisions"("id") ON DELETE RESTRICT,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_instruction_policy_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "workspace_instruction_policy_revisions_target_chk" CHECK (
    ("kind" = 'charter' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'role' AND "role_key" IS NOT NULL)
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_role_key_chk" CHECK (
    "role_key" IS NULL
    OR (
      "role_key" = lower(btrim("role_key"))
      AND length("role_key") BETWEEN 1 AND 64
      AND "role_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "role_key" !~ '--'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_content_chk" CHECK (
    length(btrim("content")) > 0 AND octet_length("content") <= 1048576
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_hash_chk" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
    AND "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex')
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_provenance_chk" CHECK (
    "provenance_source" IN ('human', 'onboarding', 'knowledge_proposal', 'legacy_import')
    AND ("provenance_source_id" IS NULL OR length("provenance_source_id") BETWEEN 1 AND 512)
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_instruction_policy_revisions_workspace_revision_uq"
    UNIQUE ("workspace_id", "revision")
);

CREATE INDEX IF NOT EXISTS "workspace_instruction_policy_revisions_workspace_history_idx"
  ON "workspace_instruction_policy_revisions"
  ("workspace_id", "kind", "scope", "role_key", "revision" DESC);

CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_heads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "role_key" text,
  "revision_id" uuid NOT NULL REFERENCES "workspace_instruction_policy_revisions"("id") ON DELETE RESTRICT,
  "revision" bigint NOT NULL,
  "content_hash" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_instruction_policy_heads_target_chk" CHECK (
    ("kind" = 'charter' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'role' AND "role_key" IS NOT NULL)
  ),
  CONSTRAINT "workspace_instruction_policy_heads_role_key_chk" CHECK (
    "role_key" IS NULL
    OR (
      "role_key" = lower(btrim("role_key"))
      AND length("role_key") BETWEEN 1 AND 64
      AND "role_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "role_key" !~ '--'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_heads_revision_chk" CHECK (
    "revision" > 0 AND "activation_version" > 0 AND "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_instruction_policy_heads_charter_uq"
  ON "workspace_instruction_policy_heads" ("workspace_id")
  WHERE "kind" = 'charter';

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_instruction_policy_heads_global_policy_uq"
  ON "workspace_instruction_policy_heads" ("workspace_id")
  WHERE "kind" = 'policy' AND "scope" = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_instruction_policy_heads_role_policy_uq"
  ON "workspace_instruction_policy_heads" ("workspace_id", "role_key")
  WHERE "kind" = 'policy' AND "scope" = 'role';

CREATE TABLE IF NOT EXISTS "workspace_instruction_policy_activation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "role_key" text,
  "type" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "old_revision_id" uuid REFERENCES "workspace_instruction_policy_revisions"("id") ON DELETE RESTRICT,
  "old_revision" bigint,
  "old_content_hash" text,
  "new_revision_id" uuid NOT NULL REFERENCES "workspace_instruction_policy_revisions"("id") ON DELETE RESTRICT,
  "new_revision" bigint NOT NULL,
  "new_content_hash" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_instruction_policy_activation_events_type_chk" CHECK (
    "type" IN ('activate', 'rollback')
  ),
  CONSTRAINT "workspace_instruction_policy_activation_events_target_chk" CHECK (
    ("kind" = 'charter' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'role' AND "role_key" IS NOT NULL)
  ),
  CONSTRAINT "workspace_instruction_policy_activation_events_role_key_chk" CHECK (
    "role_key" IS NULL
    OR (
      "role_key" = lower(btrim("role_key"))
      AND length("role_key") BETWEEN 1 AND 64
      AND "role_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "role_key" !~ '--'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_activation_events_old_revision_chk" CHECK (
    ("old_revision_id" IS NULL AND "old_revision" IS NULL AND "old_content_hash" IS NULL)
    OR (
      "old_revision_id" IS NOT NULL
      AND "old_revision" > 0
      AND "old_content_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_activation_events_new_revision_chk" CHECK (
    "new_revision" > 0
    AND "new_content_hash" ~ '^[0-9a-f]{64}$'
    AND "activation_version" > 0
  ),
  CONSTRAINT "workspace_instruction_policy_activation_events_audit_chk" CHECK (
    length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("reason")) BETWEEN 1 AND 4096
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_instruction_policy_events_target_version_uq"
  ON "workspace_instruction_policy_activation_events"
  ("workspace_id", "kind", "scope", coalesce("role_key", ''), "activation_version");

CREATE INDEX IF NOT EXISTS "workspace_instruction_policy_events_workspace_time_idx"
  ON "workspace_instruction_policy_activation_events" ("workspace_id", "created_at" DESC, "id");

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_revision_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_workspace_id uuid;
  target_kind text;
  target_scope text;
  target_role_key text;
BEGIN
  IF NEW."supersedes_revision_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "workspace_id", "kind", "scope", "role_key"
    INTO target_workspace_id, target_kind, target_scope, target_role_key
    FROM "workspace_instruction_policy_revisions"
    WHERE "id" = NEW."supersedes_revision_id";
  IF NOT FOUND
    OR target_workspace_id IS DISTINCT FROM NEW."workspace_id"
    OR target_kind IS DISTINCT FROM NEW."kind"
    OR target_scope IS DISTINCT FROM NEW."scope"
    OR target_role_key IS DISTINCT FROM NEW."role_key"
  THEN
    RAISE EXCEPTION 'superseded instruction-policy revision must use the same workspace and target'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_revisions_validate_link
  ON "workspace_instruction_policy_revisions";
CREATE TRIGGER workspace_instruction_policy_revisions_validate_link
  BEFORE INSERT OR UPDATE ON "workspace_instruction_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_revision_link();

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."revision"
      AND revision."content_hash" = NEW."content_hash"
  ) THEN
    RAISE EXCEPTION 'instruction-policy head must identify an exact target revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_heads_validate_revision
  ON "workspace_instruction_policy_heads";
CREATE TRIGGER workspace_instruction_policy_heads_validate_revision
  BEFORE INSERT OR UPDATE ON "workspace_instruction_policy_heads"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_head();

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."new_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."new_revision"
      AND revision."content_hash" = NEW."new_content_hash"
  ) THEN
    RAISE EXCEPTION 'instruction-policy activation event has an invalid new revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."old_revision_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."old_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."old_revision"
      AND revision."content_hash" = NEW."old_content_hash"
  ) THEN
    RAISE EXCEPTION 'instruction-policy activation event has an invalid old revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_events_validate_revisions
  ON "workspace_instruction_policy_activation_events";
CREATE TRIGGER workspace_instruction_policy_events_validate_revisions
  BEFORE INSERT OR UPDATE ON "workspace_instruction_policy_activation_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_event();

CREATE OR REPLACE FUNCTION workspace_instruction_policy_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace instruction-policy history is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_revisions_immutable
  ON "workspace_instruction_policy_revisions";
CREATE TRIGGER workspace_instruction_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON "workspace_instruction_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

DROP TRIGGER IF EXISTS workspace_instruction_policy_events_immutable
  ON "workspace_instruction_policy_activation_events";
CREATE TRIGGER workspace_instruction_policy_events_immutable
  BEFORE UPDATE OR DELETE ON "workspace_instruction_policy_activation_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

ALTER TABLE "workspace_instruction_policy_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_activation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_activation_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_isolation ON "workspace_instruction_policy_revisions";
CREATE POLICY workspace_isolation ON "workspace_instruction_policy_revisions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DROP POLICY IF EXISTS workspace_isolation ON "workspace_instruction_policy_heads";
CREATE POLICY workspace_isolation ON "workspace_instruction_policy_heads"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DROP POLICY IF EXISTS workspace_isolation ON "workspace_instruction_policy_activation_events";
CREATE POLICY workspace_isolation ON "workspace_instruction_policy_activation_events"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));