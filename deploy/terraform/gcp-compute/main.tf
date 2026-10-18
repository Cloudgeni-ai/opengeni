# A GCP host fleet for Opengeni compute: the hosts' managed instance group
# (nested virtualization or bare metal), the archive bucket, the authority
# that issues host and fleet-service certificates, two service accounts
# with only what each needs, and the firewall rules between hosts and the
# fleet service. The fleet service itself (compute-control) runs elsewhere,
# for example in the Opengeni Helm chart (computeControl); see
# compute/docs/operations.md.

locals {
  labels = merge(var.labels, {
    project    = "opengeni"
    component  = "compute"
    managed_by = "terraform"
  })
  hosts_tag = "${var.name_prefix}-host"
  store     = "gs://${google_storage_bucket.archive.name}/${var.archive_prefix}"
  group     = "projects/${var.project_id}/zones/${var.zone}/instanceGroupManagers/${var.name_prefix}-hosts"
  # The memory a new host offers sandboxes, which the fleet service grows
  # the group by: on a nested host its huge pages, a share of the kernel's
  # MemTotal (host-startup.sh), here estimated as 95 % of the machine
  # type's memory so the estimate errs low; on bare metal 85 % of it.
  host_memory_mib = floor(one(data.google_compute_machine_types.host.machine_types).memory_mb * 95 / 100 * (var.nested ? var.huge_pages_percent : 85) / 100 / 2) * 2
}

data "google_compute_machine_types" "host" {
  project = var.project_id
  zone    = var.zone
  filter  = "name = \"${var.machine_type}\""
}

resource "google_project_service" "apis" {
  for_each           = toset(["compute.googleapis.com", "storage.googleapis.com", "privateca.googleapis.com", "iam.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Identities -------------------------------------------------------------

resource "google_service_account" "host" {
  account_id   = "${var.name_prefix}-host"
  display_name = "Opengeni compute host"
  description  = "Compute hosts: the archive bucket's objects and their own certificates, nothing else."
}

resource "google_service_account" "control" {
  account_id   = "${var.name_prefix}-control"
  display_name = "Opengeni compute fleet service"
  description  = "The fleet service: reads and sweeps the archive bucket, sizes and fences the host group."
}

# What the fleet service does to the group (crates/compute-control/src/group.rs),
# with its identity's token from the metadata server: read and resize the
# group, list its instances, and read, reset, stop or start one to fence it.
resource "google_project_iam_custom_role" "control" {
  role_id     = replace("${var.name_prefix}_control", "-", "_")
  title       = "Opengeni compute fleet service"
  description = "Size and fence the compute host group."
  permissions = [
    "compute.instanceGroupManagers.get",
    "compute.instanceGroupManagers.update",
    "compute.instances.get",
    "compute.instances.reset",
    "compute.instances.start",
    "compute.instances.stop",
    "compute.zoneOperations.get",
  ]
}

# Granted on the project: a dedicated project for the fleet keeps it to the
# fleet's own instances.
resource "google_project_iam_member" "control_group" {
  project = var.project_id
  role    = google_project_iam_custom_role.control.id
  member  = "serviceAccount:${google_service_account.control.email}"
}

# Growing the group creates instances that run as the host account.
resource "google_service_account_iam_member" "control_acts_as_host" {
  service_account_id = google_service_account.host.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.control.email}"
}

resource "google_service_account_iam_member" "control_workload_identity" {
  count              = var.control_workload_identity == null ? 0 : 1
  service_account_id = google_service_account.control.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.control_workload_identity.namespace}/${var.control_workload_identity.service_account}]"
}

# --- Archive ----------------------------------------------------------------

resource "google_storage_bucket" "archive" {
  name                        = var.archive_bucket
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.for_tests
  labels                      = local.labels

  # Deleted objects stay recoverable for a week, past the sweep's own
  # safety age, so an operator error is undone from the bucket.
  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "host_objects" {
  bucket = google_storage_bucket.archive.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.host.email}"
}

resource "google_storage_bucket_iam_member" "control_objects" {
  bucket = google_storage_bucket.archive.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.control.email}"
}

