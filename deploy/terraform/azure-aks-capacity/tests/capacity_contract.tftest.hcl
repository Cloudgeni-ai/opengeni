mock_provider "azurerm" {
  mock_data "azurerm_kubernetes_cluster" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks"
      location = "northeurope"
    }
  }

  mock_data "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  mock_resource "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      id         = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/launch"
      node_count = 5
    }
  }
}

variables {
  environment     = "staging"
  subscription_id = "00000000-0000-0000-0000-000000000001"
}

# Mock providers cannot execute an import or prove a real no-op/count update.
# Override only computed resource fields; desired bounds and identity still
# come from the real configuration. Provider HTTP behavior is reviewed separately.
override_resource {
  target = azurerm_kubernetes_cluster_node_pool.system[0]
  values = {
    id         = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
    node_count = 4
  }
}

run "staging_adopts_only_existing_system_pool" {
  command = plan

  assert {
    condition = (
      length(azurerm_kubernetes_cluster_node_pool.system) == 1 &&
      azurerm_kubernetes_cluster_node_pool.system[0].name == "system" &&
      azurerm_kubernetes_cluster_node_pool.system[0].mode == "System" &&
      azurerm_kubernetes_cluster_node_pool.system[0].vm_size == "Standard_D4ds_v4" &&
      azurerm_kubernetes_cluster_node_pool.system[0].min_count == 4 &&
      azurerm_kubernetes_cluster_node_pool.system[0].max_count == 5 &&
      azurerm_kubernetes_cluster_node_pool.system[0].auto_scaling_enabled
    )
    error_message = "Staging must preserve its system identity and tighten only its autoscaler bounds."
  }
}

run "production_does_not_adopt_system_pool" {
  command = plan

  variables {
    environment = "production"
  }

  override_data {
    target = data.azurerm_kubernetes_cluster.existing
    values = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-prod-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-prod-neu-aks"
      location = "northeurope"
    }
  }

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-prod-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-prod-neu-aks/agentPools/system"
      max_count            = 6
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  assert {
    condition = (
      length(azurerm_kubernetes_cluster_node_pool.system) == 0 &&
      output.capacity_contract.system.owner == "azure" &&
      output.capacity_contract.system.max_count == 6
    )
    error_message = "Production system ownership must remain in the existing full Azure root."
  }
}

run "launch_pool_is_additive_warm_user_capacity" {
  command = plan

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.launch.name == "launch" &&
      azurerm_kubernetes_cluster_node_pool.launch.mode == "User" &&
      azurerm_kubernetes_cluster_node_pool.launch.vm_size == "Standard_D4ds_v5" &&
      azurerm_kubernetes_cluster_node_pool.launch.auto_scaling_enabled &&
      azurerm_kubernetes_cluster_node_pool.launch.min_count == 3 &&
      azurerm_kubernetes_cluster_node_pool.launch.max_count == 6 &&
      azurerm_kubernetes_cluster_node_pool.launch.max_pods == 30 &&
      azurerm_kubernetes_cluster_node_pool.launch.os_disk_type == "Managed" &&
      azurerm_kubernetes_cluster_node_pool.launch.os_disk_size_gb == 128
    )
    error_message = "Launch capacity must retain the reviewed compatible warm floor and family ceiling."
  }
}

run "launch_pool_does_not_exclude_existing_workloads" {
  command = plan

  assert {
    condition = (
      length(azurerm_kubernetes_cluster_node_pool.launch.node_taints) == 0 &&
      length(azurerm_kubernetes_cluster_node_pool.launch.zones) == 0 &&
      azurerm_kubernetes_cluster_node_pool.launch.os_type == "Linux" &&
      azurerm_kubernetes_cluster_node_pool.launch.os_sku == "Ubuntu" &&
      azurerm_kubernetes_cluster_node_pool.launch.node_labels["opengeni.ai/capacity-pool"] == "launch"
    )
    error_message = "General-purpose launch nodes must not require exclusive application tolerations or affinity."
  }
}

