variable "name_prefix" {
  description = "Lowercase deployment prefix; globally unique resource names also receive a generated suffix."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-16 lowercase letters, digits or hyphens, beginning with a letter and ending with a letter or digit."
  }
}

variable "resource_group_name" {
  description = "A NEW, exclusively deployment-owned resource group. Do not point this root at a shared resource group."
  type        = string
}

variable "location" {
  description = "Azure region supporting Container Apps workload profiles and PostgreSQL Flexible Server."
  type        = string
  default     = "northeurope"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Additional tags applied to created resources."
}

variable "deployment_phase" {
  description = "foundation creates substrate/secrets/optional ACR without image pulls or jobs; bootstrap also creates the manual migration job; apps additionally creates serving workloads."
  type        = string
  default     = "bootstrap"

  validation {
    condition     = contains(["foundation", "bootstrap", "apps"], var.deployment_phase)
    error_message = "deployment_phase must be foundation, bootstrap or apps."
  }
}

variable "images" {
  description = "Immutable images built from one compatible OpenGeni release. The migration job uses the API image."
  type = object({
    api               = string
    worker            = string
    web               = string
    outbox_dispatcher = optional(string)
  })

  validation {
    condition = alltrue([
      for image in [var.images.api, var.images.worker, var.images.web, var.images.outbox_dispatcher] :
      image == null ? true : can(regex("^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$", image))
    ])
    error_message = "Every supplied workload image must be an immutable lowercase registry/repository@sha256:<64 lowercase hex> reference without inline credentials."
  }
}

variable "migration_completed_revision" {
  description = "Operator attestation: the exact images.api reference whose manual migration/provision/posture/catalog job succeeded with every runtime process drained. Required for apps."
  type        = string
  default     = ""
}

variable "external_services" {
  description = "EXTERNAL Temporal and Core NATS. This root creates neither service nor their persistence. No inline credentials in these non-secret fields."
  type = object({
    temporal_host        = string
    temporal_namespace   = string
    temporal_tls_enabled = optional(bool, true)
    temporal_task_queue  = optional(string, "opengeni-runs-ts")
    nats_url             = string
  })

  validation {
    condition = (
      can(regex("^[A-Za-z0-9._-]+:[0-9]+$", var.external_services.temporal_host)) &&
      length(trimspace(var.external_services.temporal_namespace)) > 0 &&
      can(regex("^(nats|tls|ws|wss)://[A-Za-z0-9._-]+(:[0-9]+)?(/[^@]*)?$", var.external_services.nats_url))
    )
    error_message = "Supply a Temporal host:port and nonempty namespace, and a credential-free NATS URL. Put credential-bearing OPENGENI_NATS_URL in secret_env if required."
  }
}

variable "config_env" {
  description = "Non-secret OpenGeni overrides shared by API/control/turn, e.g. model endpoint/catalog or managed auth options. Safety and module-owned wiring cannot be overridden."
  type        = map(string)
  default     = {}

  validation {
    condition = (
      length(setintersection(toset(keys(var.config_env)), local.reserved_env_names)) == 0 &&
      alltrue([for name in keys(var.config_env) : can(regex("^(OPENGENI_|OTEL_|MIMALLOC_)[A-Z0-9_]+$", name)) && !can(regex("(PASSWORD|SECRET|API_KEY|ACCOUNT_KEY|TOKEN|CREDENTIALS)", name))])
    )
    error_message = "config_env accepts non-secret environment names only; module-owned safety, network, database, and role settings are reserved. Use secret_env for credentials."
  }
}

variable "secret_env" {
  description = "Application secrets delivered through the CREATED Key Vault. roles may include api/control/turn; default all three. Migration sees only the optional encryption key, never this whole map."
  type = map(object({
    value = string
    roles = optional(set(string), ["api", "control", "turn"])
  }))
  sensitive = true
  default   = {}

  validation {
    condition = (
      length(setintersection(nonsensitive(toset(keys(var.secret_env))), local.reserved_env_names)) == 0 &&
      alltrue([for name, secret in var.secret_env :
        can(regex("^[A-Z][A-Z0-9_]+$", name)) && length(trimspace(secret.value)) > 0 &&
        length(secret.roles) > 0 && length(setsubtract(secret.roles, toset(["api", "control", "turn"]))) == 0
      ])
    )
    error_message = "secret_env needs nonempty values and api/control/turn roles; module-owned database, storage, migration, role, and safety variables are forbidden."
  }
}

variable "access_mode" {
  description = "configured requires a shared deployment key; managed uses Better Auth and delegation. local is never a serving option."
  type        = string
  default     = "configured"

  validation {
    condition     = contains(["configured", "managed"], var.access_mode)
    error_message = "Only configured or managed access mode is supported for serving workloads."
  }
}

variable "sandbox_backend" {
  description = "Remote sandbox backend. Modal is the default. In-process/local/Docker/selfhosted need different host capabilities and are deliberately unsupported here."
  type        = string
  default     = "modal"

  validation {
    condition     = contains(["modal", "daytona", "runloop", "e2b", "blaxel", "cloudflare", "vercel", "opensandbox"], var.sandbox_backend)
    error_message = "Select a supported remote sandbox; none/local/docker/selfhosted are not production ACA defaults."
  }
}

