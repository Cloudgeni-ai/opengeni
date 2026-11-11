output "archive" {
  description = "Where hosts archive sandboxes: computeControl.archive in the Helm chart."
  value       = local.store
}

output "host_group" {
  description = "The hosts' managed instance group: computeControl.gcpGroup in the Helm chart."
  value       = local.group
}

output "host_memory_mib" {
  description = "Memory in MiB a new host offers sandboxes: computeControl.scaling.hostMemoryMib in the Helm chart."
  value       = local.host_memory_mib
}

output "control_service_account" {
  description = "Google service account the control service runs as (Workload Identity, or a VM's identity)."
  value       = google_service_account.control.email
}

output "host_service_account" {
  description = "Google service account the hosts run as."
  value       = google_service_account.host.email
}

output "host_authority_pem" {
  description = "The hosts' authority's certificate: ca.crt of computeControl.hostsTls.secretName."
  value       = tls_self_signed_cert.authority.cert_pem
}

output "host_authority_key_pem" {
  description = "The hosts' authority's key, PKCS#8: ca.key of computeControl.hostsTls.secretName. Every host trusts what it signs: keep it as the service's other keys."
  value       = tls_private_key.authority.private_key_pem_pkcs8
  sensitive   = true
}

output "identity_tokens" {
  description = "What the control service checks hosts' identity tokens against: computeControl.hostIdentity in the Helm chart."
  value = {
    project = var.project_id
    account = google_service_account.host.email
  }
}
