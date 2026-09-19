# OpenGeni chart volume hooks

## Release identity

`config.OPENGENI_DEPLOYMENT_REVISION` is rendered explicitly into each enabled
runtime role, including relay and artifact workers. This non-secret release
identity stays authoritative over runtime Secret defaults and survives ordinary
Helm upgrades without relying on a canary post-renderer. An empty revision adds
no explicit entry. Other provider credentials and configuration keep their
existing precedence. Canary renderers must preserve an already-correct entry's
position so saved values reproduce the same pod template on later upgrades.

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
```

The render cases skip explicitly if Helm is absent. Rendering proves manifest
structure, not a live TLS handshake or operational telemetry export. See
[`docs/deployment.md`](../../../docs/deployment.md) for release and deployment
guidance.