variable "required_model_secret_env" {
  description = "Explicit credential names for the selected real model provider. Change together with config_env when using Azure OpenAI or a custom provider."
  type        = set(string)
  default     = ["OPENGENI_OPENAI_API_KEY"]

  validation {
    condition     = length(var.required_model_secret_env) > 0
    error_message = "At least one real model provider credential must be required; a credential-free smoke worker is not a serving deployment."
  }
}

variable "vnet_cidr" {
  description = "Dedicated IPv4 /16 VNet. ACA /23 and PostgreSQL /24 subnets are derived without overlap. External private endpoints need operator-owned routing/peering."
  type        = string
  default     = "10.72.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vnet_cidr)) && can(regex("/16$", var.vnet_cidr))
    error_message = "vnet_cidr must be a valid IPv4 /16."
  }
}

variable "postgres" {
  description = "Private PostgreSQL Flexible Server sizing/availability; the migration owner and app credentials are generated separately."
  type = object({
    version                      = optional(string, "16")
    sku_name                     = optional(string, "B_Standard_B2ms")
    storage_mb                   = optional(number, 32768)
    backup_retention_days        = optional(number, 7)
    geo_redundant_backup_enabled = optional(bool, false)
    zone                         = optional(string)
    high_availability_mode       = optional(string)
    standby_availability_zone    = optional(string)
  })
  default = {}
}

variable "previous_runtime_database_roles" {
  description = "All additional old/new runtime logins during a drained maintenance upgrade, for migration drain detection only; never granted app permissions by this root."
  type        = set(string)
  default     = []

  validation {
    condition     = length(var.previous_runtime_database_roles) <= 14 && alltrue([for role in var.previous_runtime_database_roles : can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", role))])
    error_message = "Supply at most 14 canonical PostgreSQL identifiers of at most 63 bytes."
  }
}

variable "log_analytics" {
  description = "Log retention and daily ingestion cap. The cap is not a hard spending ceiling and may stop ingestion."
  type = object({
    retention_in_days = optional(number, 30)
    daily_quota_gb    = optional(number, 1)
  })
  default = {}
}

variable "key_vault_purge_protection_enabled" {
  description = "Keep true for retained deployments. Disposable validation may set false; destroy still leaves a soft-deleted vault for explicit operator purge."
  type        = bool
  default     = true
}

variable "create_acr" {
  description = "Optional EMPTY deployment-owned ACR with admin login disabled and resource-scoped AcrPull identities. Import images separately; Terraform never builds/imports them."
  type        = bool
  default     = false
}

variable "outbox_dispatcher_enabled" {
  description = "Deploy the optional dedicated artifact live-hint outbox service, with its own EXECUTE-only database identity and no runtime secrets."
  type        = bool
  default     = false
}

variable "workloads" {
  description = "Per-role Consumption resources and scaling. Workers/outbox cannot scale to zero. Single revision mode is fixed; there is no claimed Temporal/KEDA queue autoscaling."
  type = map(object({
    cpu                              = number
    memory                           = string
    min_replicas                     = number
    max_replicas                     = number
    termination_grace_period_seconds = optional(number, 120)
  }))
  default = {
    api     = { cpu = 0.5, memory = "1Gi", min_replicas = 1, max_replicas = 2 }
    web     = { cpu = 0.25, memory = "0.5Gi", min_replicas = 1, max_replicas = 2, termination_grace_period_seconds = 30 }
    control = { cpu = 0.5, memory = "1Gi", min_replicas = 1, max_replicas = 1 }
    turn    = { cpu = 1, memory = "2Gi", min_replicas = 1, max_replicas = 1 }
    outbox  = { cpu = 0.25, memory = "0.5Gi", min_replicas = 1, max_replicas = 1, termination_grace_period_seconds = 60 }
  }

  validation {
    condition = (
      length(setsubtract(toset(["api", "web", "control", "turn", "outbox"]), toset(keys(var.workloads)))) == 0 &&
      alltrue([for role, workload in var.workloads :
        contains(["api", "web", "control", "turn", "outbox"], role) &&
        workload.min_replicas >= 1 && floor(workload.min_replicas) == workload.min_replicas &&
        workload.max_replicas >= workload.min_replicas && floor(workload.max_replicas) == workload.max_replicas &&
        contains([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], workload.cpu) &&
        workload.memory == "${workload.cpu * 2}Gi" &&
        workload.termination_grace_period_seconds >= (contains(["control", "turn"], role) ? 120 : 30) &&
        workload.termination_grace_period_seconds <= 600
      ])
    )
    error_message = "Define exactly api/web/control/turn/outbox with positive integer replica bounds, Consumption CPU:memory ratio 1:2 (0.25-2 CPU), and at least 120s worker / 30s other termination grace."
  }
}

variable "migration_timeout_seconds" {
  description = "Manual migration/provision/catalog job timeout; no automatic retries. Inspect failures before explicitly starting another execution."
  type        = number
  default     = 3600

  validation {
    condition     = var.migration_timeout_seconds >= 600 && var.migration_timeout_seconds <= 86400
    error_message = "Migration timeout must be between 600 and 86400 seconds."
  }
}