mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.Network/virtualNetworks/aca-test-vnet" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.Network/virtualNetworks/aca-test-vnet/subnets/test" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.Network/privateDnsZones/test.postgres.database.azure.com" }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.DBforPostgreSQL/flexibleServers/aca-test-pg"
      fqdn = "aca-test-pg.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.OperationalInsights/workspaces/aca-test-logs" }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id             = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.App/managedEnvironments/aca-test"
      default_domain = "test.northeurope.azurecontainerapps.io"
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/aca-test"
      principal_id = "00000000-0000-0000-0000-000000000005"
      client_id    = "00000000-0000-0000-0000-000000000006"
    }
  }
  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.Storage/storageAccounts/acatestfiles"
      primary_blob_endpoint = "https://acatestfiles.blob.core.windows.net/"
      primary_access_key    = "mock-only-not-a-real-storage-key"
    }
  }
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.KeyVault/vaults/acatestkv"
      vault_uri = "https://acatestkv.vault.azure.net/"
    }
  }
  mock_resource "azurerm_key_vault_secret" {
    defaults = {
      id             = "https://acatestkv.vault.azure.net/secrets/mock/00000000000000000000000000000000"
      versionless_id = "https://acatestkv.vault.azure.net/secrets/mock"
    }
  }
  mock_resource "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-aca-test/providers/Microsoft.ContainerRegistry/registries/acatestacr"
      login_server = "acatestacr.azurecr.io"
    }
  }
}

mock_provider "random" {
  mock_resource "random_id" {
    defaults = { hex = "abcdef" }
  }
  mock_resource "random_password" {
    defaults = { result = "MockOnlyNotARealCredential0123456789012345" }
  }
}

mock_provider "azapi" {}

variables {
  name_prefix         = "aca-test"
  resource_group_name = "rg-aca-test"
  images = {
    api    = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker = "example.invalid/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    web    = "example.invalid/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
  external_services = {
    temporal_host      = "temporal.example.invalid:7233"
    temporal_namespace = "opengeni-test"
    nats_url           = "tls://nats.example.invalid:4222"
  }
  secret_env = {
    OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
    OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
    OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
    OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
    OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }
}

run "credential_projection_and_nonsecret_registry_reference_are_safe" {
  command = apply
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    config_env = {
      OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example.invalid"
      OPENGENI_MODEL_PROVIDERS_JSON = jsonencode([
        {
          id        = "mockprovider"
          baseUrl   = "https://mockprovider.example.invalid/v1"
          apiKeyEnv = "OPENGENI_MOCK_PROVIDER_API_KEY"
          models    = [{ id = "mockmodel" }]
        },
        {
          id      = "fixture-anonymous"
          kind    = "anonymous"
          baseUrl = "https://fixture.example.invalid/v1"
          label   = "apiKey text is only a public label"
          models  = [{ id = "fixture-model" }]
        }
      ])
    }
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_MOCK_PROVIDER_API_KEY       = { value = "mock-only-provider-key" }
      OPENGENI_OTEL_EXPORTER_OTLP_HEADERS  = { value = "authorization=Bearer mock-only-otlp-credential" }
      OTEL_EXPORTER_OTLP_HEADERS           = { value = "authorization=Bearer mock-only-otlp-credential" }
      OTEL_EXPORTER_OTLP_TRACES_HEADERS    = { value = "authorization=Bearer mock-only-otlp-credential" }
      OTEL_EXPORTER_OTLP_METRICS_HEADERS   = { value = "authorization=Bearer mock-only-otlp-credential" }
      OTEL_EXPORTER_OTLP_LOGS_HEADERS      = { value = "authorization=Bearer mock-only-otlp-credential" }
    }
  }
  assert {
    condition = (
      output.runtime_nonsecret_env.OTEL_EXPORTER_OTLP_ENDPOINT == "https://collector.example.invalid" &&
      jsondecode(output.runtime_nonsecret_env.OPENGENI_MODEL_PROVIDERS_JSON)[0].apiKeyEnv == "OPENGENI_MOCK_PROVIDER_API_KEY" &&
      jsondecode(output.runtime_nonsecret_env.OPENGENI_MODEL_PROVIDERS_JSON)[1].label == "apiKey text is only a public label" &&
      alltrue([for name in local.credential_env_names : !contains(keys(output.runtime_nonsecret_env), name)]) &&
      !strcontains(jsonencode(output.runtime_nonsecret_env), "mock-only-otlp-credential") &&
      !strcontains(jsonencode(output.runtime_nonsecret_env), "mock-only-provider-key")
    )
    error_message = "Credential values must not reach non-secret outputs, while structured apiKeyEnv references and benign labels remain intact."
  }
  assert {
    condition = alltrue([for role in ["api", "control", "turn"] :
      alltrue([for name in setunion(local.credential_env_names, toset(["OPENGENI_MOCK_PROVIDER_API_KEY"])) :
        one([for env in azurerm_container_app.service[role].template[0].container[0].env : env.secret_name if env.name == name]) == local.secret_names[name]
      ])
    ])
    error_message = "OTLP credentials and apiKeyEnv keys must be delivered through per-role Key Vault secret references, not plaintext config."
  }
}

