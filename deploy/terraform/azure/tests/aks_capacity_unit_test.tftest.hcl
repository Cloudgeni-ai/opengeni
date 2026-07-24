mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }
}

variables {
  create_acr_pull_role_assignment = false
  deployment_phase                = "bootstrap"
  name_prefix                     = "opengeni-test"
  resource_group_name             = "rg-opengeni-test"
}

run "legacy_managed_capacity_stays_fixed" {
  command = plan

  variables {
    managed_aks_capacity = {
      node_count = 5
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 5
    error_message = "The legacy production capacity override must still pin five nodes."
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == false
    error_message = "A node_count-only capacity override must remain a fixed pool."
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == null &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == null &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == null
    )
    error_message = "New optional capacity fields must not alter a legacy production override."
  }
}

run "staging_capacity_is_fully_pinned" {
  command = plan

  variables {
    managed_aks_capacity = {
      node_count                  = 1
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 1
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 1 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].vm_size == "Standard_E4as_v6" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == true &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 1 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_pods == 60 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_size_gb == 128 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_type == "Managed" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == "systemtemp"
    )
    error_message = "The staging override must pin SKU, autoscaling bounds, pod density, disk, and rotation name."
  }
}

run "direct_aks_capacity_controls_are_honored" {
  command = plan

  variables {
    aks = {
      node_count                  = 2
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 1
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 2 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].vm_size == "Standard_E4as_v6" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == true &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 1 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_pods == 60 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_size_gb == 128 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_type == "Managed" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == "systemtemp"
    )
    error_message = "The direct aks object must support the same optional capacity controls."
  }
}

run "invalid_staging_autoscaling_bounds_are_rejected" {
  command = plan

  variables {
    managed_aks_capacity = {
      node_count           = 1
      auto_scaling_enabled = true
      min_count            = 2
      max_count            = 3
    }
  }

  expect_failures = [
    var.managed_aks_capacity,
  ]
}
