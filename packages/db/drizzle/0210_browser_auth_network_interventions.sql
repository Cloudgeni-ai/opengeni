-- deployment-mode: maintenance
-- Canonical browser authentication, network-route, and human-intervention
-- resources. No credential value is stored outside the existing connections table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "network_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "configuration" jsonb NOT NULL,
  "consistency" jsonb NOT NULL,
  "version" bigint NOT NULL DEFAULT 1,
  "create_operation_id" uuid NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "updated_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "network_routes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "network_routes_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "network_routes_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND jsonb_typeof("configuration") = 'object'
    AND octet_length("configuration"::text) BETWEEN 2 AND 65536
    AND jsonb_typeof("consistency") = 'object'
    AND octet_length("consistency"::text) BETWEEN 2 AND 65536
    AND "version" > 0
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND octet_length("updated_by_subject_id") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "network_routes_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "network_routes_workspace_create_operation_uq"
    UNIQUE ("workspace_id", "create_operation_id")
);

CREATE UNIQUE INDEX "network_routes_workspace_active_name_uq"
  ON "network_routes" ("workspace_id", lower("name")) WHERE "status" = 'active';
CREATE INDEX "network_routes_workspace_status_updated_idx"
  ON "network_routes" ("workspace_id", "status", "updated_at", "id");

CREATE TABLE "site_auth_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "account_label" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "origins" jsonb NOT NULL,
  "login_url" text,
  "verification_url_prefixes" jsonb NOT NULL,
  "authorities" jsonb NOT NULL,
  "methods" jsonb NOT NULL,
  "preferred_identity_id" uuid,
  "preferred_placement" jsonb,
  "preferred_network_route_id" uuid,
  "health_policy" jsonb NOT NULL,
  "verification_state" text NOT NULL DEFAULT 'unknown',
  "last_verified_at" timestamptz,
  "last_verified_url" text,
  "repair_code" text,
  "version" bigint NOT NULL DEFAULT 1,
  "create_operation_id" uuid NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "updated_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "site_auth_connections_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "site_auth_connections_identity_fk"
    FOREIGN KEY ("workspace_id", "preferred_identity_id")
    REFERENCES "browser_identities"("workspace_id", "id") ON DELETE SET NULL ("preferred_identity_id"),
  CONSTRAINT "site_auth_connections_network_route_fk"
    FOREIGN KEY ("workspace_id", "preferred_network_route_id")
    REFERENCES "network_routes"("workspace_id", "id") ON DELETE SET NULL ("preferred_network_route_id"),
  CONSTRAINT "site_auth_connections_status_check" CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "site_auth_connections_verification_state_check"
    CHECK ("verification_state" IN ('unknown', 'verified', 'needs_repair', 'failed')),
  CONSTRAINT "site_auth_connections_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND octet_length("account_label") BETWEEN 1 AND 200
    AND "account_label" = btrim("account_label")
    AND jsonb_typeof("origins") = 'array'
    AND octet_length("origins"::text) BETWEEN 3 AND 65536
    AND ("login_url" IS NULL OR octet_length("login_url") BETWEEN 1 AND 16384)
    AND jsonb_typeof("verification_url_prefixes") = 'array'
    AND octet_length("verification_url_prefixes"::text) BETWEEN 2 AND 65536
    AND jsonb_typeof("authorities") = 'array'
    AND octet_length("authorities"::text) BETWEEN 3 AND 65536
    AND jsonb_typeof("methods") = 'array'
    AND octet_length("methods"::text) BETWEEN 3 AND 65536
    AND ("preferred_placement" IS NULL OR (
      jsonb_typeof("preferred_placement") = 'object'
      AND octet_length("preferred_placement"::text) BETWEEN 2 AND 65536
    ))
    AND jsonb_typeof("health_policy") = 'object'
    AND octet_length("health_policy"::text) BETWEEN 2 AND 65536
    AND ("last_verified_url" IS NULL OR octet_length("last_verified_url") BETWEEN 1 AND 16384)
    AND ("repair_code" IS NULL OR octet_length("repair_code") BETWEEN 1 AND 512)
    AND "version" > 0
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND octet_length("updated_by_subject_id") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "site_auth_connections_verification_check" CHECK (
    (
      "verification_state" = 'verified'
      AND "last_verified_at" IS NOT NULL
      AND "last_verified_url" IS NOT NULL
      AND "repair_code" IS NULL
    ) OR (
      "verification_state" = 'unknown'
      AND "last_verified_at" IS NULL
      AND "last_verified_url" IS NULL
      AND "repair_code" IS NULL
    ) OR (
      "verification_state" IN ('needs_repair', 'failed')
      AND "repair_code" IS NOT NULL
    )
  ),
  CONSTRAINT "site_auth_connections_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "site_auth_connections_workspace_create_operation_uq"
    UNIQUE ("workspace_id", "create_operation_id")
);

