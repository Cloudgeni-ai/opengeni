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
  container_insights_enabled            = local.observability_enabled && var.aks_container_insights.enabled
  container_insights_destination        = "ciworkspace"
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
  aks_auto_scaling_enabled              = var.aks.auto_scaling_enabled
  aks_max_count                         = local.aks_auto_scaling_enabled ? var.aks.max_count : null
  aks_max_pods                          = var.aks.max_pods
  aks_min_count                         = local.aks_auto_scaling_enabled ? var.aks.min_count : null
  aks_node_count_for_pool               = local.aks_auto_scaling_enabled ? null : var.aks.node_count
  aks_os_disk_size_gb                   = var.aks.os_disk_size_gb
  aks_os_disk_type                      = var.aks.os_disk_type
  aks_temporary_name_for_rotation       = var.aks.temporary_name_for_rotation
  aks_vm_size                           = var.aks.vm_size
  aks_rotation_preflight                = try(var.aks_rollout.rotation_preflight, null)
  aks_existing_node_pool                = try(data.azurerm_kubernetes_cluster_node_pool.existing[0], null)
  aks_existing_auto_scaling_enabled     = coalesce(try(local.aks_existing_node_pool.auto_scaling_enabled, null), false)
  aks_existing_node_count               = try(local.aks_existing_node_pool.node_count, null)
  aks_rotation_count_matches_live = try(
    local.aks_rotation_preflight.observed_node_count == local.aks_existing_node_count,
    false
  )
  aks_rotation_count_within_bounds = try(
    local.aks_rotation_count_matches_live &&
    local.aks_existing_node_count >= local.aks_min_count &&
    local.aks_existing_node_count <= local.aks_max_count,
    false
  )
  aks_rotation_quota_within_limit = try(
    local.aks_rotation_preflight.regional_vcpu_used +
    local.aks_existing_node_count * local.aks_rotation_preflight.rotation_vcpu_per_node <=
    local.aks_rotation_preflight.regional_vcpu_limit,
    false
  )
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

