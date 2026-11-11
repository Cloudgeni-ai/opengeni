mock_provider "google" {}
variables {
  project_id       = "test-opengeni-project"
  deployment_phase = "bootstrap"
}
run "runtime_access_is_bound_to_the_runtime_secret" {
  command = plan
  assert {
    condition     = google_secret_manager_secret_iam_member.runtime_secret_accessor.project == var.project_id && google_secret_manager_secret_iam_member.runtime_secret_accessor.secret_id == google_secret_manager_secret.runtime.secret_id && google_secret_manager_secret_iam_member.runtime_secret_accessor.role == "roles/secretmanager.secretAccessor"
    error_message = "Runtime secret access must be scoped to this deployment's single secret."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.runtime_readable_secrets) == 0
    error_message = "No other secret is readable unless the operator names it."
  }
}

run "operator_named_secrets_are_bound_individually" {
  command = plan
  variables { runtime_readable_secret_ids = ["opengeni-database", "opengeni-temporal"] }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.runtime_readable_secrets) == 2 && google_secret_manager_secret_iam_member.runtime_readable_secrets["opengeni-database"].secret_id == "opengeni-database" && google_secret_manager_secret_iam_member.runtime_readable_secrets["opengeni-temporal"].role == "roles/secretmanager.secretAccessor"
    error_message = "Each named secret gets its own secret-level binding."
  }
}

run "wildcard_or_resource_name_secret_ids_are_rejected" {
  command = plan
  variables { runtime_readable_secret_ids = ["projects/p/secrets/*"] }
  expect_failures = [var.runtime_readable_secret_ids]
}

run "the_runtime_secret_is_not_bound_twice" {
  command = plan
  variables { runtime_readable_secret_ids = ["opengeni-runtime"] }
  expect_failures = [var.runtime_readable_secret_ids]
}
