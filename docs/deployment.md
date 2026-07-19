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
outputs and the current shell variable set. The generated Helm values file
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

Inspect required modes, variable-set variables, and checks:

```bash
bun run deployment:preflight -- --profile azure-existing-services
```

Run live connectivity probes against the current shell variable set and Kubernetes context:

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

Do not treat a successful presign as storage acceptance. Release conformance
must exercise the provider-native `OPTIONS` + signed browser `PUT`, API finalize
(which performs authenticated `HEAD`), signed `GET`, and tenant-negative read.
The worker also registers one global `opengeni-file-upload-reaper` Temporal
Schedule. It retains unfinished uploads until the signed URL expires plus one
hour, claims at most 100 objects per run, retries a crashed/failed delete claim
after ten minutes, and settles the RLS row terminal only after the provider's
idempotent delete succeeds. A healthy rollout therefore needs the same worker
Temporal and object-storage access used by normal uploads; disabling or
skipping storage conformance leaves both upload and orphan cleanup unproven.

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
- `preview-pr`: operator-managed pull-request preview variable set shape.
- `preview-branch`: operator-managed branch preview variable set shape.
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

## Verified public release

Merging a changesets Version PR only commits package versions and changelogs; it
does not publish packages or release images. Public release is an explicit
dispatch of `.github/workflows/release.yml` from a ref pinned to the exact
accepted source SHA. The dispatch fails closed unless it receives retained
verification evidence for that exact source, the sanitized acceptance bundle
SHA-256, and an explicit confirmation that there are zero known defects,
skipped checks, or unverified acceptance rows. Publication unblocks separately
built package consumers; production deployment and acceptance follow it as the
release-completion gate. Staging and a fixed soak delay are not prerequisites.
The dispatch also requires the exact expected package set (for example,
`@opengeni/react@0.15.0`). The selected
dispatch ref, `source_sha`, checked-out commit, and a commit reachable from
`main` must all identify the same revision.

The dispatch re-runs the package typecheck, builds, SDK parity test, and publish
closure guard. Before touching npm it rejects any unlisted unpublished package,
rejects local version drift or an occupied version from another git source, and
retains a pre-publication plan. Afterward it requires every expected registry
entry to bind the accepted source through `gitHead` and a SHA-512 integrity
value before release images can build. That reconciliation also makes an
interrupted post-publication run safely resumable. The final
`verified-release-receipt-<sha>` binds the source, acceptance evidence, bundle
digest, and exact registry package identities. Ordinary pushes to `main` can
open/update the Version PR but cannot publish.

The sandbox image remains separate:

```bash
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
```

