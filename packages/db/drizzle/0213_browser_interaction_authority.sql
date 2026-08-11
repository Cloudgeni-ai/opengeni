-- deployment-mode: maintenance
-- Snapshot exact route authority into each BrowserSession and extend durable
-- interventions/operation receipts without rewriting migration 0210.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "browser_sessions"
  ADD COLUMN "network_route_version" bigint,
  ADD COLUMN "network_route_configuration" jsonb,
  ADD COLUMN "network_route_consistency" jsonb,
  ADD COLUMN "network_route_credential_version" bigint,
  ADD COLUMN "network_route_authority_digest" text;

UPDATE "browser_sessions" S
SET "network_route_version" = R."version",
  "network_route_configuration" = R."configuration",
  "network_route_consistency" = R."consistency"
FROM "network_routes" R
WHERE S."workspace_id" = R."workspace_id"
  AND S."network_route_id" = R."id";

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_network_route_authority_check" CHECK (
    ("network_route_id" IS NULL
      AND "network_route_version" IS NULL
      AND "network_route_configuration" IS NULL
      AND "network_route_consistency" IS NULL
      AND "network_route_credential_version" IS NULL
      AND "network_route_authority_digest" IS NULL)
    OR
    ("network_route_id" IS NOT NULL
      AND "network_route_version" > 0
      AND jsonb_typeof("network_route_configuration") = 'object'
      AND octet_length("network_route_configuration"::text) BETWEEN 2 AND 65536
      AND jsonb_typeof("network_route_consistency") = 'object'
      AND octet_length("network_route_consistency"::text) BETWEEN 2 AND 65536
      AND ("network_route_credential_version" IS NULL OR "network_route_credential_version" > 0)
      AND ("network_route_authority_digest" IS NOT NULL OR "network_route_credential_version" IS NULL)
      AND ("network_route_authority_digest" IS NULL OR (
        octet_length("network_route_authority_digest") BETWEEN 16 AND 256
        AND "network_route_authority_digest" ~ '^[A-Za-z0-9._~-]+$'
      )))
  );

CREATE INDEX "browser_sessions_workspace_network_route_idx"
  ON "browser_sessions" ("workspace_id", "network_route_id", "lifecycle");

ALTER TABLE "interaction_interventions"
  ADD COLUMN "originating_tool_call_id" text,
  ADD CONSTRAINT "interaction_interventions_originating_tool_call_check" CHECK (
    "originating_tool_call_id" IS NULL OR (
      "originating_attempt_id" IS NOT NULL
      AND octet_length("originating_tool_call_id") BETWEEN 1 AND 1024
    )
  );

CREATE UNIQUE INDEX "interaction_interventions_originating_tool_call_uq"
  ON "interaction_interventions"
  ("workspace_id", "originating_session_id", "originating_turn_id", "originating_tool_call_id")
  WHERE "originating_tool_call_id" IS NOT NULL;

ALTER TABLE "interaction_resource_operations"
  ADD COLUMN "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "interaction_resource_operations_metadata_check" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND octet_length("metadata"::text) BETWEEN 2 AND 65536
  );
