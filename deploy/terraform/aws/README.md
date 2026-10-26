# AWS Reference Substrate

This root creates a cleanup-friendly AWS substrate for the Helm chart:

- EKS cluster and managed node group.
- ECR repositories scoped under `name_prefix` for API, worker, and web images.
- S3 bucket for `OPENGENI_OBJECT_STORAGE_BACKEND=aws-s3`.

Connected Machines (`OPENGENI_SANDBOX_BACKEND=selfhosted`) add one more deployed
component, the `opengeni-relay` stream relay. It is a separate image, so an
operator enabling Connected Machines must also provision a container repository
for it (this root creates the API/worker/web repositories only). The relay pairs
each channel's producer and consumer in a per-replica in-memory registry, so its
public wss ingress must route both dials for a channel to the same replica
(consistent-hash / session affinity keyed on the channel) whenever more than one
relay replica runs. See `docs/deployment.md` (Connected Machines) for the full
relay/NATS/secret wiring.
- AWS Secrets Manager runtime secret placeholder.
- Optional RDS PostgreSQL when `postgres.mode = "managed"`. Managed-VPC mode (`network.create_vpc = true`) allows PostgreSQL ingress from the VPC CIDR. Existing-VPC mode (`network.create_vpc = false`) allows it from the EKS cluster security group, which EKS attaches to the managed node group and so to the Opengeni pods; it never opens the shared network's address space. Add other clients with `postgres.allowed_client_cidrs` and/or `postgres.allowed_security_group_ids` (`0.0.0.0/0` is rejected).
- `temporal.mode = "officialChart"` output wiring for the stack-wrapper managed upstream Temporal chart, or `external` for Temporal Cloud/customer endpoints.

Keep Opengeni workloads in the provider-neutral Helm chart. This root should only create cloud substrate and emit non-secret Helm values.

## Validate

```bash
terraform -chdir=deploy/terraform/aws init -backend=false
terraform -chdir=deploy/terraform/aws fmt -check
terraform -chdir=deploy/terraform/aws validate
```

## Apply

Before creating resources, decide where the operator will keep exact resource
names, cleanup notes, and generated access material. Keep those records outside
the repository along with Terraform state, plans, kubeconfigs, and filled
tfvars.

```bash
terraform -chdir=deploy/terraform/aws plan -var-file=terraform.tfvars
terraform -chdir=deploy/terraform/aws apply -var-file=terraform.tfvars
```

For short-lived evaluation stacks, set `postgres.deletion_protection = false`
and `postgres.skip_final_snapshot = true` before apply. For production-like
stacks, keep final snapshots and deletion protection enabled.

Do not commit state, kubeconfigs, generated database passwords, AWS credentials, or filled secret values.
The official Temporal chart still needs durable Postgres databases prepared outside the Opengeni app chart before Helm install.

### Upgrading PostgreSQL ingress

Managed VPC deployments retain the existing `postgres_from_vpc[0]` resource address and VPC CIDR rule, so the plan shows no ingress change.

Existing VPC deployments previously admitted `10.0.0.0/8`. The plan destroys that `postgres_from_vpc[0]` rule and creates `postgres_from_eks_cluster[0]` for the EKS cluster security group. Pods on this root's managed node group keep access. Before you apply, add an entry in `postgres.allowed_security_group_ids` or `postgres.allowed_client_cidrs` for every other client that reached RDS through the old range:

- Clients outside the cluster, such as a bastion, a migration runner or a Temporal server elsewhere.
- Pods that don't carry the cluster security group: nodes added by Karpenter or self-managed node groups with their own security groups, Security Groups for Pods, or VPC CNI custom networking with per-subnet security groups. Add those node or pod security groups.

The two rules are independent, so the old one may be removed a moment before the new one exists. Established connections are kept, but a new connection opened in that moment can be refused; apply outside peak traffic.
