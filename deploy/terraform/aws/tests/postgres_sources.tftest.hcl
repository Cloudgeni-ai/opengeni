mock_provider "aws" {
  mock_resource "aws_eks_cluster" {
    defaults = { identity = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/test" }] }] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "tls" {}
variables { deployment_phase = "bootstrap" }
run "managed_vpc_preserves_original_state_address" {
  command = plan
  variables { postgres = { mode = "managed" } }
  assert {
    condition = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_vpc[0].cidr_ipv4 == var.network.cidr_block && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 0
    error_message = "Managed VPC upgrades must retain postgres_from_vpc[0] and the managed VPC CIDR."
  }
}
run "existing_vpc_only_allows_declared_sources" {
  command = plan
  variables {
    network = { create_vpc = false, vpc_id = "vpc-0123456789abcdef0", subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"] }
    postgres = { mode = "managed", allowed_client_cidrs = ["10.9.4.0/24"], allowed_security_group_ids = ["sg-0123456789abcdef0"] }
  }
  assert {
    condition = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 1 && aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs["10.9.4.0/24"].cidr_ipv4 == "10.9.4.0/24" && aws_vpc_security_group_ingress_rule.postgres_from_security_groups["sg-0123456789abcdef0"].referenced_security_group_id == "sg-0123456789abcdef0"
    error_message = "Existing VPC access must use exactly the explicit client sources."
  }
}
run "existing_vpc_rejects_missing_sources" {
  command = plan
  variables {
    network = { create_vpc = false, vpc_id = "vpc-0123456789abcdef0", subnet_ids = ["subnet-0123456789abcdef0"] }
    postgres = { mode = "managed" }
  }
  expect_failures = [var.postgres]
}
run "invalid_cidr_is_rejected" {
  command = plan
  variables { postgres = { mode = "managed", allowed_client_cidrs = ["999.999.1.0/24"] } }
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
    condition = length(aws_vpc_security_group_ingress_rule.postgres_from_vpc) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_client_cidrs) == 0 && length(aws_vpc_security_group_ingress_rule.postgres_from_security_groups) == 0
    error_message = "External Postgres must not create RDS ingress rules."
  }
}
