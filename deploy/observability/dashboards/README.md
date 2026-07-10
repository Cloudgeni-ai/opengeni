# OpenGeni Grafana dashboards

Dashboards-as-code for the OpenGeni control plane. Three boards, each answering a
different "manage and fix problems as soon as they arise" question:

| File | Board | Answers |
| --- | --- | --- |
| `streaming-health.json` | **OpenGeni · Streaming Health** | Is streaming sluggish, and *where* — the model (TTFT + inter-delta gaps), the durable write path (append latency), or delivery (publish latency + batcher shape)? |
| `connected-machines.json` | **OpenGeni · Connected Machines** | Are Connected Machine control ops healthy — op outcomes, healed faults (the leading indicator), op latency, the fault taxonomy, and the payload wall? |
| `worker-fleet.json` | **OpenGeni · Worker Fleet** | Is the fleet keeping up — turns inflight/queued, worker memory vs. limit, HPA replicas, sandbox leases, and whether compaction is firing against context pressure? |

All three are theme-agnostic, tagged `opengeni` + `observability`, and carry a
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

**Kubernetes sidecar (kube-prometheus-stack / Grafana Helm)** — wrap each file in a
ConfigMap carrying the sidecar's discovery label (default `grafana_dashboard: "1"`);
the sidecar imports it automatically. Example:

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
`opengeni_model_input_tokens`, `opengeni_context_compactions_total`,
`opengeni_machine_op_*`, `opengeni_turns_*`, `opengeni_sandbox_leases`,
`opengeni_model_call_duration_seconds`, and the prom-client defaults
(`opengeni_process_resident_memory_bytes`).

A few Worker Fleet panels read **cluster-infra** series from other exporters —
`container_memory_working_set_bytes` (cAdvisor / kubelet) and
`kube_pod_container_resource_limits` + `kube_horizontalpodautoscaler_*`
(kube-state-metrics). If those exporters aren't present, only those panels are
empty; every app-series panel still works, and the memory board falls back to the
app-emitted RSS panel.

> `machine.link.*` and `machine.op.*` are session-scoped **timeline events**, not
> Prometheus series — a machine's link history lives in the session timeline (which
> carries the workspace/session context Prometheus omits). The Connected Machines
> board is the aggregate op-outcome view.
