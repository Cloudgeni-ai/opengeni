-- deployment-mode: rolling
-- Expand-only normalized Capabilities Platform state. The v1 catalog,
-- capability installations, workspace packs, and pack installations remain
-- authoritative during shadow-read/backfill and are not dropped or renamed.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "capability_plugins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plugin_key" text NOT NULL,
  "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "category" text NOT NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provenance" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_plugins_scope_chk" CHECK (
    ("account_id" IS NULL AND "workspace_id" IS NULL)
    OR ("account_id" IS NOT NULL AND "workspace_id" IS NOT NULL)
  ),
  CONSTRAINT "capability_plugins_key_chk" CHECK (
    length("plugin_key") BETWEEN 1 AND 200
    AND "plugin_key" = lower(btrim("plugin_key"))
    AND "plugin_key" ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'
  ),
  CONSTRAINT "capability_plugins_text_chk" CHECK (
    length(btrim("name")) BETWEEN 1 AND 200
    AND length("category") BETWEEN 1 AND 96
    AND ("description" IS NULL OR length("description") <= 4000)
  ),
  CONSTRAINT "capability_plugins_tags_chk" CHECK (
    jsonb_typeof("tags") = 'array'
    AND jsonb_array_length("tags") <= 64
    AND octet_length(convert_to("tags"::text, 'UTF8')) <= 8192
  ),
  CONSTRAINT "capability_plugins_provenance_chk" CHECK (
    "provenance" IN ('platform', 'deployment', 'registry', 'workspace')
  )
);

CREATE UNIQUE INDEX "capability_plugins_global_key_idx"
  ON "capability_plugins" ("plugin_key") WHERE "workspace_id" IS NULL;
CREATE UNIQUE INDEX "capability_plugins_workspace_key_idx"
  ON "capability_plugins" ("workspace_id", "plugin_key");
CREATE INDEX "capability_plugins_scope_idx"
  ON "capability_plugins" ("workspace_id", "category");

CREATE TABLE "capability_plugin_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plugin_id" uuid NOT NULL REFERENCES "capability_plugins"("id") ON DELETE CASCADE,
  "version" text NOT NULL,
  "manifest_digest" text NOT NULL,
  "manifest" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'published',
  "import_batch_id" uuid REFERENCES "import_batches"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_plugin_versions_version_chk" CHECK (
    length("version") BETWEEN 1 AND 96
    AND "version" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "capability_plugin_versions_digest_chk" CHECK (
    "manifest_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "capability_plugin_versions_manifest_chk" CHECK (
    jsonb_typeof("manifest") = 'object'
    AND octet_length(convert_to("manifest"::text, 'UTF8')) <= 1048576
  ),
  CONSTRAINT "capability_plugin_versions_status_chk" CHECK (
    "status" IN ('published', 'stale', 'withdrawn')
  ),
  CONSTRAINT "capability_plugin_versions_plugin_version_uq" UNIQUE ("plugin_id", "version"),
  CONSTRAINT "capability_plugin_versions_plugin_digest_uq" UNIQUE ("plugin_id", "manifest_digest"),
  CONSTRAINT "capability_plugin_versions_plugin_identity_uq" UNIQUE ("plugin_id", "id")
);

CREATE TABLE "capability_facets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "plugin_version_id" uuid NOT NULL
    REFERENCES "capability_plugin_versions"("id") ON DELETE CASCADE,
  "facet_key" text NOT NULL,
  "kind" text NOT NULL,
  "activation_mode" text NOT NULL,
  "required" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_facets_key_chk" CHECK (
    length("facet_key") BETWEEN 1 AND 200
    AND "facet_key" = lower(btrim("facet_key"))
    AND "facet_key" ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'
  ),
  CONSTRAINT "capability_facets_kind_chk" CHECK (
    "kind" IN ('integration', 'mcp', 'api', 'skill')
  ),
  CONSTRAINT "capability_facets_activation_chk" CHECK (
    "activation_mode" IN ('platform_available', 'runtime_baseline', 'workspace_managed')
  ),
  CONSTRAINT "capability_facets_version_key_uq" UNIQUE ("plugin_version_id", "facet_key")
);