data "azurerm_kubernetes_cluster_node_pool" "existing" {
  count = var.aks_existing_pool ? 1 : 0

  name                    = "system"
  kubernetes_cluster_name = local.aks_name
  resource_group_name     = local.resource_group_name
}

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
    name                 = "system"
    auto_scaling_enabled = local.aks_auto_scaling_enabled
    max_count            = local.aks_max_count
    max_pods             = local.aks_max_pods
    min_count            = local.aks_min_count
    # AzureRM 4.72.0 rejects node_count updates on an existing autoscaled pool.
    # Keep the requested count for validation, but let Azure/autoscaling state
    # own the live count whenever autoscaling is enabled.
    node_count                  = local.aks_node_count_for_pool
    os_disk_size_gb             = local.aks_os_disk_size_gb
    os_disk_type                = local.aks_os_disk_type
    temporary_name_for_rotation = local.aks_temporary_name_for_rotation
    vm_size                     = local.aks_vm_size

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

  # Container Insights uses managed-identity (AAD) ingestion. Its collection
  # scope comes only from the data collection rule association below; the
  # addon never falls back to legacy workspace-key collection.
  dynamic "oms_agent" {
    for_each = local.container_insights_enabled ? [azurerm_log_analytics_workspace.observability[0].id] : []

    content {
      log_analytics_workspace_id      = oms_agent.value
      msi_auth_for_monitoring_enabled = true
    }
  }

  lifecycle {
    ignore_changes = [
      microsoft_defender[0].log_analytics_workspace_id,
    ]

    precondition {
      condition = !local.aks_auto_scaling_enabled || (
        local.aks_min_count != null &&
        local.aks_max_count != null &&
        local.aks_min_count <= var.aks.node_count &&
        var.aks.node_count <= local.aks_max_count
      )
      error_message = "AKS autoscaling requires min_count <= node_count <= max_count."
    }

    precondition {
      condition     = !var.aks_existing_pool || contains(["bounds", "rotation"], var.aks_rollout.phase)
      error_message = "Existing AKS pools must explicitly select the bounds or rotation rollout phase; direct is reserved for new-cluster compatibility."
    }

    precondition {
      condition = var.aks_rollout.phase != "bounds" || (
        local.aks_auto_scaling_enabled &&
        local.aks_node_count_for_pool == null
      )
      error_message = "The AKS bounds rollout requires autoscaling and must omit an explicit fixed-pool node_count."
    }

    precondition {
      condition = var.aks_rollout.phase != "bounds" || (
        var.aks_rollout.expected_existing != null &&
        try(var.aks_rollout.expected_existing.auto_scaling_enabled, true) == local.aks_existing_auto_scaling_enabled &&
        try(var.aks_rollout.expected_existing.vm_size, null) == local.aks_existing_node_pool.vm_size &&
        try(var.aks_rollout.expected_existing.max_pods, null) == local.aks_existing_node_pool.max_pods &&
        try(var.aks_rollout.expected_existing.os_disk_size_gb, null) == local.aks_existing_node_pool.os_disk_size_gb &&
        try(var.aks_rollout.expected_existing.os_disk_type, null) == local.aks_existing_node_pool.os_disk_type &&
        var.aks.vm_size == local.aks_existing_node_pool.vm_size &&
        var.aks.max_pods == local.aks_existing_node_pool.max_pods &&
        var.aks.os_disk_size_gb == local.aks_existing_node_pool.os_disk_size_gb &&
        var.aks.os_disk_type == local.aks_existing_node_pool.os_disk_type &&
        try(var.aks_rollout.expected_existing.temporary_name_for_rotation, null) == null &&
        var.aks.temporary_name_for_rotation == null &&
        (
          try(var.aks_rollout.expected_existing.auto_scaling_enabled, true) ||
          (
            var.aks.node_count == local.aks_existing_node_count &&
            local.aks_existing_node_count >= local.aks_min_count &&
            local.aks_existing_node_count <= local.aks_max_count
          )
        )
      )
      error_message = "AKS bounds rollout must match the refreshed live system pool for SKU, pod density, disk, and autoscaling; a fixed-to-autoscaled transition must also bind the exact live count inside the requested bounds; rotation settings must remain null."
    }

    precondition {
      condition = var.aks_rollout.phase != "rotation" || (
        local.aks_rotation_count_within_bounds &&
        local.aks_rotation_quota_within_limit
      )
      error_message = "AKS rotation requires a refreshed provider count within the requested bounds and enough regional vCPU quota for the temporary pool."
    }
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "sandbox" {
  count = var.sandbox_node_pool.enabled ? 1 : 0

  name                  = var.sandbox_node_pool.name
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.sandbox_node_pool.vm_size
  mode                  = "User"

  auto_scaling_enabled = true
  min_count            = var.sandbox_node_pool.min_count
  max_count            = var.sandbox_node_pool.max_count
  node_count           = null
  max_pods             = var.sandbox_node_pool.max_pods

  os_type                     = "Linux"
  os_disk_size_gb             = var.sandbox_node_pool.os_disk_size_gb
  os_disk_type                = var.sandbox_node_pool.os_disk_type
  zones                       = var.sandbox_node_pool.zones
  temporary_name_for_rotation = var.sandbox_node_pool.temporary_name_for_rotation

  node_labels = {
    "opengeni.ai/sandbox-pool" = "opensandbox"
  }
  node_taints = [
    "opengeni.ai/sandbox=true:NoSchedule",
  ]

  upgrade_settings {
    drain_timeout_in_minutes      = var.sandbox_node_pool.node_pool_upgrade_drain_minutes
    max_surge                     = var.sandbox_node_pool.node_pool_upgrade_max_surge
    node_soak_duration_in_minutes = var.sandbox_node_pool.node_pool_upgrade_soak_minutes
  }

  tags = merge(local.tags, {
    purpose = "opengeni-opensandbox-compute"
  })
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
  # -1 is the provider's "no cap" value and preserves workspaces that do not
  # collect container logs. Container Insights always installs a cap.
  daily_quota_gb = local.container_insights_enabled ? var.aks_container_insights.workspace_daily_quota_gb : -1
  tags           = local.tags
}

# A container log transform runs in its own data flow; every other stream
# keeps the untransformed default flow into its standard table.
locals {
  container_insights_transformed_streams = var.aks_container_insights.container_log_transform_kql == null ? [] : ["Microsoft-ContainerLogV2"]
  container_insights_default_streams = [
    for stream in var.aks_container_insights.streams : stream
    if !contains(local.container_insights_transformed_streams, stream)
  ]
}

resource "azurerm_monitor_data_collection_rule" "container_insights" {
  count               = local.container_insights_enabled ? 1 : 0
  name                = "MSCI-${var.location}-${local.aks_name}"
  resource_group_name = local.resource_group_name
  location            = azurerm_log_analytics_workspace.observability[0].location
  description         = "Namespace-scoped AKS Container Insights collection for OpenGeni."
  tags                = local.tags

  destinations {
    log_analytics {
      name                  = local.container_insights_destination
      workspace_resource_id = azurerm_log_analytics_workspace.observability[0].id
    }
  }

  dynamic "data_flow" {
    for_each = length(local.container_insights_default_streams) > 0 ? [local.container_insights_default_streams] : []

    content {
      streams      = data_flow.value
      destinations = [local.container_insights_destination]
    }
  }

  # Ingestion-time transform for container stdout/stderr, for example to
  # redact request query strings before they are retained.
  dynamic "data_flow" {
    for_each = local.container_insights_transformed_streams

    content {
      streams       = [data_flow.value]
      destinations  = [local.container_insights_destination]
      transform_kql = var.aks_container_insights.container_log_transform_kql
      output_stream = data_flow.value
    }
  }

  data_sources {
    extension {
      name           = "ContainerInsightsExtension"
      extension_name = "ContainerInsights"
      streams        = var.aks_container_insights.streams
      extension_json = jsonencode({
        dataCollectionSettings = {
          interval               = var.aks_container_insights.data_collection_interval
          namespaceFilteringMode = "Include"
          namespaces             = var.aks_container_insights.namespaces
          enableContainerLogV2   = true
        }
      })
    }
  }
}

# Container Insights discovers its rule through this exact association name.
resource "azurerm_monitor_data_collection_rule_association" "container_insights" {
  count                   = local.container_insights_enabled ? 1 : 0
  name                    = "ContainerInsightsExtension"
  target_resource_id      = azurerm_kubernetes_cluster.this.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.container_insights[0].id
  description             = "Association of the OpenGeni Container Insights data collection rule. Deleting it stops container log collection for this cluster."
}

# _LogOperation is not subject to the daily cap, so this fires after the
# workspace has stopped ingesting for the day.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "container_insights_daily_cap" {
  count                = local.container_insights_enabled ? 1 : 0
  name                 = "${var.name_prefix}-logs-daily-cap"
  resource_group_name  = local.resource_group_name
  location             = azurerm_log_analytics_workspace.observability[0].location
  scopes               = [azurerm_log_analytics_workspace.observability[0].id]
  description          = "The observability Log Analytics workspace reached its daily ingestion cap and stopped collecting container logs until the daily reset."
  severity             = 2
  evaluation_frequency = "PT15M"
  # Log search alerts evaluate on TimeGenerated without latency compensation.
  # The OverQuota record is usually a single row, so a window wider than the
  # evaluation frequency keeps a late-arriving record from falling between
  # evaluations. The rule is stateless; muting stops it re-notifying every
  # evaluation while that record stays inside the window.
  window_duration                   = "PT1H"
  mute_actions_after_alert_duration = "PT6H"
  tags                              = local.tags

  criteria {
    query                   = "_LogOperation | where Category =~ \"Ingestion\" | where Detail contains \"OverQuota\""
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.observability[0].id]
  }
}

# Collection can stop without the cap being reached: a deleted association,
# an agent that cannot authenticate, or the addon removed out of band. The
# listed namespaces always log, so an empty window means collection stopped.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "container_insights_no_data" {
  count                = local.container_insights_enabled ? 1 : 0
  name                 = "${var.name_prefix}-logs-collection-stopped"
  resource_group_name  = local.resource_group_name
  location             = azurerm_log_analytics_workspace.observability[0].location
  scopes               = [azurerm_log_analytics_workspace.observability[0].id]
  description          = "No container log lines from the collected namespaces reached the observability Log Analytics workspace in the last 30 minutes."
  severity             = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"
  # Stateful: fires once when collection stops and resolves when it resumes.
  auto_mitigation_enabled = true
  tags                    = local.tags

  criteria {
    query                   = "ContainerLogV2 | where PodNamespace in (${join(", ", [for namespace in var.aks_container_insights.namespaces : "\"${namespace}\""])})"
    time_aggregation_method = "Count"
    threshold               = 1
    operator                = "LessThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.observability[0].id]
  }
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
