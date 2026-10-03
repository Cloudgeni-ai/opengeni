locals {
  environment_short   = var.environment == "staging" ? "stg" : "prod"
  resource_group_name = "rg-opengeni-${local.environment_short}-neu"
  cluster_name        = "opengeni-${local.environment_short}-neu-aks"
  manages_system_pool = var.environment == "staging"
  expected_cluster_id = "/subscriptions/${var.subscription_id}/resourceGroups/${local.resource_group_name}/providers/Microsoft.ContainerService/managedClusters/${local.cluster_name}"
  system_identity_is_preserved = (
    lower(data.azurerm_kubernetes_cluster_node_pool.system.id) == lower("${local.expected_cluster_id}/agentPools/system") &&
    data.azurerm_kubernetes_cluster_node_pool.system.name == "system" &&
    data.azurerm_kubernetes_cluster_node_pool.system.mode == "System" &&
    data.azurerm_kubernetes_cluster_node_pool.system.os_type == "Linux" &&
    data.azurerm_kubernetes_cluster_node_pool.system.priority == "Regular" &&
    data.azurerm_kubernetes_cluster_node_pool.system.auto_scaling_enabled &&
    data.azurerm_kubernetes_cluster_node_pool.system.vm_size == "Standard_D4ds_v4" &&
    data.azurerm_kubernetes_cluster_node_pool.system.max_pods == 30 &&
    data.azurerm_kubernetes_cluster_node_pool.system.os_disk_type == "Managed" &&
    data.azurerm_kubernetes_cluster_node_pool.system.os_disk_size_gb == 128
  )
}

# The existing pool read proves the exact parent cluster and pool identity.
# Do not use the full-cluster data source: it reads kubeconfig credentials even
# when the caller needs only an ARM ID. Live region admission stays in the
# protected workflow. Production's default pool stays in the full Azure root.
data "azurerm_kubernetes_cluster_node_pool" "system" {
  name                    = "system"
  kubernetes_cluster_name = local.cluster_name
  resource_group_name     = local.resource_group_name
}

import {
  for_each = local.manages_system_pool ? { system = "${local.expected_cluster_id}/agentPools/system" } : {}
  to       = azurerm_kubernetes_cluster_node_pool.system[0]
  id       = each.value
}

# Staging has no full-cluster Terraform state. Adopt only its existing pool.
# Configured count is deliberately null; the provider's GET/PUT race is
# documented in README.md and must not be mistaken for HTTP count omission.
resource "azurerm_kubernetes_cluster_node_pool" "system" {
  count = local.manages_system_pool ? 1 : 0

  name                  = "system"
  kubernetes_cluster_id = local.expected_cluster_id
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
    # This import owns bounds only. Preserve every other optional provider
    # field not explicitly identity-fenced above, including networking and
    # security settings whose omitted defaults could otherwise cycle nodes.
    ignore_changes = [
      capacity_reservation_group_id,
      eviction_policy,
      fips_enabled,
      gpu_driver,
      gpu_instance,
      host_encryption_enabled,
      host_group_id,
      kubelet_config,
      kubelet_disk_type,
      linux_os_config,
      node_count,
      node_labels,
      node_network_profile,
      node_public_ip_enabled,
      node_public_ip_prefix_id,
      node_taints,
      orchestrator_version,
      os_sku,
      pod_subnet_id,
      proximity_placement_group_id,
      scale_down_mode,
      snapshot_id,
      spot_max_price,
      tags,
      temporary_name_for_rotation,
      ultra_ssd_enabled,
      upgrade_settings,
      vnet_subnet_id,
      windows_profile,
      workload_runtime,
      zones,
    ]

    precondition {
      condition = (
        local.system_identity_is_preserved &&
        data.azurerm_kubernetes_cluster_node_pool.system.min_count <= 4 &&
        data.azurerm_kubernetes_cluster_node_pool.system.max_count >= 5 &&
        data.azurerm_kubernetes_cluster_node_pool.system.node_count >= 4 &&
        data.azurerm_kubernetes_cluster_node_pool.system.node_count <= 5
      )
      error_message = "Staging bounds must preserve the refreshed system identity, tighten monotonically, and cannot force a live-count change."
    }
  }
}

# Additive, general-purpose User capacity: no exclusive taint or pool selector
# is required of the existing application, platform, or geni canary workloads.
resource "azurerm_kubernetes_cluster_node_pool" "launch" {
  name                  = "launch"
  kubernetes_cluster_id = local.expected_cluster_id
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
      condition     = local.system_identity_is_preserved
      error_message = "Additive launch capacity must not replace or migrate the existing system pool."
    }
  }
}