CREATE UNIQUE INDEX "site_auth_connections_workspace_active_name_uq"
  ON "site_auth_connections" ("workspace_id", lower("name")) WHERE "status" = 'active';
CREATE INDEX "site_auth_connections_workspace_status_updated_idx"
  ON "site_auth_connections" ("workspace_id", "status", "updated_at", "id");

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_network_route_fk"
  FOREIGN KEY ("workspace_id", "network_route_id")
  REFERENCES "network_routes"("workspace_id", "id") ON DELETE RESTRICT;

CREATE TABLE "auth_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "site_auth_connection_id" uuid NOT NULL,
  "browser_session_id" uuid NOT NULL,
  "target_id" text NOT NULL,
  "controller_generation" text NOT NULL,
  "target_generation" text NOT NULL,
  "document_generation" text,
  "method_id" text,
  "authority_id" text,
  "state" text NOT NULL DEFAULT 'discovering',
  "choices" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pending_fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "external_action" jsonb,
  "intervention_id" uuid,
  "verified_url" text,
  "failure_code" text,
  "version" bigint NOT NULL DEFAULT 1,
  "operation_id" uuid NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "auth_runs_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "auth_runs_site_auth_connection_fk"
    FOREIGN KEY ("workspace_id", "site_auth_connection_id")
    REFERENCES "site_auth_connections"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "auth_runs_browser_session_fk"
    FOREIGN KEY ("workspace_id", "browser_session_id")
    REFERENCES "browser_sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "auth_runs_state_check" CHECK (
    "state" IN (
      'discovering', 'awaiting_choice', 'awaiting_secret', 'awaiting_external_action',
      'working', 'verified', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT "auth_runs_values_check" CHECK (
    octet_length("target_id") BETWEEN 1 AND 512
    AND octet_length("controller_generation") BETWEEN 1 AND 256
    AND octet_length("target_generation") BETWEEN 1 AND 256
    AND ("document_generation" IS NULL OR octet_length("document_generation") BETWEEN 1 AND 256)
    AND ("method_id" IS NULL OR octet_length("method_id") BETWEEN 1 AND 512)
    AND ("authority_id" IS NULL OR octet_length("authority_id") BETWEEN 1 AND 512)
    AND jsonb_typeof("choices") = 'array'
    AND octet_length("choices"::text) BETWEEN 2 AND 65536
    AND jsonb_typeof("pending_fields") = 'array'
    AND octet_length("pending_fields"::text) BETWEEN 2 AND 65536
    AND ("external_action" IS NULL OR (
      jsonb_typeof("external_action") = 'object'
      AND octet_length("external_action"::text) BETWEEN 2 AND 65536
    ))
    AND ("verified_url" IS NULL OR octet_length("verified_url") BETWEEN 1 AND 16384)
    AND ("failure_code" IS NULL OR octet_length("failure_code") BETWEEN 1 AND 512)
    AND "version" > 0
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "auth_runs_lifecycle_check" CHECK (
    (
      "state" = 'verified'
      AND "verified_url" IS NOT NULL
      AND "failure_code" IS NULL
      AND "settled_at" IS NOT NULL
    ) OR (
      "state" = 'failed'
      AND "verified_url" IS NULL
      AND "failure_code" IS NOT NULL
      AND "settled_at" IS NOT NULL
    ) OR (
      "state" = 'cancelled'
      AND "verified_url" IS NULL
      AND "settled_at" IS NOT NULL
    ) OR (
      "state" NOT IN ('verified', 'failed', 'cancelled')
      AND "verified_url" IS NULL
      AND "failure_code" IS NULL
      AND "settled_at" IS NULL
    )
  ),
  CONSTRAINT "auth_runs_projection_check" CHECK (
    ("state" = 'awaiting_choice') = (jsonb_array_length("choices") > 0)
    AND ("state" = 'awaiting_secret') = (jsonb_array_length("pending_fields") > 0)
    AND ("state" = 'awaiting_external_action') = ("external_action" IS NOT NULL)
    AND ("state" = 'failed') = ("failure_code" IS NOT NULL)
  ),
  CONSTRAINT "auth_runs_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "auth_runs_workspace_operation_uq" UNIQUE ("workspace_id", "operation_id")
);

CREATE INDEX "auth_runs_browser_history_idx"
  ON "auth_runs" ("workspace_id", "browser_session_id", "created_at");
CREATE INDEX "auth_runs_site_history_idx"
  ON "auth_runs" ("workspace_id", "site_auth_connection_id", "created_at");
CREATE UNIQUE INDEX "auth_runs_active_browser_target_uq"
  ON "auth_runs" ("workspace_id", "browser_session_id", "target_id")
  WHERE "settled_at" IS NULL;

CREATE TABLE "interaction_interventions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "target_id" text NOT NULL,
  "controller_generation" text NOT NULL,
  "target_generation" text NOT NULL,
  "document_generation" text,
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "auth_run_id" uuid,
  "originating_session_id" uuid NOT NULL,
  "originating_turn_id" uuid,
  "originating_attempt_id" uuid,
  "originating_tool_operation_id" uuid,
  "response_actor_subject_id" text,
  "version" bigint NOT NULL DEFAULT 1,
  "operation_id" uuid NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "interaction_interventions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "interaction_interventions_auth_run_fk"
    FOREIGN KEY ("workspace_id", "auth_run_id")
    REFERENCES "auth_runs"("workspace_id", "id") ON DELETE SET NULL ("auth_run_id"),
  CONSTRAINT "interaction_interventions_session_fk"
    FOREIGN KEY ("workspace_id", "originating_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "interaction_interventions_turn_fk"
    FOREIGN KEY ("workspace_id", "originating_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL ("originating_turn_id"),
  CONSTRAINT "interaction_interventions_attempt_fk"
    FOREIGN KEY ("workspace_id", "originating_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("originating_attempt_id"),
  CONSTRAINT "interaction_interventions_resource_kind_check"
    CHECK ("resource_kind" IN ('browser_session', 'computer_session')),
  CONSTRAINT "interaction_interventions_kind_check"
    CHECK ("kind" IN ('manual_login', 'mfa', 'external_action', 'confirmation', 'other')),
  CONSTRAINT "interaction_interventions_status_check"
    CHECK ("status" IN ('open', 'completed', 'dismissed', 'expired', 'cancelled')),
  CONSTRAINT "interaction_interventions_values_check" CHECK (
    octet_length("target_id") BETWEEN 1 AND 512
    AND octet_length("controller_generation") BETWEEN 1 AND 256
    AND octet_length("target_generation") BETWEEN 1 AND 256
    AND ("document_generation" IS NULL OR octet_length("document_generation") BETWEEN 1 AND 256)
    AND octet_length("reason") BETWEEN 1 AND 2048
    AND "reason" = btrim("reason")
    AND ("originating_attempt_id" IS NULL OR "originating_turn_id" IS NOT NULL)
    AND ("originating_tool_operation_id" IS NULL OR "originating_attempt_id" IS NOT NULL)
    AND ("response_actor_subject_id" IS NULL OR octet_length("response_actor_subject_id") BETWEEN 1 AND 1024)
    AND "version" > 0
  ),
  CONSTRAINT "interaction_interventions_lifecycle_check" CHECK (
    (
      "status" = 'open'
      AND "response_actor_subject_id" IS NULL
      AND "settled_at" IS NULL
    ) OR (
      "status" <> 'open'
      AND "settled_at" IS NOT NULL
    )
  ),
  CONSTRAINT "interaction_interventions_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "interaction_interventions_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id")
);

CREATE INDEX "interaction_interventions_open_resource_idx"
  ON "interaction_interventions"
  ("workspace_id", "resource_kind", "resource_id", "status", "created_at");
CREATE UNIQUE INDEX "interaction_interventions_open_target_kind_uq"
  ON "interaction_interventions"
  ("workspace_id", "resource_kind", "resource_id", "target_id", "kind")
  WHERE "status" = 'open';
CREATE UNIQUE INDEX "interaction_interventions_open_auth_run_uq"
  ON "interaction_interventions" ("workspace_id", "auth_run_id")
  WHERE "status" = 'open' AND "auth_run_id" IS NOT NULL;

ALTER TABLE "auth_runs"
  ADD CONSTRAINT "auth_runs_intervention_fk"
  FOREIGN KEY ("workspace_id", "intervention_id")
  REFERENCES "interaction_interventions"("workspace_id", "id")
  ON DELETE SET NULL ("intervention_id");

CREATE TABLE "interaction_resource_operations" (
  "operation_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "request_digest" text NOT NULL,
  "state" text NOT NULL DEFAULT 'completed',
  "result_version" bigint,
  "result" jsonb,
  "error_code" text,
  "actor_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "interaction_resource_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "interaction_resource_operations_resource_kind_check"
    CHECK ("resource_kind" IN ('network_route', 'site_auth_connection', 'auth_run', 'intervention')),
  CONSTRAINT "interaction_resource_operations_kind_check"
    CHECK ("kind" IN ('create', 'update', 'start', 'report', 'protected_fill', 'verify', 'resolve')),
  CONSTRAINT "interaction_resource_operations_state_check"
    CHECK ("state" IN ('prepared', 'dispatched', 'completed', 'failed', 'outcome_unknown')),
  CONSTRAINT "interaction_resource_operations_values_check" CHECK (
    "request_digest" ~ '^[0-9a-f]{64}$'
    AND ("result_version" IS NULL OR "result_version" > 0)
    AND ("result" IS NULL OR (
      jsonb_typeof("result") = 'object'
      AND octet_length("result"::text) BETWEEN 2 AND 262144
    ))
    AND ("error_code" IS NULL OR octet_length("error_code") BETWEEN 1 AND 512)
    AND octet_length("actor_subject_id") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "interaction_resource_operations_lifecycle_check" CHECK (
    (
      "state" = 'completed'
      AND "result_version" IS NOT NULL
      AND "result" IS NOT NULL
      AND "error_code" IS NULL
      AND "settled_at" IS NOT NULL
    ) OR (
      "state" IN ('failed', 'outcome_unknown')
      AND "result_version" IS NULL
      AND "result" IS NULL
      AND "error_code" IS NOT NULL
      AND "settled_at" IS NOT NULL
    ) OR (
      "state" IN ('prepared', 'dispatched')
      AND "result_version" IS NULL
      AND "result" IS NULL
      AND "error_code" IS NULL
      AND "settled_at" IS NULL
    )
  ),
  CONSTRAINT "interaction_resource_operations_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id")
);

CREATE INDEX "interaction_resource_operations_resource_history_idx"
  ON "interaction_resource_operations"
  ("workspace_id", "resource_kind", "resource_id", "created_at");

ALTER TABLE "network_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "network_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "network_routes"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "site_auth_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_auth_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "site_auth_connections"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "auth_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "auth_runs"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "interaction_interventions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interaction_interventions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "interaction_interventions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "interaction_resource_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interaction_resource_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "interaction_resource_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.network_routes, %I.site_auth_connections, %I.auth_runs, %I.interaction_interventions, %I.interaction_resource_operations FROM opengeni_app',
      target_schema, target_schema, target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.network_routes, %I.site_auth_connections, %I.auth_runs, %I.interaction_interventions, %I.interaction_resource_operations TO opengeni_app',
      target_schema, target_schema, target_schema, target_schema, target_schema
    );
  END IF;
END
$grants$;

RESET statement_timeout;
RESET lock_timeout;
