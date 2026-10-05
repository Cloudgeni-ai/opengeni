locals {
  # The official web image compiles VITE_API_BASE_URL="". Native environment
  # routing gives the browser one origin without a proxy container or rebuilt
  # bundle. Exact paths and slash-boundary prefixes preserve OAuth discovery
  # behavior; there is deliberately no rewrite of /v1 or /.well-known paths.
  api_edge_routes = concat([
    for prefix in ["/v1", "/agent", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"] : {
      match = { pathSeparatedPrefix = prefix, caseSensitive = true }
    }
    ], [for path in [
      "/healthz", "/install.sh", "/install.ps1", "/uninstall.sh", "/opengeni-agent-minisign.pub",
      "/oauth/register", "/oauth/authorize", "/oauth/token"
    ] : { match = { path = path, caseSensitive = true } }
  ])
  edge_rules = [
    {
      description = "OpenGeni API, MCP, OAuth discovery, and public installation assets"
      routes      = local.api_edge_routes
      targets     = [{ containerApp = local.app_name }]
    },
    {
      description = "Same-origin OpenGeni browser console"
      routes      = [{ match = { prefix = "/", caseSensitive = true } }]
      targets     = [{ containerApp = local.web_name }]
    }
  ]
}

resource "azurerm_container_app" "web" {
  count                        = var.deployment_phase == "apps" ? 1 : 0
  name                         = local.web_name
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 1
  tags                         = local.tags

  # No Key Vault or database secret grants are assigned to the browser shell.
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.workload["web"].id]
  }

  dynamic "registry" {
    for_each = var.create_acr ? [azurerm_container_registry.this[0].login_server] : []
    content {
      server   = registry.value
      identity = azurerm_user_assigned_identity.workload["web"].id
    }
  }

  ingress {
    external_enabled           = false
    allow_insecure_connections = false
    target_port                = 3000
    transport                  = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas                     = var.workloads["web"].min_replicas
    max_replicas                     = var.workloads["web"].max_replicas
    termination_grace_period_seconds = var.workloads["web"].termination_grace_period_seconds
    cooldown_period_in_seconds       = 300
    polling_interval_in_seconds      = 30
    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "40"
    }
    container {
      name   = "web"
      image  = var.images.web
      cpu    = var.workloads["web"].cpu
      memory = var.workloads["web"].memory

      env {
        name  = "PORT"
        value = "3000"
      }
      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "OPENGENI_WEB_BASE_URL"
        value = local.web_url
      }
      env {
        name  = "OPENGENI_WEB_ALLOWED_HOSTS"
        value = join(",", [local.edge_fqdn, local.web_internal_fqdn])
      }
      startup_probe {
        transport               = "TCP"
        port                    = 3000
        interval_seconds        = 5
        failure_count_threshold = 60
      }
      liveness_probe {
        transport        = "HTTP"
        port             = 3000
        path             = "/"
        interval_seconds = 20
        timeout          = 3
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/"
        interval_seconds        = 10
        timeout                 = 3
        success_count_threshold = 1
      }
    }
  }

  depends_on = [terraform_data.application_gate, azurerm_container_app_job.migration, azurerm_role_assignment.acr_pull]
}

resource "azapi_resource" "edge" {
  count     = var.deployment_phase == "apps" ? 1 : 0
  type      = "Microsoft.App/managedEnvironments/httpRouteConfigs@2024-10-02-preview"
  name      = local.edge_name
  parent_id = azurerm_container_app_environment.this.id
  location  = var.location

  # AzureRM has no resource for this native environment route. The pinned
  # preview type is not present in every provider schema/RP advertisement;
  # ARM availability must be live-verified in the operator's region. Only this
  # resource skips AzAPI's embedded-schema check, never runtime auth gates.
  schema_validation_enabled = false
  body                      = { properties = { rules = local.edge_rules } }
  response_export_values    = ["properties.fqdn", "properties.provisioningState"]

  depends_on = [azurerm_container_app.service, azurerm_container_app.web]
}