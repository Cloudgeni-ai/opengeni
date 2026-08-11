-- deployment-mode: rolling
-- Durable workspace-owned video generation. A paid provider operation is
-- independent from its originating turn/session; its retained product owns a
-- separate File and permanent video-artifact identity.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_system_updates" DROP CONSTRAINT "system_updates_kind_check";
ALTER TABLE "session_system_updates" ADD CONSTRAINT "system_updates_kind_check" CHECK (
  "kind" IN (
    'scheduled_occurrence', 'goal_continuation', 'agent_message',
    'agent_steer_instruction', 'child_terminal_result', 'media_generation_result'
  )
);

CREATE TABLE "workspace_video_generation_policies" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL DEFAULT 0,
  "enabled_model_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "default_model_id" text,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_video_generation_policies_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_video_generation_policies_revision_chk"
    CHECK ("revision" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "workspace_video_generation_policies_models_chk" CHECK (
    jsonb_typeof("enabled_model_ids") = 'array'
    AND jsonb_array_length("enabled_model_ids") <= 16
    AND ("default_model_id" IS NULL OR "enabled_model_ids" ? "default_model_id")
  )
);

CREATE TABLE "workspace_video_generation_quotas" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "reserved_bytes" bigint NOT NULL DEFAULT 0,
  "ready_bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_video_generation_quotas_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_video_generation_quotas_nonnegative_chk"
    CHECK ("reserved_bytes" >= 0 AND "ready_bytes" >= 0)
);

CREATE TABLE "video_generation_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid,
  "turn_id" uuid,
  "attempt_id" uuid,
  "tool_call_id" text NOT NULL,
  "admission_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "prompt_digest" text NOT NULL,
  "request_encrypted" text,
  "model_id" text NOT NULL,
  "source_mode" text NOT NULL,
  "capability_revision" text NOT NULL,
  "connection_id" uuid,
  "credential_version" integer NOT NULL,
  "credential_encrypted" text,
  "provider_idempotency_key" text NOT NULL,
  "provider_job_id" text,
  "provider_request_encrypted" text,
  "provider_request_expires_at" timestamptz,
  "expected_artifact_id" uuid NOT NULL,
  "expected_file_id" uuid NOT NULL,
  "reserved_bytes" bigint NOT NULL,
  "quota_state" text NOT NULL DEFAULT 'reserved',
  "status" text NOT NULL DEFAULT 'preparing',
  "admission_output_state" text NOT NULL DEFAULT 'pending',
  "terminal_update_state" text NOT NULL DEFAULT 'ineligible',
  "terminal_update_id" uuid,
  "reconcile_revision" bigint NOT NULL DEFAULT 0,
  "reconcile_lease_owner" text,
  "reconcile_lease_expires_at" timestamptz,
  "next_reconcile_at" timestamptz,
  "provider_request_sent_at" timestamptz,
  "provider_started_at" timestamptz,
  "recovery_deadline_at" timestamptz NOT NULL,
  "terminal_at" timestamptz,
  "private_data_erase_after" timestamptz,
  "bounded_public_reason" text,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "video_generation_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "video_generation_operations_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("session_id"),
  CONSTRAINT "video_generation_operations_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL ("turn_id"),
  CONSTRAINT "video_generation_operations_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id"),
  CONSTRAINT "video_generation_operations_hashes_chk" CHECK (
    "admission_key" ~ '^[0-9a-f]{64}$'
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "prompt_digest" ~ '^[0-9a-f]{64}$'
    AND "capability_revision" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "video_generation_operations_shape_chk" CHECK (
    octet_length("tool_call_id") BETWEEN 1 AND 512
    AND octet_length("model_id") BETWEEN 1 AND 256
    AND octet_length("provider_idempotency_key") BETWEEN 1 AND 128
    AND "source_mode" IN ('text','first_frame','first_and_last_frames','image_reference','video_reference')
    AND "reserved_bytes" > 0 AND "reserved_bytes" <= 536870912
    AND ("bounded_public_reason" IS NULL OR octet_length("bounded_public_reason") <= 4000)
    AND ("last_error" IS NULL OR octet_length("last_error") <= 16384)
  ),
  CONSTRAINT "video_generation_operations_state_chk" CHECK (
    "status" IN (
      'preparing','prepared','accepted','submission_uncertain','provider_started',
      'retaining','completed','provider_failed','cancelled_before_submit',
      'outcome_unknown','retention_failed'
    )
    AND "admission_output_state" IN ('pending','recorded')
    AND "terminal_update_state" IN ('ineligible','pending','leased','delivered','suppressed')
    AND "quota_state" IN ('reserved','ready','released')
    AND (("terminal_at" IS NOT NULL) = ("status" IN (
      'completed','provider_failed','cancelled_before_submit','outcome_unknown','retention_failed'
    )))
    AND ("status" <> 'submission_uncertain' OR (
      "provider_request_encrypted" IS NOT NULL AND "provider_request_expires_at" IS NOT NULL
    ))
    AND ("provider_request_encrypted" IS NULL OR "status" = 'submission_uncertain')
    AND ("status" NOT IN ('provider_started','retaining','completed','retention_failed')
      OR "provider_job_id" IS NOT NULL)
    AND ("provider_job_id" IS NULL OR "status" IN (
      'provider_started','retaining','completed','provider_failed','retention_failed'
    ))
  )
);