CREATE INDEX "capability_facets_version_kind_idx"
  ON "capability_facets" ("plugin_version_id", "kind");

CREATE TABLE "capability_integration_facets" (
  "facet_id" uuid PRIMARY KEY REFERENCES "capability_facets"("id") ON DELETE CASCADE,
  "provider_domain" text NOT NULL,
  "connection_kinds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ownership" text NOT NULL,
  "required_scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "resource_selection" text NOT NULL DEFAULT 'none',
  CONSTRAINT "capability_integration_facets_domain_chk" CHECK (
    length("provider_domain") BETWEEN 1 AND 253
    AND "provider_domain" = lower(btrim("provider_domain"))
    AND "provider_domain" !~ '[/@[:space:]]'
  ),
  CONSTRAINT "capability_integration_facets_connections_chk" CHECK (
    jsonb_typeof("connection_kinds") = 'array'
    AND jsonb_array_length("connection_kinds") <= 16
    AND octet_length(convert_to("connection_kinds"::text, 'UTF8')) <= 4096
  ),
  CONSTRAINT "capability_integration_facets_ownership_chk" CHECK (
    "ownership" IN ('workspace', 'subject', 'either')
  ),
  CONSTRAINT "capability_integration_facets_scopes_chk" CHECK (
    jsonb_typeof("required_scopes") = 'array'
    AND jsonb_array_length("required_scopes") <= 256
    AND octet_length(convert_to("required_scopes"::text, 'UTF8')) <= 32768
  ),
  CONSTRAINT "capability_integration_facets_resource_chk" CHECK (
    "resource_selection" IN ('none', 'optional', 'required')
  )
);

CREATE TABLE "capability_mcp_facets" (
  "facet_id" uuid PRIMARY KEY REFERENCES "capability_facets"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL,
  "endpoint_url" text NOT NULL,
  "transport" text NOT NULL,
  "auth_kind" text NOT NULL,
  "integration_facet_id" uuid REFERENCES "capability_integration_facets"("facet_id")
    ON DELETE RESTRICT,
  "allowed_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "capability_mcp_facets_server_chk" CHECK (
    length("server_id") BETWEEN 1 AND 128
    AND "server_id" ~ '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$'
  ),
  CONSTRAINT "capability_mcp_facets_url_chk" CHECK (
    length("endpoint_url") BETWEEN 1 AND 2048
    AND "endpoint_url" ~ '^https://'
    AND "endpoint_url" !~ '[[:cntrl:][:space:]]'
  ),
  CONSTRAINT "capability_mcp_facets_transport_chk" CHECK (
    "transport" IN ('streamable_http', 'sse')
  ),
  CONSTRAINT "capability_mcp_facets_auth_chk" CHECK (
    "auth_kind" IN ('oauth2', 'api_key', 'none', 'unknown')
  ),
  CONSTRAINT "capability_mcp_facets_tools_chk" CHECK (
    jsonb_typeof("allowed_tools") = 'array'
    AND jsonb_array_length("allowed_tools") <= 1024
    AND octet_length(convert_to("allowed_tools"::text, 'UTF8')) <= 131072
  )
);

CREATE INDEX "capability_mcp_facets_server_idx" ON "capability_mcp_facets" ("server_id");

