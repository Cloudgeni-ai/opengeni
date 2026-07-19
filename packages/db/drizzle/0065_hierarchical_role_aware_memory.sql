-- deployment-mode: rolling
-- OPE-29: additive typed scopes, labels, provenance, relationships, and
-- reversible maintenance plans for hierarchical role-aware memory.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "created_by_subject_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_created_by_subject_nonempty'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_subject_nonempty"
      CHECK (
        "created_by_subject_id" IS NULL
        OR length(btrim("created_by_subject_id")) > 0
      );
  END IF;
END $$;

ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "scope_type" text;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "scope_subject_id" text;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "scope_role_key" text;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "scope_session_id" uuid;
ALTER TABLE "knowledge_memories"
  ADD COLUMN IF NOT EXISTS "labels" text[] NOT NULL DEFAULT '{}'::text[];

-- Preserve the old free-form scope as a compatibility projection. Known
-- workspace rows keep their behavior; every unknown historical convention is
-- fail-closed legacy data until a human explicitly reclassifies it.
UPDATE "knowledge_memories"
SET "scope_type" = CASE WHEN "scope" = 'workspace' THEN 'workspace' ELSE 'legacy' END
WHERE "scope_type" IS NULL;

-- During a rolling deploy, old writers still only populate `scope`. The trigger
-- derives a safe typed value for their inserts and scope-only updates; a new
-- writer that changes both fields keeps its explicit typed scope.
CREATE OR REPLACE FUNCTION opengeni_private.derive_memory_scope_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope_type IS NULL
     OR (
       TG_OP = 'UPDATE'
       AND NEW.scope IS DISTINCT FROM OLD.scope
       AND NEW.scope_type IS NOT DISTINCT FROM OLD.scope_type
     ) THEN
    NEW.scope_type := CASE WHEN NEW.scope = 'workspace' THEN 'workspace' ELSE 'legacy' END;
    NEW.scope_subject_id := NULL;
    NEW.scope_role_key := NULL;
    NEW.scope_session_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_memories_derive_scope_type ON "knowledge_memories";
CREATE TRIGGER knowledge_memories_derive_scope_type
BEFORE INSERT OR UPDATE OF "scope", "scope_type" ON "knowledge_memories"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.derive_memory_scope_type();

