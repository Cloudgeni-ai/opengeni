locals {
  # Only environment outputs feed these URLs, never app outputs. This lets
  # bootstrap set CORS and job configuration before serving apps exist, and
  # prevents API<->web resource dependency cycles.
  edge_name         = "${var.name_prefix}-edge"
  edge_fqdn         = "${local.edge_name}.${azurerm_container_app_environment.this.default_domain}"
  api_fqdn          = "${local.app_name}.internal.${azurerm_container_app_environment.this.default_domain}"
  web_internal_fqdn = "${local.web_name}.internal.${azurerm_container_app_environment.this.default_domain}"
  web_fqdn          = local.edge_fqdn
  api_url           = "https://${local.edge_fqdn}"
  api_internal_url  = "https://${local.api_fqdn}"
  web_url           = "https://${local.web_fqdn}"
  image_revision    = substr(try(split("@sha256:", var.images.api)[1], "invalid"), 0, 12)

  reserved_env_names = toset([
    "OPENGENI_ENVIRONMENT", "OPENGENI_DEPLOYMENT_REVISION",
    "OPENGENI_DATABASE_URL", "OPENGENI_DATABASE_ADMIN_URL", "OPENGENI_MIGRATIONS_DATABASE_URL",
    "OPENGENI_APP_DATABASE_USER", "OPENGENI_APP_DATABASE_PASSWORD",
    "OPENGENI_RUNTIME_DATABASE_ROLE", "OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES",
    "OPENGENI_TEMPORAL_DATABASE_USER", "OPENGENI_TEMPORAL_DATABASE_PASSWORD",
    "OPENGENI_TEMPORAL_HOST", "OPENGENI_TEMPORAL_NAMESPACE", "OPENGENI_TEMPORAL_TASK_QUEUE", "OPENGENI_TEMPORAL_TLS_ENABLED",
    "OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL", "OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER",
    "OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD", "OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE",
    "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL", "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD",
    "OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE", "OPENGENI_ARTIFACT_MATERIALIZER_ENABLED",
    "OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED", "OPENGENI_ARTIFACT_OUTBOX_ENABLED",
    "OPENGENI_RLS_STRATEGY", "OPENGENI_DB_SCHEMA", "OPENGENI_API_HOST", "OPENGENI_API_PORT",
    "OPENGENI_API_METRICS_PORT", "OPENGENI_WORKER_HTTP_PORT", "OPENGENI_WORKER_ROLE",
    "OPENGENI_PUBLIC_BASE_URL", "OPENGENI_WEB_BASE_URL", "OPENGENI_WEB_ALLOWED_HOSTS",
    "OPENGENI_BETTER_AUTH_URL", "OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS",
    "OPENGENI_MCP_URL", "OPENGENI_MCP_INTERNAL_URL", "OPENGENI_CORS_ALLOW_ORIGIN_REGEX",
    "OPENGENI_PRODUCT_ACCESS_MODE", "OPENGENI_AUTH_REQUIRED", "OPENGENI_AUTH_ALLOW_HEALTH",
    "OPENGENI_AUTH_ALLOW_METRICS", "OPENGENI_SANDBOX_BACKEND", "OPENGENI_SANDBOX_SELFHOSTED_ENABLED",
    "OPENGENI_SANDBOX_PREPARATION_PROFILES", "OPENGENI_SANDBOX_ENV_ALLOWLIST",
    "OPENGENI_OBJECT_STORAGE_BACKEND", "OPENGENI_OBJECT_STORAGE_BUCKET", "OPENGENI_OBJECT_STORAGE_ENDPOINT",
    "OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT", "OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT",
    "OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME", "OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY",
    "OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING", "OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT",
    "OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID", "OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY",
    "OPENGENI_ORGANIZATION_USER_SETUP_EMAIL_TOKEN_TRANSPORT",
    "OPENGENI_ORGANIZATION_USER_SETUP_QUERY_EDGE_SANITIZATION_CONFIRMED",
  ])

  sandbox_secret_requirements = {
    modal       = toset(["OPENGENI_MODAL_TOKEN_ID", "OPENGENI_MODAL_TOKEN_SECRET"])
    daytona     = toset(["OPENGENI_DAYTONA_API_KEY"])
    runloop     = toset(["OPENGENI_RUNLOOP_API_KEY"])
    e2b         = toset(["OPENGENI_E2B_API_KEY"])
    blaxel      = toset(["OPENGENI_BLAXEL_API_KEY"])
    cloudflare  = toset([])
    vercel      = toset(["OPENGENI_VERCEL_TOKEN"])
    opensandbox = toset(["OPENGENI_OPENSANDBOX_API_KEY"])
  }
  sandbox_config_requirements = {
    modal       = toset(["OPENGENI_MODAL_APP_NAME"])
    daytona     = toset([])
    runloop     = toset([])
    e2b         = toset([])
    blaxel      = toset([])
    cloudflare  = toset(["OPENGENI_CLOUDFLARE_WORKER_URL"])
    vercel      = toset(["OPENGENI_VERCEL_PROJECT_ID"])
    opensandbox = toset(["OPENGENI_OPENSANDBOX_BASE_URL", "OPENGENI_OPENSANDBOX_IMAGE"])
  }
  required_application_secret_env = setunion(
    var.required_model_secret_env,
    lookup(local.sandbox_secret_requirements, var.sandbox_backend, toset([])),
    toset(["OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"]),
    var.access_mode == "configured" ? toset(["OPENGENI_ACCESS_KEY"]) : toset([
      "OPENGENI_BETTER_AUTH_SECRET", "OPENGENI_DELEGATION_SECRET", "OPENGENI_RESEND_API_KEY"
    ]),
    contains(["true", "1", "yes", "y", "on"], lower(trimspace(lookup(var.config_env, "OPENGENI_INTEGRATIONS_ENABLED", "false")))) ? toset(["OPENGENI_INTEGRATIONS_STATE_SECRET"]) : toset([])
  )

  storage_config_env = {
    OPENGENI_OBJECT_STORAGE_BACKEND            = "azure-blob"
    OPENGENI_OBJECT_STORAGE_BUCKET             = azurerm_storage_container.files.name
    OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_NAME = azurerm_storage_account.this.name
    OPENGENI_OBJECT_STORAGE_AZURE_ENDPOINT     = azurerm_storage_account.this.primary_blob_endpoint
  }
  external_config_env = {
    OPENGENI_TEMPORAL_HOST        = var.external_services.temporal_host
    OPENGENI_TEMPORAL_NAMESPACE   = var.external_services.temporal_namespace
    OPENGENI_TEMPORAL_TASK_QUEUE  = var.external_services.temporal_task_queue
    OPENGENI_TEMPORAL_TLS_ENABLED = tostring(var.external_services.temporal_tls_enabled)
    OPENGENI_NATS_URL             = var.external_services.nats_url
  }
  application_config_env = merge({
    MIMALLOC_PURGE_DELAY                               = "0"
    MIMALLOC_PURGE_DECOMMITS                           = "1"
    OPENGENI_SERVICE_NAME                              = "opengeni"
    OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS         = "30"
    OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS = "1000"
    OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS     = "5000"
    OPENGENI_OBSERVABILITY_STRUCTURED_LOGS             = "true"
    OPENGENI_OBSERVABILITY_METRICS_ENABLED             = "true"
    OPENGENI_BILLING_MODE                              = "disabled"
    OPENGENI_ENTITLEMENTS_MODE                         = "none"
    OPENGENI_USAGE_LIMITS_MODE                         = "none"
    OPENGENI_INTEGRATIONS_ENABLED                      = "false"
    OPENGENI_MODEL_CATALOG_SOURCE                      = "code"
    OPENGENI_MODAL_APP_NAME                            = "${var.name_prefix}-sandbox"
    OPENGENI_TURN_WORKER_CONCURRENCY_MODE              = "fixed"
    OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS          = "1"
    }, var.config_env, local.external_config_env, local.storage_config_env, {
    OPENGENI_ENVIRONMENT                                               = "production"
    OPENGENI_DEPLOYMENT_REVISION                                       = local.image_revision
    OPENGENI_RLS_STRATEGY                                              = "force"
    OPENGENI_RUNTIME_DATABASE_ROLE                                     = local.runtime_database_role
    OPENGENI_API_HOST                                                  = "0.0.0.0"
    OPENGENI_API_PORT                                                  = "8000"
    OPENGENI_API_METRICS_PORT                                          = "9464"
    OPENGENI_WORKER_HTTP_PORT                                          = "8001"
    OPENGENI_PUBLIC_BASE_URL                                           = local.web_url
    OPENGENI_WEB_BASE_URL                                              = local.web_url
    OPENGENI_WEB_ALLOWED_HOSTS                                         = join(",", [local.edge_fqdn, local.web_internal_fqdn])
    OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS                               = local.web_url
    OPENGENI_MCP_URL                                                   = "${local.api_url}/v1/workspaces/{workspaceId}/mcp"
    OPENGENI_MCP_INTERNAL_URL                                          = "${local.api_internal_url}/v1/workspaces/{workspaceId}/mcp"
    OPENGENI_CORS_ALLOW_ORIGIN_REGEX                                   = "^${replace(local.web_url, ".", "\\.")}$"
    OPENGENI_PRODUCT_ACCESS_MODE                                       = var.access_mode
    OPENGENI_AUTH_REQUIRED                                             = tostring(var.access_mode == "configured")
    OPENGENI_AUTH_ALLOW_HEALTH                                         = "true"
    OPENGENI_AUTH_ALLOW_METRICS                                        = "false"
    OPENGENI_SANDBOX_BACKEND                                           = var.sandbox_backend
    OPENGENI_SANDBOX_PREPARATION_PROFILES                              = "none"
    OPENGENI_SANDBOX_ENV_ALLOWLIST                                     = ""
    OPENGENI_SANDBOX_SELFHOSTED_ENABLED                                = "false"
    OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED                            = "false"
    OPENGENI_ORGANIZATION_USER_SETUP_EMAIL_TOKEN_TRANSPORT             = "fragment"
    OPENGENI_ORGANIZATION_USER_SETUP_QUERY_EDGE_SANITIZATION_CONFIRMED = "false"
  })
}

