# GCP Reference Substrate

This root creates a cleanup-friendly GCP substrate for the Helm chart:

- GKE cluster and managed node pool with Workload Identity enabled.
- Artifact Registry Docker repository.
- GCS bucket for `OPENGENI_OBJECT_STORAGE_BACKEND=gcs`, with uniform bucket-level access and public access prevention.
- Secret Manager runtime secret placeholder.
- Runtime service account for Workload Identity, GCS access, Secret Manager access scoped to the created runtime secret, signed URL generation, and Artifact Registry image pulls.
- Optional Cloud SQL PostgreSQL when `postgres.mode = "managed"`.
- Private Service Connect / service networking for managed Cloud SQL when `postgres.private_ip_enabled = true`.
- `temporal.mode = "officialChart"` output wiring for the stack-wrapper managed upstream Temporal chart, or `external` for Temporal Cloud/customer endpoints.

Connected Machines (`OPENGENI_SANDBOX_BACKEND=selfhosted`) add one more deployed
component, the `opengeni-relay` stream relay. Its image is pushed to the same
Artifact Registry repository as the API/worker/web images (no extra registry
resource is required). The relay pairs each channel's producer and consumer in a
per-replica in-memory registry, so its public wss ingress must route both dials
for a channel to the same replica (consistent-hash / session affinity keyed on
the channel) whenever more than one relay replica runs. See `docs/deployment.md`
(Connected Machines) for the full relay/NATS/secret wiring.

Keep Opengeni workloads in the provider-neutral Helm chart. This root should only create cloud substrate and emit non-secret Helm values.

Managed Postgres defaults to `edition = "ENTERPRISE"` and `availability_type = "REGIONAL"` for production resilience. Short-lived evaluation stacks can set `postgres.availability_type = "ZONAL"` with `deletion_protection = false` to reduce cost.

Regional GKE clusters distribute node pools across zones by default. Short-lived evaluation stacks can set `gke.node_locations = ["<zone>"]` and smaller node counts to avoid creating one node group per zone; omit `node_locations` for production multi-zone resilience.

Private nodes on a network created by this root (`network.create_network = true`
and `gke.enable_private_nodes = true`) get a regional Cloud Router and Cloud NAT.
NAT covers the created subnet's primary and secondary ranges so nodes and pods
can reach public model providers and external Temporal endpoints. Cloud NAT adds
provider charges; public-node deployments do not create it. NAT ports are
allocated dynamically per node (64 up to 65536) because all pods on a node share
them, and allocation errors are logged.
If such a stack already has a hand-made Cloud NAT for this subnet, a second NAT
gateway for the same subnet ranges is rejected. Import it as
`google_compute_router.private_nodes[0]` and
`google_compute_router_nat.private_nodes[0]` only when both are named
`<name_prefix>-private-nodes`; a different name forces replacement and briefly
cuts egress. Otherwise delete the hand-made NAT in a maintenance window and
apply right after.

For `network.create_network = false`, the operator must supply internet egress
for private nodes and pods, through existing Cloud NAT or another routing path.
This root does not change routing on an existing network. See
[Google's GKE NAT guidance](https://docs.cloud.google.com/nat/docs/nat-product-interactions).

### Upgrading runtime secret access

Earlier versions granted the runtime service account
`roles/secretmanager.secretAccessor` on the whole project. It is now granted on
the runtime secret only (`runtime_secret_id` output, `<name_prefix>-runtime`).
The plan destroys `google_project_iam_member.runtime_secret_accessor` and creates
`google_secret_manager_secret_iam_member.runtime_secret_accessor`. Before
applying, confirm that the External Secrets `remoteRef`/`extract` key in your Helm
values equals `runtime_secret_id`. If the same identity also syncs other secrets,
such as separate database, Temporal, NATS or object-storage credentials, list
their IDs in `runtime_readable_secret_ids`; each gets its own secret-level
binding. IAM changes can take a few minutes to propagate, so an External Secrets
refresh during the apply may fail once; synced Kubernetes Secrets and running
pods are unaffected.

## Validate

```bash
terraform -chdir=deploy/terraform/gcp init -backend=false
terraform -chdir=deploy/terraform/gcp fmt -check
terraform -chdir=deploy/terraform/gcp validate
```

## Apply

Before creating resources, decide where the operator will keep exact resource
names, cleanup notes, and generated access material. Keep those records outside
the repository along with Terraform state, plans, kubeconfigs, and filled
tfvars.

```bash
terraform -chdir=deploy/terraform/gcp plan -var-file=terraform.tfvars
terraform -chdir=deploy/terraform/gcp apply -var-file=terraform.tfvars
```

Do not commit state, kubeconfigs, generated database passwords, service-account keys, GCP credentials, or filled secret values.
The official Temporal chart still needs durable Postgres databases prepared outside the Opengeni app chart before Helm install.
