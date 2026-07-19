# OpenGeni observability — design

OpenGeni's telemetry follows two fixed contracts, so any backend works and no code
above the contracts knows which one is running:

1. **Emission contract** — every service exposes Prometheus text on `GET /metrics`,
   writes structured JSON logs to stdout, and (optionally) emits OTLP traces to the
   standard `OTEL_EXPORTER_OTLP_ENDPOINT`. Metrics are Prometheus-native end to end:
   scrape, don't funnel scraped metrics through OTLP (the name/label translation is
   lossy and you lose the identifiers PromQL depends on).
2. **Read contract** — PromQL over the Prometheus HTTP API. Dashboards and alerts
   are authored against this; kube-prometheus, VictoriaMetrics, Grafana Cloud,
   Amazon Managed Prometheus, and Mimir all serve it.

This repo owns the **emission** side and ships optional chart wiring for any
Prometheus-compatible operator. Backend choice (what scrapes, stores, charts, and
alerts) belongs to the deployment, not this repo.

## Emission: what each service exposes

| service | `/metrics` | health | notes |
|---------|-----------|--------|-------|
| api     | ✅ (port 8000, gate with `OPENGENI_AUTH_ALLOW_METRICS`) | `/healthz` (liveness) + `/readyz` (DB, NATS, Temporal, bounded timeouts) | |
| worker  | ✅ new: small HTTP listener (`OPENGENI_WORKER_HTTP_PORT`, default 8001) | `/healthz` + `/readyz` on the same listener | previously unscrapeable |
| relay   | ✅ (existing Rust atomics) | `/healthz` | already conformant |
| web     | n/a (static/SSR) | HTTP `/` probe | |

The metrics registry is [prom-client] behind the existing `Observability` facade —
call sites keep the same API, and we get gauges, default runtime metrics
(event-loop lag, heap, GC), and battle-tested exposition instead of the hand-rolled
registry.

## Domain SLIs — the metrics an agent platform is actually judged by

HTTP golden signals describe the API; they say nothing about whether **turns**
work. The domain metric set (all `opengeni_` prefixed, bounded label values only):

**Turn lifecycle** (emitted where turns are driven, `apps/worker`):
- `opengeni_turns_total{outcome}` — completed | failed | cancelled | preempted
- `opengeni_turn_duration_seconds` histogram `{outcome}`
- `opengeni_turns_inflight` gauge
- `opengeni_turn_oldest_inflight_age_seconds` gauge — **the stuck-turn signal**;
  the 2026-07-02 outage (every turn silently hung) is one `> 900` threshold away
  from a page.

**Turn capacity** (dedicated turn workers, no session/workspace labels):
- `opengeni_turn_eligible_backlog` and
  `opengeni_turn_eligible_backlog_oldest_age_seconds` — Temporal activity tasks
  that are actually eligible for `runAgentTurn`; each pod observes the same
  task queue, so fleet queries use `max`, not `sum`
- `opengeni_turn_eligible_tasks_add_rate` and
  `opengeni_turn_eligible_tasks_dispatch_rate`
- `opengeni_turn_capacity_monitor_last_read_success`,
  `opengeni_turn_capacity_monitor_last_success_timestamp_seconds`,
  `opengeni_turn_capacity_monitor_last_success_age_seconds`, and
  `opengeni_turn_capacity_monitor_fresh` — failed or hung Temporal reads make
  old queue samples explicitly stale rather than silently preserving apparent
  runnable pressure; an absent/malformed `DescribeTaskQueue.stats` object is a
  failed read, never a fresh zero backlog
- `opengeni_turn_slots_capacity`, `opengeni_turn_slots_reserved`,
  `opengeni_turn_slots_used`, `opengeni_turn_slots_available`, and
  `opengeni_turn_slot_saturation_ratio` — the memory-aware Temporal slot plane
- `opengeni_turn_admission_memory_baseline_bytes`, current/limit bytes,
  `opengeni_turn_admission_hard_bytes_per_turn`, and
  `opengeni_turn_admission_native_headroom_bytes`