CREATE TABLE "capability_api_facets" (
  "facet_id" uuid PRIMARY KEY REFERENCES "capability_facets"("id") ON DELETE CASCADE,
  "protocol" text NOT NULL,
  "base_url" text NOT NULL,
  "spec_source_url" text,
  "auth_scheme" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "integration_facet_id" uuid REFERENCES "capability_integration_facets"("facet_id")
    ON DELETE RESTRICT,
  CONSTRAINT "capability_api_facets_protocol_chk" CHECK (
    "protocol" IN ('openapi', 'graphql')
  ),
  CONSTRAINT "capability_api_facets_base_url_chk" CHECK (
    length("base_url") BETWEEN 1 AND 2048
    AND "base_url" ~ '^https://'
    AND "base_url" !~ '[[:cntrl:][:space:]]'
  ),
  CONSTRAINT "capability_api_facets_source_url_chk" CHECK (
    "spec_source_url" IS NULL OR (
      length("spec_source_url") BETWEEN 1 AND 2048
      AND "spec_source_url" ~ '^https://'
      AND "spec_source_url" !~ '[[:cntrl:][:space:]]'
    )
  ),
  CONSTRAINT "capability_api_facets_auth_chk" CHECK (
    jsonb_typeof("auth_scheme") = 'object'
    AND octet_length(convert_to("auth_scheme"::text, 'UTF8')) <= 32768
  )
);

CREATE TABLE "capability_skill_facets" (
  "facet_id" uuid PRIMARY KEY REFERENCES "capability_facets"("id") ON DELETE CASCADE,
  "capability_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "source_url" text NOT NULL,
  "source_commit" text NOT NULL,
  "source_path" text NOT NULL,
  "content_sha256" text NOT NULL,
  "file_count" integer NOT NULL,
  "total_bytes" integer NOT NULL,
  "license" text,
  CONSTRAINT "capability_skill_facets_capability_id_chk" CHECK (
    length("capability_id") BETWEEN 1 AND 512
    AND "capability_id" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "capability_skill_facets_name_chk" CHECK (
    length("name") BETWEEN 1 AND 64
    AND "name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CONSTRAINT "capability_skill_facets_description_chk" CHECK (
    length("description") BETWEEN 1 AND 2048
    AND "description" !~ '[\r\n]'
  ),
  CONSTRAINT "capability_skill_facets_source_chk" CHECK (
    length("source_url") BETWEEN 1 AND 2048
    AND "source_url" ~ '^https://'
    AND "source_url" !~ '[[:cntrl:][:space:]]'
    AND "source_commit" ~ '^[0-9a-f]{40,64}$'
    AND length("source_path") BETWEEN 1 AND 1024
    AND "source_path" !~ '(^/|/$|//|\\|(^|/)\.\.?(/|$)|[[:cntrl:]])'
  ),
  CONSTRAINT "capability_skill_facets_content_chk" CHECK (
    "content_sha256" ~ '^[0-9a-f]{64}$'
    AND "file_count" BETWEEN 1 AND 128
    AND "total_bytes" BETWEEN 1 AND 1048576
  ),
  CONSTRAINT "capability_skill_facets_license_chk" CHECK (
    "license" IS NULL OR length("license") BETWEEN 1 AND 128
  )
);

CREATE INDEX "capability_skill_facets_content_idx"
  ON "capability_skill_facets" ("content_sha256");

CREATE TABLE "capability_skill_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_facet_id" uuid NOT NULL REFERENCES "capability_skill_facets"("facet_id")
    ON DELETE CASCADE,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "byte_size" integer NOT NULL,
  "content_sha256" text NOT NULL,
  CONSTRAINT "capability_skill_files_path_chk" CHECK (
    length("path") BETWEEN 1 AND 1024
    AND "path" !~ '(^/|/$|//|\\|(^|/)\.\.?(/|$)|[[:cntrl:]])'
  ),
  CONSTRAINT "capability_skill_files_content_chk" CHECK (
    "byte_size" BETWEEN 0 AND 262144
    AND "byte_size" = octet_length(convert_to("content", 'UTF8'))
    AND "content_sha256" ~ '^[0-9a-f]{64}$'
    AND "content_sha256" = encode(sha256(convert_to("content", 'UTF8')), 'hex')
  ),
  CONSTRAINT "capability_skill_files_skill_path_uq" UNIQUE ("skill_facet_id", "path")
);