run "configured_explicit_delegation_is_one_shared_signing_secret" {
  command = apply
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_DELEGATION_SECRET           = { value = "  mock-only-long-delegation-key-value-123456789  " }
    }
  }
  assert {
    condition = (
      contains(local.signing_secret_env, "OPENGENI_DELEGATION_SECRET") &&
      local.application_config_env.OPENGENI_AUTH_REQUIRED == "true" &&
      alltrue([for role in ["api", "control", "turn"] :
        one([for env in azurerm_container_app.service[role].template[0].container[0].env :
          env.secret_name if env.name == "OPENGENI_DELEGATION_SECRET"
        ]) == local.secret_names["OPENGENI_DELEGATION_SECRET"]
      ])
    )
    error_message = "An explicit configured delegation key must use the same secret across API/control/turn without weakening shared-key auth."
  }
}

run "bootstrap_is_non_serving_and_private" {
  command = apply

  assert {
    condition     = length(azurerm_container_app.service) == 0 && length(azurerm_container_app.web) == 0 && length(azapi_resource.edge) == 0
    error_message = "Default bootstrap must not start any serving API/worker workloads."
  }
  assert {
    condition = (
      !azurerm_postgresql_flexible_server.this.public_network_access_enabled &&
      azurerm_postgresql_flexible_server.this.delegated_subnet_id == azurerm_subnet.postgres.id &&
      azurerm_postgresql_flexible_server_configuration.extensions.value == "VECTOR,PGCRYPTO,BTREE_GIN" &&
      azurerm_storage_container.files.container_access_type == "private"
    )
    error_message = "Database must be private with the extension allowlist, and Blob container must deny anonymous reads."
  }
  assert {
    condition = (
      length(azurerm_container_app_job.migration) == 1 &&
      azurerm_container_app_job.migration[0].replica_retry_limit == 0 &&
      azurerm_container_app_job.migration[0].manual_trigger_config[0].parallelism == 1 &&
      azurerm_container_app_job.migration[0].replica_timeout_in_seconds == 3600 &&
      length(azurerm_container_app_job.migration[0].event_trigger_config) == 0 &&
      length(azurerm_container_app_job.migration[0].schedule_trigger_config) == 0
    )
    error_message = "Migrations must run only by explicit manual execution, one replica, no automatic retries."
  }
  assert {
    condition = (
      length(setintersection(toset(keys(local.migration_secret_env)), toset(["OPENGENI_OPENAI_API_KEY", "OPENGENI_ACCESS_KEY", "OPENGENI_MODAL_TOKEN_SECRET"]))) == 0 &&
      local.migration_secret_env.OPENGENI_MIGRATIONS_DATABASE_URL == "migration-db-url" &&
      local.migration_secret_env.OPENGENI_DATABASE_URL == "application-db-url" &&
      strcontains(azurerm_container_app_job.migration[0].template[0].container[0].args[0], "bun run db:assert-runtime-posture") &&
      strcontains(azurerm_container_app_job.migration[0].template[0].container[0].args[0], "bun run catalog:import --snapshot /app/data/catalog/integrations-snapshot.json")
    )
    error_message = "Job must isolate owner/role-provision credentials from runtime auth/model/sandbox secrets and assert the restricted role before catalog import."
  }
  assert {
    condition = alltrue([
      for role in ["api", "control", "turn", "web"] :
      length(setintersection(local.role_secret_keys[role], toset(["migration-db-url", "app-db-password"]))) == 0
    ]) && alltrue([for grant in azurerm_role_assignment.secret_reader : strcontains(grant.scope, "/secrets/")])
    error_message = "Serving identities must never be able to retrieve the database owner/password secrets, including through vault-wide RBAC."
  }
  assert {
    condition = (
      azurerm_log_analytics_workspace.this.retention_in_days == 30 &&
      azurerm_log_analytics_workspace.this.daily_quota_gb == 1 &&
      azurerm_storage_account.this.blob_properties[0].cors_rule[0].allowed_origins == tolist(["https://aca-test-edge.test.northeurope.azurecontainerapps.io"])
    )
    error_message = "Logs must have explicit retention/cap, and Blob CORS must contain only the exact browser origin."
  }
}

