-- deployment-mode: maintenance
-- Generic, versioned workspace-published HTML artifacts. Existing sessions
-- retain their immutable capability policy; only newly created sessions use
-- the artifact tools added to the application default catalog.

-- NULL meant "the then-current worker default" before artifact permissions
-- existed. Freeze that exact historical default before the application default
-- widens. Explicit [] and every explicit narrow array remain byte-for-byte
-- unchanged. first_party_mcp_tools has been explicit and NOT NULL since 0136;
-- do not append the new artifact tools to any historical selection.
UPDATE "sessions"
SET "first_party_mcp_permissions" = '[
  "workspace:read",
  "files:read",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "goals:manage",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "variable-sets:use",
  "variable-sets:manage",
  "rigs:use",
  "github:use"
]'::jsonb
WHERE "first_party_mcp_permissions" IS NULL;

ALTER TABLE "sessions"
  ALTER COLUMN "first_party_mcp_tools"
  SET DEFAULT '[
    "set_session_title",
    "goal_set",
    "goal_update",
    "goal_complete",
    "goal_pause",
    "memory_search",
    "memory_save",
    "memory_correct",
    "preference_registry_summary",
    "preference_registry_get",
    "sandboxes_list",
    "sandbox_attach",
    "sandbox_swap",
    "run_on",
    "sandbox_provision",
    "rig_list",
    "rig_get",
    "rig_propose_change",
    "rig_verify",
    "rig_promote",
    "sessions_list",
    "session_get",
    "session_events",
    "session_create",
    "session_send_message",
    "session_pause",
    "session_resume",
    "session_steer",
    "set_other_session_title",
    "variable_set_list",
    "environment_list",
    "variable_set_set_variable",
    "environment_set_variable",
    "github_connect_link",
    "github_token",
    "github_repositories_list",
    "social_connections_list",
    "social_posts_recent",
    "social_daily_analysis_context",
    "scheduled_tasks_list",
    "scheduled_tasks_get",
    "scheduled_tasks_create",
    "scheduled_tasks_update",
    "scheduled_tasks_pause",
    "scheduled_tasks_resume",
    "scheduled_tasks_trigger",
    "scheduled_tasks_delete",
    "scheduled_task_runs_list",
    "slack_bot_list_channels",
    "slack_bot_channel_history",
    "slack_bot_thread_replies",
    "slack_bot_list_users",
    "slack_bot_list_files",
    "slack_bot_file_info",
    "slack_bot_file_content",
    "slack_bot_post_message",
    "slack_bot_delete_message",
    "artifacts_list",
    "artifacts_get_source",
    "artifacts_create",
    "artifacts_publish",
    "artifacts_rollback"
  ]'::jsonb;

CREATE TABLE "workspace_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'active',
  "current_version_id" uuid,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_artifacts_status_chk" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "workspace_artifacts_slug_chk" CHECK (
    length("slug") BETWEEN 1 AND 96
    AND "slug" ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
  ),
  CONSTRAINT "workspace_artifacts_title_chk" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "workspace_artifacts_description_chk" CHECK (
    "description" IS NULL OR length("description") <= 2000
  ),
  CONSTRAINT "workspace_artifacts_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_artifacts_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "workspace_artifacts_workspace_slug_uq" UNIQUE ("workspace_id", "slug")
);

CREATE INDEX "workspace_artifacts_list_idx"
  ON "workspace_artifacts" ("workspace_id", "updated_at" DESC);

CREATE TABLE "workspace_artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "content_key" text NOT NULL,
  "content_type" text NOT NULL DEFAULT 'text/html',
  "content_sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "operation_key" text NOT NULL,
  "source_session_id" uuid,
  "source_turn_id" uuid,
  "source_attempt_id" uuid,
  "source_execution_generation" integer,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_artifact_versions_artifact_fk"
    FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "workspace_artifacts"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_artifact_versions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_artifact_versions_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "workspace_artifact_versions_revision_uq"
    UNIQUE ("workspace_id", "artifact_id", "revision"),
  CONSTRAINT "workspace_artifact_versions_operation_uq" UNIQUE ("workspace_id", "operation_key"),
  CONSTRAINT "workspace_artifact_versions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "workspace_artifact_versions_content_chk" CHECK (
    "content_type" = 'text/html'
    AND "content_sha256" ~ '^[0-9a-f]{64}$'
    AND "size_bytes" BETWEEN 1 AND 524288
    AND length("content_key") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_artifact_versions_operation_chk" CHECK (
    length("operation_key") BETWEEN 1 AND 512
  ),
  CONSTRAINT "workspace_artifact_versions_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_artifact_versions_provenance_chk" CHECK (
    (
      "source_session_id" IS NULL
      AND "source_turn_id" IS NULL
      AND "source_attempt_id" IS NULL
      AND "source_execution_generation" IS NULL
    ) OR (
      "source_session_id" IS NOT NULL
      AND "source_turn_id" IS NOT NULL
      AND "source_attempt_id" IS NOT NULL
      AND "source_execution_generation" > 0
    )
  )
);