run "launch_upgrade_reserve_is_rounded_per_pool" {
  command = plan

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.launch.upgrade_settings[0].max_surge == "10%" &&
      azurerm_kubernetes_cluster_node_pool.launch.upgrade_settings[0].drain_timeout_in_minutes == 30 &&
      azurerm_kubernetes_cluster_node_pool.launch.upgrade_settings[0].node_soak_duration_in_minutes == 5
    )
    error_message = "Each launch pool must retain its independently budgeted surge and bounded drain policy."
  }
}

run "authorized_amd_alternative_is_explicit" {
  command = plan

  variables {
    launch_vm_size = "Standard_D4as_v5"
  }

  assert {
    condition     = azurerm_kubernetes_cluster_node_pool.launch.vm_size == "Standard_D4as_v5"
    error_message = "The authorized compatible AMD alternative must be an explicit choice."
  }
}

run "autoscaler_count_is_not_repinned_to_minimum" {
  command = plan

  override_resource {
    target          = azurerm_kubernetes_cluster_node_pool.launch
    override_during = plan
    values = {
      node_count = 5
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.launch.node_count == 5 &&
      azurerm_kubernetes_cluster_node_pool.launch.min_count == 3
    )
    error_message = "Refreshed/provider-owned counts must not be forced back to the configured minimum."
  }
}

run "staging_live_count_five_is_preserved" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 5
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  override_resource {
    target          = azurerm_kubernetes_cluster_node_pool.system[0]
    override_during = plan
    values = {
      node_count = 5
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.system[0].max_count == 5 &&
      azurerm_kubernetes_cluster_node_pool.system[0].node_count == 5
    )
    error_message = "Tightening the ceiling must admit, not downscale, an already valid live count."
  }
}

run "reject_staging_forced_live_count_reduction" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 6
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system]
}

run "reject_system_sku_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D8ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_disabled_existing_autoscaler" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = false
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_system_disk_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 64
      os_disk_type         = "Ephemeral"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_system_mode_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "User"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_wrong_cluster_identity" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster.existing
    values = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks"
      location = "northeurope"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_wrong_region" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster.existing
    values = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks"
      location = "westeurope"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_wrong_pool_identity" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_system_os_type_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Windows"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_system_priority_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Spot"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_system_pod_density_drift" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 110
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system, azurerm_kubernetes_cluster_node_pool.launch]
}

run "reject_staging_forced_live_count_increase" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 3
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system]
}

run "reject_staging_minimum_widening" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 8
      max_pods             = 30
      min_count            = 5
      mode                 = "System"
      name                 = "system"
      node_count           = 5
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system]
}

run "reject_staging_ceiling_widening" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 4
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  expect_failures = [azurerm_kubernetes_cluster_node_pool.system]
}

run "staging_already_tightened_bounds_are_admitted" {
  command = plan

  override_data {
    target = data.azurerm_kubernetes_cluster_node_pool.system
    values = {
      auto_scaling_enabled = true
      id                   = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-opengeni-stg-neu/providers/Microsoft.ContainerService/managedClusters/opengeni-stg-neu-aks/agentPools/system"
      max_count            = 5
      max_pods             = 30
      min_count            = 4
      mode                 = "System"
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      os_type              = "Linux"
      priority             = "Regular"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.system[0].min_count == 4 &&
      azurerm_kubernetes_cluster_node_pool.system[0].max_count == 5
    )
    error_message = "Already-tightened live bounds must remain admissible; this mock is not proof of an imported no-op."
  }
}

run "reject_unreviewed_environment" {
  command         = plan
  expect_failures = [var.environment]

  variables {
    environment = "preview"
  }
}

run "reject_unreviewed_family_or_shape" {
  command         = plan
  expect_failures = [var.launch_vm_size]

  variables {
    launch_vm_size = "Standard_D8ds_v5"
  }
}

run "reject_cold_floor" {
  command         = plan
  expect_failures = [var.launch_min_count]

  variables {
    launch_min_count = 0
  }
}

run "reject_unreviewed_joint_ceiling" {
  command         = plan
  expect_failures = [var.launch_max_count]

  variables {
    launch_max_count = 8
  }
}