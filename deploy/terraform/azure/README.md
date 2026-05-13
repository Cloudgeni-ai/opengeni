# OpenGeni Azure Reference Deployment

This Terraform root module is the Azure reference substrate for OpenGeni. It is intentionally focused on platform primitives and does not store application secrets in source control.

## What It Creates

- Resource group, when `create_resource_group = true`.
- Azure Container Registry.
- AKS cluster with OIDC issuer and workload identity enabled.
- Azure Key Vault with RBAC authorization enabled.
- Azure Database for PostgreSQL Flexible Server when `postgres.mode = "managed"`.
- `pgcrypto` and `pgvector` enablement for managed Postgres through the `azure.extensions` server configuration.
- Azure Storage account and private Blob container when `object_storage.mode = "managed"` and `object_storage.api = "azure-blob"`.
- ACR pull role assignment for AKS kubelet identity.
- Optional AKS Microsoft Defender attachment to an existing Log Analytics workspace.

## Phases

Use `deployment_phase = "bootstrap"` to create cloud substrate before runtime dependencies are known. Bootstrap mode does not require Temporal, object storage, or external Postgres endpoints unless those resources are being created by Terraform.

Use `deployment_phase = "complete"` when rendering or applying a fully configured deployment. Complete mode requires all external runtime endpoints.

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

## Resource Tracking

Before applying this module, add the planned resource group and resource names to `docs/azure-resource-ledger.md`. After apply, update the ledger with exact names and cleanup commands.

## Safe Defaults

- Default region is `westeurope`.
- Default AKS node count is 2.
- AKS node-pool upgrades default to Azure's standard `10%` max surge and can be overridden through the `aks` object.
- If `aks.microsoft_defender_log_analytics_workspace_id` is set, Terraform enables the AKS Microsoft Defender block. The workspace ID field is ignored after creation because Azure may normalize resource ID casing in plan output.
- Key Vault purge protection defaults to enabled for production-like usage. Disable it only for temporary verification resources that must be deleted immediately.
- ACR pull role assignment defaults to enabled. Set `create_acr_pull_role_assignment = false` if the current Azure identity cannot create role assignments; in that case an operator with RBAC permissions must grant AKS `AcrPull` before private images can run.
- Object storage defaults to managed Azure Blob for Azure reference deployments with private container access, nested public blob access disabled, blob versioning enabled, and seven-day blob/container delete retention. The sensitive connection string is exposed only as a sensitive Terraform output and should be written to Key Vault or a Kubernetes Secret, not source control.
- Temporal is external by default because production Temporal may be Temporal Cloud, customer-provided, or self-hosted separately.

If Terraform cannot create role assignments, ask an operator with sufficient Azure RBAC permissions to run:

```bash
az role assignment create \
  --assignee "$(terraform output -raw aks_kubelet_object_id)" \
  --role AcrPull \
  --scope "$(az acr show --name "$(terraform output -raw acr_login_server | cut -d. -f1)" --query id -o tsv)"
```

Until that is done, use a temporary Kubernetes image pull secret only for verification.

## Example

```bash
terraform init
terraform plan \
  -var 'deployment_phase=complete' \
  -var 'name_prefix=opengeni-dev' \
  -var 'resource_group_name=rg-opengeni-dev' \
  -var 'postgres={"mode":"external","existing_host":"existing.postgres.database.azure.com"}' \
  -var 'temporal={"mode":"external","existing_host":"temporal.example.com:7233","namespace":"default","task_queue":"opengeni-runs-ts"}' \
  -var 'object_storage={"mode":"managed","api":"azure-blob","bucket":"opengeni-files"}'
```

Do not commit `terraform.tfvars`, `.terraform/`, plans, state files, kubeconfigs, or generated credentials.
