variable "subscription_id" {
  description = "Azure subscription selected by the protected capacity workflow."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be the exact Azure subscription UUID."
  }
}

variable "environment" {
  description = "Existing OpenGeni AKS environment; production's system pool stays in its full Azure root."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "launch_vm_size" {
  description = "Explicitly authorized four-core, 16 GiB launch pool SKU. Live subscription availability is a protected workflow gate, not inferred from quota."
  type        = string
  default     = "Standard_D4ds_v5"

  validation {
    condition     = contains(["Standard_D4ds_v5", "Standard_D4as_v5"], var.launch_vm_size)
    error_message = "launch_vm_size must be an authorized compatible DDSv5 or DASv5 four-core SKU."
  }
}

variable "launch_min_count" {
  description = "Ready-node floor; three additive nodes plus four existing system nodes reserve warm launch capacity."
  type        = number
  default     = 3

  validation {
    condition     = var.launch_min_count == 3
    error_message = "The reviewed warm floor is three launch nodes per cluster."
  }
}

variable "launch_max_count" {
  description = "Joint-family quota budget permits up to six additive nodes per cluster, with independent upgrade and emergency reserves."
  type        = number
  default     = 6

  validation {
    condition     = var.launch_max_count == 6
    error_message = "The reviewed simultaneous ceiling is six launch nodes per cluster."
  }
}