run "configured_serving_roles_are_isolated" {
  command = apply

  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (
      length(azurerm_container_app.service) == 3 &&
      length(azurerm_container_app.service["control"].ingress) == 0 &&
      length(azurerm_container_app.service["turn"].ingress) == 0 &&
      !azurerm_container_app.service["api"].ingress[0].allow_insecure_connections &&
      !azurerm_container_app.service["api"].ingress[0].external_enabled &&
      !azurerm_container_app.web[0].ingress[0].external_enabled &&
      azurerm_container_app.service["api"].ingress[0].target_port == 8000
    )
    error_message = "API/web must use only internal HTTPS ingress; control and turn workers must have no health/metrics ingress."
  }
  assert {
    condition = (
      local.api_url == local.web_url &&
      local.api_internal_url == "https://aca-test-api.internal.test.northeurope.azurecontainerapps.io" &&
      azapi_resource.edge[0].type == "Microsoft.App/managedEnvironments/httpRouteConfigs@2024-10-02-preview" &&
      alltrue([for rule in local.edge_rules : alltrue([for target in rule.targets : contains(["aca-test-api", "aca-test-web"], target.containerApp)])]) &&
      length([for route in local.api_edge_routes : route if contains(["/readyz", "/traffic-readyz", "/metrics"], try(route.match.path, ""))]) == 0 &&
      alltrue([for route in local.api_edge_routes : !can(route.action)])
    )
    error_message = "Native edge must preserve same-origin browser API/MCP paths without rewrites or worker/readiness/metrics route targets."
  }
  assert {
    condition = alltrue([for role in ["control", "turn"] :
      azurerm_container_app.service[role].template[0].min_replicas >= 1 &&
      azurerm_container_app.service[role].revision_mode == "Single" &&
      azurerm_container_app.service[role].template[0].termination_grace_period_seconds >= 120 &&
      azurerm_container_app.service[role].template[0].container[0].readiness_probe[0].port == 8001 &&
      azurerm_container_app.service[role].template[0].container[0].readiness_probe[0].path == "/readyz" &&
      one([for env in azurerm_container_app.service[role].template[0].container[0].env : env.value if env.name == "OPENGENI_WORKER_ROLE"]) == role
    ])
    error_message = "Workers must be nonzero, role-pinned, single-revision, and given sufficient graceful checkpoint time with the right probes."
  }
  assert {
    condition = (
      local.application_config_env.OPENGENI_AUTH_REQUIRED == "true" &&
      local.application_config_env.OPENGENI_PRODUCT_ACCESS_MODE == "configured" &&
      local.application_config_env.OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED == "false" &&
      local.application_config_env.OPENGENI_SANDBOX_BACKEND == "modal" &&
      local.application_config_env.OPENGENI_API_METRICS_PORT == "9464" &&
      local.application_config_env.OPENGENI_AUTH_ALLOW_METRICS == "false" &&
      local.application_config_env.OPENGENI_SANDBOX_ENV_ALLOWLIST == ""
    )
    error_message = "Serving defaults must enforce shared-key auth, fail-closed native exports, remote sandbox, unrouted metrics, and no automatic secret injection into sandboxes."
  }
  assert {
    condition = (
      local.signing_secret_env == toset(["OPENGENI_ACCESS_KEY"]) &&
      !contains(local.role_secret_keys["api"], "OPENGENI_DELEGATION_SECRET") &&
      alltrue([for role in ["api", "control", "turn"] :
        one([for env in azurerm_container_app.service[role].template[0].container[0].env :
          env.secret_name if env.name == "OPENGENI_ACCESS_KEY"
        ]) == local.secret_names["OPENGENI_ACCESS_KEY"]
      ])
    )
    error_message = "Configured mode without explicit delegation must retain the same shared access-key fallback on API/control/turn."
  }
}

