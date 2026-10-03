mock_provider "google" {}
variables {
  project_id = "test-opengeni-project"
  deployment_phase = "bootstrap"
}
run "runtime_access_is_bound_to_the_runtime_secret" {
  command = plan
  assert {
    condition = google_secret_manager_secret_iam_member.runtime_secret_accessor.project == var.project_id && google_secret_manager_secret_iam_member.runtime_secret_accessor.secret_id == google_secret_manager_secret.runtime.secret_id && google_secret_manager_secret_iam_member.runtime_secret_accessor.role == "roles/secretmanager.secretAccessor"
    error_message = "Runtime secret access must be scoped to this deployment's single secret."
  }
}
