# OpenGeni Azure Reference Deployment

This Terraform root module is the Azure reference substrate for OpenGeni. It is intentionally focused on platform primitives and does not store application secrets in source control.

## What It Creates

- Resource group, when `create_resource_group = true`.
- Azure Container Registry.
- AKS cluster with OIDC issuer and workload identity enabled.
- Azure Key Vault with RBAC authorization enabled.
- Azure Database for PostgreSQL Flexible Server when `postgres.mode = "managed"`.
- `pgcrypto`, `pgvector`, and `btree_gin` enablement for managed Postgres through the `azure.extensions` server configuration. `btree_gin` is required by the upstream Temporal PostgreSQL visibility schema.
- Optional PostgreSQL firewall rules through `postgres.allow_azure_services` or `postgres.firewall_rules`.
- Azure Storage account and private Blob container when `object_storage.mode = "managed"` and `object_storage.api = "azure-blob"`.
- ACR pull role assignment for AKS kubelet identity.
- Optional AKS Microsoft Defender attachment to an existing Log Analytics workspace.

Connected Machines (`OPENGENI_SANDBOX_BACKEND=selfhosted`) add one more deployed
component, the `opengeni-relay` stream relay. Its image is pushed to the same
Azure Container Registry as the API/worker/web images (no extra registry
resource is required). The relay pairs each channel's producer and consumer in a
per-replica in-memory registry, so its public wss ingress must route both dials
for a channel to the same replica (consistent-hash / session affinity keyed on
the channel) whenever more than one relay replica runs. See `docs/deployment.md`
(Connected Machines) for the full relay/NATS/secret wiring.

## Phases

Use `deployment_phase = "bootstrap"` to create cloud substrate before runtime dependencies are known. Bootstrap mode does not require Temporal, object storage, or external Postgres endpoints unless those resources are being created by Terraform.

Use `deployment_phase = "complete"` when rendering or applying a fully configured deployment. Complete mode requires all external runtime endpoints, except `temporal.mode = "officialChart"` uses the stack-wrapper managed upstream Temporal service endpoint.

## Existing Services

Use existing customer infrastructure by setting:

```hcl
postgres = {
  mode          = "external"
  existing_host = "customer-postgres.postgres.database.azure.com"
}

temporal = {
  mode          = "external"
  existing_host = "customer-temporal.example.com:7233"
  namespace     = "default"
  task_queue    = "opengeni-runs-ts"
}

object_storage = {
  mode = "external"
  api  = "azure-blob"
}
```

External mode means Terraform does not create that dependency. The Helm values or secret manager integration must still provide the runtime values expected by OpenGeni, such as `OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING` for Azure Blob.

## Managed AKS Capacity

Keep non-secret production node capacity separate from the rest of the
environment configuration:

```hcl
managed_aks_capacity = {
  node_count = 4
}
```

When set, this policy is authoritative for the managed AKS system-pool node
count. When omitted, the existing `aks.node_count` behavior is unchanged.

## Managed PostgreSQL Capacity

Keep non-secret production capacity separate from the credential-bearing `postgres`
object. This lets private deployment automation pin the live capacity without
copying or rewriting the administrator password:

```hcl
managed_postgres_capacity = {
  sku_name          = "GP_Standard_D4ds_v5"
  storage_mb        = 131072
  storage_tier      = "P10"
  auto_grow_enabled = true
}
```

When set, this policy is authoritative for managed PostgreSQL compute and
storage. When omitted, the existing `postgres.sku_name` and
`postgres.storage_mb` behavior is unchanged and provider defaults apply to
storage tier and autogrow.

## Resource Records

Before applying this module, decide where the operator will keep exact resource
names, cleanup notes, and generated access material. Keep those records outside
the repository along with Terraform state, plans, kubeconfigs, and filled
tfvars.

## Safe Defaults

