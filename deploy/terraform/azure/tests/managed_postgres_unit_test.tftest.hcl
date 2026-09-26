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
      id         = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Network/publicIPAddresses/opengeni-test-aks-egress-ip"
      ip_address = "203.0.113.10"
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

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.DBforPostgreSQL/flexibleServers/opengeni-test-postgres"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.OperationalInsights/workspaces/opengeni-test-logs"
    }
  }

  mock_resource "azurerm_application_insights" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/components/opengeni-test-appinsights"
    }
  }

  mock_resource "azurerm_application_insights_standard_web_test" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/webTests/opengeni-test-healthz"
    }
  }

  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/actionGroups/opengeni-test-alerts"
    }
  }
}

variables {
  create_acr_pull_role_assignment = false
  deployment_phase                = "bootstrap"
  name_prefix                     = "opengeni-test"
  resource_group_name             = "rg-opengeni-test"
  postgres = {
    mode = "managed"
  }
  managed_postgres_capacity = {
    sku_name          = "GP_Standard_D4ds_v5"
    storage_mb        = 131072
    storage_tier      = "P10"
    auto_grow_enabled = true
  }
}

run "managed_postgres_defaults_leave_availability_and_parameters_unmanaged" {
  command = plan

  assert {
    condition = (
      length(azurerm_postgresql_flexible_server.this[0].high_availability) == 0 &&
      length(azurerm_postgresql_flexible_server.this[0].maintenance_window) == 0
    )
    error_message = "Without an availability policy, managed PostgreSQL must keep HA disabled and the Azure-chosen maintenance window."
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.this[0].timeouts == null
    error_message = "Without an update_timeout, the server must keep the provider's default timeouts."
  }

  assert {
    condition     = length(azurerm_postgresql_flexible_server_configuration.max_connections) == 0
    error_message = "max_connections must stay unmanaged unless explicitly pinned, because adopting it restarts the server."
  }

  assert {
    condition = (
      length(azurerm_monitor_metric_alert.postgres_cpu) == 0 &&
      length(azurerm_monitor_metric_alert.postgres_connections) == 0
    )
    error_message = "PostgreSQL saturation alerts must be opt-in."
  }
}

run "availability_policy_renders_zone_redundant_ha_and_utc_maintenance_window" {
  command = plan

  variables {
    managed_postgres_capacity = {
      sku_name          = "GP_Standard_D8ds_v5"
      storage_mb        = 131072
      storage_tier      = "P10"
      auto_grow_enabled = true
    }
    managed_postgres_availability = {
      high_availability = {
        mode = "ZoneRedundant"
      }
      maintenance_window = {
        day_of_week = 3
        start_hour  = 2
      }
      update_timeout = "120m"
    }
  }

  assert {
    condition     = azurerm_postgresql_flexible_server.this[0].timeouts.update == "120m"
    error_message = "update_timeout must raise the server's Terraform update timeout so HA seeding can finish."
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server.this[0].sku_name == "GP_Standard_D8ds_v5" &&
      azurerm_postgresql_flexible_server.this[0].high_availability[0].mode == "ZoneRedundant"
    )
    error_message = "The availability policy must render a zone-redundant standby on the pinned SKU."
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server.this[0].maintenance_window[0].day_of_week == 3 &&
      azurerm_postgresql_flexible_server.this[0].maintenance_window[0].start_hour == 2 &&
      azurerm_postgresql_flexible_server.this[0].maintenance_window[0].start_minute == 0
    )
    error_message = "The custom maintenance window must be Wednesday 02:00 UTC with start_minute defaulting to 0."
  }
}

run "availability_policy_can_set_only_a_maintenance_window" {
  command = plan

  variables {
    managed_postgres_availability = {
      maintenance_window = {
        day_of_week  = 3
        start_hour   = 2
        start_minute = 30
      }
    }
  }

  assert {
    condition = (
      length(azurerm_postgresql_flexible_server.this[0].high_availability) == 0 &&
      azurerm_postgresql_flexible_server.this[0].maintenance_window[0].start_minute == 30
    )
    error_message = "A maintenance window alone must not enable high availability."
  }
}

run "availability_policy_rejects_unknown_ha_mode" {
  command = plan

  variables {
    managed_postgres_availability = {
      high_availability = {
        mode = "Enabled"
      }
    }
  }

  expect_failures = [
    var.managed_postgres_availability,
  ]
}

run "availability_policy_rejects_invalid_standby_zone" {
  command = plan

  variables {
    managed_postgres_availability = {
      high_availability = {
        mode                      = "ZoneRedundant"
        standby_availability_zone = "4"
      }
    }
  }

  expect_failures = [
    var.managed_postgres_availability,
  ]
}