The durable human prompt count is deliberately **not** a capacity metric. A
paused prompt stays queued in Postgres but never schedules `runAgentTurn`.
PromQL alerts and the bundled dashboard select one exact namespace,
environment, Helm release, and turn-worker component. Cross-fleet aggregation
must be an explicit operator query, never the default capacity or paging path.
The stale-monitor alert includes a release-scoped `absent()` arm, while the
dashboard exposes minimum monitor freshness and maximum last-success age.
Kubernetes memory and HPA series are joined through exact
`app.kubernetes.io/instance` and worker component labels, not pod/HPA name
prefixes that can mix similarly named releases.

**Model calls** (`{provider, outcome}`; model names are bounded, provider ids more so):
- `opengeni_model_calls_total`, `opengeni_model_call_duration_seconds`

**Sandbox lifecycle** (the other half of the incident):
- `opengeni_sandbox_creates_total{backend, outcome}` and
  `opengeni_sandbox_create_duration_seconds{backend}`
- `opengeni_sandbox_leases{liveness}` gauge (warming | warm | draining | cold)
- `opengeni_sandbox_warming_timeouts_total`
- `opengeni_sandbox_orphans_terminated_total` — reaper GC; sustained non-zero means
  something upstream is leaking again

**Billing:**
- `opengeni_credit_balance_micros{account_id}` gauge
- `opengeni_credit_micros_total{kind}` counter (usage | grant | topup | refund)

**Deploy marker:** `opengeni_build_info{version, revision}` gauge=1 — dashboards
join against it instead of hard-coding SHAs.

Cardinality rule: no user ids, session ids, workspace ids, or free-form strings as
label values, ever. `account_id` is allowed only for managed-account billing
gauges where cardinality is intentionally small. Session-scoped detail already
has a home (the durable `session_events` log); metrics are aggregates.

## Log hygiene

Structured JSON stays the format (`{timestamp, level, message, service,
environment, component, …}`). Two noise bugs fixed at the source:

- The NATS status drain logged every keepalive as a `console.warn`
  (`[nats:…] pingTimer` spam). Status events route through the logger:
  disconnect-class events at `warn`, the rest at `debug`.
- `OPENGENI_DISABLE_OPENAI_TRACING` existed but was never honored; the openai-agents
  SDK printed "No API key provided for OpenAI tracing exporter" on every turn. The
  flag now calls `setTracingDisabled(true)` and defaults to disabled unless an OTLP
  endpoint is explicitly configured.

Remaining bare `console.*` calls in hot paths migrate to the logger opportunistically.

## Chart wiring (optional, off by default)

- `observability.serviceMonitor.enabled` — ServiceMonitor for api/worker/relay
  (requires the Prometheus operator CRDs; templates guard on `.Capabilities`).
- `observability.prometheusRule.enabled` — a starter PrometheusRule with the
  incident-derived alert set (stuck turns, sandbox create failures, orphan growth,
  service down). Deployments are expected to extend it.
- The bundled OTel collector remains **optional and off** for metrics — its job is
  OTLP logs/traces forwarding when a deployment wants that; scraped metrics never
  route through it.

## What the hosted deployment adds (not this repo)

A pinned kube-prometheus-stack per cluster (Prometheus + Alertmanager + Grafana),
dashboards-as-code (the on-call front page: golden signals per workload, domain
SLIs, saturation, dependency health, deploy marker), a scheduled synthetic probe
(real session create → turn completed, alert on failure/staleness), and an
Alertmanager route whose webhook spawns an **OpenGeni incident session** — the
platform diagnosing itself — with a cross-environment twist: production alerts
spawn their incident session on staging's control plane, because a dead prod can't
investigate itself.

## Verification bar

A signal counts as live only when a uniquely-tagged emission has been queried back
through the read contract (per service, per environment). Dashboards must render
against live series, and every alert rule must have fired at least once through a
forced test condition before the stack is called done.
