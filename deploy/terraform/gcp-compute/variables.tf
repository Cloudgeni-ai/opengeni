variable "project_id" {
  description = "GCP project the host fleet runs in."
  type        = string
}

variable "name_prefix" {
  description = "Prefix of every resource this root creates."
  type        = string
  default     = "opengeni-compute"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and hold 3-25 lowercase letters, digits or hyphens."
  }
}

variable "region" {
  description = "Region of the archive bucket and the hosts."
  type        = string
  default     = "europe-west4"
}

variable "zone" {
  description = "Zone of the hosts' managed instance group (the control service sizes and fences one zonal group)."
  type        = string
  default     = "europe-west4-a"
}

variable "labels" {
  description = "Labels added to every labelled resource."
  type        = map(string)
  default     = {}
}

variable "network" {
  description = "Existing VPC network and subnetwork the hosts join (self links or names)."
  type = object({
    network    = string
    subnetwork = string
  })
  default = {
    network    = "default"
    subnetwork = "default"
  }
}

variable "assign_external_ip" {
  description = "Give hosts ephemeral public addresses. Off in production: hosts reach the internet (registries, Firecracker downloads, sandboxes' traffic) through Cloud NAT instead."
  type        = bool
  default     = false
}

variable "machine_type" {
  description = "Host machine type. Nested virtualization needs an Intel family such as n2 or c3; bare-metal types (c3-*-metal) run the bare-metal memory profile."
  type        = string
  default     = "n2-standard-16"
}

variable "min_cpu_platform" {
  description = "Minimum CPU platform, for consistent snapshot CPU features across the group."
  type        = string
  default     = "Intel Cascade Lake"
}

variable "nested" {
  description = "Hosts are VMs with nested virtualization (memory profile nested, huge pages). False for bare-metal machine types."
  type        = bool
  default     = true
}

variable "huge_pages_percent" {
  description = "Share of a nested host's memory reserved as 2 MiB huge pages for guest memory; the rest is left to the agent, VMMs, pagers and the page cache."
  type        = number
  default     = 85

  validation {
    condition     = var.huge_pages_percent >= 10 && var.huge_pages_percent <= 92
    error_message = "huge_pages_percent must be between 10 and 92."
  }
}

variable "boot_image" {
  description = "Boot image of the hosts."
  type        = string
  default     = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
}

variable "boot_disk_gb" {
  description = "Boot disk size; Firecracker, the kernel, the agent's releases and logs live there."
  type        = number
  default     = 50
}

variable "state_disk" {
  description = "The state volume at /var/lib/compute: local NVMe SSDs (count of 375 GB disks, striped), or a persistent disk (type and size). Sandboxes' working copies live there; archives go to the bucket."
  type = object({
    local_ssd_count = optional(number, 0)
    pd_type         = optional(string, "pd-ssd")
    pd_size_gb      = optional(number, 500)
  })
  default = {}
}

variable "initial_hosts" {
  description = "Hosts the group starts with. Afterwards the control service sizes the group (Terraform ignores its target size)."
  type        = number
  default     = 3
}

variable "host_bundle" {
  description = "The host agent bundle (compute-host-<version>-x86_64-linux.tar.gz from a compute release) as a gs:// or https:// URL, and its SHA-256."
  type = object({
    url    = string
    sha256 = string
  })

  validation {
    condition     = can(regex("^(gs|https)://", var.host_bundle.url)) && can(regex("^[0-9a-f]{64}$", var.host_bundle.sha256))
    error_message = "host_bundle.url must be gs:// or https://, and host_bundle.sha256 a lowercase SHA-256."
  }
}

variable "base_image_ref" {
  description = "OCI image, by digest, each host builds its base image from (sandboxes that name no image)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.base_image_ref))
    error_message = "base_image_ref must name its image by digest."
  }
}

variable "control_url" {
  description = "The control service's host endpoint hosts dial, such as https://compute-control.example.com:8443: computeControl.hostUrl in the Helm chart, exactly. The service's certificate is for its host, and hosts' identity tokens are for it."
  type        = string
}

variable "previous_host_authority_pem" {
  description = "While the hosts' authority is replaced: the authority being retired (its certificate, PEM), which new hosts trust beside the current one. Empty otherwise. See operations.md, Keys and certificates."
  type        = string
  default     = ""
}

variable "control_source_ranges" {
  description = "Addresses the control service reaches hosts from (port 7443), such as the cluster's pod or node ranges."
  type        = list(string)
}

variable "control_target_tags" {
  description = "Network tags of the machines serving the control service's host endpoint, when it runs on GCE or GKE nodes in this network: hosts are let in to control_hosts_port there. Empty: no rule."
  type        = list(string)
  default     = []
}

variable "control_hosts_port" {
  description = "Port of the control service's host endpoint on control_target_tags machines (8443, or the NodePort)."
  type        = number
  default     = 8443
}

variable "ssh_source_ranges" {
  description = "Addresses allowed to SSH to hosts. Empty: no SSH rule."
  type        = list(string)
  default     = []
}

variable "host_args" {
  description = "Further compute-host serve flags, space separated, such as --otlp-endpoint http://collector:4318 --canary-every 10m."
  type        = string
  default     = ""
}

variable "archive_bucket" {
  description = "Name of the archive bucket to create (globally unique)."
  type        = string
}

variable "archive_prefix" {
  description = "Prefix of the fleet's objects in the bucket."
  type        = string
  default     = "archive"
}

variable "control_workload_identity" {
  description = "Kubernetes service account the control service runs as on GKE, bound to its Google service account through Workload Identity. Null when the service runs elsewhere (then run it as the control service account, for example as a VM's identity)."
  type = object({
    namespace       = string
    service_account = string
  })
  default = null
}

variable "for_tests" {
  description = "Let terraform destroy remove the bucket with its objects. Never in production."
  type        = bool
  default     = false
}
