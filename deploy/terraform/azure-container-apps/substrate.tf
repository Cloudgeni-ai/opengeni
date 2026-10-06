locals {
  tags                  = merge(var.tags, { application = "opengeni", deployment = var.name_prefix, managed_by = "terraform" })
  compact_prefix        = replace(var.name_prefix, "-", "")
  aca_subnet_cidr       = cidrsubnet(var.vnet_cidr, 7, 0)
  postgres_subnet_cidr  = cidrsubnet(var.vnet_cidr, 8, 2)
  app_name              = "${var.name_prefix}-api"
  web_name              = "${var.name_prefix}-web"
  infrastructure_rg     = "${var.resource_group_name}-aca-infra"
  serving_roles         = toset(["api", "control", "turn"])
  identity_roles        = setunion(local.serving_roles, toset(["web", "migration"]), var.outbox_dispatcher_enabled ? toset(["outbox"]) : toset([]))
  runtime_database_role = "opengeni_app"
  outbox_database_role  = "opengeni_artifact_outbox_dispatcher"
  migration_database_roles = sort(tolist(setunion(
    var.previous_runtime_database_roles,
    toset([local.runtime_database_role]),
    var.outbox_dispatcher_enabled ? toset([local.outbox_database_role]) : toset([])
  )))
}

data "azurerm_client_config" "current" {}

resource "random_id" "suffix" {
  byte_length = 3
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "this" {
  name                = "${var.name_prefix}-vnet"
  resource_group_name = azurerm_resource_group.this.name
  location            = var.location
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "aca" {
  name                 = "container-apps"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.aca_subnet_cidr]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "postgresql"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.postgres_subnet_cidr]
  service_endpoints    = ["Microsoft.Storage"]

  delegation {
    name = "postgresql"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name_prefix}-${random_id.suffix.hex}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "postgresql"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.this.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "random_password" "database" {
  for_each    = toset(concat(["owner", "app"], var.outbox_dispatcher_enabled ? ["outbox"] : []))
  length      = 40
  special     = false
  min_lower   = 1
  min_upper   = 1
  min_numeric = 1
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "${var.name_prefix}-pg-${random_id.suffix.hex}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = var.location
  version                       = var.postgres.version
  administrator_login           = "opengeni_owner"
  administrator_password        = random_password.database["owner"].result
  sku_name                      = var.postgres.sku_name
  storage_mb                    = var.postgres.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.postgres.backup_retention_days
  geo_redundant_backup_enabled  = var.postgres.geo_redundant_backup_enabled
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  zone                          = var.postgres.zone
  tags                          = local.tags

  dynamic "high_availability" {
    for_each = var.postgres.high_availability_mode == null ? [] : [var.postgres.high_availability_mode]
    content {
      mode                      = high_availability.value
      standby_availability_zone = var.postgres.standby_availability_zone
    }
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "opengeni" {
  name      = "opengeni"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "VECTOR,PGCRYPTO,BTREE_GIN"
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name_prefix}-logs"
  resource_group_name = azurerm_resource_group.this.name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_analytics.retention_in_days
  daily_quota_gb      = var.log_analytics.daily_quota_gb
  tags                = local.tags
}

resource "azurerm_container_app_environment" "this" {
  name                               = "${var.name_prefix}-aca"
  resource_group_name                = azurerm_resource_group.this.name
  location                           = var.location
  infrastructure_subnet_id           = azurerm_subnet.aca.id
  infrastructure_resource_group_name = local.infrastructure_rg
  internal_load_balancer_enabled     = false
  public_network_access              = "Enabled"
  logs_destination                   = "log-analytics"
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.this.id
  tags                               = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_user_assigned_identity" "workload" {
  for_each            = local.identity_roles
  name                = "${var.name_prefix}-${each.key}"
  resource_group_name = azurerm_resource_group.this.name
  location            = var.location
  tags                = local.tags
}

resource "azurerm_storage_account" "this" {
  name                             = "${substr(local.compact_prefix, 0, 13)}files${random_id.suffix.hex}"
  resource_group_name              = azurerm_resource_group.this.name
  location                         = var.location
  account_tier                     = "Standard"
  account_replication_type         = "LRS"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  shared_access_key_enabled        = true
  allow_nested_items_to_be_public  = false
  public_network_access_enabled    = true
  cross_tenant_replication_enabled = false
  tags                             = local.tags

  # Browser and remote Modal signed URLs need the public Blob endpoint. The
  # container remains private; this does not make anonymous Blob reads valid.
  blob_properties {
    versioning_enabled = true
    delete_retention_policy { days = 7 }
    container_delete_retention_policy { days = 7 }
    cors_rule {
      allowed_origins    = [local.web_url]
      allowed_methods    = ["GET", "HEAD", "PUT", "OPTIONS"]
      allowed_headers    = ["content-type", "content-md5", "x-ms-blob-type", "x-ms-version", "x-ms-client-request-id", "x-ms-meta-sha256"]
      exposed_headers    = ["etag", "content-type", "content-length", "x-ms-request-id", "x-ms-version"]
      max_age_in_seconds = 3600
    }
  }
}

resource "azurerm_storage_container" "files" {
  name                  = "opengeni-files"
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_container_registry" "this" {
  count               = var.create_acr ? 1 : 0
  name                = "${local.compact_prefix}acr${random_id.suffix.hex}"
  resource_group_name = azurerm_resource_group.this.name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  for_each             = var.create_acr ? local.identity_roles : toset([])
  scope                = azurerm_container_registry.this[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.workload[each.key].principal_id
  principal_type       = "ServicePrincipal"
}