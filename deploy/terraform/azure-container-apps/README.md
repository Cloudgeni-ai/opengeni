# OpenGeni on Azure Container Apps

An isolated Terraform root for the OpenGeni application layer and Azure
substrate. It creates no AKS cluster, Temporal server, NATS server, sandbox host,
or disposable dependency fixtures. Temporal and Core NATS are **external**,
operator-owned services. Their endpoints, namespace, authentication, persistence,
network reachability, and lifecycle must exist separately.

Static validation is not operational certification. In particular, native
environment HTTP routing uses a pinned preview ARM API, and native Office-file
export is disabled until ACA can safely support the materializer's isolation
requirements. Do not describe this root as feature-complete Kubernetes parity.

`bootstrap` remains the default. When images must first be imported into the
optional created ACR, use `foundation` to create the substrate without any
image-consuming job or app: **foundation → import matching digest images →
bootstrap → manual job Succeeded → exact-image attestation → apps**. ACA
validates migration image pulls when creating the job, not only at execution.

## Owned resources and defaults

| Resource | Contract |
| --- | --- |
| Resource group | New, exclusive deployment-owned group; never a shared production/staging group |
| Network | Dedicated IPv4 `/16` VNet, delegated ACA `/23` and separate PostgreSQL `/24`; no claimed egress firewall or external private-network peering |
| ACA environment | Workload-profiles environment with `Consumption`; Azure also creates a separate named infrastructure resource group |
| PostgreSQL | Private Flexible Server 16; no public access/firewall exception; `VECTOR,PGCRYPTO,BTREE_GIN` extension allowlist; database `opengeni` |
| Database roles | Generated owner `opengeni_owner`, restricted `opengeni_app`, optional dedicated `opengeni_artifact_outbox_dispatcher`; only migration job can read owner/provision passwords |
| Blob storage | Native `azure-blob`, private `opengeni-files` container, TLS, public signed-URL endpoint for browsers/Modal, exact edge-origin CORS, versioning and seven-day soft deletion |
| Secret delivery | Created RBAC Key Vault; separate user-assigned workload identities; `Key Vault Secrets User` scoped to individual created secrets, not the whole vault |
| Logs | Log Analytics, 30-day retention and 1 GB/day ingestion cap by default; cap is not a hard cost ceiling and may stop ingestion |
| Registry | Public anonymous digest pulls by default; optional empty created ACR, admin login disabled, resource-scoped `AcrPull` |
| Phases / bootstrap job | `foundation`: no job/apps; default `bootstrap`: manual API-image migration/provision/posture/catalog job; parallelism/completion `1`, retries `0`, timeout `3600s` |
| Serving | Distinct API, web, control worker, turn worker, optional outbox apps; `Single` revision mode; all minimum replicas at least `1` |
| Browser edge | Native environment `httpRouteConfigs` routes one HTTPS origin to internal-ingress API/web only; workers are never route targets |

Default serving resources are API `0.5 CPU / 1 GiB`, web `0.25 / 0.5 GiB`, control
`0.5 / 1 GiB`, turn `1 / 2 GiB`, optional outbox `0.25 / 0.5 GiB`. API/web scale
between one and two replicas on HTTP concurrency. Workers/outbox default to fixed
one-replica bounds; increasing their maximum enables CPU utilization scaling,
**not Temporal-backlog scaling**. Turn-worker concurrency defaults to one.
Control/turn termination grace is at least 120 seconds to contain the shipped
worker's 100-second shutdown ceiling. Rollout overlap can still occur in single
revision mode; live-test checkpoint/recovery rather than assuming exactly one
physical worker at all times.

## Runtime and auth boundaries

`access_mode = "configured"` is the default and requires
`OPENGENI_ACCESS_KEY` of at least 32 characters; protected requests use
`x-opengeni-access-key`.
`access_mode = "managed"` uses the shipped managed product auth and additionally
requires `OPENGENI_BETTER_AUTH_SECRET`, `OPENGENI_DELEGATION_SECRET`, and
`OPENGENI_RESEND_API_KEY`. Auth/delegation signing secrets must be at least 32
characters. Configure other managed sign-in/email/provider options
through `config_env`/`secret_env` as appropriate. Organization API keys still use
`Authorization: Bearer`; they are not the deployment shared key. Neither serving
mode permits `local` access.