CREATE UNIQUE INDEX "video_generation_operations_admission_uq"
  ON "video_generation_operations" ("workspace_id", "admission_key");
CREATE UNIQUE INDEX "video_generation_operations_expected_artifact_uq"
  ON "video_generation_operations" ("workspace_id", "expected_artifact_id");
CREATE UNIQUE INDEX "video_generation_operations_expected_file_uq"
  ON "video_generation_operations" ("workspace_id", "expected_file_id");
CREATE INDEX "video_generation_operations_due_idx"
  ON "video_generation_operations" ("status", "next_reconcile_at", "id");
CREATE INDEX "video_generation_operations_workspace_created_idx"
  ON "video_generation_operations" ("workspace_id", "created_at", "id");

CREATE TABLE "video_generation_references" (
  "operation_id" uuid NOT NULL REFERENCES "video_generation_operations"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "role" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "staging_object_key" text,
  "grant_expires_at" timestamptz,
  "cleanup_after" timestamptz,
  "cleaned_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "video_generation_references_pk" PRIMARY KEY ("operation_id", "ordinal"),
  CONSTRAINT "video_generation_references_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "video_generation_references_hash_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "video_generation_references_bounds_chk" CHECK (
    "ordinal" BETWEEN 0 AND 1
    AND "role" IN ('first_frame','last_frame','image_reference','video_reference')
    AND octet_length("content_type") BETWEEN 3 AND 128
    AND "size_bytes" > 0 AND "size_bytes" <= 209715200
  )
);

CREATE TABLE "generated_video_artifacts" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "primary_file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE RESTRICT,
  "operation_id" uuid NOT NULL REFERENCES "video_generation_operations"("id") ON DELETE RESTRICT,
  "session_id" uuid,
  "turn_id" uuid,
  "attempt_id" uuid,
  "model_id" text NOT NULL,
  "source_mode" text NOT NULL,
  "prompt_digest" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "duration_millis" integer NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "fps_milli" integer NOT NULL,
  "video_codec" text NOT NULL,
  "audio_codec" text,
  "has_audio" boolean NOT NULL,
  "sandbox_filename" text NOT NULL,
  "deleted_at" timestamptz,
  "ready_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "generated_video_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "generated_video_artifacts_workspace_file_scope_fk"
    FOREIGN KEY ("account_id", "workspace_id", "primary_file_id")
    REFERENCES "files"("account_id", "workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "generated_video_artifacts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE SET NULL ("session_id"),
  CONSTRAINT "generated_video_artifacts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL ("turn_id"),
  CONSTRAINT "generated_video_artifacts_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id"),
  CONSTRAINT "generated_video_artifacts_values_chk" CHECK (
    "content_type" = 'video/mp4'
    AND "size_bytes" > 0 AND "size_bytes" <= 536870912
    AND "sha256" ~ '^[0-9a-f]{64}$'
    AND "prompt_digest" ~ '^[0-9a-f]{64}$'
    AND "duration_millis" BETWEEN 1 AND 120000
    AND "width" BETWEEN 1 AND 8192 AND "height" BETWEEN 1 AND 8192
    AND "fps_milli" BETWEEN 1 AND 120000
    AND "video_codec" = 'h264'
    AND (("has_audio" AND "audio_codec" = 'aac') OR (NOT "has_audio" AND "audio_codec" IS NULL))
    AND "sandbox_filename" = 'generated-video-' || "id"::text || '.mp4'
  )
);

