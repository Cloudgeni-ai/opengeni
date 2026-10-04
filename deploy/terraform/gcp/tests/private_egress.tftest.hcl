mock_provider "google" {}
variables {
  project_id       = "test-opengeni-project"
  deployment_phase = "bootstrap"
}
run "private_nodes_in_created_network_have_public_egress" {
  command = plan
  variables { gke = { enable_private_nodes = true } }
  assert {
    condition     = length(google_compute_router.private_nodes) == 1 && length(google_compute_router_nat.private_nodes) == 1
    error_message = "Private nodes on a created network need Cloud NAT for public provider endpoints."
  }
  assert {
    condition     = google_compute_router_nat.private_nodes[0].source_subnetwork_ip_ranges_to_nat == "LIST_OF_SUBNETWORKS" && one(google_compute_router_nat.private_nodes[0].subnetwork).source_ip_ranges_to_nat == toset(["ALL_IP_RANGES"])
    error_message = "NAT must cover all primary and secondary ranges of the created GKE subnet."
  }
}
run "public_nodes_do_not_add_nat" {
  command = plan
  assert {
    condition     = length(google_compute_router_nat.private_nodes) == 0
    error_message = "Public-node deployments must not incur a new NAT resource."
  }
}
run "existing_private_network_keeps_operator_egress" {
  command = plan
  variables {
    network  = { create_network = false, network_name = "existing-vpc", subnet_name = "existing-subnet" }
    gke      = { enable_private_nodes = true }
    postgres = { mode = "external", external_database_url = "postgres://localhost/opengeni" }
  }
  assert {
    condition     = length(google_compute_router.private_nodes) == 0 && length(google_compute_router_nat.private_nodes) == 0
    error_message = "Existing networks retain operator-owned routing and egress."
  }
}
