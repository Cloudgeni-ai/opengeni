# Deployment

OpenGeni deployment work is organized around a repo-owned deployment contract, deterministic artifacts, and conformance checks. Repository CI validates deployment artifacts; it does not deploy maintainer-owned preview infrastructure from pull requests.

## Profiles

List supported profiles:

```bash
bun run deployment:profiles
```

Render a stack plan before creating anything. The plan lists resource classes,
platform dependencies managed by wrapper commands, external dependencies,
required secret keys, deploy commands, verification commands, and destroy
commands:

```bash
bun run deployment:stack -- --profile gcp-managed
bun run deployment:stack -- --profile aws-existing-services --json
```

After Terraform apply, generate private deployment artifacts from Terraform
outputs and the current shell environment. The generated Helm values file
contains non-secret provider wiring; `runtime.env` is intended for a private
Kubernetes Secret and must not be committed:

```bash
terraform -chdir=deploy/terraform/gcp output -json \
  > .agent/generated/gcp-managed/terraform-output.json

OPENGENI_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
  bun run deployment:runtime-artifacts -- \
  --profile gcp-managed \
  --terraform-output .agent/generated/gcp-managed/terraform-output.json \
  --out-dir .agent/generated/gcp-managed

kubectl -n opengeni create secret generic opengeni-runtime \
  --from-env-file=.agent/generated/gcp-managed/runtime.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

For Azure managed Blob storage, the artifact generator can consume the
sensitive Terraform output `object_storage_azure_connection_string` into the
private `runtime.env` file. Keep the Terraform output JSON under `.agent/` or
another ignored private path.

Inspect required modes, environment variables, and checks:

```bash
bun run deployment:preflight -- --profile azure-existing-services
```

Run live connectivity probes against the current shell environment and Kubernetes context:

```bash
KUBECONFIG=/path/to/kubeconfig bun run deployment:preflight -- --profile azure-managed --live
```

Run API-level deployment conformance against a reachable OpenGeni API:

```bash
bun run deployment:conformance -- --base-url https://opengeni.example.com
```

For deployments with the built-in shared-key boundary enabled, pass the same key
used by the backend. Conformance sends it as `x-opengeni-access-key`, verifies
that client config is secret-free, verifies protected routes reject missing
keys, discovers the workspace through `/v1/access/me`, and then exercises
workspace-scoped API/SSE requests:

```bash
OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  bun run deployment:conformance -- --base-url https://opengeni.example.com
```

For managed deployments, conformance should use an OpenGeni product API key for
the test workspace:

```bash
OPENGENI_CONFORMANCE_PRODUCT_TOKEN="$OPENGENI_TEST_WORKSPACE_API_KEY" \
  bun run deployment:conformance -- --base-url https://staging.app.opengeni.ai
```

If the target reports deployment-key auth and no conformance deployment key is
provided, conformance fails instead of treating auth as a skipped check.

Managed SaaS operators should keep their release pipeline, live Stripe account
checks, staging/prod canaries, backup/restore drills, observability evidence,
and private deployment inventory in an operator-controlled private repository or
secret-managed CI system. The open-source repository intentionally provides the
reusable product, chart, Terraform roots, and conformance commands; it does not
ship Cloudgeni-specific operational release gates or live-account scripts.

For private in-cluster MinIO behind a local port-forward, keep the presigned URL host intact with curl's connect mapping:

```bash
bun run deployment:conformance -- \
  --base-url http://127.0.0.1:18080 \
  --object-connect-to opengeni-minio:9000:127.0.0.1:19000
```

The object-storage check performs a browser-style `OPTIONS` preflight before
the signed `PUT`. Managed and external buckets must allow direct upload CORS
for the deployed web origin. Prefer exact HTTPS origins in production; use `*`
only for disposable private evaluation stacks where signed URLs and the
OpenGeni access key are the real access boundaries.

The conformance command verifies API health, Prometheus metrics exposure, a real session run, event replay, SSE replay, manual scheduled-task dispatch, and file upload/download unless the corresponding `--skip-observability`, `--skip-agent`, `--skip-scheduled-tasks`, or `--skip-storage` flag is set. Skipped checks are explicit verification gaps, not proof that the skipped subsystem works.

For Azure Blob-backed deployments, no object host rewrite should be needed because upload/download URLs are public Azure Blob SAS URLs:

```bash
bun run deployment:conformance -- \
  --base-url http://127.0.0.1:18080 \
  --timeout-seconds 180