resource "terraform_data" "application_gate" {
  input = var.migration_completed_revision

  lifecycle {
    precondition {
      condition     = var.deployment_phase != "apps" || var.migration_completed_revision == var.images.api
      error_message = "Start apps only after the drained manual job succeeds; migration_completed_revision must equal the exact images.api digest reference. This is operator attestation, not automatic live verification."
    }
    precondition {
      condition = var.deployment_phase != "apps" || alltrue([
        for name in local.required_application_secret_env :
        try(length(trimspace(var.secret_env[name].value)) > 0 && length(setsubtract(local.serving_roles, var.secret_env[name].roles)) == 0, false)
      ])
      error_message = "apps requires real model/sandbox credentials, encryption key, and the selected configured/managed auth credentials projected to api/control/turn."
    }
    precondition {
      condition = var.deployment_phase != "apps" || alltrue([
        for name in lookup(local.sandbox_config_requirements, var.sandbox_backend, toset([])) :
        length(trimspace(lookup(local.application_config_env, name, ""))) > 0
      ])
      error_message = "Supply the selected remote sandbox's required non-secret settings in config_env."
    }
    precondition {
      condition     = !var.outbox_dispatcher_enabled || var.images.outbox_dispatcher != null
      error_message = "outbox_dispatcher_enabled requires its distinct immutable outbox_dispatcher image."
    }
    precondition {
      condition = var.deployment_phase != "apps" || (
        try(can(regex("^[A-Za-z0-9+/]{43}=$", var.secret_env["OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"].value)), false) &&
        alltrue([for name in var.access_mode == "configured" ? toset(["OPENGENI_ACCESS_KEY"]) : toset(["OPENGENI_BETTER_AUTH_SECRET", "OPENGENI_DELEGATION_SECRET"]) :
          try(length(var.secret_env[name].value) >= 32, false)
        ])
      )
      error_message = "Serving auth signing/shared keys must be at least 32 characters; ENVIRONMENTS_ENCRYPTION_KEY must be base64-encoded 32 bytes."
    }
    precondition {
      condition = !var.outbox_dispatcher_enabled || (
        (length(trimspace(lookup(var.config_env, "OPENGENI_SELFHOSTED_NATS_CONTROL_USER", ""))) > 0) ==
        contains(nonsensitive(keys(var.secret_env)), "OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD")
      )
      error_message = "Outbox NATS control username and password must either both be supplied or both omitted."
    }
  }
}