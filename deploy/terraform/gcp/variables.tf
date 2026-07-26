variable "project_id" {
  description = "GCP project id for the reference deployment."
  type        = string
}

variable "name_prefix" {
  description = "Prefix used for GCP resources created by this root."
  type        = string
  default     = "opengeni"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and contain 3-31 lowercase letters, numbers, or hyphens."
  }
}

variable "region" {
  description = "GCP region for regional resources."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for zonal resources."
  type        = string
  default     = "us-central1-a"
}

variable "labels" {
  description = "Additional labels applied to created GCP resources."
  type        = map(string)
  default     = {}
}

variable "deployment_phase" {
  description = "bootstrap creates substrate without requiring runtime endpoints. complete requires external endpoints when selected."
  type        = string
  default     = "complete"

  validation {
    condition     = contains(["bootstrap", "complete"], var.deployment_phase)
    error_message = "deployment_phase must be bootstrap or complete."
  }
}

variable "network" {
  description = "VPC settings. Use create_network=false with existing subnet for production networks."
  type = object({
    create_network = optional(bool, true)
    network_name   = optional(string)
    subnet_name    = optional(string)
    subnet_cidr    = optional(string, "10.52.0.0/20")
  })
  default = {}
}

variable "gke" {
  description = "GKE cluster and node pool settings."
  type = object({
    release_channel      = optional(string, "REGULAR")
    deletion_protection  = optional(bool, true)
    machine_type         = optional(string, "e2-standard-4")
    disk_size_gb         = optional(number, 100)
    node_count           = optional(number, 2)
    min_node_count       = optional(number, 1)
    max_node_count       = optional(number, 4)
    node_locations       = optional(list(string))
    enable_private_nodes = optional(bool, false)
  })
  default = {}
}

variable "artifact_registry_writer_members" {
  description = "IAM members allowed to push OpenGeni workload images to the Artifact Registry repository."
  type        = list(string)
  default     = []
}

variable "gke_admin_members" {
  description = "IAM members allowed to administer the GKE cluster through Kubernetes API."
  type        = list(string)
  default     = []
}

variable "kubernetes_workload_identity" {
  description = "Kubernetes identity allowed to impersonate the GCP runtime service account."
  type = object({
    namespace       = optional(string, "opengeni")
    service_account = optional(string, "opengeni")
  })
  default = {}
}

variable "postgres" {
  description = "Postgres mode. Use managed for Cloud SQL PostgreSQL or external to connect an existing compatible server."
  type = object({
    mode                   = string
    existing_host          = optional(string)
    database_version       = optional(string, "POSTGRES_16")
    edition                = optional(string, "ENTERPRISE")
    tier                   = optional(string, "db-custom-2-8192")
    availability_type      = optional(string, "REGIONAL")
    disk_size_gb           = optional(number, 32)
    administrator_login    = optional(string, "opengeni")
    administrator_password = optional(string)
    deletion_protection    = optional(bool, true)
    private_ip_enabled     = optional(bool, true)
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

  validation {
    condition     = var.postgres.mode != "managed" || contains(["ENTERPRISE", "ENTERPRISE_PLUS"], try(var.postgres.edition, "ENTERPRISE"))
    error_message = "postgres.edition must be ENTERPRISE or ENTERPRISE_PLUS when postgres.mode is managed."
  }

  validation {
    condition     = var.postgres.mode != "managed" || contains(["ZONAL", "REGIONAL"], try(var.postgres.availability_type, "REGIONAL"))
    error_message = "postgres.availability_type must be ZONAL or REGIONAL when postgres.mode is managed."
  }

  validation {
    condition     = var.postgres.mode != "managed" || !try(var.postgres.private_ip_enabled, true) || var.network.create_network
    error_message = "postgres.private_ip_enabled currently requires network.create_network=true so Terraform can create private service networking."
  }
}

variable "temporal" {
  description = "Temporal endpoint settings. Use external for an existing endpoint or officialChart for the stack-wrapper managed upstream Temporal chart."
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
  description = "GCS object storage settings. Managed mode creates a bucket from project_id and name_prefix; bucket is used only for external mode."
  type = object({
    mode                        = string
    bucket                      = optional(string, "opengeni-files")
    location                    = optional(string)
    force_destroy               = optional(bool, false)
    versioning_enabled          = optional(bool, true)
    uniform_bucket_level_access = optional(bool, true)
    cors_allowed_origins        = optional(list(string), [])
    cors_max_age_seconds        = optional(number, 3600)
  })
  default = {
    mode = "managed"
  }

  validation {
    condition     = contains(["managed", "external"], var.object_storage.mode)
    error_message = "object_storage.mode must be managed or external."
  }
}
