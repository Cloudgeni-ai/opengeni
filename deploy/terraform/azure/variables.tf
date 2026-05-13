variable "name_prefix" {
  description = "Prefix used for Azure resources created by this module."
  type        = string
  default     = "opengeni"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and contain 3-31 lowercase letters, numbers, or hyphens."
  }
}

variable "location" {
  description = "Azure region for resources created by this module."
  type        = string
  default     = "westeurope"
}

variable "create_resource_group" {
  description = "Whether to create the resource group."
  type        = bool
  default     = true
}

variable "resource_group_name" {
  description = "Resource group name to create or use."
  type        = string
  default     = "rg-opengeni"
}

variable "tags" {
  description = "Additional tags applied to created Azure resources."
  type        = map(string)
  default     = {}
}

variable "deployment_phase" {
  description = "bootstrap creates Azure substrate that does not need runtime endpoints yet. complete requires all runtime dependency endpoints."
  type        = string
  default     = "complete"

  validation {
    condition     = contains(["bootstrap", "complete"], var.deployment_phase)
    error_message = "deployment_phase must be bootstrap or complete."
  }
}

variable "aks" {
  description = "AKS cluster settings."
  type = object({
    kubernetes_version                            = optional(string)
    node_count                                    = optional(number, 2)
    vm_size                                       = optional(string, "Standard_D4ds_v5")
    dns_prefix                                    = optional(string)
    node_pool_upgrade_max_surge                   = optional(string, "10%")
    node_pool_upgrade_drain_timeout_minutes       = optional(number, 0)
    node_pool_upgrade_node_soak_minutes           = optional(number, 0)
    microsoft_defender_log_analytics_workspace_id = optional(string)
  })
  default = {}
}

variable "key_vault" {
  description = "Key Vault settings."
  type = object({
    purge_protection_enabled = optional(bool, true)
  })
  default = {}
}

variable "create_acr_pull_role_assignment" {
  description = "Whether Terraform should grant AKS kubelet identity AcrPull on the created ACR. Disable when the current Azure identity cannot write role assignments."
  type        = bool
  default     = true
}

variable "postgres" {
  description = "Postgres mode. Use managed to create Azure Database for PostgreSQL Flexible Server or external to connect an existing compatible server."
  type = object({
    mode                   = string
    existing_host          = optional(string)
    administrator_login    = optional(string, "opengeni")
    administrator_password = optional(string)
    sku_name               = optional(string, "B_Standard_B2s")
    storage_mb             = optional(number, 32768)
    version                = optional(string, "16")
  })
  default = {
    mode = "external"
  }

  validation {
    condition     = contains(["managed", "external"], var.postgres.mode)
    error_message = "postgres.mode must be managed or external."
  }

  validation {
    condition     = var.deployment_phase != "complete" || var.postgres.mode != "external" || try(length(var.postgres.existing_host) > 0, false)
    error_message = "postgres.existing_host is required when postgres.mode is external and deployment_phase is complete."
  }

  validation {
    condition     = var.deployment_phase != "complete" || var.postgres.mode != "managed" || try(length(var.postgres.administrator_password) >= 16, false)
    error_message = "postgres.administrator_password with at least 16 characters is required when postgres.mode is managed and deployment_phase is complete."
  }
}

variable "temporal" {
  description = "Temporal mode. This module currently connects to an existing Temporal endpoint; self-hosted Temporal belongs in the Helm/platform layer."
  type = object({
    mode          = string
    existing_host = optional(string)
    namespace     = optional(string, "default")
    task_queue    = optional(string, "opengeni-runs-ts")
  })
  default = {
    mode = "external"
  }

  validation {
    condition     = contains(["external"], var.temporal.mode)
    error_message = "temporal.mode currently supports external only in the Azure Terraform substrate."
  }

  validation {
    condition     = var.deployment_phase != "complete" || try(length(var.temporal.existing_host) > 0, false)
    error_message = "temporal.existing_host is required when deployment_phase is complete."
  }
}

variable "object_storage" {
  description = "Object storage mode. Use managed azure-blob for Azure Blob or external for customer-provided Azure Blob/S3-compatible storage."
  type = object({
    mode                  = string
    api                   = optional(string, "azure-blob")
    endpoint              = optional(string)
    bucket                = optional(string, "opengeni-files")
    region                = optional(string, "us-east-1")
    provider              = optional(string, "S3Compatible")
    account_name          = optional(string)
    account_tier          = optional(string, "Standard")
    replication_type      = optional(string, "LRS")
    versioning_enabled    = optional(bool, true)
    delete_retention_days = optional(number, 7)
  })
  default = {
    mode = "managed"
    api  = "azure-blob"
  }

  validation {
    condition     = contains(["managed", "external"], var.object_storage.mode)
    error_message = "object_storage.mode must be managed or external."
  }

  validation {
    condition     = contains(["azure-blob", "s3-compatible"], var.object_storage.api)
    error_message = "object_storage.api must be azure-blob or s3-compatible."
  }

  validation {
    condition     = var.object_storage.mode != "managed" || var.object_storage.api == "azure-blob"
    error_message = "managed object storage currently supports azure-blob."
  }

  validation {
    condition     = var.deployment_phase != "complete" || var.object_storage.mode != "external" || var.object_storage.api != "s3-compatible" || try(length(var.object_storage.endpoint) > 0, false)
    error_message = "object_storage.endpoint is required when using external S3-compatible storage and deployment_phase is complete."
  }
}
