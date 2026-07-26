variable "name_prefix" {
  description = "Prefix used for AWS resources created by this root."
  type        = string
  default     = "opengeni"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and contain 3-31 lowercase letters, numbers, or hyphens."
  }
}

variable "region" {
  description = "AWS region for the reference deployment."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Additional tags applied to created AWS resources."
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
  description = "VPC settings. Use create_vpc=false with existing private subnets for production networks."
  type = object({
    create_vpc = optional(bool, true)
    vpc_id     = optional(string)
    cidr_block = optional(string, "10.42.0.0/16")
    availability_zones = optional(list(string), [
      "us-east-1a",
      "us-east-1b",
    ])
    public_subnet_cidrs = optional(list(string), [
      "10.42.0.0/20",
      "10.42.16.0/20",
    ])
    subnet_ids = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = !var.network.create_vpc || length(var.network.availability_zones) >= length(var.network.public_subnet_cidrs)
    error_message = "network.availability_zones must include at least one entry per public subnet CIDR when create_vpc=true."
  }
}

variable "eks" {
  description = "EKS cluster and node group settings."
  type = object({
    kubernetes_version     = optional(string, "1.31")
    endpoint_public_access = optional(bool, true)
    node_instance_types = optional(list(string), [
      "m6i.large",
    ])
    node_desired_size = optional(number, 2)
    node_min_size     = optional(number, 1)
    node_max_size     = optional(number, 4)
  })
  default = {}
}

variable "ecr_force_delete" {
  description = "Whether to allow Terraform destroy to delete non-empty ECR repositories. Use true for short-lived evaluation environments."
  type        = bool
  default     = false
}

variable "kubernetes_workload_identity" {
  description = "Kubernetes service account allowed to assume the AWS runtime IAM role through IRSA."
  type = object({
    namespace       = optional(string, "opengeni")
    service_account = optional(string, "opengeni")
  })
  default = {}
}

variable "postgres" {
  description = "Postgres mode. Use managed for RDS PostgreSQL or external to connect an existing compatible server."
  type = object({
    mode                   = string
    existing_host          = optional(string)
    engine_version         = optional(string, "16.3")
    instance_class         = optional(string, "db.t4g.medium")
    allocated_storage      = optional(number, 32)
    administrator_login    = optional(string, "opengeni")
    administrator_password = optional(string)
    deletion_protection    = optional(bool, true)
    skip_final_snapshot    = optional(bool, false)
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
  description = "S3 object storage settings. Managed mode creates a bucket with a generated name; bucket is used only for external mode."
  type = object({
    mode                       = string
    bucket                     = optional(string, "opengeni-files")
    force_destroy              = optional(bool, false)
    versioning_enabled         = optional(bool, true)
    noncurrent_expiration_days = optional(number, 30)
    cors_allowed_origins       = optional(list(string), [])
    cors_max_age_seconds       = optional(number, 3600)
  })
  default = {
    mode = "managed"
  }

  validation {
    condition     = contains(["managed", "external"], var.object_storage.mode)
    error_message = "object_storage.mode must be managed or external."
  }
}