- Default region is `westeurope`. If Azure PostgreSQL is offer-restricted there for the active subscription, set `postgres.location` to an allowed region such as `northeurope` while keeping the rest of the stack in the primary region.
- Default AKS node count is 2.
- AKS node-pool upgrades default to Azure's standard `10%` max surge and can be overridden through the `aks` object.
- If `aks.microsoft_defender_log_analytics_workspace_id` is set, Terraform enables the AKS Microsoft Defender block. The workspace ID field is ignored after creation because Azure may normalize resource ID casing in plan output.
- Key Vault purge protection defaults to enabled for production-like usage. Disable it only for short-lived evaluation resources that must be deleted immediately.
- ACR pull role assignment defaults to enabled. Set `create_acr_pull_role_assignment = false` if the current Azure identity cannot create role assignments; in that case an operator with RBAC permissions must grant AKS `AcrPull` before private images can run.
- Deployment automation identities that call `az aks get-credentials --admin`
  must be supplied through `aks_admin_principal_ids` so Terraform grants the
  Azure Kubernetes Service Cluster Admin Role on the created AKS cluster. Do not
  patch this permission manually and then claim the environment is reproducible;
  if the private ops workflow cannot load AKS credentials from its configured
  Azure OIDC identity, the deployment is not ready.
- Deployment automation identities that create or update public app DNS records
  must be supplied through `dns_zone_contributor_assignments` so Terraform
  grants DNS Zone Contributor on the exact Azure DNS zone. Do not manually patch
  DNS RBAC after a failed deploy and then claim the environment is reproducible;
  if the private ops workflow cannot set the configured app A record, the
  deployment is not ready.
- Object storage defaults to managed Azure Blob for Azure reference deployments with private container access, nested public blob access disabled, blob versioning enabled, and seven-day blob/container delete retention. The sensitive connection string is exposed only as a sensitive Terraform output and should be written to Key Vault or a Kubernetes Secret, not source control.
- Temporal can be `external` for Temporal Cloud/customer endpoints or `officialChart` for the stack-wrapper managed upstream Temporal chart. The chart still needs durable Postgres persistence prepared outside the OpenGeni app chart.
- For temporary AKS/Flexible Server smoke tests, `postgres.allow_azure_services = true` can unblock Azure-internal access. Prefer private networking or tightly scoped `postgres.firewall_rules` for long-lived deployments.
- If a failed Azure PostgreSQL create reserves a server name without leaving an importable resource, set `postgres.name` to a new cleanup-friendly name and rerun the private-state plan. Set `postgres.zone` explicitly after creation if Azure reports a provider drift from an assigned zone.

If Terraform cannot create role assignments, ask an operator with sufficient Azure RBAC permissions to run:

```bash
az role assignment create \
  --assignee "$(terraform output -raw aks_kubelet_object_id)" \
  --role AcrPull \
  --scope "$(az acr show --name "$(terraform output -raw acr_login_server | cut -d. -f1)" --query id -o tsv)"
```

Until that is done, use a temporary Kubernetes image pull secret only for private evaluation.

For deployment automation identity access, prefer setting
`aks_admin_principal_ids` and reapplying Terraform. A direct `az role
assignment create --role "Azure Kubernetes Service Cluster Admin Role"` command
is break-glass only and must be followed by codifying the principal ID in the
private tfvars/state before readiness can be claimed.

For workflow-managed DNS records, prefer setting
`dns_zone_contributor_assignments` and reapplying Terraform. A direct `az role
assignment create --role "DNS Zone Contributor"` command is break-glass only and
must be followed by codifying the DNS zone and principal ID in the private
tfvars/state before readiness can be claimed.

## Example

```bash
terraform init
terraform plan \
  -var 'deployment_phase=complete' \
  -var 'name_prefix=opengeni-dev' \
  -var 'resource_group_name=rg-opengeni-dev' \
  -var 'postgres={"mode":"external","existing_host":"existing.postgres.database.azure.com"}' \
  -var 'temporal={"mode":"officialChart","namespace":"default","task_queue":"opengeni-runs-ts"}' \
  -var 'object_storage={"mode":"managed","api":"azure-blob","bucket":"opengeni-files"}'
```

Do not commit `terraform.tfvars`, `.terraform/`, plans, state files, kubeconfigs, or generated credentials.