run "remote_modal_publication_has_owned_sandbox_baseline" {
  command = apply

  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (
      local.application_config_env.OPENGENI_SANDBOX_OWNERSHIP_ENABLED == "true" &&
      local.application_config_env.OPENGENI_SANDBOX_BACKEND == "modal" &&
      local.application_config_env.OPENGENI_SANDBOX_SELFHOSTED_ENABLED == "false" &&
      local.application_config_env.OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED == "false" &&
      local.application_config_env.OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED == "false" &&
      alltrue([for role in ["api", "control", "turn"] :
        one([for env in azurerm_container_app.service[role].template[0].container[0].env :
          env.value if env.name == "OPENGENI_SANDBOX_OWNERSHIP_ENABLED"
        ]) == "true" &&
        one([for env in azurerm_container_app.service[role].template[0].container[0].env :
          env.value if env.name == "OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED"
        ]) == "false"
      ])
    )
    error_message = "API/control/turn must share owned remote Modal leases for file publication without enabling Connected Machines, artifact runtime, or native exports."
  }
  assert {
    condition = (
      !contains(keys(local.migration_config_env), "OPENGENI_SANDBOX_OWNERSHIP_ENABLED") &&
      !contains(keys(local.outbox_config_env), "OPENGENI_SANDBOX_OWNERSHIP_ENABLED")
    )
    error_message = "Maintenance/outbox config must not acquire the serving sandbox ownership flag."
  }
}

run "optional_outbox_has_only_dedicated_authority" {
  command = apply

  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    outbox_dispatcher_enabled    = true
    create_acr                   = true
    images = {
      api               = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      worker            = "example.invalid/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web               = "example.invalid/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      outbox_dispatcher = "example.invalid/opengeni-outbox@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  }

  assert {
    condition = (
      local.role_secret_keys["outbox"] == toset(["outbox-db-url"]) &&
      length(azurerm_container_app.service["outbox"].ingress) == 0 &&
      azurerm_container_app.service["outbox"].template[0].container[0].readiness_probe[0].port == 9466 &&
      local.outbox_secret_env.OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL == "outbox-db-url" &&
      contains(local.migration_database_roles, "opengeni_artifact_outbox_dispatcher") &&
      length(azurerm_role_assignment.acr_pull) == 6 &&
      !azurerm_container_registry.this[0].admin_enabled
    )
    error_message = "Outbox must use a separate database credential, no runtime/owner secrets or ingress, its own probe port, and only resource-scoped ACR pull access."
  }
}

run "apps_require_exact_successful_migration_attestation" {
  command = plan
  variables { deployment_phase = "apps" }
  expect_failures = [terraform_data.application_gate]
}

run "apps_require_real_model_sandbox_and_auth_credentials" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env                   = {}
  }
  expect_failures = [terraform_data.application_gate]
}

run "serving_local_auth_is_forbidden" {
  command = plan
  variables { access_mode = "local" }
  expect_failures = [var.access_mode]
}

run "serving_sandbox_none_is_forbidden" {
  command = plan
  variables { sandbox_backend = "none" }
  expect_failures = [var.sandbox_backend]
}

run "module_owned_auth_and_materializer_flags_cannot_be_overridden" {
  command = plan
  variables {
    config_env = {
      OPENGENI_AUTH_REQUIRED                  = "false"
      OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED = "true"
    }
  }
  expect_failures = [var.config_env]
}

run "owner_credentials_cannot_be_injected_into_serving_secrets" {
  command = plan
  variables { secret_env = { OPENGENI_MIGRATIONS_DATABASE_URL = { value = "forbidden-owner-url" } } }
  expect_failures = [var.secret_env]
}

run "module_owned_sandbox_ownership_cannot_be_disabled" {
  command = plan
  variables { config_env = { OPENGENI_SANDBOX_OWNERSHIP_ENABLED = "false" } }
  expect_failures = [var.config_env]
}

run "module_owned_sandbox_ownership_cannot_be_overridden_by_secrets" {
  command = plan
  variables { secret_env = { OPENGENI_SANDBOX_OWNERSHIP_ENABLED = { value = "false" } } }
  expect_failures = [var.secret_env]
}

