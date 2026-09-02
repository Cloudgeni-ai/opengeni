-- deployment-mode: rolling
-- Retain editable source and exact requested-tool identities beside each
-- immutable Workspace HTML artifact version. Existing versions remain valid:
-- their source columns stay NULL and readers derive a one-file index.html
-- source bundle from the already-verified published HTML.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "workspace_artifact_versions"
  ADD COLUMN "source_key" text,
  ADD COLUMN "source_sha256" text,
  ADD COLUMN "source_size_bytes" integer,
  ADD COLUMN "requested_tools" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "workspace_artifact_versions"
  DROP CONSTRAINT "workspace_artifact_versions_content_chk";

ALTER TABLE "workspace_artifact_versions"
  ADD CONSTRAINT "workspace_artifact_versions_content_chk" CHECK (
    "content_type" = 'text/html'
    AND "content_sha256" ~ '^[0-9a-f]{64}$'
    AND "size_bytes" BETWEEN 1 AND 4194304
    AND length("content_key") BETWEEN 1 AND 1024
    AND (
      (
        "source_key" IS NULL
        AND "source_sha256" IS NULL
        AND "source_size_bytes" IS NULL
      ) OR (
        length("source_key") BETWEEN 1 AND 1024
        AND "source_sha256" ~ '^[0-9a-f]{64}$'
        AND "source_size_bytes" BETWEEN 1 AND 4194304
      )
    )
    AND jsonb_typeof("requested_tools") = 'array'
    AND jsonb_array_length("requested_tools") <= 128
  ) NOT VALID;

ALTER TABLE "workspace_artifact_versions"
  VALIDATE CONSTRAINT "workspace_artifact_versions_content_chk";

ALTER TABLE "workspace_artifact_events"
  DROP CONSTRAINT "workspace_artifact_events_type_chk";

ALTER TABLE "workspace_artifact_events"
  ADD CONSTRAINT "workspace_artifact_events_type_chk"
  CHECK ("type" IN ('published', 'rolled_back', 'archived', 'restored')) NOT VALID;

ALTER TABLE "workspace_artifact_events"
  VALIDATE CONSTRAINT "workspace_artifact_events_type_chk";