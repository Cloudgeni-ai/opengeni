# GCP hosts for Opengeni compute: the hosts' managed instance group (nested
# virtualization or bare metal), the archive bucket, the hosts' authority
# the control service issues host certificates and its own with, two
# service accounts with only what each needs, and the firewall rules between
# hosts and the control service. The control service itself
# (compute-control) runs elsewhere, for example in the Opengeni Helm chart
# (computeControl); see compute/docs/operations.md.

locals {
  labels = merge(var.labels, {
    project    = "opengeni"
    component  = "compute"
    managed_by = "terraform"
  })
  hosts_tag = "${var.name_prefix}-host"
  store     = "gs://${google_storage_bucket.archive.name}/${var.archive_prefix}"
  group     = "projects/${var.project_id}/zones/${var.zone}/instanceGroupManagers/${var.name_prefix}-hosts"
  # The memory a new host offers sandboxes, which the control service grows
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
  for_each = toset(concat(
    ["compute.googleapis.com", "storage.googleapis.com", "iam.googleapis.com"],
    length(var.host_readable_secrets) > 0 ? ["secretmanager.googleapis.com"] : [],
  ))
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Identities -------------------------------------------------------------

resource "google_service_account" "host" {
  account_id   = "${var.name_prefix}-host"
  display_name = "Opengeni compute host"
  description  = "Compute hosts: the archive bucket's objects, nothing else."
}

resource "google_service_account" "control" {
  account_id   = "${var.name_prefix}-control"
  display_name = "Opengeni compute control service"
  description  = "The control service: reads and sweeps the archive bucket, sizes and fences the host group."
}

# What the control service does to the group (crates/compute-control/src/group.rs),
# with its identity's token from the metadata server: read and resize the
# group, list its instances, and read, reset, stop or start one to fence it.
resource "google_project_iam_custom_role" "control" {
  role_id     = replace("${var.name_prefix}_control", "-", "_")
  title       = "Opengeni compute control service"
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
# The hosts' authority: a key and a self-signed certificate the control
# service holds (ca.key and ca.crt of computeControl.hostsTls.secretName).
# The service issues its own host-endpoint certificate from it, in memory
# for a week and anew every day, and each host's, for the instance name
# the host's identity token proves. Hosts trust the authority's certificate
# alone (and previous_host_authority_pem while one is replaced), from the
# instance template's metadata. The key lives in this
# state and the service's Secret, never in the service's database; replace
# it as operations.md, Keys and certificates says.

resource "tls_private_key" "authority" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "authority" {
  private_key_pem       = tls_private_key.authority.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 87600
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    organization = "Opengeni compute"
    common_name  = "${var.name_prefix} hosts"
  }
}

# The secrets the hosts' prelude may read (host_readable_secrets).
resource "google_secret_manager_secret_iam_member" "host_reads" {
  for_each  = toset(var.host_readable_secrets)
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.host.email}"

  depends_on = [google_project_service.apis]
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
    compute-host-authority = "${tls_self_signed_cert.authority.cert_pem}${var.previous_host_authority_pem}"
    compute-nested         = var.nested ? "true" : "false"
    compute-huge-pages-pct = tostring(var.huge_pages_percent)
    compute-host-args      = var.host_args
    compute-prelude        = var.host_startup_prelude
    compute-advertise      = var.advertise_interface
    startup-script         = file("${path.module}/host-startup.sh")
  }

  lifecycle {
    create_before_destroy = true
  }
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

  # No auto-healing: the control service decides when a host is lost and
  # fences it; a group that recreated instances on its own would race it.

  lifecycle {
    # The control service sizes the group.
    ignore_changes = [target_size]
  }
}
