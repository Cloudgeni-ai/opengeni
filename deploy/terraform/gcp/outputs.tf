output "project_id" {
  description = "GCP project id used by this deployment."
  value       = var.project_id
}

output "region" {
  description = "GCP region used by this deployment."
  value       = var.region
}

output "gke_cluster_name" {
  description = "GKE cluster name."
  value       = google_container_cluster.this.name
}

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository id."
  value       = google_artifact_registry_repository.images.repository_id
}

output "runtime_service_account_email" {
  description = "GCP service account intended for OpenGeni workload identity."
  value       = google_service_account.runtime.email
}

output "runtime_secret_id" {
  description = "Secret Manager secret intended for OpenGeni runtime values."
  value       = google_secret_manager_secret.runtime.secret_id
}

output "postgres_host" {
  description = "Postgres host to use for OPENGENI_DATABASE_URL."
  value       = var.postgres.mode == "managed" ? (var.postgres.private_ip_enabled ? google_sql_database_instance.postgres[0].private_ip_address : google_sql_database_instance.postgres[0].public_ip_address) : var.postgres.existing_host
}

output "temporal_host" {
  description = "Temporal host to use for OPENGENI_TEMPORAL_HOST."
  value       = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : var.temporal.existing_host
}

output "object_storage_backend" {
  description = "Runtime object storage backend."
  value       = "gcs"
}

output "object_storage_bucket" {
  description = "GCS bucket for OpenGeni file storage."
  value       = var.object_storage.mode == "managed" ? google_storage_bucket.files[0].name : var.object_storage.bucket
}

output "helm_set_values" {
  description = "Non-secret Helm values that connect OpenGeni workloads to this GCP substrate."
  value = {
    "global.imageRegistry"                                          = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
    "serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account" = google_service_account.runtime.email
    "config.OPENGENI_TEMPORAL_HOST"                                 = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : try(var.temporal.existing_host, null)
    "config.OPENGENI_TEMPORAL_NAMESPACE"                            = var.temporal.namespace
    "config.OPENGENI_TEMPORAL_TASK_QUEUE"                           = var.temporal.task_queue
    "config.OPENGENI_OBJECT_STORAGE_BACKEND"                        = "gcs"
    "config.OPENGENI_OBJECT_STORAGE_BUCKET"                         = var.object_storage.mode == "managed" ? google_storage_bucket.files[0].name : var.object_storage.bucket
    "config.OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID"                 = var.project_id
  }
}