```

Current profiles:

- `local-compose`: existing Docker Compose development stack.
- `local-kubernetes`: local Kubernetes cluster running the Helm chart with in-cluster dependencies.
- `kubernetes-external`: Kubernetes workloads connected to existing customer services.
- `azure-managed`: AKS plus Azure-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `azure-existing-services`: Azure Kubernetes workloads connected to existing Postgres, Temporal, and object storage.
- `aws-managed`: EKS plus AWS-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `aws-existing-services`: EKS workloads connected to existing Postgres, Temporal, and object storage.
- `gcp-managed`: GKE plus GCP-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `gcp-existing-services`: GKE workloads connected to existing Postgres, Temporal, and object storage.
- `preview-pr`: operator-managed pull-request preview environment shape.
- `preview-branch`: operator-managed branch preview environment shape.
- `self-contained-kubernetes`: Kubernetes-hosted dependencies for demos or air-gapped evaluation.

## Local Docker Compose

`bun run dev` is the primary local Docker Compose path. It starts Postgres, NATS, Temporal, MinIO, migrations, the sandbox image build, API, worker, and web.

When a common host port is already occupied, `bun run dev` auto-selects a nearby free port for Docker Compose and rewrites the in-memory runtime URLs for that run. Set `OPENGENI_POSTGRES_HOST_PORT`, `OPENGENI_NATS_HOST_PORT`, `OPENGENI_NATS_MONITOR_HOST_PORT`, `OPENGENI_TEMPORAL_HOST_PORT`, `OPENGENI_MINIO_HOST_PORT`, or `OPENGENI_MINIO_CONSOLE_HOST_PORT` in `.env` if you need fixed local port choices.

## Build Images

Build local OpenGeni workload images:

```bash
bun run image:build:api
bun run image:build:worker
bun run image:build:web
```

Image builds default to `linux/amd64`, matching the Azure AKS reference node pool. Override with `OPENGENI_IMAGE_PLATFORM` for another target.

For production Helm releases, pin API, worker, web, and migration images by digest as well as tag. The chart renders images as `repository:tag@sha256:...` when `image.digest` is set, which keeps tags readable while making the deployed artifact immutable.

The sandbox image remains separate:

```bash
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
```

## Helm

Render the chart with an existing secret:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set global.imageRegistry=REGISTRY.example.com \
  --set secret.existingSecret=opengeni-runtime
```

For production NATS, use an existing endpoint or the official NATS chart and pass the resulting URL through `nats.url` or `OPENGENI_NATS_URL`. The chart-owned NATS template is only a disposable fixture for local and smoke verification:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set nats.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

For a self-contained Kubernetes smoke deployment, enable the optional dependency primitives:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set postgres.enabled=true \
  --set temporal.enabled=true \
  --set nats.enabled=true \
  --set minio.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

For local Kubernetes parity testing, build local images and install the same chart into the local cluster:

```bash
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target api -t opengeni-api:local-k8s .
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target worker -t opengeni-worker:local-k8s .
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target web -t opengeni-web:local-k8s .
kind load docker-image opengeni-api:local-k8s opengeni-worker:local-k8s opengeni-web:local-k8s --name "${KIND_CLUSTER_NAME:-opengeni-local}"

export OPENGENI_ACCESS_KEY="${OPENGENI_ACCESS_KEY:?set OPENGENI_ACCESS_KEY for local shared-key auth}"
kubectl create namespace opengeni-local --dry-run=client -o yaml | kubectl apply -f -
kubectl -n opengeni-local create secret generic opengeni-runtime-local-k8s \
  --from-literal=OPENGENI_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install opengeni-local deploy/helm/opengeni \
  --namespace opengeni-local \
  --values deploy/helm/opengeni/values.local-kubernetes.example.yaml
```

