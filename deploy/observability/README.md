# OpenGeni observability stack

`deploy/observability` is the optional Kubernetes observability distribution for
OpenGeni. It is a thin Helm wrapper around the upstream
`kube-prometheus-stack` chart and packages the canonical OpenGeni dashboards
from [`dashboards/`](dashboards/) without copying their JSON.

The wrapper is intentionally separate from `deploy/helm/opengeni`:

- this chart lifecycle-manages Prometheus, Prometheus Operator, Alertmanager,
  Grafana, kube-state-metrics, node-exporter, and the canonical dashboard
  ConfigMaps;
- the OpenGeni application chart owns `/metrics`, `ServiceMonitor`,
  `PrometheusRule`, and optional OTLP collector integration;
- environment overlays own ingress/TLS, Grafana administrator credentials,
  Alertmanager receivers, remote write, scheduling, and environment-only rules
  or dashboards.

## Requirements

- Kubernetes 1.25 or newer (the pinned upstream chart requirement)
- Helm 3
- a default `StorageClass`, or an overlay that sets one explicitly
- enough capacity for the selected profile
- no second Prometheus Operator managing the same cluster-scoped resources

The dependency is exactly pinned in `Chart.yaml` and `Chart.lock`. Use
`helm dependency build deploy/observability`; do not replace the pin with a
version range or an unconstrained dependency update in deployment automation.

## Capacity profiles

The default values are a persistent, single-replica profile suitable for a
compact self-hosted cluster:

| Component | Persistent capacity | Retention |
| --- | ---: | ---: |
| Prometheus | 8 GiB | 7 days, capped at 6 GB |
| Alertmanager | 2 GiB | 120 hours |
| Grafana | 2 GiB | persistent database and plugins |

`values.production.example.yaml` raises Prometheus to 50 GiB/15 days, Grafana
to 5 GiB, Alertmanager to 5 GiB, and requires an existing
`opengeni-grafana-admin` Secret. It is a capacity and credential example, not a
complete production overlay. Review storage classes, volume reclaim policy,
backups, replicas, resource limits, ingress, and alert routing for each cluster.

## Plan and install

Print the ordered self-hosted plan:

```bash
bun run deployment:observability -- --profile single-node
```

Print the larger-profile plan as JSON:

```bash
bun run deployment:observability -- \
  --profile production \
  --environment production \
  --json
```

The plan deliberately installs only the wrapper. It never upgrades or rolls
back OpenGeni application workloads and never executes application hooks. After
the wrapper is ready, include `opengeni.values.example.yaml` in the next
ordinary OpenGeni application release using that release's exact chart version
and complete authoritative values. The ordering matters: the application chart
omits `ServiceMonitor` and `PrometheusRule` when the Prometheus Operator CRDs do
not exist.

A direct default-profile install is:

```bash
helm dependency build deploy/observability
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace opengeni --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace observability opengeni.ai/monitoring=enabled --overwrite
kubectl label namespace opengeni opengeni.ai/monitoring=enabled --overwrite

helm upgrade --install opengeni-observability deploy/observability \
  --namespace observability \
  --set-string "opengeni.sourceRevision=$(git rev-parse HEAD)" \
  --set-string kube-prometheus-stack.prometheus.prometheusSpec.externalLabels.environment=self-hosted \
  --wait --timeout 20m
```

For a new or existing OpenGeni installation, include
`deploy/observability/opengeni.values.example.yaml` in the ordinary application
chart install or release upgrade. Do not run a local application-chart upgrade
solely to toggle observability: a different checkout can roll workloads and run
database migration hooks.

## Verify

Run the live contract verifier from the same immutable source revision used by
the install:

```bash
bun run deployment:observability-verify -- \
  --namespace observability \
  --release opengeni-observability \
  --app-namespace opengeni
```

It verifies:

- the expected wrapper chart release is deployed;
- every dashboard ConfigMap exactly matches its canonical JSON and content hash;
- the source-revision annotations match the source checkout;
- OpenGeni `ServiceMonitor` and `PrometheusRule` resources exist with the shared
  discovery label;
- required rules are declared and loaded by the live Prometheus API;
- Grafana is healthy and its dashboard provisioner has received the exact files.

`--skip-live-apis` is available only for object-level diagnostics; it is an
explicit verification gap, not proof that Prometheus or Grafana consumed the
objects.

When the wrapper dependency is disabled in favor of an existing Kubernetes
monitoring platform, point the same verifier at that platform while retaining
the canonical dashboard sidecar check:

```bash
bun run deployment:observability-verify -- \
  --namespace observability \
  --release opengeni-observability \
  --app-namespace opengeni \
  --prometheus-url http://127.0.0.1:19090 \
  --grafana-url http://127.0.0.1:13000 \
  --grafana-namespace monitoring \
  --grafana-pod-selector app.kubernetes.io/name=grafana \
  --grafana-sidecar-container grafana-sc-dashboard \
  --grafana-dashboard-directory /tmp/dashboards/OpenGeni
```

The supplied HTTP endpoints must already be reachable through the operator's
trusted local tunnel or authenticated proxy. The verifier does not accept or
retrieve monitoring-platform credentials.

## Existing monitoring platforms

If a cluster already has a compatible Prometheus Operator and Grafana sidecar,
set `kube-prometheus-stack.enabled=false` and install this chart only for the
canonical dashboard ConfigMaps. The existing Prometheus instance must select
resources labeled `opengeni.ai/monitoring=enabled` in namespaces carrying the
same label, and the Grafana sidecar must select `grafana_dashboard=1` with the
`grafana_folder` folder annotation. Use the configurable verifier endpoints and
sidecar location above to produce the same complete receipt.

Do not install two Prometheus Operators into the same cluster without an
explicit CRD and ownership plan.

## Security and upgrades

- Grafana, Prometheus, and Alertmanager are ClusterIP-only by default. Add
  authenticated ingress in an environment overlay; do not expose them
  anonymously.
- The bundled Grafana dashboard sidecar reads ConfigMaps only in its own
  namespace. It does not receive cluster-wide Secret access.
- Stable dashboard UIDs are intentional. UI edits to provisioned dashboards
  are not authoritative and may be overwritten by the next reconciliation.
- Treat a `kube-prometheus-stack` version change, regenerated `Chart.lock`,
  rendered manifest review, and live verification as one upgrade unit.
- Export Grafana state and confirm PVC/volume reclaim behavior before uninstall.