CREATE TABLE "capability_plugin_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plugin_id" uuid NOT NULL REFERENCES "capability_plugins"("id") ON DELETE RESTRICT,
  "plugin_version_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "installed_by_subject_id" text NOT NULL,
  "installed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_plugin_installations_plugin_version_fk"
    FOREIGN KEY ("plugin_id", "plugin_version_id")
    REFERENCES "capability_plugin_versions"("plugin_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "capability_plugin_installations_status_chk" CHECK (
    "status" IN ('active', 'disabled', 'needs_attention')
  ),
  CONSTRAINT "capability_plugin_installations_version_chk" CHECK ("version" > 0),
  CONSTRAINT "capability_plugin_installations_actor_chk" CHECK (
    length(btrim("installed_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "capability_plugin_installations_workspace_plugin_uq"
    UNIQUE ("workspace_id", "plugin_id")
);

CREATE INDEX "capability_plugin_installations_workspace_status_idx"
  ON "capability_plugin_installations" ("workspace_id", "status");

CREATE TABLE "capability_facet_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "plugin_installation_id" uuid NOT NULL
    REFERENCES "capability_plugin_installations"("id") ON DELETE CASCADE,
  "facet_id" uuid NOT NULL REFERENCES "capability_facets"("id") ON DELETE RESTRICT,
  "connection_id" uuid REFERENCES "connections"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "attention_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_facet_installations_status_chk" CHECK (
    "status" IN ('active', 'disabled', 'needs_attention')
  ),
  CONSTRAINT "capability_facet_installations_config_chk" CHECK (
    jsonb_typeof("config") = 'object'
    AND octet_length(convert_to("config"::text, 'UTF8')) <= 131072
  ),
  CONSTRAINT "capability_facet_installations_version_chk" CHECK ("version" > 0),
  CONSTRAINT "capability_facet_installations_attention_chk" CHECK (
    ("status" = 'needs_attention') = ("attention_code" IS NOT NULL)
    AND ("attention_code" IS NULL OR length("attention_code") BETWEEN 1 AND 120)
  ),
  CONSTRAINT "capability_facet_installations_installation_facet_uq"
    UNIQUE ("plugin_installation_id", "facet_id")
);

CREATE INDEX "capability_facet_installations_workspace_status_idx"
  ON "capability_facet_installations" ("workspace_id", "status");

CREATE TABLE "capability_component_owners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "facet_installation_id" uuid NOT NULL
    REFERENCES "capability_facet_installations"("id") ON DELETE CASCADE,
  "owner_kind" text NOT NULL,
  "owner_id" text NOT NULL,
  "removable" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capability_component_owners_kind_chk" CHECK (
    "owner_kind" IN ('direct', 'plugin', 'pack', 'migration')
  ),
  CONSTRAINT "capability_component_owners_id_chk" CHECK (
    length("owner_id") BETWEEN 1 AND 512 AND "owner_id" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "capability_component_owners_unique_uq"
    UNIQUE ("facet_installation_id", "owner_kind", "owner_id")
);

CREATE INDEX "capability_component_owners_workspace_owner_idx"
  ON "capability_component_owners" ("workspace_id", "owner_kind", "owner_id");

CREATE TABLE "integration_spec_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_facet_id" uuid NOT NULL REFERENCES "capability_api_facets"("facet_id")
    ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "protocol" text NOT NULL,
  "source_url" text,
  "spec_digest" text NOT NULL,
  "spec" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_spec_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "integration_spec_revisions_protocol_chk" CHECK (
    "protocol" IN ('openapi', 'graphql')
  ),
  CONSTRAINT "integration_spec_revisions_source_chk" CHECK (
    "source_url" IS NULL OR (
      length("source_url") BETWEEN 1 AND 2048
      AND "source_url" ~ '^https://'
      AND "source_url" !~ '[[:cntrl:][:space:]]'
    )
  ),
  CONSTRAINT "integration_spec_revisions_spec_chk" CHECK (
    "spec_digest" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("spec") = 'object'
    AND octet_length(convert_to("spec"::text, 'UTF8')) <= 4194304
  ),
  CONSTRAINT "integration_spec_revisions_status_chk" CHECK (
    "status" IN ('active', 'stale', 'invalid')
  ),
  CONSTRAINT "integration_spec_revisions_facet_revision_uq"
    UNIQUE ("api_facet_id", "revision"),
  CONSTRAINT "integration_spec_revisions_facet_digest_uq"
    UNIQUE ("api_facet_id", "spec_digest")
);

