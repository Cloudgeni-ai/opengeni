mock_provider "azurerm" {
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
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerService/managedClusters/opengeni-test-aks"
      default_node_pool = {
        auto_scaling_enabled        = true
        max_count                   = 8
        max_pods                    = 30
        min_count                   = 4
        name                        = "system"
        node_count                  = 4
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
        vm_size                     = "Standard_D4ds_v4"
      }
    }
  }

  mock_resource "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      id                   = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerService/managedClusters/opengeni-test-aks/agentPools/sandbox"
      auto_scaling_enabled = true
      max_count            = 20
      max_pods             = 110
      min_count            = 0
      mode                 = "User"
      name                 = "sandbox"
      node_count           = 0
      node_labels = {
        "opengeni.ai/sandbox-pool" = "opensandbox"
      }
      node_taints     = ["opengeni.ai/sandbox=true:NoSchedule"]
      os_disk_size_gb = 128
      os_disk_type    = "Ephemeral"
      vm_size         = "Standard_D4ds_v5"
    }
  }

  mock_data "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      auto_scaling_enabled = true
      max_count            = 8
      max_pods             = 30
      min_count            = 4
      name                 = "system"
      node_count           = 4
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerRegistry/registries/opengenitestacr"
    }
  }

  mock_resource "azurerm_public_ip" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Network/publicIPAddresses/opengeni-test-aks-egress-ip"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.KeyVault/vaults/opengenitestkv"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Storage/storageAccounts/opengenitestfiles"
    }
  }

  mock_resource "azurerm_storage_container" {
    defaults = {
      id = "https://opengenitestfiles.blob.core.windows.net/opengeni-files"
    }
  }
}

# Model the pre-transition state of an imported fixed system pool. Bounds
# admission must prove this provider state exactly before enabling autoscaling.
mock_provider "azurerm" {
  alias = "fixed"

  mock_data "azurerm_client_config" {
    defaults = {
      client_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
      tenant_id       = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_data "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      auto_scaling_enabled = false
      max_count            = null
      max_pods             = 30
      min_count            = null
      name                 = "system"
      node_count           = 6
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      vm_size              = "Standard_D4ds_v4"
    }
  }
}

# Model the authoritative post-convergence refresh separately from the
# imported count-four provider state above. The real operator refresh supplies
# this state after phase 1; the alias keeps that transition deterministic in
# a unit test without pretending a mock provider can mutate an existing state.
mock_provider "azurerm" {
  alias = "converged"

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
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerService/managedClusters/opengeni-test-aks"
      default_node_pool = {
        auto_scaling_enabled        = true
        max_count                   = 3
        max_pods                    = 30
        min_count                   = 3
        name                        = "system"
        node_count                  = 3
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
        vm_size                     = "Standard_D4ds_v4"
      }
    }
  }

  mock_data "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      auto_scaling_enabled = true
      max_count            = 3
      max_pods             = 30
      min_count            = 3
      name                 = "system"
      node_count           = 3
      os_disk_size_gb      = 128
      os_disk_type         = "Managed"
      vm_size              = "Standard_D4ds_v4"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test"
    }
  }

  mock_resource "azurerm_container_registry" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.ContainerRegistry/registries/opengenitestacr"
    }
  }

  mock_resource "azurerm_public_ip" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Network/publicIPAddresses/opengeni-test-aks-egress-ip"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.KeyVault/vaults/opengenitestkv"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Storage/storageAccounts/opengenitestfiles"
    }
  }

  mock_resource "azurerm_storage_container" {
    defaults = {
      id = "https://opengenitestfiles.blob.core.windows.net/opengeni-files"
    }
  }
}

variables {
  create_acr_pull_role_assignment = false
  deployment_phase                = "bootstrap"
  name_prefix                     = "opengeni-test"
  resource_group_name             = "rg-opengeni-test"
}

run "fixed_pool_retains_explicit_node_count" {
  command = plan

  variables {
    aks = {
      node_count = 5
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 5
    error_message = "Fixed pools must retain explicit node_count configuration."
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == false &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == null &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == null
    )
    error_message = "Fixed pools must not receive autoscaling bounds."
  }
}

run "opensandbox_pool_is_disabled_by_default" {
  command = plan

  assert {
    condition     = length(azurerm_kubernetes_cluster_node_pool.sandbox) == 0
    error_message = "The dedicated OpenSandbox node pool must remain disabled by default."
  }

  assert {
    condition     = output.sandbox_node_pool == null
    error_message = "Disabled OpenSandbox capacity must render a null output."
  }
}

