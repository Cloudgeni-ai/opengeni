locals {
  # These CLIs do not host an API or execute model/sandbox turns. Deliberately
  # use a maintenance-only, sandbox-free settings posture instead of copying
  # serving auth/provider credentials into an owner-credential job.
  migration_config_env = merge(local.storage_config_env, {
    OPENGENI_ENVIRONMENT                          = "production"
    OPENGENI_DEPLOYMENT_REVISION                  = local.image_revision
    OPENGENI_PRODUCT_ACCESS_MODE                  = "local"
    OPENGENI_SANDBOX_BACKEND                      = "none"
    OPENGENI_INTEGRATIONS_ENABLED                 = "false"
    OPENGENI_BILLING_MODE                         = "disabled"
    OPENGENI_MODEL_CATALOG_SOURCE                 = "code"
    OPENGENI_RLS_STRATEGY                         = "force"
    OPENGENI_RUNTIME_DATABASE_ROLE                = local.runtime_database_role
    OPENGENI_APP_DATABASE_USER                    = local.runtime_database_role
    OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES = join(",", local.migration_database_roles)
  }, var.outbox_dispatcher_enabled ? { OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER = local.outbox_database_role } : {})
  migration_secret_env = merge({
    OPENGENI_MIGRATIONS_DATABASE_URL          = "migration-db-url"
    OPENGENI_DATABASE_URL                     = "application-db-url"
    OPENGENI_APP_DATABASE_PASSWORD            = "app-db-password"
    OPENGENI_OBJECT_STORAGE_AZURE_ACCOUNT_KEY = "blob-account-key"
    }, var.outbox_dispatcher_enabled ? {
    OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD = "outbox-db-password"
  } : {}, contains(nonsensitive(keys(var.secret_env)), "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY") ? { OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY = "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY" } : {})
}

resource "azurerm_container_app_job" "migration" {
  name                         = "${var.name_prefix}-migrate"
  resource_group_name          = azurerm_resource_group.this.name
  location                     = var.location
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = "Consumption"
  replica_retry_limit          = 0
  replica_timeout_in_seconds   = var.migration_timeout_seconds
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.workload["migration"].id]
  }

  dynamic "secret" {
    for_each = local.migration_secret_keys
    content {
      name                = local.secret_names[secret.value]
      identity            = azurerm_user_assigned_identity.workload["migration"].id
      key_vault_secret_id = azurerm_key_vault_secret.this[secret.value].versionless_id
    }
  }

  dynamic "registry" {
    for_each = var.create_acr ? [azurerm_container_registry.this[0].login_server] : []
    content {
      server   = registry.value
      identity = azurerm_user_assigned_identity.workload["migration"].id
    }
  }

  template {
    container {
      name   = "migration"
      image  = var.images.api
      cpu    = 1
      memory = "2Gi"
      # Official API images retain /app package.json, Bun, migration sources,
      # provision/posture CLIs, and the vendored integrations catalog.
      command = ["/bin/sh", "-ec"]
      args = [join(" && ", [
        "cd /app",
        "bun run db:migrate",
        "bun run db:provision-roles",
        "bun run db:assert-runtime-posture",
        "OPENGENI_DATABASE_URL=\"$OPENGENI_MIGRATIONS_DATABASE_URL\" bun run catalog:import --snapshot /app/data/catalog/integrations-snapshot.json --if-changed --skip-logos"
      ])]

      dynamic "env" {
        for_each = local.migration_config_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.migration_secret_env
        content {
          name        = env.key
          secret_name = local.secret_names[env.value]
        }
      }
    }
  }

  depends_on = [
    terraform_data.application_gate,
    azurerm_postgresql_flexible_server_database.opengeni,
    azurerm_postgresql_flexible_server_configuration.extensions,
    azurerm_role_assignment.secret_reader,
    azurerm_role_assignment.acr_pull,
  ]
}