CREATE TABLE "integration_tools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "facet_id" uuid NOT NULL REFERENCES "capability_facets"("id") ON DELETE CASCADE,
  "tool_key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "input_schema" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_schema" jsonb,
  "effect" text NOT NULL DEFAULT 'read',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_tools_key_chk" CHECK (
    length("tool_key") BETWEEN 1 AND 200
    AND "tool_key" ~ '^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$'
  ),
  CONSTRAINT "integration_tools_text_chk" CHECK (
    length("name") BETWEEN 1 AND 200
    AND ("description" IS NULL OR length("description") <= 4000)
  ),
  CONSTRAINT "integration_tools_schema_chk" CHECK (
    jsonb_typeof("input_schema") = 'object'
    AND ("output_schema" IS NULL OR jsonb_typeof("output_schema") = 'object')
    AND octet_length(convert_to("input_schema"::text, 'UTF8')) <= 262144
    AND ("output_schema" IS NULL OR octet_length(convert_to("output_schema"::text, 'UTF8')) <= 262144)
  ),
  CONSTRAINT "integration_tools_effect_chk" CHECK (
    "effect" IN ('read', 'write', 'destructive')
  ),
  CONSTRAINT "integration_tools_facet_tool_uq" UNIQUE ("facet_id", "tool_key")
);

CREATE TABLE "integration_feature_facets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "integration_facet_id" uuid NOT NULL
    REFERENCES "capability_integration_facets"("facet_id") ON DELETE CASCADE,
  "feature_key" text NOT NULL,
  "kind" text NOT NULL,
  "config_schema" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_feature_facets_key_chk" CHECK (
    length("feature_key") BETWEEN 1 AND 200
    AND "feature_key" = lower(btrim("feature_key"))
    AND "feature_key" ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'
  ),
  CONSTRAINT "integration_feature_facets_kind_chk" CHECK (
    "kind" IN ('tools', 'knowledge_source', 'inbound_trigger', 'delivery_destination', 'identity_link')
  ),
  CONSTRAINT "integration_feature_facets_schema_chk" CHECK (
    jsonb_typeof("config_schema") = 'object'
    AND jsonb_typeof("capabilities") = 'object'
    AND octet_length(convert_to("config_schema"::text, 'UTF8')) <= 131072
    AND octet_length(convert_to("capabilities"::text, 'UTF8')) <= 131072
  ),
  CONSTRAINT "integration_feature_facets_integration_feature_uq"
    UNIQUE ("integration_facet_id", "feature_key")
);

CREATE INDEX "integration_feature_facets_integration_kind_idx"
  ON "integration_feature_facets" ("integration_facet_id", "kind");

CREATE TABLE "integration_feature_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "feature_facet_id" uuid NOT NULL REFERENCES "integration_feature_facets"("id")
    ON DELETE RESTRICT,
  "integration_facet_installation_id" uuid NOT NULL
    REFERENCES "capability_facet_installations"("id") ON DELETE CASCADE,
  "binding_key" text NOT NULL,
  "display_name" text NOT NULL,
  "runtime_key" text,
  "connection_id" uuid REFERENCES "connections"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active',
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "cursor" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "last_success_at" timestamptz,
  "last_error_code" text,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_feature_bindings_identity_chk" CHECK (
    length("binding_key") BETWEEN 1 AND 128
    AND "binding_key" = lower(btrim("binding_key"))
    AND "binding_key" ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'
    AND length(btrim("display_name")) BETWEEN 1 AND 200
    AND length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "integration_feature_bindings_runtime_chk" CHECK (
    "runtime_key" IS NULL OR (
      length("runtime_key") BETWEEN 1 AND 128
      AND "runtime_key" ~ '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$'
    )
  ),
  CONSTRAINT "integration_feature_bindings_status_chk" CHECK (
    "status" IN ('active', 'paused', 'needs_attention', 'disabled')
  ),
  CONSTRAINT "integration_feature_bindings_state_chk" CHECK (
    jsonb_typeof("config") = 'object'
    AND jsonb_typeof("cursor") = 'object'
    AND octet_length(convert_to("config"::text, 'UTF8')) <= 131072
    AND octet_length(convert_to("cursor"::text, 'UTF8')) <= 131072
    AND "version" > 0
    AND ("last_error_code" IS NULL OR length("last_error_code") BETWEEN 1 AND 120)
  ),
  CONSTRAINT "integration_feature_bindings_installation_feature_key_uq"
    UNIQUE (
      "workspace_id", "integration_facet_installation_id", "feature_facet_id", "binding_key"
    )
);