run "opensandbox_pool_uses_exact_capacity_isolation_contract" {
  command = plan

  variables {
    sandbox_node_pool = {
      enabled         = true
      name            = "sandbox"
      vm_size         = "Standard_D4ds_v5"
      min_count       = 0
      max_count       = 40
      max_pods        = 110
      zones           = ["1", "2", "3"]
      os_disk_size_gb = 128
      os_disk_type    = "Ephemeral"
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.sandbox[0].mode == "User" &&
      azurerm_kubernetes_cluster_node_pool.sandbox[0].auto_scaling_enabled &&
      azurerm_kubernetes_cluster_node_pool.sandbox[0].min_count == 0 &&
      azurerm_kubernetes_cluster_node_pool.sandbox[0].max_count == 40 &&
      azurerm_kubernetes_cluster_node_pool.sandbox[0].max_pods == 110
    )
    error_message = "OpenSandbox compute must be an autoscaling AKS user pool with the reviewed bounds."
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster_node_pool.sandbox[0].node_labels["opengeni.ai/sandbox-pool"] == "opensandbox" &&
      length(azurerm_kubernetes_cluster_node_pool.sandbox[0].node_taints) == 1 &&
      azurerm_kubernetes_cluster_node_pool.sandbox[0].node_taints[0] == "opengeni.ai/sandbox=true:NoSchedule"
    )
    error_message = "OpenSandbox node labels and taints must match the pinned BatchSandbox template exactly."
  }
}

run "opensandbox_pool_rejects_invalid_bounds" {
  command = plan

  variables {
    sandbox_node_pool = {
      enabled   = true
      min_count = 6
      max_count = 5
    }
  }

  expect_failures = [
    var.sandbox_node_pool,
  ]
}

run "opensandbox_pool_rejects_system_name" {
  command = plan

  variables {
    sandbox_node_pool = {
      enabled = true
      name    = "system"
    }
  }

  expect_failures = [
    var.sandbox_node_pool,
  ]
}

run "direct_autoscaling_omits_node_count" {
  command = plan

  variables {
    aks = {
      node_count           = 3
      auto_scaling_enabled = true
      min_count            = 3
      max_count            = 3
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == true &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 3
    )
    error_message = "Autoscaled pools must omit node_count so provider state owns the live count."
  }
}

run "fixed_pool_can_enable_bounded_autoscaling_in_place" {
  command = plan
  providers = {
    azurerm = azurerm.fixed
  }

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 6
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 6
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        auto_scaling_enabled        = false
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  assert {
    condition = (
      local.aks_existing_node_count == 6 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].auto_scaling_enabled == true &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 6 &&
      local.aks_node_count_for_pool == null
    )
    error_message = "A fixed pool transition must bind live count six and configure only bounded autoscaling while omitting desired node_count."
  }
}

run "fixed_pool_transition_rejects_a_false_live_count" {
  command = plan
  providers = {
    azurerm = azurerm.fixed
  }

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 5
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 6
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        auto_scaling_enabled        = false
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "fixed_pool_transition_rejects_stale_autoscaling_state" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 4
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 4
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        auto_scaling_enabled        = false
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "bounds_rollout_preserves_existing_rotation_fields" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].vm_size == "Standard_D4ds_v4" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_pods == 30 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_size_gb == 128 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_type == "Managed" &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == null &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 3
    )
    error_message = "Phase 1 must change only autoscaling bounds while preserving live rotation-sensitive fields."
  }
}

run "imported_autoscaled_count_is_retained_when_bounds_change" {
  command   = apply
  state_key = "aks-count-transition"

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 4
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 4
      max_count                   = 8
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 4
    error_message = "The imported autoscaled pool must start with the provider-reported count of four."
  }
}

run "bounds_change_does_not_emit_node_count_update" {
  command   = plan
  state_key = "aks-count-transition"

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  assert {
    condition = (
      azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 4 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].min_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].max_count == 3 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].os_disk_size_gb == 128 &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == null
    )
    error_message = "Changing bounds from 4-8 to 3-3 must retain provider count four and emit no node_count update."
  }
}