Then run conformance through port-forwards:

```bash
kubectl -n opengeni-local port-forward svc/opengeni-local-api 28080:8000
kubectl -n opengeni-local port-forward svc/opengeni-local-minio 29000:9000

OPENGENI_CONFORMANCE_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  bun run deployment:conformance -- \
  --base-url http://127.0.0.1:28080 \
  --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000
```

The chart defaults API, worker, and web deployments to zero-surge rolling updates (`maxSurge: 0`, `maxUnavailable: 1`) so one-node smoke clusters do not need spare node capacity during upgrades. Increase surge settings in larger production clusters if you want faster replacement and have capacity headroom.

The in-cluster Postgres, Temporal, NATS, and MinIO templates are disposable conformance fixtures for local Kubernetes, CI, and smoke verification. They are not lightweight production alternatives or the production distribution of those systems. Production operators should use managed services, existing customer endpoints, or official upstream charts/operators, and provider-native object storage through the runtime secret.

Production self-hosted platform dependencies should use mature upstream projects rather than OpenGeni-owned replicas of those systems:

- NATS: official NATS Helm chart, or an existing managed/customer NATS endpoint.
- Temporal: Temporal Cloud, an existing customer endpoint, or the official Temporal Helm chart connected to external persistence.
- Postgres: managed cloud Postgres, an existing customer database, or a production PostgreSQL operator such as CloudNativePG.
- Secrets: External Secrets Operator with Azure Key Vault, AWS Secrets Manager, GCP Secret Manager, Vault, or an equivalent store.
- TLS: cert-manager, cloud load balancer certificate integration, or an existing ingress/TLS stack.
- Observability: OpenTelemetry Collector/Operator plus Prometheus Operator-compatible resources, exported to a self-hosted LGTM-compatible stack or a managed cloud backend.

The OpenGeni Helm chart owns OpenGeni API, web, worker, migrations, and integration resources such as `ServiceMonitor`, `PrometheusRule`, `ExternalSecret`, and workload NetworkPolicies. It must not become a replacement chart for NATS, Temporal, Postgres, cert-manager, or the observability platform.

The stack wrapper may install upstream charts as a convenience layer. That
keeps lifecycle commands visible and reversible without making those charts
OpenGeni chart dependencies. For managed cloud profiles, the generated stack
plan includes:

- upstream NATS from `https://nats-io.github.io/k8s/helm/charts`, release
  `opengeni-nats` in namespace `opengeni-platform`;
- upstream Temporal from `https://go.temporal.io/helm-charts`, release
  `opengeni-temporal` in namespace `opengeni-platform`;
- `deploy/stacks/opengeni-platform-networkpolicies.yaml`, which keeps those
  ClusterIP services limited to OpenGeni API/worker pods when the cluster CNI
  enforces Kubernetes `NetworkPolicy`;
- runtime endpoints wired as `nats://opengeni-nats.opengeni-platform.svc.cluster.local:4222`
  and `opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233`.

Temporal still needs durable persistence. The committed example upstream
Temporal values file at
`deploy/stacks/official-temporal-postgres.values.example.yaml` documents the
shape, but stack runs should generate a private values file under
`.agent/generated/` instead of editing the example:

```bash
TEMPORAL_POSTGRES_HOST="$(terraform -chdir=deploy/terraform/gcp output -raw postgres_host)" \
  bun run deployment:temporal-values -- \
  --out .agent/generated/official-temporal-postgres.values.yaml
```

The generator writes no database password. By default it uses the managed
Postgres admin user `opengeni` and asks the upstream Temporal schema jobs to
create/manage the `temporal` and `temporal_visibility` databases. Create a
Kubernetes Secret named `opengeni-temporal-postgres` in `opengeni-platform`
with that user's password. Keep that database server and secret outside the
OpenGeni app chart lifecycle.
Use `TEMPORAL_POSTGRES_CONNECT_ADDR=host:port` instead of
`TEMPORAL_POSTGRES_HOST` when the provider-specific connection endpoint already
includes a port or needs a proxy-local address.

