output "archive" {
  description = "Where hosts archive sandboxes: computeControl.archive in the Helm chart."
  value       = local.store
}

output "host_group" {
  description = "The hosts' managed instance group: computeControl.gcpGroup in the Helm chart."
  value       = local.group
}

output "control_service_account" {
  description = "Google service account the fleet service runs as (Workload Identity, or a VM's identity)."
  value       = google_service_account.control.email
}

output "host_service_account" {
  description = "Google service account the hosts run as."
  value       = google_service_account.host.email
}

output "fleet_ca_pem" {
  description = "The fleet authority's certificate: ca.crt of computeControl.hostsTls.secretName."
  value       = google_privateca_certificate_authority.fleet.pem_ca_certificates[0]
}

output "control_certificate_pem" {
  description = "The fleet service's host-endpoint certificate chain: tls.crt of computeControl.hostsTls.secretName."
  value       = length(var.control_dns_names) > 0 ? join("", concat([google_privateca_certificate.control[0].pem_certificate], google_privateca_certificate.control[0].pem_certificate_chain)) : null
}

output "control_private_key_pem" {
  description = "The fleet service's host-endpoint key: tls.key of computeControl.hostsTls.secretName."
  value       = length(var.control_dns_names) > 0 ? tls_private_key.control[0].private_key_pem : null
  sensitive   = true
}