Serving defaults to a real **Modal** sandbox. `none`, `local`, `docker`, and
Connected Machine `selfhosted` are not supported serving choices in this root.
Supply Modal token ID/secret and a real model credential before enabling apps.
The default model credential requirement is `OPENGENI_OPENAI_API_KEY`; for Azure
OpenAI or another deployment provider, change `required_model_secret_env`
together with the shipped provider's non-secret configuration. Other listed
remote backends require their actual credentials/endpoints, and their live
behavior remains separately unverified. For Modal Computer/Browser, explicitly
select a digest-pinned **desktop** image; do not substitute a headless sandbox
image. Private Modal image pulls need an operator-created Modal registry secret;
the ACA `AcrPull` identity cannot authorize Modal's pull.

All serving roles require the stable base64-encoded 32-byte
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`. Secrets are supplied in a sensitive map:

```hcl
secret_env = {
  OPENGENI_OPENAI_API_KEY = {
    value = "<private-secret-manager-value>"
    roles = ["api", "control", "turn"] # default if omitted
  }
}
```

Required auth/model/sandbox credentials must be available to all three roles
because their shared settings parser validates the selected configuration and
the API also owns sandbox-facing features. Optional secrets can be restricted
to selected roles. The web shell receives no application secrets. The outbox
receives only its dedicated database URL and optional NATS authentication
material. The migration job receives only owner/app URLs, exact role-provision
passwords, Blob key, and optional encryption key for historical maintenance
conversions; it never inherits the complete application secret map.

The shipped Azure Blob adapter signs SAS URLs using an account key; it does not
implement managed-identity/user-delegation-key signing. This root stores the
**created account's** key in Key Vault and uses managed identity to retrieve it.
That key remains account-wide authority, not a container-scoped credential.
Do not disable shared-key access or claim keyless Blob access without changing
and verifying the runtime adapter. Account keys, database passwords, and supplied
secrets appear in Terraform state: `sensitive` hides terminal values, not state
contents. Secret references are versionless to permit Key Vault reference
refresh; verify actual rotation behavior before relying on it.

The API exposes only the intentional minimal `/healthz` endpoint at the edge.
Its dependency readiness endpoints are not edge routes. API metrics use a
dedicated unrouted port `9464`; workers' unauthenticated health/metrics listeners
have no ingress at all. `/metrics` at the public web origin is not a Prometheus
scrape endpoint. Use a private, explicitly authorized observability path, not a
public worker route. Do not trust arbitrary forwarded headers: if configuring
`OPENGENI_API_TRUSTED_PROXY_HOPS`/CIDRs, verify the actual ACA ingress chain and
client-source behavior first.

API/web origins and internal FQDNs are derived from the **environment** output,
not each other's app outputs, avoiding Terraform cycles. The public edge is
`<name_prefix>-edge.<environment.default_domain>`; the internal API is
`<name_prefix>-api.internal.<environment.default_domain>`. The public API and web
outputs intentionally have the same origin: official web images compile
`VITE_API_BASE_URL=""`, so runtime environment variables alone cannot wire two
public origins. Exact Blob CORS, cookie/trusted origins, public callbacks, browser
hosts, and public/internal MCP URLs are generated from this topology. The web
image's static server does not itself implement a runtime Host allowlist;
internal ingress/routing is the edge boundary. Custom domains/certificates and
alternate public gateways are not managed by this root.

Native routing preserves `/v1`, `/agent`, the two OAuth metadata path prefixes,
exact `/oauth/register`, `/oauth/authorize`, `/oauth/token`, installer/public-key
paths, and `/healthz`. It does not rewrite those paths or route any worker.
Setup-account email tokens remain in fragment transport: query-bearer mode is
blocked until a separate, proven logging/tracing sanitization design exists.
Native artifact materializer deployment/export is fixed off: tool export is
removed from the ceiling and HTTP export requests fail closed. There is no
privileged sidecar, user-namespace workaround, or successful namespace-portability
claim here.

## Ordered operator workflow

1. Arrange existing production Temporal/NATS services and real model/sandbox
   access. Private external endpoints need operator-owned routing/peering; this
   root only owns its VNet. For disposable live validation, separately owned
   fixtures are acceptable but are not production defaults.
2. Use matching-release digest-pinned official API/worker/web images. With
   `create_acr = false`, images must be anonymously pullable and available before
   applying `bootstrap`. For a new `create_acr = true` registry, start with
   `foundation`, import the matching images separately, update the digests/registry
   host, and then apply `bootstrap`. A job's create operation already validates
   image pull; a private upstream reference without authorized pull credentials
   cannot be used to postpone the import until bootstrap completes. No build/import
   occurs in Terraform, and no role is assigned to an existing external registry.
3. Ensure the applying principal can create the new resource group/resources
   and assign the documented roles on the created vault/secrets/optional ACR.
   An operator must pre-register `Microsoft.App`, `Microsoft.Network`,
   `Microsoft.DBforPostgreSQL`, `Microsoft.Storage`, `Microsoft.KeyVault`,
   `Microsoft.ManagedIdentity`, and `Microsoft.OperationalInsights` (and
   `Microsoft.ContainerRegistry` if used). Both providers disable automatic
   registration; this root does not mutate unrelated subscription providers.
4. Keep filled tfvars, backend metadata, state, plans, and credential-bearing
   logs outside the repository. Use an absolute private deployment directory
   with restrictive permissions. Copy/edit the example there and set
   `deployment_phase = "foundation"` if the created ACR needs image import first,
   otherwise leave the default `"bootstrap"` with already pullable images.
   Production operators should use a locked, encrypted remote backend in a thin
   wrapper consuming this directory as a module; the standalone root's local
   backend is for isolated operator use.

```bash
# Run from the repository root; use your own absolute private directory.
TF_ROOT="$PWD/deploy/terraform/azure-container-apps"
OPENGENI_DEPLOYMENT_DIR="/absolute/private/opengeni-aca"
export TF_DATA_DIR="$OPENGENI_DEPLOYMENT_DIR/terraform-data"

