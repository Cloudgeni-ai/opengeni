-- deployment-mode: rolling

-- Onboarding inputs create immutable proposal receipts plus ordinary inactive
-- instruction-policy revisions. This table is provenance/audit evidence only:
-- it never writes or owns an active policy head.
CREATE TABLE "workspace_instruction_policy_onboarding_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "role_key" text,
  "source_id" text NOT NULL,
  "source_version" text NOT NULL,
  "confidence_bps" integer NOT NULL,
  "baseline_revision_id" uuid REFERENCES "workspace_instruction_policy_revisions"("id")
    ON DELETE RESTRICT,
  "baseline_revision" bigint,
  "baseline_content_hash" text,
  "baseline_activation_version" bigint NOT NULL,
  "baseline_activated_at" timestamptz,
  "draft_revision_id" uuid NOT NULL REFERENCES "workspace_instruction_policy_revisions"("id")
    ON DELETE RESTRICT,
  "draft_revision" bigint NOT NULL,
  "draft_content_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_operation_receipt_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_target_chk" CHECK (
    ("kind" = 'charter' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'global' AND "role_key" IS NULL)
    OR ("kind" = 'policy' AND "scope" = 'role' AND "role_key" IS NOT NULL)
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_role_key_chk" CHECK (
    "role_key" IS NULL
    OR (
      "role_key" = lower(btrim("role_key"))
      AND length("role_key") BETWEEN 1 AND 64
      AND "role_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "role_key" !~ '--'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_source_chk" CHECK (
    length(btrim("source_id")) BETWEEN 1 AND 512
    AND length(btrim("source_version")) BETWEEN 1 AND 256
    AND "confidence_bps" BETWEEN 0 AND 10000
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_baseline_chk" CHECK (
    (
      "baseline_revision_id" IS NULL
      AND "baseline_revision" IS NULL
      AND "baseline_content_hash" IS NULL
      AND "baseline_activation_version" = 0
      AND "baseline_activated_at" IS NULL
    ) OR (
      "baseline_revision_id" IS NOT NULL
      AND "baseline_revision" > 0
      AND "baseline_content_hash" ~ '^[0-9a-f]{64}$'
      AND "baseline_activation_version" > 0
      AND "baseline_activated_at" IS NOT NULL
    )
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_draft_chk" CHECK (
    "draft_revision" > 0
    AND "draft_content_hash" ~ '^[0-9a-f]{64}$'
    AND "status" = 'proposed'
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_instruction_policy_onboarding_proposals_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id")
);

CREATE UNIQUE INDEX "workspace_instruction_policy_onboarding_proposals_source_version_target_uq"
  ON "workspace_instruction_policy_onboarding_proposals"
  (
    "workspace_id",
    "kind",
    "scope",
    coalesce("role_key", ''),
    "source_id",
    "source_version"
  );

CREATE INDEX "workspace_instruction_policy_onboarding_proposals_workspace_time_idx"
  ON "workspace_instruction_policy_onboarding_proposals"
  ("workspace_id", "created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_onboarding_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."baseline_revision_id" IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM "workspace_instruction_policy_heads" head
      WHERE head."account_id" = NEW."account_id"
        AND head."workspace_id" = NEW."workspace_id"
        AND head."kind" = NEW."kind"
        AND head."scope" = NEW."scope"
        AND head."role_key" IS NOT DISTINCT FROM NEW."role_key"
    ) THEN
      RAISE EXCEPTION 'instruction-policy onboarding proposal must capture the exact active head baseline'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_heads" head
    WHERE head."account_id" = NEW."account_id"
      AND head."workspace_id" = NEW."workspace_id"
      AND head."kind" = NEW."kind"
      AND head."scope" = NEW."scope"
      AND head."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND head."revision_id" = NEW."baseline_revision_id"
      AND head."revision" = NEW."baseline_revision"
      AND head."content_hash" = NEW."baseline_content_hash"
      AND head."activation_version" = NEW."baseline_activation_version"
      AND head."activated_at" = NEW."baseline_activated_at"
  ) THEN
    RAISE EXCEPTION 'instruction-policy onboarding proposal must capture the exact active head baseline'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."baseline_revision_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."baseline_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."baseline_revision"
      AND revision."content_hash" = NEW."baseline_content_hash"
  ) THEN
    RAISE EXCEPTION 'instruction-policy onboarding proposal has an invalid baseline revision'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_revisions" revision
    WHERE revision."id" = NEW."draft_revision_id"
      AND revision."operation_id" = NEW."operation_id"
      AND revision."request_fingerprint" = NEW."request_fingerprint"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."kind" = NEW."kind"
      AND revision."scope" = NEW."scope"
      AND revision."role_key" IS NOT DISTINCT FROM NEW."role_key"
      AND revision."revision" = NEW."draft_revision"
      AND revision."content_hash" = NEW."draft_content_hash"
      AND revision."provenance_source" = 'onboarding'
      AND revision."provenance_source_id" = NEW."id"::text
      AND revision."supersedes_revision_id" IS NOT DISTINCT FROM NEW."baseline_revision_id"
      AND revision."created_by_subject_id" = NEW."created_by_subject_id"
  ) THEN
    RAISE EXCEPTION 'instruction-policy onboarding proposal must identify its exact inactive draft'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_heads" head
    WHERE head."account_id" = NEW."account_id"
      AND head."workspace_id" = NEW."workspace_id"
      AND head."revision_id" = NEW."draft_revision_id"
  ) OR EXISTS (
    SELECT 1
    FROM "workspace_instruction_policy_activation_events" event
    WHERE event."account_id" = NEW."account_id"
      AND event."workspace_id" = NEW."workspace_id"
      AND event."new_revision_id" = NEW."draft_revision_id"
  ) THEN
    RAISE EXCEPTION 'instruction-policy onboarding proposal must identify a never-activated inactive draft'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_instruction_policy_onboarding_proposals_validate_draft
  BEFORE INSERT OR UPDATE ON "workspace_instruction_policy_onboarding_proposals"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_onboarding_proposal();

CREATE TRIGGER workspace_instruction_policy_onboarding_proposals_immutable
  BEFORE UPDATE OR DELETE ON "workspace_instruction_policy_onboarding_proposals"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

ALTER TABLE "workspace_instruction_policy_onboarding_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_onboarding_proposals" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_instruction_policy_onboarding_proposals"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));