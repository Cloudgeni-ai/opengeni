locals {
  tags = merge(var.tags, {
    project    = "opengeni"
    managed_by = "terraform"
    purpose    = "opengeni-deployment"
  })

  resource_group_name = var.create_resource_group ? azurerm_resource_group.this[0].name : var.resource_group_name
  acr_name            = replace("${var.name_prefix}acr", "-", "")
  aks_name            = "${var.name_prefix}-aks"
  key_vault_name      = substr(replace("${var.name_prefix}-kv", "-", ""), 0, 24)
  aks_egress_ip_name  = "${var.name_prefix}-aks-egress-ip"
  postgres_name       = coalesce(var.postgres.name, "${var.name_prefix}-postgres")
  storage_account_name = substr(
    coalesce(var.object_storage.account_name, replace("${var.name_prefix}files", "-", "")),
    0,
    24
  )
  observability_enabled                 = try(var.observability.enabled, false)
  log_analytics_workspace_name          = coalesce(try(var.observability.log_analytics_workspace_name, null), "${var.name_prefix}-logs")
  application_insights_name             = coalesce(try(var.observability.application_insights_name, null), "${var.name_prefix}-appinsights")
  action_group_name                     = coalesce(try(var.observability.action_group_name, null), "${var.name_prefix}-alerts")
  availability_test_name                = coalesce(try(var.observability.availability_test_name, null), "${var.name_prefix}-healthz")
  availability_alert_name               = coalesce(try(var.observability.availability_alert_name, null), "${var.name_prefix}-availability")
  availability_test_geo_locations       = try(var.observability.availability_test_geo_locations, ["emea-nl-ams-azr"])
  availability_test_frequency           = try(var.observability.availability_test_frequency, 300)
  availability_test_timeout             = try(var.observability.availability_test_timeout, 30)
  availability_alert_severity           = try(var.observability.availability_alert_severity, 1)
  availability_failed_locations         = try(var.observability.availability_failed_locations, 1)
  availability_test_url                 = try(var.observability.availability_test_url, null)
  observability_action_group_short_name = try(var.observability.action_group_short_name, "opengenialrt")
  observability_alert_email_receivers   = try(var.observability.alert_email_receivers, {})
  dns_zone_contributor_principals = {
    for item in flatten([
      for assignment_name, assignment in var.dns_zone_contributor_assignments : [
        for principal_id in assignment.principal_ids : {
          key                 = "${assignment_name}/${principal_id}"
          resource_group_name = assignment.resource_group_name
          zone_name           = assignment.zone_name
          principal_id        = principal_id
        }
      ]
    ]) : item.key => item
  }
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

resource "azurerm_public_ip" "aks_egress" {
  name                = local.aks_egress_ip_name
  resource_group_name = local.resource_group_name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
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
    node_count = var.managed_aks_capacity != null ? var.managed_aks_capacity.node_count : var.aks.node_count
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

  network_profile {
    network_plugin    = "azure"
    load_balancer_sku = "standard"
    outbound_type     = "loadBalancer"

    load_balancer_profile {
      outbound_ip_address_ids = [azurerm_public_ip.aks_egress.id]
    }
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

resource "azurerm_role_assignment" "aks_network_public_ip" {
  count                = var.create_aks_network_role_assignment ? 1 : 0
  principal_id         = azurerm_kubernetes_cluster.this.identity[0].principal_id
  role_definition_name = "Network Contributor"
  scope                = azurerm_public_ip.aks_egress.id
}

resource "azurerm_role_assignment" "aks_admin_principals" {
  for_each             = var.aks_admin_principal_ids
  principal_id         = each.value
  role_definition_name = "Azure Kubernetes Service Cluster Admin Role"
  scope                = azurerm_kubernetes_cluster.this.id
}

resource "azurerm_role_assignment" "dns_zone_contributors" {
  for_each             = local.dns_zone_contributor_principals
  principal_id         = each.value.principal_id
  role_definition_name = "DNS Zone Contributor"
  scope                = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${each.value.resource_group_name}/providers/Microsoft.Network/dnsZones/${each.value.zone_name}"
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

resource "azurerm_log_analytics_workspace" "observability" {
  count               = local.observability_enabled ? 1 : 0
  name                = local.log_analytics_workspace_name
  resource_group_name = local.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "observability" {
  count               = local.observability_enabled ? 1 : 0
  name                = local.application_insights_name
  resource_group_name = local.resource_group_name
  location            = var.location
  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.observability[0].id
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_monitor_action_group" "observability" {
  count               = local.observability_enabled ? 1 : 0
  name                = local.action_group_name
  resource_group_name = local.resource_group_name
  short_name          = local.observability_action_group_short_name
  tags                = local.tags

  dynamic "email_receiver" {
    for_each = local.observability_alert_email_receivers

    content {
      name                    = email_receiver.key
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

resource "azurerm_application_insights_standard_web_test" "availability" {
  count                   = local.observability_enabled ? 1 : 0
  name                    = local.availability_test_name
  resource_group_name     = local.resource_group_name
  location                = var.location
  application_insights_id = azurerm_application_insights.observability[0].id
  enabled                 = true
  frequency               = local.availability_test_frequency
  timeout                 = local.availability_test_timeout
  retry_enabled           = true
  geo_locations           = local.availability_test_geo_locations
  description             = "OpenGeni production health check."
  tags                    = local.tags

  request {
    url                              = local.availability_test_url
    http_verb                        = "GET"
    follow_redirects_enabled         = true
    parse_dependent_requests_enabled = false
  }

  validation_rules {
    expected_status_code        = 200
    ssl_check_enabled           = true
    ssl_cert_remaining_lifetime = 7
  }
}

resource "azurerm_monitor_metric_alert" "availability" {
  count               = local.observability_enabled ? 1 : 0
  name                = local.availability_alert_name
  resource_group_name = local.resource_group_name
  scopes = [
    azurerm_application_insights_standard_web_test.availability[0].id,
    azurerm_application_insights.observability[0].id,
  ]
  description              = "Alerts when the OpenGeni production availability test fails."
  severity                 = local.availability_alert_severity
  enabled                  = true
  auto_mitigate            = true
  frequency                = "PT1M"
  window_size              = "PT5M"
  target_resource_type     = "Microsoft.Insights/webtests"
  target_resource_location = var.location
  tags                     = local.tags

  application_insights_web_test_location_availability_criteria {
    web_test_id           = azurerm_application_insights_standard_web_test.availability[0].id
    component_id          = azurerm_application_insights.observability[0].id
    failed_location_count = local.availability_failed_locations
  }

  action {
    action_group_id = azurerm_monitor_action_group.observability[0].id
  }
}

resource "azurerm_postgresql_flexible_server" "this" {
  count                  = var.postgres.mode == "managed" ? 1 : 0
  name                   = local.postgres_name
  resource_group_name    = local.resource_group_name
  location               = coalesce(var.postgres.location, var.location)
  zone                   = var.postgres.zone
  version                = var.postgres.version
  administrator_login    = var.postgres.administrator_login
  administrator_password = var.postgres.administrator_password
  sku_name               = var.managed_postgres_capacity != null ? var.managed_postgres_capacity.sku_name : var.postgres.sku_name
  storage_mb             = var.managed_postgres_capacity != null ? var.managed_postgres_capacity.storage_mb : var.postgres.storage_mb
  storage_tier           = var.managed_postgres_capacity != null ? var.managed_postgres_capacity.storage_tier : null
  auto_grow_enabled      = var.managed_postgres_capacity != null ? var.managed_postgres_capacity.auto_grow_enabled : null
  tags                   = local.tags
}

resource "azurerm_postgresql_flexible_server_database" "opengeni" {
  count     = var.postgres.mode == "managed" ? 1 : 0
  name      = "opengeni"
  server_id = azurerm_postgresql_flexible_server.this[0].id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = var.postgres.mode == "managed" && var.postgres.allow_azure_services ? 1 : 0
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.this[0].id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "aks_egress" {
  count            = var.postgres.mode == "managed" ? 1 : 0
  name             = "allow-aks-egress"
  server_id        = azurerm_postgresql_flexible_server.this[0].id
  start_ip_address = azurerm_public_ip.aks_egress.ip_address
  end_ip_address   = azurerm_public_ip.aks_egress.ip_address
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "custom" {
  for_each         = var.postgres.mode == "managed" ? var.postgres.firewall_rules : {}
  name             = each.key
  server_id        = azurerm_postgresql_flexible_server.this[0].id
  start_ip_address = each.value.start_ip_address
  end_ip_address   = each.value.end_ip_address
}

resource "azurerm_postgresql_flexible_server_configuration" "pgvector" {
  count     = var.postgres.mode == "managed" ? 1 : 0
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this[0].id
  value     = "PGCRYPTO,VECTOR,BTREE_GIN"
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

    dynamic "cors_rule" {
      for_each = length(var.object_storage.cors_allowed_origins) > 0 ? [1] : []
      content {
        allowed_headers    = ["*"]
        allowed_methods    = ["GET", "HEAD", "OPTIONS", "PUT"]
        allowed_origins    = var.object_storage.cors_allowed_origins
        exposed_headers    = ["*"]
        max_age_in_seconds = var.object_storage.cors_max_age_seconds
      }
    }
  }
}

resource "azurerm_storage_container" "files" {
  count                 = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? 1 : 0
  name                  = var.object_storage.bucket
  storage_account_id    = azurerm_storage_account.files[0].id
  container_access_type = "private"
}
