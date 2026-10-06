locals {
  outbox_config_env = merge({
    OPENGENI_SERVICE_NAME                  = "opengeni-artifact-outbox"
    OPENGENI_ENVIRONMENT                   = "production"
    OPENGENI_DEPLOYMENT_REVISION           = local.image_revision
    OPENGENI_ARTIFACT_OUTBOX_ENABLED       = "true"
    OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE = local.outbox_database_role
    OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT     = "9466"
    OPENGENI_ARTIFACT_OUTBOX_DB_POOL_SIZE  = "4"
    OPENGENI_NATS_URL                      = var.external_services.nats_url
    OPENGENI_OBSERVABILITY_STRUCTURED_LOGS = "true"
    OPENGENI_OBSERVABILITY_METRICS_ENABLED = "true"
    }, contains(keys(var.config_env), "OPENGENI_SELFHOSTED_NATS_CONTROL_USER") ? {
    OPENGENI_SELFHOSTED_NATS_CONTROL_USER = var.config_env["OPENGENI_SELFHOSTED_NATS_CONTROL_USER"]
  } : {})
  outbox_secret_env = merge(
    { OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL = "outbox-db-url" },
    { for key in local.outbox_secret_keys : key => key if contains(nonsensitive(keys(var.secret_env)), key) }
  )
  service_definitions = merge({
    api = {
      name        = local.app_name
      image       = var.images.api
      port        = 8000
      readiness   = "/traffic-readyz"
      config_env  = local.application_config_env
      secret_env  = local.application_secret_env["api"]
      secret_keys = local.role_secret_keys["api"]
      ingress     = true
    }
    control = {
      name        = "${var.name_prefix}-control"
      image       = var.images.worker
      port        = 8001
      readiness   = "/readyz"
      config_env  = merge(local.application_config_env, { OPENGENI_WORKER_ROLE = "control" })
      secret_env  = local.application_secret_env["control"]
      secret_keys = local.role_secret_keys["control"]
      ingress     = false
    }
    turn = {
      name        = "${var.name_prefix}-turn"
      image       = var.images.worker
      port        = 8001
      readiness   = "/readyz"
      config_env  = merge(local.application_config_env, { OPENGENI_WORKER_ROLE = "turn" })
      secret_env  = local.application_secret_env["turn"]
      secret_keys = local.role_secret_keys["turn"]
      ingress     = false
    }
    }, var.outbox_dispatcher_enabled ? {
    outbox = {
      name        = "${var.name_prefix}-outbox"
      image       = coalesce(var.images.outbox_dispatcher, var.images.worker)
      port        = 9466
      readiness   = "/readyz"
      config_env  = local.outbox_config_env
      secret_env  = local.outbox_secret_env
      secret_keys = local.role_secret_keys["outbox"]
      ingress     = false
    }
  } : {})
}

# Separate replicas, images, Temporal queues, and identities. Workers have NO
# ingress block: their unauthenticated health/metrics listeners stay unrouted.
resource "azurerm_container_app" "service" {
  for_each                     = var.deployment_phase == "apps" ? local.service_definitions : {}
  name                         = each.value.name
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  max_inactive_revisions       = 1
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.workload[each.key].id]
  }

  dynamic "secret" {
    for_each = each.value.secret_keys
    content {
      name                = local.secret_names[secret.value]
      identity            = azurerm_user_assigned_identity.workload[each.key].id
      key_vault_secret_id = azurerm_key_vault_secret.this[secret.value].versionless_id
    }
  }

  dynamic "registry" {
    for_each = var.create_acr ? [azurerm_container_registry.this[0].login_server] : []
    content {
      server   = registry.value
      identity = azurerm_user_assigned_identity.workload[each.key].id
    }
  }

  dynamic "ingress" {
    for_each = each.value.ingress ? [true] : []
    content {
      external_enabled           = false
      allow_insecure_connections = false
      target_port                = each.value.port
      transport                  = "http"
      traffic_weight {
        latest_revision = true
        percentage      = 100
      }
    }
  }

  template {
    min_replicas                     = var.workloads[each.key].min_replicas
    max_replicas                     = var.workloads[each.key].max_replicas
    termination_grace_period_seconds = var.workloads[each.key].termination_grace_period_seconds
    cooldown_period_in_seconds       = 300
    polling_interval_in_seconds      = 30

    dynamic "http_scale_rule" {
      for_each = each.key == "api" ? [true] : []
      content {
        name                = "http-concurrency"
        concurrent_requests = "40"
      }
    }

    # CPU scaling is NOT Temporal backlog scaling. Fixed one-replica defaults
    # avoid unproven scaler credentials or JetStream assumptions about Core NATS.
    dynamic "custom_scale_rule" {
      for_each = each.key != "api" && var.workloads[each.key].max_replicas > var.workloads[each.key].min_replicas ? [true] : []
      content {
        name             = "cpu-utilization"
        custom_rule_type = "cpu"
        metadata         = { type = "Utilization", value = "70" }
      }
    }

    container {
      name   = each.key
      image  = each.value.image
      cpu    = var.workloads[each.key].cpu
      memory = var.workloads[each.key].memory

      dynamic "env" {
        for_each = { for name, value in each.value.config_env : name => value if !contains(keys(each.value.secret_env), name) }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = each.value.secret_env
        content {
          name        = env.key
          secret_name = local.secret_names[env.value]
        }
      }

      # Startup checks only that the process is up; dependency readiness has
      # its own endpoint and must not restart a healthy process during outages.
      startup_probe {
        transport               = "TCP"
        port                    = each.value.port
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 120
      }
      liveness_probe {
        transport               = "HTTP"
        port                    = each.value.port
        path                    = "/healthz"
        initial_delay           = 30
        interval_seconds        = 20
        timeout                 = 3
        failure_count_threshold = 3
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = each.value.port
        path                    = each.value.readiness
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  depends_on = [
    terraform_data.application_gate,
    azurerm_container_app_job.migration,
    azurerm_role_assignment.secret_reader,
    azurerm_role_assignment.acr_pull,
  ]
}