run "namespaced_otlp_auth_headers_require_secret_env" {
  command = plan
  variables { config_env = { OPENGENI_OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer mock-only" } }
  expect_failures = [var.config_env]
}

run "common_otlp_auth_headers_require_secret_env" {
  command = plan
  variables { config_env = { OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer mock-only" } }
  expect_failures = [var.config_env]
}

run "trace_otlp_auth_headers_require_secret_env" {
  command = plan
  variables { config_env = { OTEL_EXPORTER_OTLP_TRACES_HEADERS = "authorization=Bearer mock-only" } }
  expect_failures = [var.config_env]
}

run "metric_otlp_auth_headers_require_secret_env" {
  command = plan
  variables { config_env = { OTEL_EXPORTER_OTLP_METRICS_HEADERS = "authorization=Bearer mock-only" } }
  expect_failures = [var.config_env]
}

run "log_otlp_auth_headers_require_secret_env" {
  command = plan
  variables { config_env = { OTEL_EXPORTER_OTLP_LOGS_HEADERS = "authorization=Bearer mock-only" } }
  expect_failures = [var.config_env]
}

run "configured_api_only_delegation_is_rejected" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_DELEGATION_SECRET           = { value = "mock-only-long-delegation-key-value-123456789", roles = ["api"] }
    }
  }
  expect_failures = [terraform_data.application_gate]
}

run "configured_short_delegation_is_rejected" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_DELEGATION_SECRET           = { value = "short" }
    }
  }
  expect_failures = [terraform_data.application_gate]
}

run "configured_delegation_padding_does_not_meet_signing_minimum" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_DELEGATION_SECRET           = { value = "                    short                    " }
    }
  }
  expect_failures = [terraform_data.application_gate]
}

run "sandbox_artifact_runtime_cannot_be_enabled_in_config" {
  command = plan
  variables { config_env = { OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED = "true" } }
  expect_failures = [var.config_env]
}

run "sandbox_artifact_runtime_cannot_be_enabled_by_secret_override" {
  command = plan
  variables { secret_env = { OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED = { value = "true" } } }
  expect_failures = [var.secret_env]
}

run "inline_model_api_key_cannot_enter_nonsecret_config" {
  command = plan
  variables {
    config_env = {
      OPENGENI_MODEL_PROVIDERS_JSON = jsonencode([{
        id      = "mockprovider"
        baseUrl = "https://mockprovider.example.invalid/v1"
        apiKey  = "mock-only-inline-provider-credential"
        models  = [{ id = "mockmodel" }]
      }])
    }
  }
  expect_failures = [var.config_env]
}

run "malformed_model_provider_json_is_rejected" {
  command = plan
  variables { config_env = { OPENGENI_MODEL_PROVIDERS_JSON = "{not-json" } }
  expect_failures = [var.config_env]
}

run "nonarray_model_provider_json_is_rejected" {
  command = plan
  variables { config_env = { OPENGENI_MODEL_PROVIDERS_JSON = "{}" } }
  expect_failures = [var.config_env]
}

run "credential_bearing_whole_model_registry_stays_secret_backed" {
  command = apply
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ACCESS_KEY                  = { value = "mock-only-long-access-key-value-123456789" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_MODEL_PROVIDERS_JSON = { value = jsonencode([{
        id             = "mockprovider"
        baseUrl        = "https://mockprovider.example.invalid/v1"
        apiKey         = "mock-only-inline-secret-provider-key"
        defaultHeaders = { authorization = "Bearer mock-only-private-provider-header" }
        models         = [{ id = "mockmodel" }]
      }]) }
    }
  }
  assert {
    condition = (
      !contains(keys(output.runtime_nonsecret_env), "OPENGENI_MODEL_PROVIDERS_JSON") &&
      !strcontains(jsonencode(output.runtime_nonsecret_env), "mock-only-inline-secret-provider-key") &&
      !strcontains(jsonencode(output.runtime_nonsecret_env), "mock-only-private-provider-header") &&
      alltrue([for role in ["api", "control", "turn"] :
        one([for env in azurerm_container_app.service[role].template[0].container[0].env :
          env.secret_name if env.name == "OPENGENI_MODEL_PROVIDERS_JSON"
        ]) == local.secret_names["OPENGENI_MODEL_PROVIDERS_JSON"]
      ])
    )
    error_message = "Credential-bearing whole model registry config must remain a Key Vault secret and never a non-secret output."
  }
}