terraform -chdir="$TF_ROOT" init -reconfigure \
  -backend-config="path=$OPENGENI_DEPLOYMENT_DIR/terraform.tfstate"
terraform -chdir="$TF_ROOT" plan \
  -var-file="$OPENGENI_DEPLOYMENT_DIR/terraform.tfvars" \
  -out="$OPENGENI_DEPLOYMENT_DIR/initial.tfplan"
terraform -chdir="$TF_ROOT" apply "$OPENGENI_DEPLOYMENT_DIR/initial.tfplan"
```

   If the initial phase is `foundation`, inspect `acr`, `environment`, and
   `infrastructure_resource_group_name`. There is no migration job or serving
   app; `migration_job` and `migration_job_name` are null (Terraform can omit
   null outputs from CLI output). Import matching-release API/worker/web images,
   plus outbox if enabled, into that **created** ACR using the operator's authorized
   source access. Verify the imported digests and set `images` to their created
   registry references; do not assume a tag or upstream private-registry access
   proves ACA can pull them. Change the private tfvars to `deployment_phase =
   "bootstrap"`, then plan/apply again:

```bash
terraform -chdir="$TF_ROOT" plan \
  -var-file="$OPENGENI_DEPLOYMENT_DIR/terraform.tfvars" \
  -out="$OPENGENI_DEPLOYMENT_DIR/bootstrap.tfplan"
