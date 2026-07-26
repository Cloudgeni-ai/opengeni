locals {
  labels = merge(var.labels, {
    project    = "opengeni"
    managed_by = "terraform"
    purpose    = "opengeni-deployment"
  })

  cluster_name                = "${var.name_prefix}-gke"
  artifact_repo_id            = "${var.name_prefix}-images"
  runtime_sa_id               = "${var.name_prefix}-runtime"
  network_name                = var.network.create_network ? google_compute_network.this[0].name : var.network.network_name
  subnet_name                 = var.network.create_network ? google_compute_subnetwork.this[0].name : var.network.subnet_name
  postgres_private_ip_enabled = var.postgres.mode == "managed" && var.postgres.private_ip_enabled
}

resource "google_compute_network" "this" {
  count                   = var.network.create_network ? 1 : 0
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "this" {
  count         = var.network.create_network ? 1 : 0
  name          = "${var.name_prefix}-subnet"
  ip_cidr_range = var.network.subnet_cidr
  network       = google_compute_network.this[0].id
  region        = var.region
}

resource "google_project_service" "servicenetworking" {
  count              = local.postgres_private_ip_enabled ? 1 : 0
  project            = var.project_id
  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_global_address" "private_services" {
  count         = local.postgres_private_ip_enabled ? 1 : 0
  name          = "${var.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.this[0].id
}

resource "google_service_networking_connection" "private_vpc" {
  count                   = local.postgres_private_ip_enabled ? 1 : 0
  network                 = google_compute_network.this[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[0].name]

  depends_on = [google_project_service.servicenetworking]
}

resource "google_service_account" "runtime" {
  account_id   = local.runtime_sa_id
  display_name = "OpenGeni runtime"
  description  = "Runtime identity for OpenGeni workloads."
}

resource "google_container_cluster" "this" {
  name                     = local.cluster_name
  location                 = var.region
  remove_default_node_pool = true
  initial_node_count       = 1
  network                  = local.network_name
  subnetwork               = local.subnet_name
  node_locations           = var.gke.node_locations
  deletion_protection      = var.gke.deletion_protection

  release_channel {
    channel = var.gke.release_channel
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  dynamic "private_cluster_config" {
    for_each = var.gke.enable_private_nodes ? [1] : []

    content {
      enable_private_nodes    = true
      enable_private_endpoint = false
      master_ipv4_cidr_block  = "172.16.0.0/28"
    }
  }

  resource_labels = local.labels
}

resource "google_container_node_pool" "system" {
  name           = "system"
  location       = var.region
  cluster        = google_container_cluster.this.name
  node_count     = var.gke.node_count
  node_locations = var.gke.node_locations

  autoscaling {
    min_node_count = var.gke.min_node_count
    max_node_count = var.gke.max_node_count
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.gke.machine_type
    disk_size_gb    = var.gke.disk_size_gb
    service_account = google_service_account.runtime.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = local.labels

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.artifact_repo_id
  description   = "OpenGeni workload images"
  format        = "DOCKER"
  labels        = local.labels
}

resource "google_artifact_registry_repository_iam_member" "image_writers" {
  for_each   = toset(var.artifact_registry_writer_members)
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = each.value
}

resource "google_artifact_registry_repository_iam_member" "runtime_image_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "files" {
  count                       = var.object_storage.mode == "managed" ? 1 : 0
  name                        = "${var.project_id}-${var.name_prefix}-files"
  location                    = coalesce(var.object_storage.location, var.region)
  force_destroy               = var.object_storage.force_destroy
  uniform_bucket_level_access = var.object_storage.uniform_bucket_level_access
  public_access_prevention    = "enforced"
  labels                      = local.labels

  dynamic "cors" {
    for_each = length(var.object_storage.cors_allowed_origins) > 0 ? [1] : []
    content {
      origin          = var.object_storage.cors_allowed_origins
      method          = ["GET", "HEAD", "PUT"]
      response_header = ["Content-Type", "ETag", "x-goog-meta-sha256"]
      max_age_seconds = var.object_storage.cors_max_age_seconds
    }
  }

  versioning {
    enabled = var.object_storage.versioning_enabled
  }
}

resource "google_secret_manager_secret" "runtime" {
  secret_id = "${var.name_prefix}-runtime"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_project_iam_member" "runtime_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "gke_admin" {
  for_each = toset(var.gke_admin_members)
  project  = var.project_id
  role     = "roles/container.admin"
  member   = each.value
}

resource "google_service_account_iam_member" "runtime_workload_identity" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.kubernetes_workload_identity.namespace}/${var.kubernetes_workload_identity.service_account}]"

  depends_on = [google_container_cluster.this]
}

resource "google_service_account_iam_member" "runtime_token_creator" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "runtime_storage_admin" {
  count  = var.object_storage.mode == "managed" ? 1 : 0
  bucket = google_storage_bucket.files[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_sql_database_instance" "postgres" {
  count               = var.postgres.mode == "managed" ? 1 : 0
  name                = "${var.name_prefix}-postgres"
  database_version    = var.postgres.database_version
  region              = var.region
  deletion_protection = var.postgres.deletion_protection

  settings {
    edition           = var.postgres.edition
    tier              = var.postgres.tier
    disk_size         = var.postgres.disk_size_gb
    disk_autoresize   = true
    availability_type = var.postgres.availability_type
    user_labels       = local.labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    dynamic "ip_configuration" {
      for_each = local.postgres_private_ip_enabled ? [1] : []

      content {
        ipv4_enabled    = false
        private_network = google_compute_network.this[0].id
      }
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "opengeni" {
  count    = var.postgres.mode == "managed" ? 1 : 0
  name     = "opengeni"
  instance = google_sql_database_instance.postgres[0].name
}

resource "google_sql_user" "opengeni" {
  count    = var.postgres.mode == "managed" ? 1 : 0
  name     = var.postgres.administrator_login
  instance = google_sql_database_instance.postgres[0].name
  password = var.postgres.administrator_password
}
