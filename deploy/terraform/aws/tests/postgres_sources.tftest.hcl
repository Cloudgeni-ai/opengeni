mock_provider "aws" {
  mock_resource "aws_eks_cluster" {
    override_during = plan
    defaults = {
      identity   = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/test" }] }]
      vpc_config = { cluster_security_group_id = "sg-0c1a5e7c1a5e7c1a5" }
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "tls" {
  mock_data "tls_certificate" {
    defaults = { certificates = [{ sha1_fingerprint = "0000000000000000000000000000000000000000" }] }
  }
}
variables { deployment_phase = "bootstrap" }

run "managed_vpc_preserves_original_state_address" {
  command = plan
  variables { postgres = { mode = "managed" } }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_vpc[0].cidr_ipv4 == var.network.cidr_block
    error_message = "Managed VPC upgrades must retain postgres_from_vpc[0] and the managed VPC CIDR."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 0
    error_message = "Managed VPC mode must not add any other ingress by default."
  }
}

run "existing_vpc_admits_the_eks_cluster_security_group_only" {
  command = plan
  variables {
    network  = { create_vpc = false, vpc_id = "vpc-0123456789abcdef0", subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"] }
    postgres = { mode = "managed" }
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 0
    error_message = "Existing VPC mode must not fall back to an address range such as 10.0.0.0/8."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster[0].referenced_security_group_id == "sg-0c1a5e7c1a5e7c1a5" && aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster[0].from_port == 5432 && aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster[0].to_port == 5432
    error_message = "Existing VPC mode must admit PostgreSQL from the EKS cluster security group."
  }
}

run "existing_vpc_adds_declared_sources" {
  command = plan
  variables {
    network  = { create_vpc = false, vpc_id = "vpc-0123456789abcdef0", subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"] }
    postgres = { mode = "managed", allowed_client_cidrs = ["10.9.4.0/24"], allowed_security_group_ids = ["sg-0123456789abcdef0"] }
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster) == 1 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs["10.9.4.0/24"].cidr_ipv4 == "10.9.4.0/24" && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_security_groups["sg-0123456789abcdef0"].referenced_security_group_id == "sg-0123456789abcdef0"
    error_message = "Existing VPC access must be the cluster security group plus exactly the declared sources."
  }
}

run "managed_vpc_adds_declared_sources" {
  command = plan
  variables { postgres = { mode = "managed", allowed_client_cidrs = ["192.168.10.0/24"] } }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 1 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs["192.168.10.0/24"].cidr_ipv4 == "192.168.10.0/24"
    error_message = "Declared sources must be honoured in managed VPC mode, not silently ignored."
  }
}

run "invalid_cidr_is_rejected" {
  command = plan
  variables { postgres = { mode = "managed", allowed_client_cidrs = ["999.999.1.0/24"] } }
  expect_failures = [var.postgres]
}

run "open_internet_cidr_is_rejected" {
  command = plan
  variables { postgres = { mode = "managed", allowed_client_cidrs = ["0.0.0.0/0"] } }
  expect_failures = [var.postgres]
}

run "host_bits_cidr_is_rejected" {
  command = plan
  variables { postgres = { mode = "managed", allowed_client_cidrs = ["10.9.4.7/24"] } }
  expect_failures = [var.postgres]
}

run "invalid_security_group_is_rejected" {
  command = plan
  variables { postgres = { mode = "managed", allowed_security_group_ids = ["sg-short"] } }
  expect_failures = [var.postgres]
}

run "external_postgres_has_no_managed_ingress" {
  command = plan
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_eks_cluster) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 0
    error_message = "External Postgres must not create RDS ingress rules."
  }
}
