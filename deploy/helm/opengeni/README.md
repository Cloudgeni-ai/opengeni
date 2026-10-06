# OpenGeni chart workload configuration hooks

## Release identity

`config.OPENGENI_DEPLOYMENT_REVISION` is rendered explicitly into each enabled
runtime role, including relay and artifact workers. This non-secret release
identity stays authoritative over runtime Secret defaults and survives ordinary
Helm upgrades without relying on a canary post-renderer. An empty revision adds
no explicit entry. Other provider credentials and configuration keep their
existing precedence. Canary renderers must preserve an already-correct entry's
position so saved values reproduce the same pod template on later upgrades.

## Service links

Every OpenGeni pod sets `enableServiceLinks: false`. Kubernetes otherwise
injects `<SERVICE>_PORT=tcp://<ip>:<port>` variables for each Service in the
namespace. For a Service such as `opengeni-api-metrics` that yields
`OPENGENI_API_METRICS_PORT`, which collides with an OpenGeni setting and fails
settings parsing at startup in any pod that does not set it explicitly. Pods
reach services through DNS.

## Workload-local environment

`api.extraEnv` and `worker.extraEnv` accept Kubernetes EnvVar lists and default to
`[]`. API entries affect only its container; worker entries affect both control
and turn containers. Neither list changes the shared ConfigMap or runtime Secret,
so web, artifact roles, migration and catalog-import Jobs do not inherit them.
This matters for settings such as `NODE_EXTRA_CA_CERTS`, whose file must exist
only in the containers with the corresponding volume mount.

```yaml
api:
  extraEnv:
    - name: NODE_EXTRA_CA_CERTS
      value: /etc/telemetry/tls/ca.crt
```

Use these with the volume hooks below; the environment list alone does not mount
or create a certificate. Repeat the settings and mounts under `worker` when
needed. Native `valueFrom` references are supported; keep credentials in Secrets,
not literal values. Values are YAML, not evaluated as templates. Malformed or
duplicate entries, release-identity/role/listener overrides and overrides of
active chart-generated service settings fail rendering. Other workload-specific
variables follow Kubernetes' normal explicit-env precedence over `envFrom`.

## Volumes

The chart accepts native Kubernetes volume and volume-mount lists at:

| Workload | Pod volumes | Container mounts |
| --- | --- | --- |
| API | `api.extraVolumes` | `api.extraVolumeMounts` |
| Control and turn workers | `worker.extraVolumes` | `worker.extraVolumeMounts` |
| Optional OTEL collector | `observability.collector.extraVolumes` | `observability.collector.extraVolumeMounts` |

All six default to `[]`. Entries are appended, not substituted for built-in
volumes. The control worker keeps its OpenSandbox inventory projection when
enabled; the collector keeps its `config` volume mounted at `/conf`. Worker
entries apply to **both** worker roles. Collector entries take effect only when
`observability.collector.enabled=true`. No other workloads inherit these lists.

For example, mount an existing same-namespace Secret containing a CA and client
certificate/key in the API (repeat the lists under `worker` and/or
`observability.collector` for those workloads):

```yaml
api:
  extraVolumes:
    - name: telemetry-tls
      secret:
        secretName: telemetry-client-tls
        defaultMode: 0440
  extraVolumeMounts:
    - name: telemetry-tls
      mountPath: /etc/telemetry/tls
      readOnly: true
```

These hooks only mount files; they do not create Secrets, configure TLS/auth,
change NetworkPolicies, or enable telemetry. Configure each exporter/receiver
separately to use the mounted paths (the collector accepts its full configuration
through `observability.collector.config`). Ensure the workload's UID/GID can read
the files. Keep keys out of values files and source control. Use distinct volume
names and mount paths: do not collide with built-in `config` or
`opensandbox-kubernetes-inventory` entries or shadow their mount paths. Values
are emitted as YAML, not evaluated as Helm templates. Secret rotation and any
required process reload/restart remain the operator's responsibility; external
Secret contents do not enter the chart's rollout checksum.

Render and test locally with Helm on `PATH`:

```sh
helm template opengeni deploy/helm/opengeni -f my-values.yaml
bun test ./deploy/helm/opengeni/test/extra-volumes.test.ts
bun test ./deploy/helm/opengeni/test/extra-env.test.ts
```

The render cases skip explicitly if Helm is absent. CI runs every
`deploy/**/*.test.ts` file, each in its own process, in the `Deployment
artifacts` job, where Helm is installed. Rendering proves manifest
structure, not a live TLS handshake or operational telemetry export. See
[`docs/deployment.md`](../../../docs/deployment.md) for release and deployment
guidance.
## Replicas and autoscaling

When a workload's `autoscaling.enabled` is true (API, web, relay, control
worker, turn worker), its HPA owns the replica count. The Deployment then keeps
its live replica count on `helm upgrade` (via `lookup`) and omits `replicas`
when rendered offline (fresh install, `helm template`, GitOps), so an upgrade
never scales a Deployment back to `replicaCount` and kills pods with in-flight
turns. `replicaCount` applies only when autoscaling is off.

`worker.turns.autoscaling.queueDemand` is an explicit, default-off schema-v1
source contract, not a production acceptance flag. It adds Namespace demand,
queue-only and busy-pod metrics to CPU, memory and agent-only inflight. The
initial policy disables downscale. See
[`worker-autoscaling.md`](../../../docs/worker-autoscaling.md) for prerequisites,
exact semantics, adapter freshness fencing and recovery gates. Its dedicated
`worker-scaler-prometheusrule.yaml` does not alter the accepted legacy alerts.

Run real Helm/schema and Prometheus rule fixtures with:

```sh
bun test ./deploy/helm/opengeni/test/queue-demand.test.ts
# All chart tests isolated, all example values linted, upgrade contracts:
bun scripts/check-worker-queue-demand.ts
```

The focused suite requires real binaries: `OPENGENI_HELM` and
`OPENGENI_PROMTOOL` (or `PATH`) override the test tools. On Linux x64 it downloads
official Helm 3.19.0 and Prometheus 3.5.0 into a temporary cache, verifies their
official archive checksums and checks cached binary hashes. It fails rather
than silently skipping when tooling is unavailable. Application dependencies
and the lockfile are untouched.
