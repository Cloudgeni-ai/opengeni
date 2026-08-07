# OpenGeni Grafana dashboards

Dashboards-as-code for the OpenGeni control plane. Four boards, each answering a
different "manage and fix problems as soon as they arise" question:

| File | Board | Answers |
| --- | --- | --- |
| `streaming-health.json` | **OpenGeni · Streaming Health** | Is streaming sluggish, and *where* — the model, durable append, NATS publish, batching, or SSE connection/reconnect path? |
| `connected-machines.json` | **OpenGeni · Connected Machines** | Are Connected Machine control ops healthy — op outcomes, healed faults (the leading indicator), op latency, the fault taxonomy, and the payload wall? |
| `worker-fleet.json` | **OpenGeni · Worker Fleet** | Is the fleet keeping up — turns inflight/queued, worker memory vs. limit, HPA replicas, sandbox leases, and whether compaction is firing against context pressure? |
| `sandbox-health.json` | **OpenGeni · Sandbox Health** | Are provider operations, creates, lease recovery, checkpoint GC, deadline rotation, draining, and retained-process reconciliation healthy? |

All four are theme-agnostic, tagged `opengeni` + `observability`, and carry a
`$datasource` template variable — pick your Prometheus datasource on import; no UID
is hardcoded.

## Importing

**Grafana UI** — Dashboards → New → Import → Upload JSON file (or paste), then select
your Prometheus datasource for the `$datasource` prompt.

**Provisioned (file provider)** — mount this directory and point a provider at it:

```yaml
# /etc/grafana/provisioning/dashboards/opengeni.yaml
apiVersion: 1
providers:
  - name: opengeni
    type: file
    options:
      path: /var/lib/grafana/dashboards/opengeni
      foldersFromFilesStructure: true
```

**OpenGeni Kubernetes observability wrapper** — install the chart rooted at
`deploy/observability`. It renders one deterministic ConfigMap per file directly
from this directory, labels it for the Grafana sidecar, records the content hash
and source revision, and installs the pinned Prometheus/Grafana stack. See
[`../README.md`](../README.md).

**Existing Kubernetes sidecar** — if the cluster already has a compatible Grafana
sidecar, wrap each file in a ConfigMap carrying the sidecar's discovery label
(default `grafana_dashboard: "1"`). The wrapper chart can provision only these
ConfigMaps with `kube-prometheus-stack.enabled=false`; manual creation remains a
fallback for non-Helm installations. Example:

```bash
kubectl create configmap opengeni-streaming-health \
  --from-file=streaming-health.json \
  --dry-run=client -o yaml \
  | kubectl label --local -f - grafana_dashboard=1 -o yaml \
  | kubectl apply -f -
```

## Metric sources

Most panels read **app-emitted** series scraped from OpenGeni's `/metrics` endpoints.
Enable scraping via the chart:

```yaml
observability:
  metrics: { enabled: true }
  serviceMonitor: { enabled: true }   # api + worker + relay ServiceMonitors
  prometheusRule: { enabled: true }   # the starter alerts (see ../../helm/opengeni/templates/prometheusrule.yaml)
```

App series used here (non-exhaustive): `opengeni_stream_ttft_seconds`,
`opengeni_stream_inter_delta_gap_seconds`, `opengeni_stream_batch_flush_*`,
`opengeni_session_event_append_seconds`, `opengeni_session_event_publish_seconds`,
`opengeni_sse_connections_*`, `opengeni_sse_delivery_bound_events_total`,
`opengeni_http_request_duration_seconds`,
`opengeni_model_input_tokens`, `opengeni_context_compactions_total`,
`opengeni_machine_op_*`, `opengeni_turns_*`, `opengeni_sandbox_leases`,
`opengeni_sandbox_operations_total`, `opengeni_sandbox_operation_duration_seconds`,
`opengeni_sandbox_inventory_refresh_timestamp_seconds`,
`opengeni_sandbox_checkpoint_artifacts`, `opengeni_sandbox_rotation_backlog`,
`opengeni_sandbox_leases_expired_draining`, `opengeni_retained_processes_*`,
`opengeni_model_call_duration_seconds`,
`opengeni_turn_worker_memory_guard_utilization_ratio`,
`opengeni_turn_worker_memory_guard_target_ratio`,
`opengeni_turn_worker_memory_guard_available_bytes`,
`opengeni_turn_worker_memory_guard_process_rss_ratio`,
`opengeni_turn_worker_memory_guard_breach_seconds`,
`opengeni_turn_worker_memory_guard_drains_total`, and the prom-client defaults
(`opengeni_process_resident_memory_bytes`).

Some Worker Fleet panels and recording rules also read **cluster-infra** series:
container working sets from cAdvisor/kubelet; pod, phase, resource-limit, HPA,
and node-readiness data from kube-state-metrics; memory/I/O PSI, swap, and node
identity from node-exporter; and runtime errors plus instance-to-node identity
from kubelet. If an exporter is absent, the dependent cluster panels and alerts
are empty. The app-emitted memory-guard panels remain available without a
container memory limit and expose both whole-host and effective finite-cgroup
headroom directly from the turn worker.

Sandbox inventory metrics are complete database projections emitted by whichever
control replica executes the global reaper activity. Never sum those replicated/stale
samples directly. The chart's `opengeni:*:fresh_max` recording rules first require the
matching projection domain to have refreshed on the same scrape target within the
configured freshness window (five minutes by default), then take the authoritative
maximum. Helm rejects a freshness window shorter than three configured sandbox-reaper
periods. A blank recorded series is an inventory
telemetry failure, not a healthy zero; `OpenGeniSandboxInventoryProjectionStale`
alerts on that condition.

> `machine.link.*` and `machine.op.*` are session-scoped **timeline events**, not
> Prometheus series — a machine's link history lives in the session timeline (which
> carries the workspace/session context Prometheus omits). The Connected Machines
> board is the aggregate op-outcome view.