CREATE INDEX "integration_feature_bindings_workspace_status_idx"
  ON "integration_feature_bindings" ("workspace_id", "status");
CREATE UNIQUE INDEX "integration_feature_bindings_workspace_runtime_uq"
  ON "integration_feature_bindings" ("workspace_id", "runtime_key")
  WHERE "runtime_key" IS NOT NULL;

CREATE TABLE "integration_feature_binding_owners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "binding_id" uuid NOT NULL REFERENCES "integration_feature_bindings"("id")
    ON DELETE CASCADE,
  "owner_kind" text NOT NULL,
  "owner_id" text NOT NULL,
  "removable" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_feature_binding_owners_kind_chk" CHECK (
    "owner_kind" IN ('direct', 'plugin', 'pack', 'migration')
  ),
  CONSTRAINT "integration_feature_binding_owners_id_chk" CHECK (
    length("owner_id") BETWEEN 1 AND 512 AND "owner_id" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "integration_feature_binding_owners_unique_uq"
    UNIQUE ("binding_id", "owner_kind", "owner_id")
);

CREATE INDEX "integration_feature_binding_owners_workspace_owner_idx"
  ON "integration_feature_binding_owners" ("workspace_id", "owner_kind", "owner_id");

CREATE TABLE "capability_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "kind" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "phase" text NOT NULL DEFAULT 'admitted',
  "version" integer NOT NULL DEFAULT 1,
  "result" jsonb,
  "error_code" text,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "capability_operations_idempotency_chk" CHECK (
    length("idempotency_key") BETWEEN 1 AND 200
    AND "request_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "capability_operations_kind_chk" CHECK (
    "kind" IN ('install', 'connect', 'configure', 'update', 'repair', 'disconnect', 'uninstall')
  ),
  CONSTRAINT "capability_operations_target_chk" CHECK (
    "target_kind" IN ('plugin', 'integration', 'skill', 'pack', 'facet_binding')
    AND length("target_id") BETWEEN 1 AND 512
  ),
  CONSTRAINT "capability_operations_status_chk" CHECK (
    "status" IN ('pending', 'running', 'completed', 'failed', 'outcome_unknown')
  ),
  CONSTRAINT "capability_operations_state_chk" CHECK (
    length("phase") BETWEEN 1 AND 120
    AND "version" > 0
    AND ("result" IS NULL OR (
      jsonb_typeof("result") = 'object'
      AND octet_length(convert_to("result"::text, 'UTF8')) <= 131072
    ))
    AND ("error_code" IS NULL OR length("error_code") BETWEEN 1 AND 120)
    AND length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
    AND (("status" IN ('completed', 'failed')) = ("completed_at" IS NOT NULL))
  ),
  CONSTRAINT "capability_operations_workspace_idempotency_uq"
    UNIQUE ("workspace_id", "idempotency_key")
);

CREATE INDEX "capability_operations_workspace_status_idx"
  ON "capability_operations" ("workspace_id", "status", "updated_at");

