locals {
  tags = merge(var.tags, {
    project = "opengeni"
    owner   = "codex"
    purpose = "deployment-verification"
  })

  resource_group_name = var.create_resource_group ? azurerm_resource_group.this[0].name : var.resource_group_name
  acr_name            = replace("${var.name_prefix}acr", "-", "")
  aks_name            = "${var.name_prefix}-aks"
  key_vault_name      = substr(replace("${var.name_prefix}-kv", "-", ""), 0, 24)
  postgres_name       = "${var.name_prefix}-postgres"
  storage_account_name = substr(
    coalesce(var.object_storage.account_name, replace("${var.name_prefix}files", "-", "")),
    0,
    24
  )
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "this" {
  count    = var.create_resource_group ? 1 : 0
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_container_registry" "this" {
  name                = local.acr_name
  resource_group_name = local.resource_group_name
  location            = var.location
  sku                 = "Standard"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "this" {
  name                      = local.aks_name
  resource_group_name       = local.resource_group_name
  location                  = var.location
  dns_prefix                = coalesce(var.aks.dns_prefix, "${var.name_prefix}-aks")
  kubernetes_version        = var.aks.kubernetes_version
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
  tags                      = local.tags

  default_node_pool {
    name       = "system"
    node_count = var.aks.node_count
    vm_size    = var.aks.vm_size

    upgrade_settings {
      drain_timeout_in_minutes      = var.aks.node_pool_upgrade_drain_timeout_minutes
      max_surge                     = var.aks.node_pool_upgrade_max_surge
      node_soak_duration_in_minutes = var.aks.node_pool_upgrade_node_soak_minutes
    }
  }

  identity {
    type = "SystemAssigned"
  }

  dynamic "microsoft_defender" {
    for_each = var.aks.microsoft_defender_log_analytics_workspace_id == null ? [] : [var.aks.microsoft_defender_log_analytics_workspace_id]

    content {
      log_analytics_workspace_id = microsoft_defender.value
    }
  }

  lifecycle {
    ignore_changes = [
      microsoft_defender[0].log_analytics_workspace_id,
    ]
  }
}

resource "azurerm_role_assignment" "aks_acr_pull" {
  count                = var.create_acr_pull_role_assignment ? 1 : 0
  principal_id         = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
  role_definition_name = "AcrPull"
  scope                = azurerm_container_registry.this.id
}

resource "azurerm_key_vault" "this" {
  name                       = local.key_vault_name
  resource_group_name        = local.resource_group_name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = var.key_vault.purge_protection_enabled
  soft_delete_retention_days = 7
  tags                       = local.tags
}

resource "azurerm_postgresql_flexible_server" "this" {
  count                  = var.postgres.mode == "managed" ? 1 : 0
  name                   = local.postgres_name
  resource_group_name    = local.resource_group_name
  location               = var.location
  version                = var.postgres.version
  administrator_login    = var.postgres.administrator_login
  administrator_password = var.postgres.administrator_password
  sku_name               = var.postgres.sku_name
  storage_mb             = var.postgres.storage_mb
  tags                   = local.tags
}

resource "azurerm_postgresql_flexible_server_database" "opengeni" {
  count     = var.postgres.mode == "managed" ? 1 : 0
  name      = "opengeni"
  server_id = azurerm_postgresql_flexible_server.this[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "pgvector" {
  count     = var.postgres.mode == "managed" ? 1 : 0
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this[0].id
  value     = "PGCRYPTO,VECTOR"
}

resource "azurerm_storage_account" "files" {
  count                           = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? 1 : 0
  name                            = local.storage_account_name
  resource_group_name             = local.resource_group_name
  location                        = var.location
  account_tier                    = var.object_storage.account_tier
  account_replication_type        = var.object_storage.replication_type
  allow_nested_items_to_be_public = false
  min_tls_version                 = "TLS1_2"
  tags                            = local.tags

  blob_properties {
    versioning_enabled = var.object_storage.versioning_enabled

    delete_retention_policy {
      days = var.object_storage.delete_retention_days
    }

    container_delete_retention_policy {
      days = var.object_storage.delete_retention_days
    }
  }
}

resource "azurerm_storage_container" "files" {
  count                 = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? 1 : 0
  name                  = var.object_storage.bucket
  storage_account_id    = azurerm_storage_account.files[0].id
  container_access_type = "private"
}