ALTER TABLE "knowledge_memories" ALTER COLUMN "scope_type" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_scope_selector_check'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_scope_selector_check"
      CHECK (
        ("scope_type" = 'workspace'
          AND "scope_subject_id" IS NULL AND "scope_role_key" IS NULL AND "scope_session_id" IS NULL)
        OR ("scope_type" = 'user'
          AND "scope_subject_id" IS NOT NULL
          AND length(btrim("scope_subject_id")) > 0
          AND "scope_role_key" IS NULL AND "scope_session_id" IS NULL)
        OR ("scope_type" = 'role'
          AND "scope_subject_id" IS NULL
          AND "scope_role_key" IS NOT NULL
          AND length(btrim("scope_role_key")) > 0
          AND "scope_session_id" IS NULL)
        OR ("scope_type" = 'session'
          AND "scope_subject_id" IS NULL AND "scope_role_key" IS NULL
          AND "scope_session_id" IS NOT NULL)
        OR ("scope_type" = 'ephemeral'
          AND "scope_subject_id" IS NULL AND "scope_role_key" IS NULL
          AND "scope_session_id" IS NOT NULL AND "valid_until" IS NOT NULL)
        OR ("scope_type" = 'legacy'
          AND "scope_subject_id" IS NULL AND "scope_role_key" IS NULL AND "scope_session_id" IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_valid_window_check'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_valid_window_check"
      CHECK ("valid_until" IS NULL OR "valid_from" < "valid_until");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_scope_session_fk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_scope_session_fk"
      FOREIGN KEY ("workspace_id", "scope_session_id")
      REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.memory_labels_valid(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_length(value, 1), 0) <= 16
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS label
      WHERE label !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
    )
    AND cardinality(value) = cardinality(ARRAY(SELECT DISTINCT label FROM unnest(value) AS label));
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_labels_check'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_labels_check"
      CHECK (opengeni_private.memory_labels_valid("labels"));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_memories_workspace_id_uq"
  ON "knowledge_memories" ("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_typed_scope_idx"
  ON "knowledge_memories" ("workspace_id", "scope_type", "scope_subject_id", "scope_role_key", "scope_session_id");
CREATE INDEX IF NOT EXISTS "knowledge_memories_labels_idx"
  ON "knowledge_memories" USING gin ("labels");

-- Exact dedup is scope-local. The V1 workspace-only index would incorrectly
-- merge equal text belonging to different users, roles, or sessions.
DROP INDEX IF EXISTS "knowledge_memories_workspace_visible_text_hash_uq";
CREATE UNIQUE INDEX "knowledge_memories_scope_visible_text_hash_uq"
  ON "knowledge_memories" (
    "workspace_id", "scope_type", "scope_subject_id", "scope_role_key", "scope_session_id", "text_hash"
  ) NULLS NOT DISTINCT
  WHERE "status" IN ('active', 'approved') AND "text_hash" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "knowledge_memory_relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_memory_id" uuid NOT NULL,
  "target_memory_id" uuid NOT NULL,
  "relationship_type" text NOT NULL,
  "actor_subject_id" text,
  "actor_session_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_memory_relationships_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_relationships_source_fk"
    FOREIGN KEY ("workspace_id", "source_memory_id")
    REFERENCES "knowledge_memories"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_relationships_target_fk"
    FOREIGN KEY ("workspace_id", "target_memory_id")
    REFERENCES "knowledge_memories"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_relationships_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("actor_session_id"),
  CONSTRAINT "knowledge_memory_relationships_type_check"
    CHECK ("relationship_type" IN (
      'derived_from', 'supersedes', 'contradicts', 'related_to', 'applies_to', 'depends_on'
    )),
  CONSTRAINT "knowledge_memory_relationships_distinct_check"
    CHECK ("source_memory_id" <> "target_memory_id"),
  CONSTRAINT "knowledge_memory_relationships_actor_subject_nonempty"
    CHECK ("actor_subject_id" IS NULL OR length(btrim("actor_subject_id")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_memory_relationships_edge_uq"
  ON "knowledge_memory_relationships" (
    "workspace_id", "source_memory_id", "target_memory_id", "relationship_type"
  );
-- Symmetric relationships have one database identity regardless of endpoint
-- order. Application canonicalization makes normal writes deterministic; this
-- expression index also protects against reverse edges from raw/older writers.
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_memory_relationships_symmetric_edge_uq"
  ON "knowledge_memory_relationships" (
    "workspace_id",
    "relationship_type",
    LEAST("source_memory_id", "target_memory_id"),
    GREATEST("source_memory_id", "target_memory_id")
  )
  WHERE "relationship_type" IN ('contradicts', 'related_to');
CREATE INDEX IF NOT EXISTS "knowledge_memory_relationships_source_idx"
  ON "knowledge_memory_relationships" ("workspace_id", "source_memory_id", "created_at");
CREATE INDEX IF NOT EXISTS "knowledge_memory_relationships_target_idx"
  ON "knowledge_memory_relationships" ("workspace_id", "target_memory_id", "created_at");

CREATE TABLE IF NOT EXISTS "knowledge_memory_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "operation_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'previewed',
  "actor_subject_id" text NOT NULL,
  "actor_session_id" uuid,
  "plan_hash" text NOT NULL,
  "plan" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "inverse_plan" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "applied_at" timestamptz,
  "reverted_at" timestamptz,
  CONSTRAINT "knowledge_memory_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_operations_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("actor_session_id"),
  CONSTRAINT "knowledge_memory_operations_type_check"
    CHECK ("operation_type" IN ('retention', 'reconcile')),
  CONSTRAINT "knowledge_memory_operations_status_check"
    CHECK ("status" IN ('previewed', 'applied', 'reverted')),
  CONSTRAINT "knowledge_memory_operations_subject_nonempty"
    CHECK (length(btrim("actor_subject_id")) > 0),
  CONSTRAINT "knowledge_memory_operations_plan_hash_check"
    CHECK ("plan_hash" ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS "knowledge_memory_operations_actor_created_idx"
  ON "knowledge_memory_operations" ("workspace_id", "actor_subject_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "knowledge_memory_deletion_audits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "memory_id" uuid NOT NULL,
  "actor_subject_id" text NOT NULL,
  "actor_session_id" uuid,
  "deleted_relationship_count" integer NOT NULL DEFAULT 0,
  "deleted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_memory_deletion_audits_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_deletion_audits_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("actor_session_id"),
  CONSTRAINT "knowledge_memory_deletion_audits_subject_nonempty"
    CHECK (length(btrim("actor_subject_id")) > 0),
  CONSTRAINT "knowledge_memory_deletion_audits_relationship_count_check"
    CHECK ("deleted_relationship_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "knowledge_memory_deletion_audits_actor_deleted_idx"
  ON "knowledge_memory_deletion_audits" ("workspace_id", "actor_subject_id", "deleted_at" DESC);

CREATE TABLE IF NOT EXISTS "knowledge_memory_export_audits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "actor_subject_id" text NOT NULL,
  "actor_session_id" uuid,
  "included_private" boolean NOT NULL DEFAULT true,
  "included_ephemeral" boolean NOT NULL DEFAULT false,
  "memory_count" integer NOT NULL,
  "relationship_count" integer NOT NULL,
  "exported_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_memory_export_audits_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_memory_export_audits_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("actor_session_id"),
  CONSTRAINT "knowledge_memory_export_audits_subject_nonempty"
    CHECK (length(btrim("actor_subject_id")) > 0),
  CONSTRAINT "knowledge_memory_export_audits_private_check"
    CHECK ("included_private"),
  CONSTRAINT "knowledge_memory_export_audits_counts_check"
    CHECK ("memory_count" >= 0 AND "relationship_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "knowledge_memory_export_audits_actor_exported_idx"
  ON "knowledge_memory_export_audits" ("workspace_id", "actor_subject_id", "exported_at" DESC);

CREATE OR REPLACE FUNCTION opengeni_private.current_memory_private_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(nullif(current_setting('opengeni.memory_private_admin', true), '')::boolean, false);
$$;

ALTER TABLE "knowledge_memory_relationships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_relationships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_deletion_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_deletion_audits" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_export_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memory_export_audits" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'knowledge_memories' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memories";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'knowledge_memory_relationships' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memory_relationships";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'knowledge_memory_operations' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memory_operations";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'knowledge_memory_deletion_audits' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memory_deletion_audits";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'knowledge_memory_export_audits' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memory_export_audits";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "knowledge_memories"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      scope_type <> 'user'
      OR scope_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      scope_type <> 'user'
      OR scope_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  );

CREATE POLICY workspace_isolation ON "knowledge_memory_relationships"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM "knowledge_memories" source
      WHERE source.workspace_id = knowledge_memory_relationships.workspace_id
        AND source.id = knowledge_memory_relationships.source_memory_id
    )
    AND EXISTS (
      SELECT 1 FROM "knowledge_memories" target
      WHERE target.workspace_id = knowledge_memory_relationships.workspace_id
        AND target.id = knowledge_memory_relationships.target_memory_id
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM "knowledge_memories" source
      WHERE source.workspace_id = knowledge_memory_relationships.workspace_id
        AND source.id = knowledge_memory_relationships.source_memory_id
    )
    AND EXISTS (
      SELECT 1 FROM "knowledge_memories" target
      WHERE target.workspace_id = knowledge_memory_relationships.workspace_id
        AND target.id = knowledge_memory_relationships.target_memory_id
    )
  );

CREATE POLICY workspace_isolation ON "knowledge_memory_operations"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  );

CREATE POLICY workspace_isolation ON "knowledge_memory_deletion_audits"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  );

CREATE POLICY workspace_isolation ON "knowledge_memory_export_audits"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      actor_subject_id = opengeni_private.current_subject_id()
      OR opengeni_private.current_memory_private_admin()
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;