CREATE UNIQUE INDEX "generated_video_artifacts_workspace_file_uq"
  ON "generated_video_artifacts" ("workspace_id", "primary_file_id");
CREATE UNIQUE INDEX "generated_video_artifacts_workspace_operation_uq"
  ON "generated_video_artifacts" ("workspace_id", "operation_id");
CREATE INDEX "generated_video_artifacts_session_created_idx"
  ON "generated_video_artifacts" ("workspace_id", "session_id", "created_at", "id");

CREATE OR REPLACE FUNCTION opengeni_private.claim_video_generation_operations(
  p_owner text,
  p_lease_seconds integer,
  p_limit integer
) RETURNS TABLE(operation_id uuid, account_id uuid, workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, opengeni_private
AS $$
BEGIN
  IF p_owner IS NULL OR length(btrim(p_owner)) NOT BETWEEN 1 AND 256
    OR p_lease_seconds NOT BETWEEN 5 AND 600
    OR p_limit NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'invalid video generation claim request';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT operation.id
    FROM public.video_generation_operations AS operation
    WHERE (
        (
          operation.status IN ('accepted','submission_uncertain','provider_started','retaining')
          AND coalesce(operation.next_reconcile_at, operation.updated_at) <= clock_timestamp()
        )
        OR (
          operation.status IN (
            'completed','provider_failed','cancelled_before_submit','outcome_unknown','retention_failed'
          )
          AND (
            operation.terminal_update_state IN ('pending','leased')
            OR EXISTS (
              SELECT 1
              FROM public.video_generation_references AS reference
              WHERE reference.operation_id = operation.id
                AND reference.staging_object_key IS NOT NULL
                AND reference.cleaned_at IS NULL
                AND coalesce(reference.cleanup_after, operation.recovery_deadline_at)
                  <= clock_timestamp()
            )
          )
        )
      )
      AND (
        operation.reconcile_lease_expires_at IS NULL
        OR operation.reconcile_lease_expires_at <= clock_timestamp()
      )
    ORDER BY coalesce(operation.next_reconcile_at, operation.updated_at), operation.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.video_generation_operations AS operation
    SET reconcile_lease_owner = p_owner,
        reconcile_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        reconcile_revision = operation.reconcile_revision + 1,
        updated_at = clock_timestamp()
    FROM candidates
    WHERE operation.id = candidates.id
    RETURNING operation.id, operation.account_id, operation.workspace_id
  )
  SELECT claimed.id, claimed.account_id, claimed.workspace_id FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.claim_video_generation_operations(text, integer, integer)
  FROM PUBLIC;

ALTER TABLE "workspace_video_generation_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_video_generation_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "workspace_video_generation_policies"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "workspace_video_generation_quotas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_video_generation_quotas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "workspace_video_generation_quotas"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "video_generation_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "video_generation_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "video_generation_operations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "video_generation_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "video_generation_references" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "video_generation_references"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "generated_video_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generated_video_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_isolation" ON "generated_video_artifacts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_video_generation_policies" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_video_generation_quotas" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "video_generation_operations" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "video_generation_references" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "generated_video_artifacts" TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_video_generation_operations(text, integer, integer)
      TO opengeni_app;
  END IF;
END $$;
