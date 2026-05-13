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

output "aks_kubelet_object_id" {
  description = "AKS kubelet identity object id. Use this to grant AcrPull when Terraform cannot manage role assignments."
  value       = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}

output "key_vault_name" {
  description = "Key Vault name for runtime secret storage."
  value       = azurerm_key_vault.this.name
}

output "postgres_host" {
  description = "Postgres host to use for OPENGENI_DATABASE_URL."
  value       = var.postgres.mode == "managed" ? azurerm_postgresql_flexible_server.this[0].fqdn : var.postgres.existing_host
}

output "temporal_host" {
  description = "Temporal host to use for OPENGENI_TEMPORAL_HOST."
  value       = var.temporal.existing_host
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
    "config.OPENGENI_TEMPORAL_HOST"              = try(var.temporal.existing_host, null)
    "config.OPENGENI_TEMPORAL_NAMESPACE"         = var.temporal.namespace
    "config.OPENGENI_TEMPORAL_TASK_QUEUE"        = var.temporal.task_queue
    "config.OPENGENI_OBJECT_STORAGE_BACKEND"     = var.object_storage.api
    "config.OPENGENI_OBJECT_STORAGE_BUCKET"      = var.object_storage.bucket
    "config.OPENGENI_OBJECT_STORAGE_REGION"      = var.object_storage.api == "s3-compatible" ? var.object_storage.region : null
    "config.OPENGENI_OBJECT_STORAGE_S3_PROVIDER" = var.object_storage.api == "s3-compatible" ? var.object_storage.provider : null
  }
}