run "mutable_images_are_forbidden" {
  command = plan
  variables {
    images = {
      api    = "example.invalid/opengeni-api:latest"
      worker = "example.invalid/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web    = "example.invalid/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  expect_failures = [var.images]
}

run "workers_cannot_scale_to_zero" {
  command = plan
  variables {
    workloads = {
      api     = { cpu = 0.5, memory = "1Gi", min_replicas = 1, max_replicas = 2 }
      web     = { cpu = 0.25, memory = "0.5Gi", min_replicas = 1, max_replicas = 2 }
      control = { cpu = 0.5, memory = "1Gi", min_replicas = 0, max_replicas = 1 }
      turn    = { cpu = 1, memory = "2Gi", min_replicas = 1, max_replicas = 1 }
      outbox  = { cpu = 0.25, memory = "0.5Gi", min_replicas = 1, max_replicas = 1 }
    }
  }
  expect_failures = [var.workloads]
}

run "managed_auth_is_explicit_and_uses_no_shared_key_fallback" {
  command = apply
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    access_mode                  = "managed"
    secret_env = {
      OPENGENI_OPENAI_API_KEY              = { value = "mock-openai-key" }
      OPENGENI_MODAL_TOKEN_ID              = { value = "mock-modal-id" }
      OPENGENI_MODAL_TOKEN_SECRET          = { value = "mock-modal-secret" }
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = { value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      OPENGENI_BETTER_AUTH_SECRET          = { value = "mock-only-long-better-auth-key-value-123456789" }
      OPENGENI_DELEGATION_SECRET           = { value = "mock-only-long-delegation-key-value-123456789" }
      OPENGENI_RESEND_API_KEY              = { value = "mock-resend-api-key" }
      OPENGENI_OPTIONAL_PROVIDER_API_KEY   = { value = "api-only-mock-value", roles = ["api"] }
    }
  }
  assert {
    condition = (
      local.application_config_env.OPENGENI_PRODUCT_ACCESS_MODE == "managed" &&
      local.application_config_env.OPENGENI_AUTH_REQUIRED == "false" &&
      !contains(local.role_secret_keys["api"], "OPENGENI_ACCESS_KEY") &&
      contains(local.role_secret_keys["api"], "OPENGENI_OPTIONAL_PROVIDER_API_KEY") &&
      !contains(local.role_secret_keys["control"], "OPENGENI_OPTIONAL_PROVIDER_API_KEY") &&
      !contains(local.role_secret_keys["turn"], "OPENGENI_OPTIONAL_PROVIDER_API_KEY") &&
      !contains(local.role_secret_keys["migration"], "OPENGENI_OPTIONAL_PROVIDER_API_KEY") &&
      local.application_config_env.OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS == local.web_url
    )
    error_message = "Managed mode must require its real auth credentials/origin and preserve exact optional-secret projection, not inherit a shared-key or migration authority fallback."
  }
  assert {
    condition = (
      length([for route in local.api_edge_routes : route if try(route.match.pathSeparatedPrefix, "") == "/.well-known/oauth-protected-resource"]) == 1 &&
      length([for route in local.api_edge_routes : route if try(route.match.pathSeparatedPrefix, "") == "/.well-known/oauth-authorization-server"]) == 1 &&
      length([for route in local.api_edge_routes : route if try(route.match.path, "") == "/oauth/token"]) == 1 &&
      length([for route in local.api_edge_routes : route if try(route.match.prefix, "") == "/.well-known"]) == 0
    )
    error_message = "OAuth metadata requires exact slash-boundary prefixes and token route, never broad rewriting/routing of all /.well-known paths."
  }
}

run "managed_missing_credentials_is_rejected" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    access_mode                  = "managed"
  }
  expect_failures = [terraform_data.application_gate]
}

run "integrations_enabled_with_runtime_truthy_flag_requires_state_key" {
  command = plan
  variables {
    deployment_phase             = "apps"
    migration_completed_revision = "example.invalid/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    config_env                   = { OPENGENI_INTEGRATIONS_ENABLED = "1" }
  }
  expect_failures = [terraform_data.application_gate]
}

run "outbox_requires_its_distinct_image" {
  command = plan
  variables { outbox_dispatcher_enabled = true }
  expect_failures = [terraform_data.application_gate]
}

run "plaintext_credentials_cannot_enter_config_env" {
  command = plan
  variables { config_env = { OPENGENI_OPENAI_API_KEY = "must-use-secret-env" } }
  expect_failures = [var.config_env]
}

