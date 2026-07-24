output "resource_group_name" {
  description = "Resource group used by the Azure reference deployment."
  value       = local.resource_group_name
}

output "aks_name" {
  description = "AKS cluster name."
  value       = azurerm_kubernetes_cluster.this.name
}

output "aks_oidc_issuer_url" {
  description = "AKS OIDC issuer URL for workload identity."
  value       = azurerm_kubernetes_cluster.this.oidc_issuer_url
}

output "acr_login_server" {
  description = "ACR login server for OpenGeni images."
  value       = azurerm_container_registry.this.login_server
}

output "acr_pull_role_assignment_enabled" {
  description = "Whether this Terraform run manages the AKS AcrPull role assignment."
  value       = var.create_acr_pull_role_assignment
}

output "aks_network_role_assignment_enabled" {
  description = "Whether this Terraform run manages the AKS Network Contributor role assignment on the static public IP."
  value       = var.create_aks_network_role_assignment
}

output "aks_admin_principal_ids" {
  description = "Azure AD principal IDs granted Azure Kubernetes Service Cluster Admin Role on the created AKS cluster."
  value       = sort(tolist(var.aks_admin_principal_ids))
}

output "dns_zone_contributor_assignments" {
  description = "Azure DNS zone contributor assignments managed for deployment automation."
  value = {
    for name, assignment in var.dns_zone_contributor_assignments : name => {
      resource_group_name = assignment.resource_group_name
      zone_name           = assignment.zone_name
      principal_ids       = sort(tolist(assignment.principal_ids))
    }
  }
}

output "aks_control_plane_principal_id" {
  description = "AKS control-plane identity principal id. Use this to grant public IP join permissions when Terraform cannot manage role assignments."
  value       = azurerm_kubernetes_cluster.this.identity[0].principal_id
}

output "aks_kubelet_object_id" {
  description = "AKS kubelet identity object id. Use this to grant AcrPull when Terraform cannot manage role assignments."
  value       = try(azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id, null)
}

output "aks_egress_public_ip" {
  description = "Static outbound public IP used by AKS and allowed through the managed Postgres firewall."
  value       = azurerm_public_ip.aks_egress.ip_address
}

output "key_vault_name" {
  description = "Key Vault name for runtime secret storage."
  value       = azurerm_key_vault.this.name
}

output "observability" {
  description = "Azure Monitor resources created when observability.enabled is true."
  value = {
    enabled                    = try(var.observability.enabled, false)
    log_analytics_workspace_id = try(azurerm_log_analytics_workspace.observability[0].id, null)
    application_insights_id    = try(azurerm_application_insights.observability[0].id, null)
    availability_web_test_id   = try(azurerm_application_insights_standard_web_test.availability[0].id, null)
    action_group_id            = try(azurerm_monitor_action_group.observability[0].id, null)
    availability_alert_id      = try(azurerm_monitor_metric_alert.availability[0].id, null)
  }
}

output "postgres_host" {
  description = "Postgres host to use for OPENGENI_DATABASE_URL."
  value       = var.postgres.mode == "managed" ? azurerm_postgresql_flexible_server.this[0].fqdn : var.postgres.existing_host
}

output "temporal_host" {
  description = "Temporal host to use for OPENGENI_TEMPORAL_HOST."
  value       = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : var.temporal.existing_host
}

output "temporal_namespace" {
  description = "Temporal namespace to use for OPENGENI_TEMPORAL_NAMESPACE."
  value       = var.temporal.namespace
}

output "temporal_task_queue" {
  description = "Temporal task queue to use for OPENGENI_TEMPORAL_TASK_QUEUE."
  value       = var.temporal.task_queue
}

output "object_storage_endpoint" {
  description = "Object storage endpoint for S3-compatible external storage or Azure Blob managed storage."
  value       = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? azurerm_storage_account.files[0].primary_blob_endpoint : var.object_storage.endpoint
}

output "object_storage_backend" {
  description = "Runtime object storage backend."
  value       = var.object_storage.api
}

output "object_storage_bucket" {
  description = "Runtime object storage bucket/container."
  value       = var.object_storage.bucket
}

output "object_storage_azure_account_name" {
  description = "Azure Storage account name when managed Azure Blob is enabled."
  value       = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? azurerm_storage_account.files[0].name : null
}

output "object_storage_azure_connection_string" {
  description = "Sensitive Azure Blob connection string for OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING when managed Azure Blob is enabled."
  value       = var.object_storage.mode == "managed" && var.object_storage.api == "azure-blob" ? azurerm_storage_account.files[0].primary_connection_string : null
  sensitive   = true
}

output "helm_set_values" {
  description = "Non-secret Helm values that connect OpenGeni workloads to this Azure substrate."
  value = {
    "global.imageRegistry"                       = azurerm_container_registry.this.login_server
    "config.OPENGENI_TEMPORAL_HOST"              = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : try(var.temporal.existing_host, null)
    "config.OPENGENI_TEMPORAL_NAMESPACE"         = var.temporal.namespace
    "config.OPENGENI_TEMPORAL_TASK_QUEUE"        = var.temporal.task_queue
    "config.OPENGENI_OBJECT_STORAGE_BACKEND"     = var.object_storage.api
    "config.OPENGENI_OBJECT_STORAGE_BUCKET"      = var.object_storage.bucket
    "config.OPENGENI_OBJECT_STORAGE_REGION"      = var.object_storage.api == "s3-compatible" ? var.object_storage.region : null
    "config.OPENGENI_OBJECT_STORAGE_S3_PROVIDER" = var.object_storage.api == "s3-compatible" ? var.object_storage.provider : null
  }
}
