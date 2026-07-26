locals {
  tags = merge(var.tags, {
    project    = "opengeni"
    managed_by = "terraform"
    purpose    = "opengeni-deployment"
  })

  cluster_name = "${var.name_prefix}-eks"
  repository_names = {
    api    = "${var.name_prefix}/opengeni-api"
    worker = "${var.name_prefix}/opengeni-worker"
    web    = "${var.name_prefix}/opengeni-web"
  }
  oidc_issuer_url     = aws_eks_cluster.this.identity[0].oidc[0].issuer
  oidc_provider_host  = replace(local.oidc_issuer_url, "https://", "")
  runtime_bucket_arns = var.object_storage.mode == "managed" ? [aws_s3_bucket.files[0].arn] : ["arn:aws:s3:::${var.object_storage.bucket}"]
}

data "aws_caller_identity" "current" {}

locals {
  selected_subnet_ids = var.network.create_vpc ? aws_subnet.public[*].id : var.network.subnet_ids
  selected_vpc_id     = var.network.create_vpc ? aws_vpc.this[0].id : var.network.vpc_id
}

resource "aws_vpc" "this" {
  count                = var.network.create_vpc ? 1 : 0
  cidr_block           = var.network.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, { Name = "${var.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "this" {
  count  = var.network.create_vpc ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.network.create_vpc ? length(var.network.public_subnet_cidrs) : 0
  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = var.network.public_subnet_cidrs[count.index]
  availability_zone       = var.network.availability_zones[count.index]
  map_public_ip_on_launch = true
  tags = merge(local.tags, {
    Name                                          = "${var.name_prefix}-public-${count.index + 1}"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                      = "1"
  })
}

resource "aws_route_table" "public" {
  count  = var.network.create_vpc ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "public_internet" {
  count                  = var.network.create_vpc ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  count          = var.network.create_vpc ? length(aws_subnet.public) : 0
  route_table_id = aws_route_table.public[0].id
  subnet_id      = aws_subnet.public[count.index].id
}

data "aws_iam_policy_document" "eks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_cluster" {
  name               = "${var.name_prefix}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.eks_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.eks.kubernetes_version
  tags     = local.tags

  vpc_config {
    subnet_ids              = local.selected_subnet_ids
    endpoint_public_access  = var.eks.endpoint_public_access
    endpoint_private_access = true
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

data "aws_iam_policy_document" "node_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name_prefix}-eks-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_registry" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = local.selected_subnet_ids
  instance_types  = var.eks.node_instance_types
  tags            = local.tags

  scaling_config {
    desired_size = var.eks.node_desired_size
    min_size     = var.eks.node_min_size
    max_size     = var.eks.node_max_size
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_registry,
  ]
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "aws-ebs-csi-driver"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  service_account_role_arn    = aws_iam_role.ebs_csi.arn
  tags                        = local.tags

  depends_on = [
    aws_eks_node_group.system,
    aws_iam_role_policy_attachment.ebs_csi,
  ]
}

data "tls_certificate" "eks_oidc" {
  url = local.oidc_issuer_url
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = local.oidc_issuer_url
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[0].sha1_fingerprint]
  tags            = local.tags
}

data "aws_iam_policy_document" "ebs_csi_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_provider_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_provider_host}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.name_prefix}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

data "aws_iam_policy_document" "runtime_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_provider_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_provider_host}:sub"
      values   = ["system:serviceaccount:${var.kubernetes_workload_identity.namespace}:${var.kubernetes_workload_identity.service_account}"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name               = "${var.name_prefix}-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_assume_role.json
  tags               = local.tags
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid = "OpenGeniObjectStorage"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [for arn in local.runtime_bucket_arns : "${arn}/*"]
  }

  statement {
    sid       = "OpenGeniObjectStorageList"
    actions   = ["s3:ListBucket"]
    resources = local.runtime_bucket_arns
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "${var.name_prefix}-runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_ecr_repository" "workloads" {
  for_each             = local.repository_names
  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.ecr_force_delete
  tags                 = local.tags

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_s3_bucket" "files" {
  count         = var.object_storage.mode == "managed" ? 1 : 0
  bucket_prefix = "${replace(var.name_prefix, "-", "")}-files-"
  force_destroy = var.object_storage.force_destroy
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "files" {
  count                   = var.object_storage.mode == "managed" ? 1 : 0
  bucket                  = aws_s3_bucket.files[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "files" {
  count  = var.object_storage.mode == "managed" ? 1 : 0
  bucket = aws_s3_bucket.files[0].id

  versioning_configuration {
    status = var.object_storage.versioning_enabled ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  count  = var.object_storage.mode == "managed" ? 1 : 0
  bucket = aws_s3_bucket.files[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "files" {
  count  = var.object_storage.mode == "managed" && length(var.object_storage.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.files[0].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = var.object_storage.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = var.object_storage.cors_max_age_seconds
  }
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.name_prefix}/runtime"
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_db_subnet_group" "postgres" {
  count      = var.postgres.mode == "managed" ? 1 : 0
  name       = "${var.name_prefix}-postgres"
  subnet_ids = local.selected_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "postgres" {
  count       = var.postgres.mode == "managed" ? 1 : 0
  name_prefix = "${var.name_prefix}-postgres-"
  vpc_id      = local.selected_vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_vpc" {
  count             = var.postgres.mode == "managed" ? 1 : 0
  security_group_id = aws_security_group.postgres[0].id
  cidr_ipv4         = var.network.create_vpc ? var.network.cidr_block : "10.0.0.0/8"
  from_port         = 5432
  ip_protocol       = "tcp"
  to_port           = 5432
}

resource "aws_db_instance" "postgres" {
  count                     = var.postgres.mode == "managed" ? 1 : 0
  identifier                = "${var.name_prefix}-postgres"
  engine                    = "postgres"
  engine_version            = var.postgres.engine_version
  instance_class            = var.postgres.instance_class
  allocated_storage         = var.postgres.allocated_storage
  db_name                   = "opengeni"
  username                  = var.postgres.administrator_login
  password                  = var.postgres.administrator_password
  db_subnet_group_name      = aws_db_subnet_group.postgres[0].name
  vpc_security_group_ids    = [aws_security_group.postgres[0].id]
  skip_final_snapshot       = var.postgres.skip_final_snapshot
  final_snapshot_identifier = var.postgres.skip_final_snapshot ? null : "${var.name_prefix}-postgres-final"
  deletion_protection       = var.postgres.deletion_protection
  storage_encrypted         = true
  tags                      = local.tags
}