Some managed PostgreSQL services require encrypted connections. For AWS RDS,
the managed stack wrapper downloads the AWS RDS global CA bundle into
`.agent/generated/<profile>/`, creates a private `opengeni-postgres-ca`
ConfigMap in `opengeni-platform`, and generates Temporal SQL TLS settings with:

```bash
TEMPORAL_POSTGRES_TLS_ENABLED=true
TEMPORAL_POSTGRES_TLS_CA_FILE=/etc/opengeni/postgres-ca/ca.pem
TEMPORAL_POSTGRES_TLS_CA_CONFIG_MAP_NAME=opengeni-postgres-ca
```

Use an encrypted OpenGeni application database URL for the same service, for
example `OPENGENI_DATABASE_URL=postgres://.../opengeni?sslmode=require` for AWS
RDS. If a different provider or customer database requires a custom CA, mount
that CA through a private ConfigMap/Secret and set the same Temporal TLS env
vars before running `bun run deployment:temporal-values`.

After the upstream Temporal chart is running, the stack wrapper applies
`deploy/stacks/official-temporal-namespace-job.yaml` to register the Temporal
namespace used by OpenGeni (`default` by default). The OpenGeni worker cannot
poll task queues until that Temporal namespace exists.

Use this boundary when building a production cluster:

| Capability | Production source | OpenGeni wiring |
| --- | --- | --- |
| NATS | Existing endpoint or official NATS chart from `https://nats-io.github.io/k8s/helm/charts/` | `nats.enabled=false` plus `nats.url` or `OPENGENI_NATS_URL` |
| Temporal | Temporal Cloud, existing endpoint, or official Temporal chart from `https://go.temporal.io/helm-charts` with external persistence | `temporal.enabled=false` plus `OPENGENI_TEMPORAL_HOST` |
| Postgres | Managed cloud Postgres, existing database, or CloudNativePG from `https://cloudnative-pg.github.io/charts` | `postgres.enabled=false` plus `OPENGENI_DATABASE_URL` |
| Secrets | External Secrets Operator from `https://charts.external-secrets.io`, Vault, or cloud-native secret delivery | `externalSecret.enabled=true` or `secret.existingSecret` |
| TLS | cert-manager, cloud load balancer certificates, or an existing ingress/TLS stack | `ingress.tls` and SSE-safe ingress annotations |
| Observability | OpenTelemetry Collector/Operator, Prometheus Operator CRDs, or a managed OTLP/Prometheus backend | `/metrics`, OTLP env, `ServiceMonitor`, `PrometheusRule` |

The secret must provide runtime values such as:

- `OPENGENI_DATABASE_URL`
- `OPENGENI_TEMPORAL_HOST`
- `OPENGENI_NATS_URL` when not using in-cluster NATS
- `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` when dependencies need longer startup windows
- `OPENGENI_OPENAI_API_KEY` or Azure OpenAI equivalents
- `OPENGENI_OBJECT_STORAGE_BACKEND=s3-compatible` plus endpoint/access-key settings for local/self-contained modes
- `OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob` plus Azure Blob connection string/account-key settings
- `OPENGENI_OBJECT_STORAGE_BACKEND=aws-s3` plus `OPENGENI_OBJECT_STORAGE_REGION`; prefer IRSA/EKS Pod Identity over static keys
- `OPENGENI_OBJECT_STORAGE_BACKEND=gcs` plus `OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID`; prefer GKE Workload Identity over service-account JSON
- `OPENGENI_PRODUCT_ACCESS_MODE=local|configured|managed`, independent of cloud/infrastructure profile
- `OPENGENI_BILLING_MODE=disabled|stripe`, `OPENGENI_ENTITLEMENTS_MODE=none|static|managed`, and `OPENGENI_USAGE_LIMITS_MODE=none|static|managed`
- `OPENGENI_AUTH_REQUIRED=true` and `OPENGENI_ACCESS_KEY` only when using the optional deployment shared-key boundary
- `OPENGENI_BETTER_AUTH_SECRET`, trusted origins, public base URL, Resend key, and delegation secret when `OPENGENI_PRODUCT_ACCESS_MODE=managed`
- `OPENGENI_STRIPE_SECRET_KEY`, publishable key, webhook secret, and model pricing JSON when `OPENGENI_BILLING_MODE=stripe`
- sandbox backend credentials when required