run "availability_policy_rejects_invalid_update_timeout" {
  command = plan

  variables {
    managed_postgres_availability = {
      update_timeout = "1.5h"
    }
  }

  expect_failures = [
    var.managed_postgres_availability,
  ]
}

run "availability_policy_rejects_invalid_maintenance_day" {
  command = plan

  variables {
    managed_postgres_availability = {
      maintenance_window = {
        day_of_week = 7
        start_hour  = 2
      }
    }
  }

  expect_failures = [
    var.managed_postgres_availability,
  ]
}

run "pinned_max_connections_is_managed_as_a_server_parameter" {
  command = plan

  variables {
    managed_postgres_capacity = {
      sku_name          = "GP_Standard_D8ds_v5"
      storage_mb        = 131072
      storage_tier      = "P10"
      auto_grow_enabled = true
      max_connections   = 3437
    }
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server_configuration.max_connections[0].name == "max_connections" &&
      azurerm_postgresql_flexible_server_configuration.max_connections[0].value == "3437"
    )
    error_message = "A pinned max_connections must render the exact static server parameter."
  }
}

run "capacity_rejects_out_of_range_max_connections" {
  command = plan

  variables {
    managed_postgres_capacity = {
      sku_name          = "GP_Standard_D8ds_v5"
      storage_mb        = 131072
      storage_tier      = "P10"
      auto_grow_enabled = true
      max_connections   = 6000
    }
  }

  expect_failures = [
    var.managed_postgres_capacity,
  ]
}

run "saturation_alerts_use_observability_action_group_and_percent_of_max_connections" {
  # Mocked apply makes the server and action group IDs known for the routing assertion.
  command = apply

  variables {
    observability = {
      enabled               = true
      availability_test_url = "https://opengeni.example.test/healthz"
      alert_email_receivers = {
        oncall = "oncall@example.test"
      }
    }
    managed_postgres_alerts = {
      max_connections = 429
    }
  }

  assert {
    condition = (
      azurerm_monitor_metric_alert.postgres_cpu[0].criteria[0].metric_name == "cpu_percent" &&
      azurerm_monitor_metric_alert.postgres_cpu[0].criteria[0].aggregation == "Average" &&
      azurerm_monitor_metric_alert.postgres_cpu[0].criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_metric_alert.postgres_cpu[0].criteria[0].threshold == 80
    )
    error_message = "The CPU alert must fire above 80% average CPU."
  }

  assert {
    condition = (
      azurerm_monitor_metric_alert.postgres_connections[0].criteria[0].metric_name == "active_connections" &&
      azurerm_monitor_metric_alert.postgres_connections[0].criteria[0].aggregation == "Maximum" &&
      azurerm_monitor_metric_alert.postgres_connections[0].criteria[0].threshold == 343
    )
    error_message = "The connection alert must fire above floor(80% of 429) = 343 active connections."
  }

  assert {
    condition = (
      azurerm_monitor_metric_alert.postgres_cpu[0].scopes == toset(["/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.DBforPostgreSQL/flexibleServers/opengeni-test-postgres"]) &&
      [for action in azurerm_monitor_metric_alert.postgres_connections[0].action : action.action_group_id] == ["/subscriptions/test/resourceGroups/rg-opengeni-test/providers/Microsoft.Insights/actionGroups/opengeni-test-alerts"]
    )
    error_message = "PostgreSQL alerts must scope the managed server and route to the observability action group."
  }
}

run "saturation_alerts_default_to_pinned_max_connections" {
  command = plan

  variables {
    observability = {
      enabled               = true
      availability_test_url = "https://opengeni.example.test/healthz"
      alert_email_receivers = {
        oncall = "oncall@example.test"
      }
    }
    managed_postgres_capacity = {
      sku_name          = "GP_Standard_D8ds_v5"
      storage_mb        = 131072
      storage_tier      = "P10"
      auto_grow_enabled = true
      max_connections   = 3437
    }
    managed_postgres_alerts = {}
  }

  assert {
    condition     = azurerm_monitor_metric_alert.postgres_connections[0].criteria[0].threshold == 2749
    error_message = "Without an explicit alert max_connections, the pinned server parameter drives the threshold."
  }
}

run "saturation_alerts_require_observability" {
  command = plan

  variables {
    managed_postgres_alerts = {
      max_connections = 429
    }
  }

  expect_failures = [
    var.managed_postgres_alerts,
  ]
}

run "saturation_alerts_require_a_connection_limit" {
  command = plan

  variables {
    observability = {
      enabled               = true
      availability_test_url = "https://opengeni.example.test/healthz"
      alert_email_receivers = {
        oncall = "oncall@example.test"
      }
    }
    managed_postgres_alerts = {}
  }

  expect_failures = [
    var.managed_postgres_alerts,
  ]
}