CREATE OR REPLACE FUNCTION capability_v2_reject_immutable_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER capability_facets_immutable
  BEFORE UPDATE ON "capability_facets"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER capability_integration_facets_immutable
  BEFORE UPDATE ON "capability_integration_facets"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER capability_mcp_facets_immutable
  BEFORE UPDATE ON "capability_mcp_facets"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER capability_api_facets_immutable
  BEFORE UPDATE ON "capability_api_facets"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER capability_skill_facets_immutable
  BEFORE UPDATE ON "capability_skill_facets"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER capability_skill_files_immutable
  BEFORE UPDATE ON "capability_skill_files"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();
CREATE TRIGGER integration_spec_revisions_immutable
  BEFORE UPDATE ON "integration_spec_revisions"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE OR REPLACE FUNCTION capability_plugin_versions_restrict_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."plugin_id" IS DISTINCT FROM OLD."plugin_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."manifest_digest" IS DISTINCT FROM OLD."manifest_digest"
    OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
    OR NEW."import_batch_id" IS DISTINCT FROM OLD."import_batch_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'published capability plugin version identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_plugin_versions_restrict_update
  BEFORE UPDATE ON "capability_plugin_versions"
  FOR EACH ROW EXECUTE FUNCTION capability_plugin_versions_restrict_update();