Do not commit real secret values.

OpenGeni's storage package intentionally exposes a small provider-neutral boundary instead of calling provider SDKs directly from routes. The current shipped backends are `s3-compatible`, `azure-blob`, `aws-s3`, and `gcs`; sandbox file resources are emitted as native storage mounts when the sandbox backend supports them, or materialized through short-lived signed downloads when a backend cannot mount that provider directly. Additional providers should be added behind the same boundary, or bridged through a library such as `files-sdk` if that becomes the lowest-maintenance adapter layer.

Sandbox file mount support is also backend-specific:

| Sandbox backend | S3-compatible | Azure Blob | AWS S3 | GCS |
| --- | --- | --- | --- | --- |
| Docker/local in-container sandboxes | rclone mount | rclone mount | signed download materialization | signed download materialization |
| Modal | SDK cloud bucket mount | signed download materialization | signed download materialization | signed download materialization |

## Security Boundary

OpenGeni separates deployment edge access from product access. `OPENGENI_AUTH_REQUIRED=true` is an optional deployment shared-key boundary for smoke tests and simple self-hosting. It is not the tenant model and it does not create users, accounts, workspaces, or billing state. Set `OPENGENI_ACCESS_KEY` through a Kubernetes Secret, ExternalSecret, or provider secret manager; clients send it as `x-opengeni-access-key`.

Product access is controlled by `OPENGENI_PRODUCT_ACCESS_MODE`:

- `local` bootstraps a local default account/workspace.
- `configured` supports self-hosted embedded deployments with delegated bearer tokens or the deployment shared-key boundary.
- `managed` uses Better Auth for browser human auth, OpenGeni-owned API keys for product/API access, Stripe prepaid credits, usage, limits, and local entitlement mirrors.

Long-lived public deployments should still sit behind a gateway or ingress stack that provides:

- TLS termination with a managed certificate.
- Authentication and authorization for every user-facing route.
- Rate limits and request size limits appropriate for session, file, and SSE traffic.
- Long-lived SSE support with buffering disabled and read/send timeouts of at least `3600` seconds.
- Access logs that include request id, user or tenant id from the gateway, route, status, and duration.
- Explicit deny rules for internal-only surfaces if you expose only the public client API.

When `OPENGENI_AUTH_REQUIRED=true`, `/v1/config/client` remains public but does not expose the access key, `/healthz` is public by default for Kubernetes probes, and `/metrics` is protected by default unless `OPENGENI_AUTH_ALLOW_METRICS=true` is set for an internal scraper path.

For AKS smoke deployments using `ingress-nginx` behind an Azure LoadBalancer service, configure the ingress controller service health probes explicitly. HTTP/HTTPS probes to `/` can mark ingress-nginx unhealthy when the default backend returns a non-200 response, leaving the public VIP allocated but unrouted. TCP probes are sufficient for the temporary ingress-controller smoke path:

```yaml
controller:
  service:
    annotations:
      service.beta.kubernetes.io/azure-load-balancer-health-probe-protocol: Tcp
      service.beta.kubernetes.io/port_80_health-probe_protocol: Tcp
      service.beta.kubernetes.io/port_443_health-probe_protocol: Tcp
```

Secret delivery should use one of these patterns:

- Kubernetes Secret created by an external secret operator from Azure Key Vault, Vault, Doppler, 1Password, or an equivalent system.
- Workload identity plus an application-side secret fetcher, once the application layer owns that integration.
- A short-lived manually created Kubernetes Secret only for smoke tests.

