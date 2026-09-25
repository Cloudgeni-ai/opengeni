# Container Insights is optional, namespace-scoped, and always cost-capped.
# Resource identities are mocked during plan so the wiring between the
# workspace, the AKS addon, the collection rule, and its association is
# asserted directly instead of being left unknown.
mock_provider "azurerm" {
  override_during = plan

  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerService/managedClusters/opengeni-test-aks"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-opengeni-test/providers/Microsoft.OperationalInsights/workspaces/opengeni-test-logs"
    }
  }

  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/actionGroups/opengeni-test-alerts"
    }
  }

  mock_resource "azurerm_monitor_data_collection_rule" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/dataCollectionRules/MSCI-westeurope-opengeni-test-aks"
    }
  }
}

variables {
  create_acr_pull_role_assignment = false
  deployment_phase                = "bootstrap"
  name_prefix                     = "opengeni-test"
  resource_group_name             = "rg-opengeni-test"
  observability = {
    enabled               = true
    availability_test_url = "https://opengeni.example.com/healthz"
    alert_email_receivers = {
      operator = "operator@example.com"
    }
  }
}

run "container_insights_is_disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(azurerm_kubernetes_cluster.this.oms_agent) == 0 &&
      length(azurerm_monitor_data_collection_rule.container_insights) == 0 &&
      length(azurerm_monitor_data_collection_rule_association.container_insights) == 0 &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.container_insights_daily_cap) == 0
    )
    error_message = "Container Insights must not install the AKS addon or a collection rule unless explicitly enabled."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.observability[0].daily_quota_gb == -1
    error_message = "A workspace without container log collection must keep the provider's uncapped default so existing deployments plan no change."
  }

  assert {
    condition     = output.aks_container_insights.enabled == false && output.aks_container_insights.data_collection_rule_id == null
    error_message = "The disabled Container Insights output must report no collection rule."
  }
}

run "container_insights_collects_only_listed_namespaces_with_a_cap" {
  command = plan

  variables {
    aks_container_insights = {
      enabled                  = true
      namespaces               = ["opengeni", "opengeni-platform"]
      workspace_daily_quota_gb = 5
    }
  }

  assert {
    condition = (
      length(azurerm_kubernetes_cluster.this.oms_agent) == 1 &&
      azurerm_kubernetes_cluster.this.oms_agent[0].msi_auth_for_monitoring_enabled == true &&
      azurerm_kubernetes_cluster.this.oms_agent[0].log_analytics_workspace_id == azurerm_log_analytics_workspace.observability[0].id
    )
    error_message = "The AKS monitoring addon must use managed-identity ingestion into the observability workspace."
  }

  assert {
    condition     = azurerm_log_analytics_workspace.observability[0].daily_quota_gb == 5
    error_message = "Enabling container log collection must install the reviewed workspace daily ingestion cap."
  }

  assert {
    condition = (
      azurerm_monitor_data_collection_rule.container_insights[0].name == "MSCI-westeurope-opengeni-test-aks" &&
      azurerm_monitor_data_collection_rule.container_insights[0].location == "westeurope" &&
      azurerm_monitor_data_collection_rule.container_insights[0].destinations[0].log_analytics[0].workspace_resource_id == azurerm_log_analytics_workspace.observability[0].id
    )
    error_message = "The collection rule must live beside, and deliver only to, the observability workspace."
  }

  assert {
    condition = (
      toset(azurerm_monitor_data_collection_rule.container_insights[0].data_flow[0].streams) == toset(["Microsoft-ContainerLogV2", "Microsoft-KubeEvents", "Microsoft-KubePodInventory"]) &&
      toset(azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].streams) == toset(["Microsoft-ContainerLogV2", "Microsoft-KubeEvents", "Microsoft-KubePodInventory"]) &&
      azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].extension_name == "ContainerInsights"
    )
    error_message = "The default collection must be the logs-and-events preset: ContainerLogV2, Kubernetes events, and pod inventory."
  }

  assert {
    condition = (
      jsondecode(azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].extension_json).dataCollectionSettings.namespaceFilteringMode == "Include" &&
      jsondecode(azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].extension_json).dataCollectionSettings.namespaces == ["opengeni", "opengeni-platform"] &&
      jsondecode(azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].extension_json).dataCollectionSettings.enableContainerLogV2 == true &&
      jsondecode(azurerm_monitor_data_collection_rule.container_insights[0].data_sources[0].extension[0].extension_json).dataCollectionSettings.interval == "5m"
    )
    error_message = "Collection must include only the listed namespaces through ContainerLogV2 at the reviewed inventory interval."
  }

  assert {
    condition = (
      azurerm_monitor_data_collection_rule_association.container_insights[0].name == "ContainerInsightsExtension" &&
      azurerm_monitor_data_collection_rule_association.container_insights[0].target_resource_id == azurerm_kubernetes_cluster.this.id &&
      azurerm_monitor_data_collection_rule_association.container_insights[0].data_collection_rule_id == azurerm_monitor_data_collection_rule.container_insights[0].id
    )
    error_message = "Container Insights discovers its rule only through the ContainerInsightsExtension association on the cluster."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.container_insights_daily_cap[0].name == "opengeni-test-logs-daily-cap" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.container_insights_daily_cap[0].scopes == tolist([azurerm_log_analytics_workspace.observability[0].id]) &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.container_insights_daily_cap[0].criteria[0].query, "OverQuota") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.container_insights_daily_cap[0].action[0].action_groups == tolist([azurerm_monitor_action_group.observability[0].id])
    )
    error_message = "Reaching the workspace daily cap must alert the observability action group instead of silently dropping logs."
  }

  assert {
    condition = (
      output.aks_container_insights.enabled &&
      output.aks_container_insights.data_collection_rule_id == azurerm_monitor_data_collection_rule.container_insights[0].id &&
      output.aks_container_insights.namespaces == tolist(["opengeni", "opengeni-platform"]) &&
      output.aks_container_insights.workspace_daily_quota_gb == 5
    )
    error_message = "The Container Insights output must report the exact rule, namespaces, and cap for operator verification."
  }
}

run "container_insights_requires_the_observability_workspace" {
  command = plan

  variables {
    observability = {}
    aks_container_insights = {
      enabled                  = true
      namespaces               = ["opengeni"]
      workspace_daily_quota_gb = 5
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}

run "container_insights_requires_a_namespace_scope" {
  command = plan

  variables {
    aks_container_insights = {
      enabled                  = true
      workspace_daily_quota_gb = 5
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}

run "container_insights_requires_a_daily_cap" {
  command = plan

  variables {
    aks_container_insights = {
      enabled    = true
      namespaces = ["opengeni"]
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}

run "container_insights_rejects_an_unbounded_cap" {
  command = plan

  variables {
    aks_container_insights = {
      enabled                  = true
      namespaces               = ["opengeni"]
      workspace_daily_quota_gb = -1
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}

run "container_insights_requires_container_logs_v2" {
  command = plan

  variables {
    aks_container_insights = {
      enabled                  = true
      namespaces               = ["opengeni"]
      streams                  = ["Microsoft-KubeEvents"]
      workspace_daily_quota_gb = 5
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}

run "container_insights_rejects_invalid_namespaces" {
  command = plan

  variables {
    aks_container_insights = {
      enabled                  = true
      namespaces               = ["OpenGeni"]
      workspace_daily_quota_gb = 5
    }
  }

  expect_failures = [
    var.aks_container_insights,
  ]
}