CREATE OR REPLACE FUNCTION capability_v2_validate_plugin_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "capability_plugins" p
    JOIN "capability_plugin_versions" v
      ON v."plugin_id" = p."id" AND v."id" = NEW."plugin_version_id"
    WHERE p."id" = NEW."plugin_id"
      AND (
        p."workspace_id" IS NULL
        OR (
          p."account_id" = NEW."account_id"
          AND p."workspace_id" = NEW."workspace_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'plugin installation version or tenant does not match its plugin'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_plugin_installations_validate
  BEFORE INSERT OR UPDATE ON "capability_plugin_installations"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_plugin_installation();

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "capability_plugin_installations" i
    JOIN "capability_facets" f ON f."id" = NEW."facet_id"
    WHERE i."id" = NEW."plugin_installation_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
      AND f."plugin_version_id" = i."plugin_version_id"
  ) THEN
    RAISE EXCEPTION 'facet installation does not match its plugin installation or tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."connection_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "connections" c
    WHERE c."id" = NEW."connection_id"
      AND c."account_id" = NEW."account_id"
      AND c."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'facet installation connection belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_facet_installations_validate
  BEFORE INSERT OR UPDATE ON "capability_facet_installations"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_installation();

CREATE OR REPLACE FUNCTION capability_v2_validate_component_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "capability_facet_installations" i
    WHERE i."id" = NEW."facet_installation_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'component owner does not match its facet installation tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_component_owners_validate
  BEFORE INSERT OR UPDATE ON "capability_component_owners"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_component_owner();

CREATE OR REPLACE FUNCTION capability_v2_validate_feature_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "integration_feature_facets" f
    JOIN "capability_facet_installations" i
      ON i."id" = NEW."integration_facet_installation_id"
     AND i."facet_id" = f."integration_facet_id"
    WHERE f."id" = NEW."feature_facet_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'feature binding does not match its integration installation or tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."connection_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "connections" c
    WHERE c."id" = NEW."connection_id"
      AND c."account_id" = NEW."account_id"
      AND c."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'feature binding connection belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_feature_bindings_validate
  BEFORE INSERT OR UPDATE ON "integration_feature_bindings"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_feature_binding();

CREATE OR REPLACE FUNCTION capability_v2_validate_feature_binding_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "integration_feature_bindings" b
    WHERE b."id" = NEW."binding_id"
      AND b."account_id" = NEW."account_id"
      AND b."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'feature binding owner does not match its binding tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_feature_binding_owners_validate
  BEFORE INSERT OR UPDATE ON "integration_feature_binding_owners"
  FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_feature_binding_owner();

ALTER TABLE "capability_plugins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_plugins" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_plugin_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_plugin_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_integration_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_integration_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_mcp_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_mcp_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_api_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_api_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_skill_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_skill_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_skill_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_skill_files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_plugin_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_plugin_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_facet_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_facet_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_component_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_component_owners" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_spec_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_spec_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_tools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_tools" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_facets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_facets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_binding_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_feature_binding_owners" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capability_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_or_global_visibility ON "capability_plugins"
  USING (
    "workspace_id" IS NULL
    OR opengeni_private.workspace_rls_visible("account_id", "workspace_id")
  )
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY parent_plugin_visibility ON "capability_plugin_versions"
  USING (EXISTS (
    SELECT 1 FROM "capability_plugins" p WHERE p."id" = "plugin_id"
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "capability_plugins" p
    WHERE p."id" = "plugin_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));

CREATE POLICY parent_plugin_visibility ON "capability_facets"
  USING (EXISTS (
    SELECT 1 FROM "capability_plugin_versions" v WHERE v."id" = "plugin_version_id"
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_plugin_versions" v
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE v."id" = "plugin_version_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));

CREATE POLICY parent_facet_visibility ON "capability_integration_facets"
  USING (EXISTS (SELECT 1 FROM "capability_facets" f WHERE f."id" = "facet_id"))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_facets" f
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE f."id" = "facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_facet_visibility ON "capability_mcp_facets"
  USING (EXISTS (SELECT 1 FROM "capability_facets" f WHERE f."id" = "facet_id"))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_facets" f
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE f."id" = "facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_facet_visibility ON "capability_api_facets"
  USING (EXISTS (SELECT 1 FROM "capability_facets" f WHERE f."id" = "facet_id"))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_facets" f
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE f."id" = "facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_facet_visibility ON "capability_skill_facets"
  USING (EXISTS (SELECT 1 FROM "capability_facets" f WHERE f."id" = "facet_id"))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_facets" f
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE f."id" = "facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_skill_visibility ON "capability_skill_files"
  USING (EXISTS (
    SELECT 1 FROM "capability_skill_facets" s WHERE s."facet_id" = "skill_facet_id"
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_skill_facets" s
    JOIN "capability_facets" f ON f."id" = s."facet_id"
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE s."facet_id" = "skill_facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_api_visibility ON "integration_spec_revisions"
  USING (EXISTS (
    SELECT 1 FROM "capability_api_facets" a WHERE a."facet_id" = "api_facet_id"
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_api_facets" a
    JOIN "capability_facets" f ON f."id" = a."facet_id"
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE a."facet_id" = "api_facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_facet_visibility ON "integration_tools"
  USING (EXISTS (SELECT 1 FROM "capability_facets" f WHERE f."id" = "facet_id"))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_facets" f
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE f."id" = "facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));
CREATE POLICY parent_integration_visibility ON "integration_feature_facets"
  USING (EXISTS (
    SELECT 1 FROM "capability_integration_facets" i
    WHERE i."facet_id" = "integration_facet_id"
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "capability_integration_facets" i
    JOIN "capability_facets" f ON f."id" = i."facet_id"
    JOIN "capability_plugin_versions" v ON v."id" = f."plugin_version_id"
    JOIN "capability_plugins" p ON p."id" = v."plugin_id"
    WHERE i."facet_id" = "integration_facet_id"
      AND p."workspace_id" IS NOT NULL
      AND opengeni_private.workspace_rls_visible(p."account_id", p."workspace_id")
  ));

CREATE POLICY workspace_isolation ON "capability_plugin_installations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "capability_facet_installations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "capability_component_owners"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "integration_feature_bindings"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "integration_feature_binding_owners"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "capability_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "capability_plugins",
      "capability_plugin_versions",
      "capability_facets",
      "capability_integration_facets",
      "capability_mcp_facets",
      "capability_api_facets",
      "capability_skill_facets",
      "capability_skill_files",
      "capability_plugin_installations",
      "capability_facet_installations",
      "capability_component_owners",
      "integration_spec_revisions",
      "integration_tools",
      "integration_feature_facets",
      "integration_feature_bindings",
      "integration_feature_binding_owners",
      "capability_operations"
    TO opengeni_app;
  END IF;
END $$;