ALTER TABLE "workspace_artifacts"
  ADD CONSTRAINT "workspace_artifacts_current_version_fk"
  FOREIGN KEY ("workspace_id", "current_version_id")
  REFERENCES "workspace_artifact_versions"("workspace_id", "id")
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "workspace_artifact_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL,
  "type" text NOT NULL,
  "from_version_id" uuid,
  "to_version_id" uuid NOT NULL,
  "operation_key" text NOT NULL,
  "source_session_id" uuid,
  "source_turn_id" uuid,
  "source_attempt_id" uuid,
  "source_execution_generation" integer,
  "actor_subject_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_artifact_events_artifact_fk"
    FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "workspace_artifacts"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_artifact_events_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_artifact_events_operation_uq" UNIQUE ("workspace_id", "operation_key"),
  CONSTRAINT "workspace_artifact_events_type_chk" CHECK ("type" IN ('published', 'rolled_back')),
  CONSTRAINT "workspace_artifact_events_operation_chk" CHECK (length("operation_key") BETWEEN 1 AND 512),
  CONSTRAINT "workspace_artifact_events_audit_chk" CHECK (
    length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("reason")) BETWEEN 1 AND 4096
  ),
  CONSTRAINT "workspace_artifact_events_provenance_chk" CHECK (
    (
      "source_session_id" IS NULL
      AND "source_turn_id" IS NULL
      AND "source_attempt_id" IS NULL
      AND "source_execution_generation" IS NULL
    ) OR (
      "source_session_id" IS NOT NULL
      AND "source_turn_id" IS NOT NULL
      AND "source_attempt_id" IS NOT NULL
      AND "source_execution_generation" > 0
    )
  )
);

CREATE INDEX "workspace_artifact_events_list_idx"
  ON "workspace_artifact_events" ("workspace_id", "artifact_id", "created_at" DESC);

ALTER TABLE "workspace_artifact_versions"
  ADD CONSTRAINT "workspace_artifact_versions_source_session_fk"
    FOREIGN KEY ("workspace_id", "source_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "workspace_artifact_versions_source_turn_fk"
    FOREIGN KEY ("workspace_id", "source_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "workspace_artifact_versions_source_attempt_fk"
    FOREIGN KEY ("workspace_id", "source_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "workspace_artifact_events"
  ADD CONSTRAINT "workspace_artifact_events_source_session_fk"
    FOREIGN KEY ("workspace_id", "source_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "workspace_artifact_events_source_turn_fk"
    FOREIGN KEY ("workspace_id", "source_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "workspace_artifact_events_source_attempt_fk"
    FOREIGN KEY ("workspace_id", "source_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION workspace_artifact_validate_current()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."current_version_id" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "workspace_artifact_versions" version
      WHERE version."workspace_id" = NEW."workspace_id"
        AND version."artifact_id" = NEW."id"
        AND version."id" = NEW."current_version_id"
    ) THEN
      RAISE EXCEPTION 'artifact current version must belong to the artifact' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_artifact_validate_event_links()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "workspace_artifact_versions" version
    WHERE version."workspace_id" = NEW."workspace_id"
      AND version."artifact_id" = NEW."artifact_id"
      AND version."id" = NEW."to_version_id"
  ) OR (NEW."from_version_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "workspace_artifact_versions" version
    WHERE version."workspace_id" = NEW."workspace_id"
      AND version."artifact_id" = NEW."artifact_id"
      AND version."id" = NEW."from_version_id"
  )) THEN
    RAISE EXCEPTION 'artifact event versions must belong to the artifact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER workspace_artifacts_validate_current
  AFTER INSERT OR UPDATE ON "workspace_artifacts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workspace_artifact_validate_current();
CREATE TRIGGER workspace_artifact_events_validate_links
  BEFORE INSERT OR UPDATE ON "workspace_artifact_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_artifact_validate_event_links();

CREATE OR REPLACE FUNCTION workspace_artifact_reject_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND NOT EXISTS (
    SELECT 1 FROM "workspaces" workspace WHERE workspace."id" = OLD."workspace_id"
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace artifact history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workspace_artifact_versions_immutable
  BEFORE UPDATE OR DELETE ON "workspace_artifact_versions"
  FOR EACH ROW EXECUTE FUNCTION workspace_artifact_reject_history_mutation();
CREATE TRIGGER workspace_artifact_events_immutable
  BEFORE UPDATE OR DELETE ON "workspace_artifact_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_artifact_reject_history_mutation();

ALTER TABLE "workspace_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_artifacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_artifact_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_artifact_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_artifact_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_artifact_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_artifacts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "workspace_artifact_versions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "workspace_artifact_events"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE "workspace_artifacts", "workspace_artifact_versions", "workspace_artifact_events" FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workspace_artifacts" TO opengeni_app;
    GRANT SELECT, INSERT ON TABLE "workspace_artifact_versions", "workspace_artifact_events" TO opengeni_app;
  END IF;
END;
$$;