run "rotation_is_allowed_after_count_refresh_and_quota_check" {
  command = plan
  providers = {
    azurerm = azurerm.converged
  }

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 3
        regional_vcpu_used     = 66
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = 4
      }
    }
  }

  assert {
    condition = (
      local.aks_existing_node_count == 3 &&
      local.aks_rotation_count_matches_live &&
      local.aks_rotation_quota_within_limit &&
      var.aks_rollout.rotation_preflight.observed_node_count == 3 &&
      var.aks_rollout.rotation_preflight.regional_vcpu_used +
      var.aks_rollout.rotation_preflight.observed_node_count * var.aks_rollout.rotation_preflight.rotation_vcpu_per_node <=
      var.aks_rollout.rotation_preflight.regional_vcpu_limit &&
      azurerm_kubernetes_cluster.this.default_node_pool[0].temporary_name_for_rotation == "systemtemp"
    )
    error_message = "Phase 2 must carry refreshed count three and a 78/80 vCPU peak before rotation."
  }
}

run "rotation_is_rejected_before_count_converges" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 4
        regional_vcpu_used     = 64
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = 4
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "rotation_rejects_false_count_three_attestation_against_live_count_four" {
  command   = plan
  state_key = "aks-count-transition"

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 3
        regional_vcpu_used     = 66
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = 4
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "rotation_is_rejected_when_quota_headroom_is_insufficient" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 3
        regional_vcpu_used     = 69
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = 4
      }
    }
  }

  expect_failures = [
    var.aks_rollout,
  ]
}

run "existing_pool_rejects_omitted_rollout_for_rotation_sensitive_changes" {
  command   = plan
  state_key = "aks-count-transition"

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "bounds_rollout_rejects_fixed_pool_configuration" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_D4ds_v4"
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "rotation_rejects_negative_vcpu_preflight" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 3
        regional_vcpu_used     = 66
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = -4
      }
    }
  }

  expect_failures = [
    var.aks_rollout,
  ]
}

run "invalid_direct_autoscaling_bounds_are_rejected" {
  command = plan

  variables {
    aks = {
      node_count           = 3
      auto_scaling_enabled = true
      min_count            = 4
      max_count            = 8
    }
  }

  expect_failures = [
    var.aks,
  ]
}

run "bounds_rollout_rejects_rotation_sensitive_changes" {
  command = plan

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "bounds_rejects_self_attested_existing_snapshot" {
  command   = plan
  state_key = "aks-count-transition"

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_E4as_v6"
        max_pods                    = 60
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = "systemtemp"
      }
    }
  }

  expect_failures = [
    azurerm_kubernetes_cluster.this,
  ]
}

run "post_convergence_refreshes_count_three_state" {
  command   = apply
  state_key = "aks-count-converged"
  providers = {
    azurerm = azurerm.converged
  }

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_D4ds_v4"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 30
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = null
    }

    aks_rollout = {
      phase = "bounds"
      expected_existing = {
        vm_size                     = "Standard_D4ds_v4"
        max_pods                    = 30
        os_disk_size_gb             = 128
        os_disk_type                = "Managed"
        temporary_name_for_rotation = null
      }
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 3
    error_message = "The refreshed provider state must report count three before phase 2."
  }
}

run "rotation_uses_refreshed_count_three_state" {
  command   = plan
  state_key = "aks-count-converged"
  providers = {
    azurerm = azurerm.converged
  }

  variables {
    aks_existing_pool = true
    aks = {
      node_count                  = 3
      vm_size                     = "Standard_E4as_v6"
      auto_scaling_enabled        = true
      min_count                   = 3
      max_count                   = 3
      max_pods                    = 60
      os_disk_size_gb             = 128
      os_disk_type                = "Managed"
      temporary_name_for_rotation = "systemtemp"
    }

    aks_rollout = {
      phase = "rotation"
      rotation_preflight = {
        observed_node_count    = 3
        regional_vcpu_used     = 66
        regional_vcpu_limit    = 80
        rotation_vcpu_per_node = 4
      }
    }
  }

  assert {
    condition     = azurerm_kubernetes_cluster.this.default_node_pool[0].node_count == 3
    error_message = "Phase 2 must refresh provider state to count three before rotation."
  }

  assert {
    condition = (
      local.aks_existing_node_count == 3 &&
      local.aks_rotation_count_matches_live
    )
    error_message = "Phase 2 must bind the rotation evidence to the refreshed live node-pool count."
  }
}
