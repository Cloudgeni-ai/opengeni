# Deployment

OpenGeni deployment work is organized around a repo-owned deployment contract, deterministic artifacts, and conformance checks.

## Profiles

List supported profiles:

```bash
bun run deployment:profiles
```

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

For private in-cluster MinIO behind a local port-forward, keep the presigned URL host intact with curl's connect mapping:

```bash
bun run deployment:conformance -- \
  --base-url http://127.0.0.1:18080 \
  --object-connect-to opengeni-minio:9000:127.0.0.1:19000
```

The conformance command verifies API health, Prometheus metrics exposure, a real session run, event replay, SSE replay, manual scheduled-task dispatch, and file upload/download unless the corresponding `--skip-observability`, `--skip-agent`, `--skip-scheduled-tasks`, or `--skip-storage` flag is set.

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
- `azure-managed`: Azure reference deployment with managed Azure substrate where currently supported.
- `azure-existing-services`: Azure Kubernetes workloads connected to existing Postgres, Temporal, and object storage.
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

For in-cluster NATS:

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

kubectl create namespace opengeni-local --dry-run=client -o yaml | kubectl apply -f -
kubectl -n opengeni-local create secret generic opengeni-runtime-local-k8s --from-env-file=.env

helm upgrade --install opengeni-local deploy/helm/opengeni \
  --namespace opengeni-local \
  --set secret.existingSecret=opengeni-runtime-local-k8s \
  --set api.image.repository=opengeni-api \
  --set api.image.tag=local-k8s \
  --set worker.image.repository=opengeni-worker \
  --set worker.image.tag=local-k8s \
  --set web.image.repository=opengeni-web \
  --set web.image.tag=local-k8s \
  --set migrations.image.repository=opengeni-api \
  --set migrations.image.tag=local-k8s \
  --set postgres.enabled=true \
  --set temporal.enabled=true \
  --set nats.enabled=true \
  --set minio.enabled=true \
  --set config.OPENGENI_SANDBOX_BACKEND=none
```

Then run conformance through port-forwards:

```bash
kubectl -n opengeni-local port-forward svc/opengeni-local-api 28080:8000
kubectl -n opengeni-local port-forward svc/opengeni-local-minio 29000:9000

bun run deployment:conformance -- \
  --base-url http://127.0.0.1:28080 \
  --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000
```

The chart defaults API, worker, and web deployments to zero-surge rolling updates (`maxSurge: 0`, `maxUnavailable: 1`) so one-node smoke clusters do not need spare node capacity during upgrades. Increase surge settings in larger production clusters if you want faster replacement and have capacity headroom.

The in-cluster Postgres, Temporal, and MinIO templates are intended for demos, local Kubernetes, and smoke tests. Production Azure operators should use Azure Blob or another explicitly configured external file adapter through the runtime secret.

The secret must provide runtime values such as:

- `OPENGENI_DATABASE_URL`
- `OPENGENI_TEMPORAL_HOST`
- `OPENGENI_NATS_URL` when not using in-cluster NATS
- `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` when dependencies need longer startup windows
- `OPENGENI_OPENAI_API_KEY` or Azure OpenAI equivalents
- `OPENGENI_OBJECT_STORAGE_BACKEND=s3-compatible` plus endpoint/access-key settings, or `OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob` plus Azure Blob connection string/account-key settings
- sandbox backend credentials when required

Do not commit real secret values.

OpenGeni's storage package intentionally exposes a small provider-neutral boundary instead of calling S3 or Azure Blob directly from routes. The current shipped backends are `s3-compatible` and `azure-blob`; sandbox file resources are emitted as native storage mounts when the sandbox backend supports them, or materialized through the sandbox file API when a backend cannot mount that provider directly. Additional providers should be added behind the same boundary, or bridged through a library such as `files-sdk` if that becomes the lowest-maintenance adapter layer.

Sandbox file mount support is also backend-specific:

| Sandbox backend | S3-compatible storage | Azure Blob storage |
| --- | --- | --- |
| Docker/local in-container sandboxes | Supported through rclone-based in-container mounts. | Supported through rclone-based in-container mounts. |
| Modal | Supported through the SDK's Modal cloud bucket mount strategy. | Supported by reading attached file resources server-side and materializing them into the Modal sandbox before the agent starts. This is not a live Azure Blob mount; large-file policy should be enforced at the upload/product layer. |

## Security Boundary

OpenGeni does not currently ship built-in public auth, tenancy, RBAC, API keys, WAF policy, or rate limiting. Treat the API as an internal service unless an external gateway supplies those controls.

Production ingress should sit behind a gateway or ingress stack that provides:

- TLS termination with a managed certificate.
- Authentication and authorization for every user-facing route.
- Rate limits and request size limits appropriate for session, file, and SSE traffic.
- Long-lived SSE support with buffering disabled and read/send timeouts of at least `3600` seconds.
- Access logs that include request id, user or tenant id from the gateway, route, status, and duration.
- Explicit deny rules for internal-only surfaces if you expose only the public client API.

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
- API latency: p95 latency is above the product SLO for 10 minutes, tracked separately for `/v1/sessions`, event replay, SSE, scheduled-task trigger, and file routes.
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

Before applying anything in Azure:

1. Add planned resources to `docs/azure-resource-ledger.md`.
2. Keep secrets in local env files, Key Vault, or Terraform variables that are not committed.
3. Run:

```bash
terraform -chdir=deploy/terraform/azure init
terraform -chdir=deploy/terraform/azure validate
terraform -chdir=deploy/terraform/azure plan
```

After apply, update the ledger with exact resources and cleanup commands.

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

The strict completion criteria live in `docs/infra-deployment-goal.md`.