The Connected Machine stream relay is a separate deployed component built from
the `agent/` Cargo workspace. It is only needed when Connected Machines are
enabled (see [Connected Machines](#connected-machines)):

```bash
docker build -f agent/crates/opengeni-relay/Dockerfile -t opengeni-relay agent
```

For production Helm releases that enable Connected Machines, pin the
`opengeni-relay` image by digest as well as tag, the same way API, worker, web,
and migration images are pinned.

## Helm

Released OpenGeni charts are published to GHCR as OCI artifacts. For release
installs, pin the chart version explicitly; the release pipeline packages the
chart with `appVersion` set to the same OpenGeni version, and the default image
tags resolve to that appVersion:

```bash
OPENGENI_VERSION="<published-version>"

helm upgrade --install opengeni oci://ghcr.io/cloudgeni-ai/charts/opengeni \
  --namespace opengeni \
  --create-namespace \
  --version "$OPENGENI_VERSION" \
  --set secret.existingSecret=opengeni-runtime
```

Use the repo checkout chart path only for development, chart edits, local
rendering, or smoke tests against locally built images. `deploy/helm/opengeni`
keeps a source-tree `Chart.yaml` version for development; releases do not commit
Chart.yaml bumps. If you install from a clone instead of the OCI chart, set
`api.image.tag`, `worker.image.tag`, `web.image.tag`, `migrations.image.tag`,
and, when enabled, `relay.image.tag` to the image tag you intend to run.

Render the development chart path with an existing secret:

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

The OpenGeni Helm chart owns OpenGeni API, web, worker, migrations, optional Terraform Registry MCP docs service, and integration resources such as `ServiceMonitor`, `PrometheusRule`, `ExternalSecret`, and workload NetworkPolicies. It must not become a replacement chart for NATS, Temporal, Postgres, cert-manager, or the observability platform.

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
- `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` (base64, exactly 32 bytes; generate with `openssl rand -base64 32`) for workspace variable sets; required when `OPENGENI_PRODUCT_ACCESS_MODE=managed` outside local/test, optional otherwise (variable set routes return 503 until it is set). See `docs/variable-sets.md`.
- `OPENGENI_STRIPE_SECRET_KEY`, publishable key, webhook secret, and model pricing JSON when `OPENGENI_BILLING_MODE=stripe`
- sandbox backend credentials when required

Do not commit real secret values.

OpenGeni's storage package intentionally exposes a small provider-neutral boundary instead of calling provider SDKs directly from routes. The current shipped backends are `s3-compatible`, `azure-blob`, `aws-s3`, and `gcs`; sandbox file resources are emitted as native storage mounts when the sandbox backend supports them, or materialized through short-lived signed downloads when a backend cannot mount that provider directly. Additional providers should be added behind the same boundary, or bridged through a library such as `files-sdk` if that becomes the lowest-maintenance adapter layer.

Sandbox file mount support is also backend-specific:

| Sandbox backend | S3-compatible | Azure Blob | AWS S3 | GCS |
| --- | --- | --- | --- | --- |
| Docker/local in-container sandboxes | rclone mount | rclone mount | signed download materialization | signed download materialization |
| Modal | SDK cloud bucket mount | signed download materialization | signed download materialization | signed download materialization |

### Existing-session tool replacement rollout

`OPENGENI_SESSION_TURN_TOOL_REPLACEMENT_ENABLED` defaults to `false`. This is a
two-phase compatibility gate, not a permanent product default: older workers
merge an explicit follow-up `tools` array with session tools, while current
workers treat the accepted turn's `tools` plus `tools_provided` as exact
provenance. Enabling replacement before old workers are gone can silently widen
an explicit empty or narrowed turn.

Activate in this order:

1. Roll the provenance-aware API with the flag still `false`, and wait until no
   old API instance serves traffic. Explicit `tools` on existing-session user
   messages returns `503`; omitted tools continue to inherit normally.
2. Let any explicit replacement turns admitted before the gate settle.
3. Roll provenance-aware workers. Drain or terminate every old poller and prove
   no old attempt remains active before continuing.
4. Set `OPENGENI_SESSION_TURN_TOOL_REPLACEMENT_ENABLED=true` and roll the API
   configuration. Existing-session explicit replacement is now admitted.

Rollback is the reverse safety fence, not simply a worker image rollback:

1. Disable the flag first so no new explicit replacement turn can be admitted.
2. Drain every already-admitted replacement turn.
3. Only then roll workers back.

Initial session creation remains able to accept an explicit tool policy while
the flag is off. Reusable scheduled runs synthesize inherited internal turns and
are not separately blocked. Never rewrite or globally reinterpret historical
`tools_provided=false` rows; their durable meaning remains “the accepted turn
omitted tools and inherits its session policy.”

## Terraform Registry MCP Docs

The Helm chart can deploy an optional, cluster-internal HashiCorp Terraform MCP
server for authoritative Terraform Registry documentation:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set terraformMcp.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

This renders a `ClusterIP` service at
`http://<fullname>-terraform-mcp:8080/mcp`. For a release named `opengeni`, the
default service name is `opengeni-terraform-mcp`. Register it in
`OPENGENI_MCP_SERVERS`, for example:

```json
[
  {
    "id": "terraform-registry",
    "name": "Terraform Registry Docs",
    "url": "http://opengeni-terraform-mcp:8080/mcp",
    "cacheToolsList": true
  }
]
```

Then select it per session with an explicit tool reference such as
`{"kind":"mcp","id":"terraform-registry"}`. The chart does not wire a Terraform
Enterprise token or other provider credential into this server; it is a
registry-docs endpoint only.

## Connected Machines

A Connected Machine is a user-owned computer (a laptop, workstation, or server,
including macOS) enrolled as a first-class primary compute backend
(`OPENGENI_SANDBOX_BACKEND=selfhosted`). When a session turn targets a Connected
Machine, the platform establishes the machine session directly and routes tool
execution to the agent running on that machine over a NATS request/reply control
plane. No cloud sandbox box is created for that turn, no platform-minted GitHub
token is distributed to the machine (it uses its own local git credentials), and
repositories are not cloned onto it by the platform; the working directory is
chosen per session.

This is a separate, optional deployment surface. It is gated OFF by default;
existing deployments are completely unaffected unless an operator enables it.

### Enable flag

The whole feature is gated by `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (default
`false`). While it is off, the enrollment routes return `404` — the surface does
not exist for the deployment — and the `selfhosted` backend is inert.

### Components to deploy

Enabling Connected Machines adds two net-new deployed components plus their
ingress and secret wiring:

- **Stream relay** (`opengeni-relay` image): a stateless wss byte-pump that
  splices the agent's producer stream and the viewer's consumer stream for a
  channel (pty/desktop). Enable with `relay.enabled=true`; the chart then renders
  the relay Deployment, Service, HPA, PodDisruptionBudget, NetworkPolicy, and —
  when observability is on — a ServiceMonitor. The relay holds no cluster state
  and makes no cluster egress; both the agent and the viewer dial IN through the
  ingress.
- **NATS with auth-callout**: the machine's agent dials a NATS websocket to reach
  the request/reply control plane, authenticated per workspace by a NATS
  auth-callout responder. Use the chart-managed NATS fixture with
  `nats.authCallout.enabled=true` for preview/smoke, or fold the same
  `deploy/nats/auth-callout.conf` config into an external/production NATS
  deployment (`nats.enabled=false`).

Both the relay and the NATS websocket need public wss ingress hosts (for example
`relay.<domain>` and `nats.<domain>`) with the long-lived-stream ingress
annotations (read/send timeouts of at least `3600` seconds, buffering off). Flip
`selfhosted.enabled=true` together with `relay.enabled=true` and the NATS
callout.

### Ingress channel affinity

The relay pairs a channel's producer and consumer in a per-replica in-memory
registry, so both dials for a given channel must reach the SAME relay replica.
When running more than one relay replica behind an L7 ingress, configure the
ingress to route both dials for a channel to the same backend (consistent-hash or
session affinity keyed on the channel); otherwise a producer and consumer can
land on different replicas and never pair.

### Runtime-secret keys

Set these in the runtime secret (never a committed values file) when enabling
Connected Machines:

- `OPENGENI_STREAM_TOKEN_SECRET` — HMAC the relay verifies the viewer (`ogs_`)
  stream token with.
- `OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET` — HMAC the relay verifies the agent
  (`ogr_`) producer token with; may be omitted to reuse
  `OPENGENI_STREAM_TOKEN_SECRET` for both planes.
- `OPENGENI_ENROLLMENT_SIGNING_SECRET` — HMAC the control plane signs the
  enrollment bearer with (falls back to `OPENGENI_DELEGATION_SECRET`).
- `OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED`,
  `OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY`,
  `OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD`, and
  `OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD` — the NATS auth-callout account
  seed/public key and the control/callout logins.

Non-secret wiring goes in config/values: `OPENGENI_SELFHOSTED_NATS_URL` and
`OPENGENI_SELFHOSTED_RELAY_URL` (the public wss URLs the agent dials, matching the
ingress hosts) plus the callout account/user names. The relay's non-secret tuning
knobs are `OPENGENI_RELAY_RING_FRAMES`, `OPENGENI_RELAY_SPLICE_BUFFER`,
`OPENGENI_RELAY_RATE_BURST_BYTES`, `OPENGENI_RELAY_RATE_BYTES_PER_SEC`, and
`OPENGENI_RELAY_PAIR_TIMEOUT_SECS`. A missing token secret makes the relay reject
every connection (fail-closed).

### Agent binary distribution

The machine agent is served from the control plane itself. The API exposes the
install script and the per-deploy agent binary at auth-exempt paths
(`/install.sh`, `/install.ps1`, `/uninstall.sh`, and `/agent/*`), so
`curl -fsSL https://<host>/install.sh | sh` installs the exact agent build that
matches the running control plane (the per-SHA binary baked into the API image),
with no dependency on an external CDN. A public release archive is the fallback
for other OS/arch assets and the self-update channel. Route these paths (and an
optional `get.<domain>` host) to the `api` service in the ingress.

### Enrolling a machine

Enrollment binds a machine to a workspace and requires the enable flag. Two paths
are supported:

- **Device flow**: the agent starts an enrollment
  (`/v1/enrollments/device/start`) and a workspace member holding
  `enrollments:manage` approves it at the consent page
  (`/v1/workspaces/:workspaceId/enrollments/device/approve`).
- **Zero-click enroll token**: a workspace member holding `enrollments:manage`
  mints a short-TTL enroll token
  (`/v1/workspaces/:workspaceId/enrollments/token`) that the agent redeems
  headlessly (`/v1/enrollments/token/exchange`) with no human approval — suited
  to fleet or headless provisioning.

Client SDKs surface the machine dashboard and enrollment flow through the
`@opengeni/react/machines` subpath, and target a session at a specific machine
with `CreateSessionRequest.targetSandboxId` (plus an optional `workingDir`).

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

OpenGeni emits Prometheus-native metrics. Scrape `/metrics` directly; do not route scraped metrics through OTLP. API and worker processes also emit structured JSON logs and optional OTLP/HTTP JSON traces.

Service endpoints:

- API: `GET /metrics` and `GET /healthz` on `OPENGENI_API_PORT` (default `8000`); `GET /readyz` checks Postgres, NATS, and Temporal with bounded timeouts.
- Worker: `GET /metrics`, `GET /healthz`, and `GET /readyz` on `OPENGENI_WORKER_HTTP_PORT` (default `8001`); readiness checks the same dependencies.
- Relay: `GET /metrics` and `GET /healthz` on the relay port when the relay is enabled.

Useful settings:

- `OPENGENI_OBSERVABILITY_STRUCTURED_LOGS=true` for JSON logs.
- `OPENGENI_OBSERVABILITY_METRICS_ENABLED=true` to expose process and domain metrics.
- `OPENGENI_WORKER_HTTP_PORT=8001` for the worker metrics/health listener.
- `OPENGENI_AUTH_ALLOW_HEALTH=true` allows both `/healthz` and `/readyz` through the deployment-key gate.
- `OPENGENI_AUTH_ALLOW_METRICS=true` allows API `/metrics` through the deployment-key gate for an internal scraper path.
- `OPENGENI_DISABLE_OPENAI_TRACING=true` disables OpenAI Agents SDK tracing; tracing also defaults off when no OTLP endpoint is configured.
- `OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` to export spans to an OpenTelemetry Collector.
- `OPENGENI_OTEL_EXPORTER_OTLP_HEADERS=key=value,...` for exporter headers; put this in a secret when it contains credentials.

The Helm chart has optional Prometheus Operator wiring, off by default:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set observability.serviceMonitor.enabled=true \
  --set observability.prometheusRule.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

`ServiceMonitor` and `PrometheusRule` templates render only when `monitoring.coreos.com/v1` CRDs are installed. The starter rules cover stuck turns (`opengeni_turn_oldest_inflight_age_seconds > 900`), sandbox create failure ratio, orphan sandbox growth, and scraped target availability. The chart-managed OpenTelemetry Collector remains optional and is for traces/logs forwarding, not scraped metrics.

Minimum production dashboards should cover:

- API traffic: request rate, error rate, and p50/p95/p99 latency by `route`, `method`, `status`, `variable set`, and `component`.
- Worker execution: activity run rate, failure rate, and p50/p95/p99 `runAgentTurn` duration by `activity`, `status`, `variable set`, and `component`.
- Turn lifecycle: `opengeni_turns_total{outcome}`, `opengeni_turn_duration_seconds`, `opengeni_turns_inflight`, and `opengeni_turn_oldest_inflight_age_seconds`.
- Model, Codex, and sandbox SLIs: `opengeni_model_calls_total{provider,outcome}`, `opengeni_model_call_duration_seconds{provider}`, `opengeni_codex_credential_selections_total{strategy,reason}`, `opengeni_codex_credential_failures_total{kind,outcome}`, `opengeni_codex_pool_observations_total{depth}`, `opengeni_codex_pool_low_total{depth}`, `opengeni_sandbox_creates_total{backend,outcome}`, `opengeni_sandbox_create_duration_seconds{backend}`, `opengeni_sandbox_leases{liveness}`, `opengeni_sandbox_warming_timeouts_total`, and `opengeni_sandbox_orphans_terminated_total`.
- Queue and billing: `opengeni_turns_queued`, `opengeni_credit_balance_micros{account_id}`, `opengeni_credit_micros_total{kind}`, and `opengeni_build_info{version,revision}`.
- Dependency health: Postgres connection health, Temporal worker poll health, NATS connectivity, object-storage write/read conformance, and sandbox backend readiness.
- Runtime health: API/worker restarts, CPU/memory saturation, pod pending time, collector scrape/export errors, and OTLP export failures.

Prometheus-style examples:

```promql
sum by (route, method) (rate(opengeni_http_requests_total{variable set="production"}[5m]))
```

```promql
sum by (route) (rate(opengeni_http_requests_total{variable set="production",status=~"5.."}[5m]))
/
sum by (route) (rate(opengeni_http_requests_total{variable set="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(opengeni_http_request_duration_seconds_bucket{variable set="production"}[5m]))
)
```

```promql
sum by (activity, status) (rate(opengeni_worker_activity_runs_total{variable set="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, activity) (rate(opengeni_worker_activity_duration_seconds_bucket{variable set="production"}[5m]))
)
```

```promql
max(opengeni_turn_oldest_inflight_age_seconds{variable set="production"})
```

Minimum production alerts:

- API/worker availability: `/healthz` or `/readyz` is unavailable from probes for more than 2 minutes.
- API errors: 5xx ratio is above 2% for 10 minutes, or any critical route stays above 5% for 5 minutes.
- API latency: p95 latency is above the product SLO for 10 minutes, tracked separately for `/v1/workspaces/:workspaceId/sessions`, event replay, SSE, scheduled-task trigger, and file routes.
- Turn stuck: the oldest in-flight turn is older than 15 minutes for 5 minutes.
- Sandbox create failures: sandbox create failure ratio is above 20% for 10 minutes.
- Sandbox orphan growth: `increase(opengeni_sandbox_orphans_terminated_total[30m]) > 0`.
- Codex credential pool: any zero-eligible observation is critical; repeated one-eligible observations are warning-level reduced redundancy. The default PrometheusRule uses `opengeni_codex_pool_low_total{depth="zero"|"one"}`.
- Worker failures: `runAgentTurn` failure ratio is above 5% for 10 minutes.
- Worker duration: p95 `runAgentTurn` duration is above the expected model/tool budget for 15 minutes.
- Scheduler health: manual scheduled-task conformance does not dispatch a session through Temporal within the configured timeout.
- Storage health: object-storage conformance cannot create, complete, presign, and read a file.
- Streaming health: SSE replay conformance does not return persisted events after reconnect.
- Collector health: collector pod is not ready or its configured OTLP exporter reports failures.
- Secret/sandbox hygiene: conformance detects unintended sandbox variable-set variables or sandbox backend startup failures.

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
own CI/CD variable set with their own cluster, registry, secrets, and teardown
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
