-- deployment-mode: rolling
-- Keep generated image bytes in the permanent workspace file authority while
-- recording only bounded provider/tool correlation needed for replay and UI.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "generated_image_artifacts" (
  "artifact_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid,
  "turn_id" uuid,
  "attempt_id" uuid,
  "upload_id" uuid,
  "settlement_key" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "source_strategy" text NOT NULL,
  "provider_id" text NOT NULL,
  "provider_binding_hash" text NOT NULL,
  "provider_item_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "media_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "sandbox_path" text NOT NULL,
  "ready_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "generated_image_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "generated_image_artifacts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("session_id"),
  CONSTRAINT "generated_image_artifacts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL ("turn_id"),
  CONSTRAINT "generated_image_artifacts_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id"),
  CONSTRAINT "generated_image_artifacts_upload_fk"
    FOREIGN KEY ("upload_id") REFERENCES "file_uploads"("id") ON DELETE SET NULL,
  CONSTRAINT "generated_image_artifacts_workspace_file_fk"
    FOREIGN KEY ("workspace_id", "artifact_id")
    REFERENCES "files"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "generated_image_artifacts_source_strategy_chk"
    CHECK ("source_strategy" IN ('native_hosted', 'provider_adapter')),
  CONSTRAINT "generated_image_artifacts_source_shape_chk"
    CHECK (
      ("source_strategy" = 'native_hosted' AND "provider_item_id" IS NOT NULL)
      OR ("source_strategy" = 'provider_adapter' AND "provider_item_id" IS NULL)
    ),
  CONSTRAINT "generated_image_artifacts_status_chk"
    CHECK ("status" IN ('pending', 'ready')),
  CONSTRAINT "generated_image_artifacts_ready_shape_chk"
    CHECK (("status" = 'ready') = ("ready_at" IS NOT NULL)),
  CONSTRAINT "generated_image_artifacts_media_type_chk"
    CHECK ("media_type" IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "generated_image_artifacts_size_chk"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 67108864),
  CONSTRAINT "generated_image_artifacts_sha256_chk"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "generated_image_artifacts_binding_hash_chk"
    CHECK ("provider_binding_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "generated_image_artifacts_identity_bounds_chk"
    CHECK (
      "settlement_key" ~ '^[0-9a-f]{64}$'
      AND octet_length("tool_call_id") BETWEEN 1 AND 512
      AND octet_length("provider_id") BETWEEN 1 AND 128
      AND ("provider_item_id" IS NULL OR octet_length("provider_item_id") BETWEEN 1 AND 512)
      AND ("last_error" IS NULL OR octet_length("last_error") <= 16384)
    ),
  CONSTRAINT "generated_image_artifacts_dimensions_chk"
    CHECK (
      "width" BETWEEN 1 AND 16384
      AND "height" BETWEEN 1 AND 16384
      AND ("width"::bigint * "height"::bigint) <= 67108864
    ),
  CONSTRAINT "generated_image_artifacts_sandbox_path_chk"
    CHECK ("sandbox_path" ~ '^/workspace/generated-images/generated-image-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$')
);

CREATE UNIQUE INDEX "generated_image_artifacts_settlement_key_uq"
  ON "generated_image_artifacts" ("workspace_id", "settlement_key");
CREATE INDEX "generated_image_artifacts_session_created_idx"
  ON "generated_image_artifacts" ("workspace_id", "session_id", "created_at", "artifact_id");
CREATE UNIQUE INDEX "generated_image_artifacts_provider_item_uq"
  ON "generated_image_artifacts" ("workspace_id", "provider_id", "provider_binding_hash", "provider_item_id")
  WHERE "provider_item_id" IS NOT NULL;

CREATE TABLE "image_generation_operations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid,
  "turn_id" uuid,
  "attempt_id" uuid,
  "operation_key" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "provider_binding_hash" text NOT NULL,
  "model_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "expected_artifact_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'prepared',
  "provider_started_at" timestamptz,
  "completed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "image_generation_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "image_generation_operations_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "image_generation_operations_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "image_generation_operations_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id"),
  CONSTRAINT "image_generation_operations_status_chk"
    CHECK ("status" IN ('prepared', 'provider_started', 'completed', 'outcome_unknown')),
  CONSTRAINT "image_generation_operations_digest_chk"
    CHECK (
      "operation_key" ~ '^[0-9a-f]{64}$'
      AND "provider_binding_hash" ~ '^[0-9a-f]{64}$'
      AND "request_digest" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "image_generation_operations_identity_bounds_chk"
    CHECK (
      octet_length("tool_call_id") BETWEEN 1 AND 512
      AND octet_length("provider_id") BETWEEN 1 AND 128
      AND octet_length("model_id") BETWEEN 1 AND 256
      AND ("last_error" IS NULL OR octet_length("last_error") <= 16384)
    ),
  CONSTRAINT "image_generation_operations_state_chk"
    CHECK (
      ("status" = 'prepared' AND "provider_started_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" IN ('provider_started', 'outcome_unknown') AND "provider_started_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'completed' AND "provider_started_at" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "image_generation_operations_operation_key_uq"
  ON "image_generation_operations" ("workspace_id", "operation_key");
CREATE INDEX "image_generation_operations_session_created_idx"
  ON "image_generation_operations" ("workspace_id", "session_id", "created_at", "id");

ALTER TABLE "generated_image_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generated_image_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "generated_image_artifacts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "image_generation_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "image_generation_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "image_generation_operations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "generated_image_artifacts" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "image_generation_operations" TO opengeni_app;
  END IF;
END $$;
