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

variable "managed_aks_capacity" {
  description = "Optional non-secret capacity policy for the managed AKS system pool. Production automation can pin live node capacity without duplicating the rest of the environment configuration."
  type = object({
    node_count = number
  })
  default  = null
  nullable = true

  validation {
    condition = var.managed_aks_capacity == null ? true : (
      var.managed_aks_capacity.node_count >= 1 &&
      var.managed_aks_capacity.node_count <= 1000 &&
      floor(var.managed_aks_capacity.node_count) == var.managed_aks_capacity.node_count
    )
    error_message = "managed_aks_capacity.node_count must be a whole number between 1 and 1000."
  }
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

variable "create_aks_network_role_assignment" {
  description = "Whether Terraform should grant the AKS control-plane identity Network Contributor on the static AKS public IP. Required for Kubernetes load balancers to attach the configured outbound IP."
  type        = bool
  default     = true
}

variable "aks_admin_principal_ids" {
  description = "Azure AD principal IDs that Terraform should grant Azure Kubernetes Service Cluster Admin Role on the created AKS cluster. Use this for deployment automation identities that run kubectl/Helm through az aks get-credentials --admin."
  type        = set(string)
  default     = []
}

variable "dns_zone_contributor_assignments" {
  description = "Azure DNS zones where deployment automation principals should receive DNS Zone Contributor. Use this when workflows manage app host records as part of reproducible environment bootstrap."
  type = map(object({
    resource_group_name = string
    zone_name           = string
    principal_ids       = set(string)
  }))
  default = {}
}

variable "observability" {
  description = "Optional Azure Monitor resources for production availability probes, alerts, and workspace-backed Application Insights."
  type = object({
    enabled                         = optional(bool, false)
    log_analytics_workspace_name    = optional(string)
    application_insights_name       = optional(string)
    action_group_name               = optional(string)
    action_group_short_name         = optional(string, "opengenialrt")
    alert_email_receivers           = optional(map(string), {})
    availability_test_name          = optional(string)
    availability_test_url           = optional(string)
    availability_test_frequency     = optional(number, 300)
    availability_test_timeout       = optional(number, 30)
    availability_test_geo_locations = optional(list(string), ["emea-nl-ams-azr"])
    availability_alert_name         = optional(string)
    availability_alert_severity     = optional(number, 1)
    availability_failed_locations   = optional(number, 1)
  })
  default = {}

  validation {
    condition     = !try(var.observability.enabled, false) || try(length(var.observability.availability_test_url) > 0, false)
    error_message = "observability.availability_test_url is required when observability.enabled is true."
  }

  validation {
    condition     = !try(var.observability.enabled, false) || try(length(var.observability.alert_email_receivers) > 0, false)
    error_message = "observability.alert_email_receivers must include at least one receiver when observability.enabled is true."
  }
}

variable "postgres" {
  description = "Postgres mode. Use managed to create Azure Database for PostgreSQL Flexible Server or external to connect an existing compatible server."
  type = object({
    mode                   = string
    name                   = optional(string)
    location               = optional(string)
    zone                   = optional(string)
    existing_host          = optional(string)
    administrator_login    = optional(string, "opengeni")
    administrator_password = optional(string)
    sku_name               = optional(string, "B_Standard_B2s")
    storage_mb             = optional(number, 32768)
    version                = optional(string, "16")
    allow_azure_services   = optional(bool, false)
    firewall_rules = optional(map(object({
      start_ip_address = string
      end_ip_address   = string
    })), {})
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

variable "managed_postgres_capacity" {
  description = "Optional non-secret capacity policy for managed PostgreSQL. Keep this separate from the credential-bearing postgres object so production automation can pin compute and storage without duplicating secrets."
  type = object({
    sku_name          = string
    storage_mb        = number
    storage_tier      = string
    auto_grow_enabled = bool
  })
  default  = null
  nullable = true

  validation {
    condition = var.managed_postgres_capacity == null ? true : (
      can(regex("^(B|GP|MO)_Standard_", var.managed_postgres_capacity.sku_name)) &&
      contains([32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4193280, 4194304, 8388608, 16777216, 33553408], var.managed_postgres_capacity.storage_mb) &&
      contains(["P4", "P6", "P10", "P15", "P20", "P30", "P40", "P50", "P60", "P70", "P80"], var.managed_postgres_capacity.storage_tier)
    )
    error_message = "managed_postgres_capacity must use a valid Azure PostgreSQL SKU, supported storage size, and supported storage tier."
  }
}

variable "temporal" {
  description = "Temporal mode. Use external for an existing endpoint or officialChart for the stack-wrapper managed upstream Temporal chart."
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
    condition     = contains(["external", "officialChart"], var.temporal.mode)
    error_message = "temporal.mode must be external or officialChart."
  }

  validation {
    condition     = var.deployment_phase != "complete" || var.temporal.mode != "external" || try(length(var.temporal.existing_host) > 0, false)
    error_message = "temporal.existing_host is required when temporal.mode is external and deployment_phase is complete."
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
    cors_allowed_origins  = optional(list(string), [])
    cors_max_age_seconds  = optional(number, 3600)
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