Do not put provider credentials, model keys, storage keys, kubeconfigs, TLS private keys, Terraform state, or generated connection strings in committed values files. Sandbox credentials are opt-in through `OPENGENI_SANDBOX_PREPARATION_PROFILES` and `OPENGENI_SANDBOX_ENV_ALLOWLIST`; keep the default `none` profile unless the run truly needs cloud or GitHub credentials inside the sandbox.

## Observability

The API exposes Prometheus-compatible metrics at `/metrics` and records request counters and duration histograms with service, environment, component, route, method, and status labels. API and worker processes can emit structured JSON logs and OTLP/HTTP JSON traces.

Useful settings:

- `OPENGENI_OBSERVABILITY_STRUCTURED_LOGS=true` for JSON logs.
- `OPENGENI_OBSERVABILITY_METRICS_ENABLED=true` to expose API metrics.
- `OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` to export spans to an OpenTelemetry Collector.
- `OPENGENI_OTEL_EXPORTER_OTLP_HEADERS=key=value,...` for exporter headers; put this in a secret when it contains credentials.

The Helm chart can deploy a lightweight OpenTelemetry Collector:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set observability.otel.enabled=true \
  --set observability.collector.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

When the chart-managed collector is enabled and no explicit OTLP endpoint is set, workloads export spans to the release-local collector service. The default collector config receives OTLP/HTTP traces and scrapes the API `/metrics` endpoint, then exports through the collector `debug` exporter. Production operators should replace `observability.collector.config` with their Azure Monitor, OTLP, Prometheus remote-write, Grafana, Datadog, or other backend exporter configuration.

Minimum production dashboards should cover:

- API traffic: request rate, error rate, and p50/p95/p99 latency by `route`, `method`, `status`, `environment`, and `component`.
- Worker execution: activity run rate, failure rate, and p50/p95/p99 `runAgentSegment` duration by `activity`, `status`, `environment`, and `component`.
- Dependency health: Postgres connection health, Temporal worker poll health, NATS connectivity, object-storage write/read conformance, and sandbox backend readiness.
- Session health: sessions created, turns completed, turns failed, scheduled task dispatch latency, SSE reconnect/replay success, and queue depth once those counters are added.
- Runtime health: API/worker restarts, CPU/memory saturation, pod pending time, collector scrape/export errors, and OTLP export failures.

Prometheus-style examples:

```promql
sum by (route, method) (rate(opengeni_http_requests_total{environment="production"}[5m]))
```

```promql
sum by (route) (rate(opengeni_http_requests_total{environment="production",status=~"5.."}[5m]))
/
sum by (route) (rate(opengeni_http_requests_total{environment="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(opengeni_http_request_duration_seconds_bucket{environment="production"}[5m]))
)
```

```promql
sum by (activity, status) (rate(opengeni_worker_activity_runs_total{environment="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, activity) (rate(opengeni_worker_activity_duration_seconds_bucket{environment="production"}[5m]))
)
```

Minimum production alerts:

- API availability: `/healthz` is unavailable from the ingress or synthetic probe for more than 2 minutes.
- API errors: 5xx ratio is above 2% for 10 minutes, or any critical route stays above 5% for 5 minutes.
- API latency: p95 latency is above the product SLO for 10 minutes, tracked separately for `/v1/workspaces/:workspaceId/sessions`, event replay, SSE, scheduled-task trigger, and file routes.
- Worker failures: `runAgentSegment` failure ratio is above 5% for 10 minutes.
- Worker duration: p95 `runAgentSegment` duration is above the expected model/tool budget for 15 minutes.
- Scheduler health: manual scheduled-task conformance does not dispatch a session through Temporal within the configured timeout.
- Storage health: object-storage conformance cannot create, complete, presign, and read a file.
- Streaming health: SSE replay conformance does not return persisted events after reconnect.
- Collector health: collector pod is not ready, cannot scrape API metrics, or its configured exporter reports failures.
- Secret/sandbox hygiene: conformance detects unintended sandbox environment variables or sandbox backend startup failures.

## Azure Reference

The Azure Terraform root lives at `deploy/terraform/azure`.