# --- Certificates -----------------------------------------------------------
#
# One private authority signs the hosts' certificates (the fleet service
# trusts it for host connections) and the fleet service's host-endpoint
# certificate (hosts trust it for the service). Hosts request their own at
# boot and renew them; any instance running as the host account can ask
# for a certificate of any host name, so until the fleet service issues
# host certificates against an instance identity token, the host account
# is as trusted as every host (see operations.md, Security).

# Certificate Authority Service never reuses a deleted pool's name, so
# each pool gets a suffix and a fleet can be torn down and made again.
resource "random_id" "pool" {
  byte_length = 3
}

resource "google_privateca_ca_pool" "fleet" {
  name     = "${var.name_prefix}-fleet-${random_id.pool.hex}"
  location = var.region
  # Enterprise keeps the certificates it issues, so Terraform can manage
  # the fleet service's certificate and a lost host's can be revoked; the
  # DevOps tier keeps none (about $20 against $200 a month per authority).
  tier   = "ENTERPRISE"
  labels = local.labels

  issuance_policy {
    maximum_lifetime = "2592000s"
    allowed_key_types {
      elliptic_curve {
        signature_algorithm = "ECDSA_P256"
      }
    }
    baseline_values {
      ca_options {
        is_ca = false
      }
      key_usage {
        base_key_usage {
          digital_signature = true
        }
        extended_key_usage {
          server_auth = true
          client_auth = true
        }
      }
    }
    identity_constraints {
      allow_subject_passthrough           = true
      allow_subject_alt_names_passthrough = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_privateca_certificate_authority" "fleet" {
  pool                                   = google_privateca_ca_pool.fleet.name
  certificate_authority_id               = "${var.name_prefix}-fleet-root"
  location                               = var.region
  type                                   = "SELF_SIGNED"
  lifetime                               = "315360000s"
  deletion_protection                    = !var.for_tests
  skip_grace_period                      = var.for_tests
  ignore_active_certificates_on_deletion = var.for_tests
  labels                                 = local.labels

  config {
    subject_config {
      subject {
        organization = "Opengeni compute"
        common_name  = "${var.name_prefix} fleet authority"
      }
    }
    x509_config {
      ca_options {
        is_ca = true
      }
      key_usage {
        base_key_usage {
          cert_sign = true
          crl_sign  = true
        }
        extended_key_usage {}
      }
    }
  }

  key_spec {
    algorithm = "EC_P256_SHA256"
  }
}

resource "google_privateca_ca_pool_iam_member" "host_requests" {
  ca_pool = google_privateca_ca_pool.fleet.id
  role    = "roles/privateca.certificateRequester"
  member  = "serviceAccount:${google_service_account.host.email}"
}

# Hosts read the authority's certificate to trust the fleet service.
resource "google_privateca_ca_pool_iam_member" "host_reads" {
  ca_pool = google_privateca_ca_pool.fleet.id
  role    = "roles/privateca.poolReader"
  member  = "serviceAccount:${google_service_account.host.email}"
}

resource "tls_private_key" "control" {
  count       = length(var.control_dns_names) > 0 ? 1 : 0
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "control" {
  count           = length(var.control_dns_names) > 0 ? 1 : 0
  private_key_pem = tls_private_key.control[0].private_key_pem
  dns_names       = var.control_dns_names
  subject {
    common_name = var.control_dns_names[0]
  }
}

# The fleet service's host-endpoint certificate, for 30 days: renew it
# with `terraform apply -replace=google_privateca_certificate.control[0]`
# and restart the service (operations.md, Rotating keys and certificates).
resource "google_privateca_certificate" "control" {
  count                 = length(var.control_dns_names) > 0 ? 1 : 0
  pool                  = google_privateca_ca_pool.fleet.name
  location              = var.region
  certificate_authority = google_privateca_certificate_authority.fleet.certificate_authority_id
  name                  = "${var.name_prefix}-control-${substr(sha256(tls_cert_request.control[0].cert_request_pem), 0, 12)}"
  lifetime              = "2592000s"
  pem_csr               = tls_cert_request.control[0].cert_request_pem
}

# --- Network ----------------------------------------------------------------

resource "google_compute_firewall" "control_to_hosts" {
  name          = "${var.name_prefix}-control-to-hosts"
  network       = var.network.network
  direction     = "INGRESS"
  source_ranges = var.control_source_ranges
  target_tags   = [local.hosts_tag]
  allow {
    protocol = "tcp"
    ports    = ["7443"]
  }
}

resource "google_compute_firewall" "hosts_to_control" {
  count       = length(var.control_target_tags) > 0 ? 1 : 0
  name        = "${var.name_prefix}-hosts-to-control"
  network     = var.network.network
  direction   = "INGRESS"
  source_tags = [local.hosts_tag]
  target_tags = var.control_target_tags
  allow {
    protocol = "tcp"
    ports    = [tostring(var.control_hosts_port)]
  }
}

resource "google_compute_firewall" "ssh_to_hosts" {
  count         = length(var.ssh_source_ranges) > 0 ? 1 : 0
  name          = "${var.name_prefix}-ssh-to-hosts"
  network       = var.network.network
  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  target_tags   = [local.hosts_tag]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# --- Hosts ------------------------------------------------------------------

resource "google_compute_instance_template" "host" {
  name_prefix      = "${var.name_prefix}-host-"
  machine_type     = var.machine_type
  min_cpu_platform = var.min_cpu_platform
  tags             = [local.hosts_tag]
  labels           = local.labels

  advanced_machine_features {
    enable_nested_virtualization = var.nested
  }

  disk {
    source_image = var.boot_image
    disk_size_gb = var.boot_disk_gb
    disk_type    = "pd-balanced"
    boot         = true
    auto_delete  = true
  }

  dynamic "disk" {
    for_each = range(var.state_disk.local_ssd_count)
    content {
      type         = "SCRATCH"
      disk_type    = "local-ssd"
      interface    = "NVME"
      disk_size_gb = 375
    }
  }

  dynamic "disk" {
    for_each = var.state_disk.local_ssd_count == 0 ? [1] : []
    content {
      device_name  = "state"
      disk_type    = var.state_disk.pd_type
      disk_size_gb = var.state_disk.pd_size_gb
      auto_delete  = true
      boot         = false
    }
  }

  network_interface {
    network    = var.network.network
    subnetwork = var.network.subnetwork
    dynamic "access_config" {
      for_each = var.assign_external_ip ? [1] : []
      content {}
    }
  }

  service_account {
    email  = google_service_account.host.email
    scopes = ["cloud-platform"]
  }

  scheduling {
    # Bare-metal machines cannot live-migrate. A host that restarts comes
    # back as a fresh registration; the fleet fences what it ran (ADR 18).
    on_host_maintenance = var.nested ? "MIGRATE" : "TERMINATE"
    automatic_restart   = true
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    block-project-ssh-keys = length(var.ssh_source_ranges) == 0 ? "true" : "false"
    enable-oslogin         = "TRUE"
    compute-bundle-url     = var.host_bundle.url
    compute-bundle-sha256  = var.host_bundle.sha256
    compute-control        = var.control_url
    compute-store          = local.store
    compute-base-image     = var.base_image_ref
    compute-ca-pool        = google_privateca_ca_pool.fleet.name
    compute-ca-location    = var.region
    compute-nested         = var.nested ? "true" : "false"
    compute-huge-pages-pct = tostring(var.huge_pages_percent)
    compute-host-args      = var.host_args
    startup-script         = file("${path.module}/host-startup.sh")
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_privateca_certificate_authority.fleet]
}

resource "google_compute_instance_group_manager" "hosts" {
  name               = "${var.name_prefix}-hosts"
  zone               = var.zone
  base_instance_name = "${var.name_prefix}-host"
  target_size        = var.initial_hosts

  version {
    instance_template = google_compute_instance_template.host.self_link
  }

  # A new template reaches hosts only as the operator replaces them, each
  # drained first (operations.md, Upgrading hosts): never all at once.
  update_policy {
    type                  = "OPPORTUNISTIC"
    minimal_action        = "REPLACE"
    max_surge_fixed       = 1
    max_unavailable_fixed = 0
  }

  # No auto-healing: the fleet service decides when a host is lost and
  # fences it; a group that recreated instances on its own would race it.

  lifecycle {
    # The fleet service sizes the group.
    ignore_changes = [target_size]
  }
}
