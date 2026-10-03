locals {
  environment_short   = var.environment == "staging" ? "stg" : "prod"
  resource_group_name = "rg-opengeni-${local.environment_short}-neu"
  cluster_name        = "opengeni-${local.environment_short}-neu-aks"
  manages_system_pool = var.environment == "staging"
}

# Existing clusters are read, never imported into this narrow capacity root.
# Production's default pool remains owned by deploy/terraform/azure.
data "azurerm_kubernetes_cluster" "existing" {
  name                = local.cluster_name
  resource_group_name = local.resource_group_name
}

data "azurerm_kubernetes_cluster_node_pool" "system" {
  name                    = "system"
  kubernetes_cluster_name = local.cluster_name
  resource_group_name     = local.resource_group_name
}

import {
  for_each = local.manages_system_pool ? { system = "${data.azurerm_kubernetes_cluster.existing.id}/agentPools/system" } : {}
  to       = azurerm_kubernetes_cluster_node_pool.system[0]
  id       = each.value
}

# Staging has no full-cluster Terraform state. Adopt only its existing pool.
# Count is deliberately null: neither this root nor later applies repin it.
resource "azurerm_kubernetes_cluster_node_pool" "system" {
  count = local.manages_system_pool ? 1 : 0

  name                  = "system"
  kubernetes_cluster_id = data.azurerm_kubernetes_cluster.existing.id
  mode                  = "System"
  vm_size               = "Standard_D4ds_v4"
  auto_scaling_enabled  = true
  node_count            = null
  min_count             = 4
  max_count             = 5
  max_pods              = 30
  os_type               = "Linux"
  os_disk_type          = "Managed"
  os_disk_size_gb       = 128

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      node_count,
      node_labels,
      node_taints,
      orchestrator_version,
      os_sku,
      tags,
      upgrade_settings,
    ]

    precondition {
      condition = (
        data.azurerm_kubernetes_cluster_node_pool.system.auto_scaling_enabled &&
        data.azurerm_kubernetes_cluster_node_pool.system.vm_size == "Standard_D4ds_v4" &&
        data.azurerm_kubernetes_cluster_node_pool.system.max_pods == 30 &&
        data.azurerm_kubernetes_cluster_node_pool.system.os_disk_type == "Managed" &&
        data.azurerm_kubernetes_cluster_node_pool.system.os_disk_size_gb == 128 &&
        data.azurerm_kubernetes_cluster_node_pool.system.node_count >= 4 &&
        data.azurerm_kubernetes_cluster_node_pool.system.node_count <= 5
      )
      error_message = "Staging bounds must preserve the refreshed autoscaled D4ds_v4 system pool and cannot force a live-count reduction."
    }
  }
}

# Additive, general-purpose User capacity: no exclusive taint or pool selector
# is required of the existing application, platform, or geni canary workloads.
resource "azurerm_kubernetes_cluster_node_pool" "launch" {
  name                  = "launch"
  kubernetes_cluster_id = data.azurerm_kubernetes_cluster.existing.id
  mode                  = "User"
  vm_size               = var.launch_vm_size
  auto_scaling_enabled  = true
  node_count            = null
  min_count             = var.launch_min_count
  max_count             = var.launch_max_count
  max_pods              = 30
  os_type               = "Linux"
  os_sku                = "Ubuntu"
  os_disk_type          = "Managed"
  os_disk_size_gb       = 128
  zones                 = []
  node_labels = {
    "opengeni.ai/capacity-pool" = "launch"
  }
  node_taints = []

  upgrade_settings {
    max_surge                     = "10%"
    drain_timeout_in_minutes      = 30
    node_soak_duration_in_minutes = 5
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [node_count]

    precondition {
      condition = (
        data.azurerm_kubernetes_cluster_node_pool.system.auto_scaling_enabled &&
        data.azurerm_kubernetes_cluster_node_pool.system.vm_size == "Standard_D4ds_v4" &&
        data.azurerm_kubernetes_cluster_node_pool.system.max_pods == 30 &&
        data.azurerm_kubernetes_cluster_node_pool.system.os_disk_type == "Managed" &&
        data.azurerm_kubernetes_cluster_node_pool.system.os_disk_size_gb == 128
      )
      error_message = "Additive launch capacity must not replace or migrate the existing system pool."
    }
  }
}