terraform -chdir="$TF_ROOT" apply "$OPENGENI_DEPLOYMENT_DIR/bootstrap.tfplan"
```

5. Now inspect `environment`, `postgres`, `migration_job`, and `secret_references`
   outputs. Bootstrap creates the **job definition**, not an execution. Before
   a maintenance upgrade, drain every old/new API, control worker, turn worker,
   and outbox identity that can use the target DB. Supply every additional login
   through `previous_runtime_database_roles`; this list is drain-detection
   authority only, not a grant to old roles. Never run old images after a
   maintenance cutover.
6. Start the manual job and inspect its exact execution's logs/result. Do not
   enable apps unless it is `Succeeded` and the restricted-role posture step
   passed. There are no automatic job retries; inspect a failure before explicitly
   starting another execution. RBAC propagation/region capacity can require
   remediation; do not interpret a resource definition as successful execution.

```bash
ACA_RESOURCE_GROUP=$(terraform -chdir="$TF_ROOT" output -raw resource_group_name)
ACA_MIGRATION_JOB=$(terraform -chdir="$TF_ROOT" output -raw migration_job_name)
az containerapp job start \
  --resource-group "$ACA_RESOURCE_GROUP" --name "$ACA_MIGRATION_JOB"
az containerapp job execution list \
  --resource-group "$ACA_RESOURCE_GROUP" --name "$ACA_MIGRATION_JOB"
```

The official API image retains `/app/package.json`, Bun, the migrations and role
CLIs, and the committed catalog snapshot. The exact command is:

```sh
cd /app &&
bun run db:migrate &&
bun run db:provision-roles &&
bun run db:assert-runtime-posture &&
OPENGENI_DATABASE_URL="$OPENGENI_MIGRATIONS_DATABASE_URL" \
  bun run catalog:import --snapshot /app/data/catalog/integrations-snapshot.json \
  --if-changed --skip-logos