run "foundation_creates_private_substrate_acr_without_image_pulls" {
  command = apply
  variables {
    deployment_phase = "foundation"
    create_acr       = true
    secret_env       = {}
    images = {
      api    = "acatestacr.azurecr.io/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      worker = "acatestacr.azurecr.io/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web    = "acatestacr.azurecr.io/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  assert {
    condition = (
      length(azurerm_container_app_job.migration) == 0 &&
      length(azurerm_container_app.service) == 0 &&
      length(azurerm_container_app.web) == 0 &&
      length(azapi_resource.edge) == 0 &&
      output.migration_job == null && output.migration_job_name == null
    )
    error_message = "foundation must have no migration job, image-consuming app or route, and absent job outputs must safely return null."
  }
  assert {
    condition = (
      length(azurerm_container_registry.this) == 1 &&
      output.acr.login_server == "acatestacr.azurecr.io" &&
      length(azurerm_user_assigned_identity.workload) == 5 &&
      length(azurerm_role_assignment.acr_pull) == 5 &&
      alltrue([for grant in azurerm_role_assignment.acr_pull : grant.scope == azurerm_container_registry.this[0].id]) &&
      !azurerm_postgresql_flexible_server.this.public_network_access_enabled &&
      azurerm_storage_container.files.container_access_type == "private" &&
      output.infrastructure_resource_group_name == "rg-aca-test-aca-infra" &&
      local.application_config_env.OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED == "false"
    )
    error_message = "foundation must retain private substrate, created-resource-only ACR pull identities, infrastructure RG tracking, and fail-closed exports."
  }
}

run "foundation_cannot_bypass_exact_app_attestation" {
  command = plan
  variables {
    deployment_phase = "apps"
    create_acr       = true
    images = {
      api    = "acatestacr.azurecr.io/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      worker = "acatestacr.azurecr.io/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web    = "acatestacr.azurecr.io/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  expect_failures = [terraform_data.application_gate]
}

run "bootstrap_after_foundation_creates_only_manual_private_acr_job" {
  command = apply
  variables {
    deployment_phase = "bootstrap"
    create_acr       = true
    secret_env       = {}
    images = {
      api    = "acatestacr.azurecr.io/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      worker = "acatestacr.azurecr.io/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web    = "acatestacr.azurecr.io/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  assert {
    condition = (
      length(azurerm_container_app_job.migration) == 1 &&
      output.migration_job_name == "aca-test-migrate" &&
      output.migration_job.image == var.images.api &&
      azurerm_container_app_job.migration[0].registry[0].server == output.acr.login_server &&
      azurerm_container_app_job.migration[0].registry[0].identity == azurerm_user_assigned_identity.workload["migration"].id &&
      azurerm_container_app_job.migration[0].replica_retry_limit == 0 &&
      azurerm_container_app_job.migration[0].manual_trigger_config[0].parallelism == 1 &&
      length(azurerm_container_app.service) == 0 && length(azurerm_container_app.web) == 0 &&
      output.environment.id == run.foundation_creates_private_substrate_acr_without_image_pulls.environment.id &&
      output.postgres.id == run.foundation_creates_private_substrate_acr_without_image_pulls.postgres.id
    )
    error_message = "foundation -> bootstrap must retain substrate and create a single non-retrying manual job using only the created ACR pull identity, never serving apps."
  }
}

run "private_acr_apps_follow_matching_bootstrap_job_attestation" {
  command = apply
  variables {
    deployment_phase             = "apps"
    create_acr                   = true
    migration_completed_revision = "acatestacr.azurecr.io/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    images = {
      api    = "acatestacr.azurecr.io/opengeni-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      worker = "acatestacr.azurecr.io/opengeni-worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      web    = "acatestacr.azurecr.io/opengeni-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  assert {
    condition = (
      output.migration_job.image == var.migration_completed_revision &&
      length(azurerm_container_app_job.migration) == 1 &&
      length(azurerm_container_app.service) == 3 && length(azurerm_container_app.web) == 1 &&
      length(azapi_resource.edge) == 1 &&
      local.application_config_env.OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED == "false" &&
      output.infrastructure_resource_group_name == "rg-aca-test-aca-infra"
    )
    error_message = "apps must remain exact-image attestation gated after foundation/bootstrap, with exports disabled and both resource-group scopes tracked."
  }
}