It supports:

- AKS for OpenGeni workloads.
- ACR for images.
- Key Vault for runtime secret storage.
- Managed Azure PostgreSQL when `postgres.mode = "managed"`.
- Existing customer Postgres when `postgres.mode = "external"`.
- Existing Temporal endpoint when `temporal.mode = "external"`.
- Managed Azure Blob storage when `object_storage.mode = "managed"` and `object_storage.api = "azure-blob"`.
- Existing Azure Blob or S3-compatible object storage through runtime secrets.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed Blob URLs.

Before applying anything in Azure:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, Key Vault, or Terraform variables that are not committed.
3. Run:

```bash
terraform -chdir=deploy/terraform/azure init
terraform -chdir=deploy/terraform/azure validate
terraform -chdir=deploy/terraform/azure plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## AWS Reference

The AWS Terraform root lives at `deploy/terraform/aws`.

It supports EKS, ECR, S3, AWS Secrets Manager, optional RDS PostgreSQL, and existing Postgres/Temporal endpoints. Use `deploy/helm/opengeni/values.aws-managed.example.yaml` as the non-secret Helm values shape.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed S3 URLs.

Before applying anything in AWS:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, AWS Secrets Manager, or uncommitted Terraform variables.
3. Run:

```bash
terraform -chdir=deploy/terraform/aws init -backend=false
terraform -chdir=deploy/terraform/aws validate
terraform -chdir=deploy/terraform/aws plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## GCP Reference

The GCP Terraform root lives at `deploy/terraform/gcp`.

It supports GKE, Artifact Registry, GCS, Secret Manager, workload identity, optional Cloud SQL PostgreSQL, and existing Postgres/Temporal endpoints. Use `deploy/helm/opengeni/values.gcp-managed.example.yaml` as the non-secret Helm values shape.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed GCS URLs.

Before applying anything in GCP:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, Secret Manager, or uncommitted Terraform variables.
3. Run:

```bash
terraform -chdir=deploy/terraform/gcp init -backend=false
terraform -chdir=deploy/terraform/gcp validate
terraform -chdir=deploy/terraform/gcp plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## Previews

The public repository does not include a pull-request workflow that deploys to
maintainer-owned infrastructure. The `preview-pr` and `preview-branch` profiles
are reusable stack-contract shapes for operator-owned automation. If an operator
wants preview deployments, they should run `bun run deployment:stack` in their
own CI/CD environment with their own cluster, registry, secrets, and teardown
policy.

Preview profiles are managed-product previews, not fake demos. They use
disposable in-cluster Postgres, Temporal, NATS, and MinIO fixtures so state can
be torn down safely, but they still run the real API, web app, worker, model
provider, and configured sandbox backend. The checked-in
`values.preview-managed.example.yaml` file keeps replicas small and enables the
fixture data plane; generated private runtime artifacts must still provide
managed auth, Resend, Stripe test mode, GitHub App, model-provider, Modal, and
image digest values. Do not use `OPENGENI_SANDBOX_BACKEND=none` for previews
that are meant to validate product behavior.

Preview deployments should be private or maintainer-gated even when signup is
enabled. The source repo may contain the contract, Helm values shape, and
conformance scripts, but not provider secrets, kubeconfigs, Terraform state,
preview tenant data, or unsanitized evidence.

## Conformance

A deployment is not acceptable until it proves:

- API health works.
- Migrations run safely.
- Postgres and pgvector are available.
- Temporal is reachable and workers can poll the task queue.
- NATS pub/sub works.
- SSE reconnect replays from Postgres.
- Object storage can write/read.
- Sandbox backend can start and does not receive unintended credentials.
- A scripted session can create, stream, replay, run, and complete.
- A scheduled task can be created, manually triggered through Temporal, dispatch a session, and be cleaned up.
- Logs, metrics, and traces carry enough correlation data for production debugging.

Use `bun run deployment:stack`, `bun run deployment:preflight`, provider
Terraform validation, Helm rendering, and this conformance suite as the merge
and release gate for deployment changes.