```

The posture step connects as `opengeni_app`; catalog import switches only that
subprocess to the owner URL. `--skip-logos` skips remote long-tail fetches, not
vendored curated-logo Blob writes. The job uses a maintenance-only local-access,
sandbox-free settings posture because these CLIs serve no ingress and execute
no turns; serving apps always use the production auth/remote-sandbox gate.

7. In the private tfvars, supply all required runtime secrets, set
   `deployment_phase = "apps"`, and set `migration_completed_revision` to the
   **full exact `images.api` digest reference** whose job succeeded. This field
   is an operator attestation, not an automatic ARM execution-status check.
   The gate refuses missing credentials, unsafe modes, and mismatched revision.
   Plan to another private plan file and apply it. Read `edge_route` and confirm
   the reported FQDN/provisioning state matches `api_url`/`web_url` before testing.
8. Run the live checks below. Do not claim an operational deployment solely
   from `fmt`, `validate`, mocked tests, ARM provisioning, or a health response.

For an upgrade requiring maintenance, changing back to `bootstrap` **destroys
the serving apps and route**, not the database/storage/environment. Drain and
verify physical processes have gone away, then run the new exact-image manual
job and set a new successful-revision attestation. A boolean flag, workflow
cancellation, or Terraform creating a job is not drain/completion proof.
Changing a running deployment to `foundation` additionally removes the manual
job; it is not a rolling-upgrade shortcut. The explicit moved block preserves
the existing job's state address as `migration[0]` when adopting this counted
resource in `bootstrap`/`apps`, without recreating it merely for the address change.

## Outputs consumed by operators/tooling

| Output | Meaning |
| --- | --- |
| `resource_group_name`, `infrastructure_resource_group_name` | Both task-owned resource-group names relevant to cleanup |
| `api_url`, `web_url` | Same public HTTPS edge origin, computable during foundation/bootstrap |
| `endpoints` | `api`, `web`, `api_internal`, public workspace-template `mcp` |
| `environment` | `id`, `name`, `default_domain`, `vnet_id`, ACA `subnet_id` |
| `migration_job_name`, `migration_job` | Null in foundation; otherwise manual job name and `id`, group, image, exact application login list, start command |
| `postgres` | Server `id`, `fqdn`, database, app role, migration owner name; no password/URL |
| `secret_references` | Created versionless Key Vault IDs keyed by supplied env name or `migration-db-url`, `application-db-url`, etc.; no values |
| `runtime_nonsecret_env` | Shared non-secret runtime wiring; excludes supplied secret overrides |
| `workload_identities` | Per-role identity/principal/client IDs |
| `blob_storage`, `acr`, `log_analytics_workspace_id` | Storage/CORS metadata, optional registry metadata, logging resource ID |
| `serving_app_ids`, `edge_route` | Created serving resources and route readback; empty/null in foundation/bootstrap |

## Static checks

Terraform `>= 1.13, < 2`, AzureRM `4.72.0`, AzAPI `2.13.0`, random `3.7.2` are
pinned. Commit the provider lock file. Mocked tests do not use Azure credentials
or create cloud resources.

```bash
terraform -chdir=deploy/terraform/azure-container-apps fmt -check -recursive
terraform -chdir=deploy/terraform/azure-container-apps init -backend=false -input=false
terraform -chdir=deploy/terraform/azure-container-apps validate
terraform -chdir=deploy/terraform/azure-container-apps test
```

## Required live verification and remaining limits

- Verify pinned preview `httpRouteConfigs@2024-10-02-preview` availability and
  HTTPS behavior in the chosen region. AzAPI embedded-schema validation is
  disabled **only for this route resource** because availability/schema
  advertisements differ; its ARM body and readback require a live check.
- Verify Key Vault RBAC propagation and identity secret resolution, private
  PostgreSQL connectivity, migration/provision/catalog success, and FORCE-RLS
  posture through the non-owner runtime credential.
- Verify the real browser console, same-origin config/auth routes, managed login
  if selected, authenticated workspace/session creation, replay/SSE reconnect,
  schedules, actual model execution, and remote-sandbox Codemode/MCP connectivity.
  ACA ingress timeouts and SSE recovery require live testing; no streaming-parity
  claim is made by these static settings.
- Verify a denied unauthenticated protected request and denied/unrouted public
  metrics/worker listeners. Public install/health/OAuth discovery exceptions
  are intentional and remain governed by the shipped API's auth behavior.
- Verify browser signed Blob upload/download, exact-origin preflights, remote
  sandbox file materialization/publication, and retained bytes. Public Blob
  reachability is needed for signed browser/Modal URLs; anonymous object access
  must still fail.
- Verify control/turn role ports, replica bounds, revision readback, scaling,
  SIGTERM checkpoint/requeue/recovery, logs, and your private metrics/traces path.
  No default OTLP collector or promised trace exporter is deployed here.
- Native Office export/materialization remains unsupported and fail closed.
  Do not lower namespace/seccomp/privilege isolation to turn it on. Optional
  outbox dispatch alone does not enable native exports.
- Region quotas, PostgreSQL HA/backup sizing, private dependency connectivity,
  secret rotation, custom domains, external Temporal/NATS reliability, and
  production disaster recovery remain operator responsibilities.

## Teardown of isolated validation

Remove any separately created **task fixtures** that depend on this environment
first; do not delete real externally supplied Temporal/NATS services. With the
same private state/tfvars, plan and execute `terraform destroy`. Verify both
owned resource groups and every task-created fixture/resource are absent;
Azure-managed infrastructure-group cleanup can be asynchronous. Do not delete
shared groups or unrelated production/staging resources to make destroy pass.

Key Vault destroy intentionally does not purge soft-deleted vaults. The default
purge protection retains the tombstone for seven days; disposable tests may set
`key_vault_purge_protection_enabled = false` before creation and explicitly purge
**only the exact test vault** during final cleanup. Storage soft-delete retention
and PostgreSQL backups similarly need an explicit retention/cleanup assessment.
Keep state/credentials protected and only remove private task artifacts after
cleanup has been verified and required evidence retained without secrets.

## Source contracts

- [Runtime settings and credential validation](../../../packages/config/src/index.ts)
- [Official workload image stages/commands](../../../docker/opengeni.Dockerfile)
- [Migration job and catalog import reference](../../helm/opengeni/templates/migration-job.yaml)
- [Shipped migration/role/image values](../../helm/opengeni/values.yaml)
- [Azure Blob SAS adapter](../../../packages/storage/src/index.ts)
- [Microsoft native environment routing](https://learn.microsoft.com/azure/container-apps/rule-based-routing)
- [Microsoft VNet requirements](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks)