output "account_id" {
  description = "AWS account id used by this deployment."
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "AWS region used by this deployment."
  value       = var.region
}

output "eks_cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "ecr_repository_urls" {
  description = "ECR repository URLs keyed by workload component."
  value       = { for name, repo in aws_ecr_repository.workloads : name => repo.repository_url }
}

output "runtime_secret_name" {
  description = "AWS Secrets Manager secret intended for OpenGeni runtime values."
  value       = aws_secretsmanager_secret.runtime.name
}

output "runtime_role_arn" {
  description = "IAM role ARN intended for OpenGeni workload IRSA."
  value       = aws_iam_role.runtime.arn
}

output "postgres_host" {
  description = "Postgres host to use for OPENGENI_DATABASE_URL."
  value       = var.postgres.mode == "managed" ? aws_db_instance.postgres[0].address : var.postgres.existing_host
}

output "temporal_host" {
  description = "Temporal host to use for OPENGENI_TEMPORAL_HOST."
  value       = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : var.temporal.existing_host
}

output "object_storage_backend" {
  description = "Runtime object storage backend."
  value       = "aws-s3"
}

output "object_storage_bucket" {
  description = "S3 bucket for OpenGeni file storage."
  value       = var.object_storage.mode == "managed" ? aws_s3_bucket.files[0].bucket : var.object_storage.bucket
}

output "helm_set_values" {
  description = "Non-secret Helm values that connect OpenGeni workloads to this AWS substrate."
  value = {
    "global.imageRegistry"                                      = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    "api.image.repository"                                      = local.repository_names.api
    "worker.image.repository"                                   = local.repository_names.worker
    "web.image.repository"                                      = local.repository_names.web
    "migrations.image.repository"                               = local.repository_names.api
    "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn" = aws_iam_role.runtime.arn
    "config.OPENGENI_TEMPORAL_HOST"                             = var.temporal.mode == "officialChart" ? "opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233" : try(var.temporal.existing_host, null)
    "config.OPENGENI_TEMPORAL_NAMESPACE"                        = var.temporal.namespace
    "config.OPENGENI_TEMPORAL_TASK_QUEUE"                       = var.temporal.task_queue
    "config.OPENGENI_OBJECT_STORAGE_BACKEND"                    = "aws-s3"
    "config.OPENGENI_OBJECT_STORAGE_BUCKET"                     = var.object_storage.mode == "managed" ? aws_s3_bucket.files[0].bucket : var.object_storage.bucket
    "config.OPENGENI_OBJECT_STORAGE_REGION"                     = var.region
    "config.OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE"           = "false"
  }
}
