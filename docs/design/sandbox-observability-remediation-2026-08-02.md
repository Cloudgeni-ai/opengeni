# Sandbox observability remediation

Status: accepted design
Owner: OpenGeni infrastructure
Date: 2026-08-02

## Decision

Ship sandbox observability as one versioned product contract split across the public
OpenGeni repository and the private deployment controller:

1. OpenGeni owns metric names, bounded labels, aggregation semantics, alert rules,
   and canonical Grafana dashboards.
2. `opengeni-ops` installs those exact public artifacts from the immutable release
   checkout, adds cluster/synthetic signals, and proves the installed objects match
   the release before producing an observability receipt.
3. Database-backed gauges are replicated observations, not per-process shards. Their
   fleet query is therefore `max` (or `max by (...)`), while process-local gauges and
   counters keep `sum`/`rate` semantics.
4. A sandbox dashboard is not considered installed because Grafana is healthy. The
   install receipt must prove the dashboard ConfigMap, required Prometheus rules, and
   current synthetic-probe contract independently, then verify the loaded rules and
   dashboard queries through the live Prometheus and Grafana APIs.

This avoids a second hand-maintained copy of the dashboard in private ops, prevents
Helm values from silently replacing the public alert catalog, and makes a stale
synthetic script a failed deployment rather than a month-long invisible condition.

## Current failures

The 2026-08-02 production audit found the following independent defects:

| ID | Failure | Consequence | Root cause |
| --- | --- | --- | --- |
| O1 | `sum(opengeni_sandbox_leases)` | Lease inventory is doubled and cold history is presented as active capacity. | The gauge is a full database projection exported by two control replicas. |
| O2 | Drain alert uses `5m_to_15m|gt_15m` | The alert can never match emitted `lt_5m|5m_1h|1h_1d|gte_1d` labels. | Alert and emitter evolved independently. |
| O3 | Production has only the compact on-call sandbox panel | Create failures, latency, recovery, checkpoint GC, rotation, drains, and retained processes are invisible. | Canonical public dashboards are not installed by the private bootstrap. |
| O4 | Production rules contain only three API alerts | Sandbox failures have no live alert coverage. | A values override replaces, rather than extends, the chart default rule catalog. |
| O5 | The deployed synthetic probe is from July 4 | Every recent probe fails at API contract admission before creating a session. | Source was fixed but the generated ConfigMap was never converged or semantically verified. |
| O6 | `increase(kube_job_status_failed[45m]) > 0` | A newly-created failed Job series with value `1` does not fire the alert. | Counter semantics were applied to an ephemeral gauge. |
| O7 | Dashboard installation evidence checks names only | Stale content can pass the deployment gate. | Evidence is not bound to required rule expressions or dashboard payloads. |

These are not one provider failure. O1/O2/O4/O6 are query/alert defects, O3/O5/O7
are deployment-convergence defects. Existing application metrics already cover the
operational sandbox lifecycle required to diagnose the incidents that motivated this
work.

## Scope

### Included in this release

- Correct every replicated-gauge query and the stale drain matcher.
- Make every database-projection family export a last-success timestamp and refresh
  failure counter. Queries admit only fresh replicas, so a worker that stops winning
  the reaper activity cannot pin a stale high value through `max`.
- Add a dedicated canonical `OpenGeni · Sandbox Health` dashboard covering:
  - authoritative lease inventory, with cold history visually separated;
  - create attempts, failures, backend mix, and p50/p95/p99 latency;
  - warming timeouts and orphan termination sweeps;
  - checkpoint artifact states and checkpoint-GC outcomes;
  - provider-deadline rotations and each blocker class;
  - expired drains by backend and age;
  - retained-process inventory, terminal-owner backlog, and reconciliation outcomes;
  - routed sandbox command/filesystem/desktop operation outcomes and latency by
    bounded backend and operation labels.
- Keep a corrected compact sandbox summary on the on-call dashboard and link it to
  the canonical dashboard.
- Add actionable alerts for warming timeouts, create availability, overdue rotation,
  expired drains, checkpoint deletion failures, retained terminal owners, and probe
  failure.
- Install every canonical public dashboard from the exact release source checkout.
- Keep kube-prometheus-stack pinned to the exact currently deployed chart version;
  an upgrade is an explicit reviewed source change, never a mutable repository lookup.
- Attach the exact environment as a Prometheus external label so public alerts route
  through the private Alertmanager contract without duplicating cluster identity in
  every public rule.
- Make private rule generation additive and fail when required public rules disappear.
- Replace the synthetic failed-Job expression with an ephemeral-gauge-safe query.
- Bind the deployed synthetic probe to the current API contract and verify its script
  content plus successful durable ledger semantics.
- Alert both on a failed probe Job and on absence of a recent successful CronJob;
  scheduling alone is not evidence that the product path worked.
- Extend public and private tests so label vocabularies, PromQL aggregation, generated
  objects, and evidence contracts cannot drift independently.

### Explicit non-goals

- Provider spend and quota are not inferred from sandbox counts. Modal billing and
  quota require an authoritative provider billing/quota data source; fabricated
  Prometheus estimates would be misleading. Add that as a separate integration only
  when exact account-scoped provider data and ownership are available.
- No session/workspace/sandbox IDs are Prometheus labels; they are high-cardinality and
  belong in logs/traces.
- No production mutation is part of source merge. The emitter changes require an
  ordinary application release before the serialized observability bootstrap, each
  with an exact live receipt.

## Metric and query contract

| Signal class | Source ownership | Fleet aggregation |
| --- | --- | --- |
| DB inventory gauges (`sandbox_leases`, checkpoint artifacts, rotation backlog, retained-process inventory, expired drains) | Each reaper execution projects complete database state on whichever control replica wins that activity. | Freshness-filter by domain, then `max` / `max by (labels)` |
| Process-local gauges (`turns_inflight`, memory) | One process owns its local value. | `sum` for counts; `max` for oldest/pressure |
| Counters | Each process emits only its own events. | `sum(rate(...))` or `sum(increase(...))` |
| Histograms | Each process emits local buckets. | `histogram_quantile(..., sum by (le, bounded labels) (rate(...)))` |
| Kubernetes Job status | kube-state-metrics ephemeral gauge. | `max_over_time(...[window])`, then `max`/`sum` by stable identity |

`cold` leases are durable history and must never be labeled “active”. Dashboard copy
calls them historical/cold; live capacity is `warming|warm|draining`.

The reaper activity is scheduled globally but may execute on different control-worker
replicas over time. A replica therefore retains its last sample after another replica
wins later ticks. Each successful projection sets
`opengeni_sandbox_inventory_refresh_timestamp_seconds{domain}`; each failed projection
increments `opengeni_sandbox_inventory_refresh_failures_total{domain}`. Inventory
recording rules select the exact matching timestamp domain, join on the scrape
target's `job` and `instance`, filter to replicas within a freshness window of at
least three reaper periods, and only then apply `max`. Dashboard panels and alerts
consume those recording rules rather than repeating joins. A per-domain alert fires
if every replica is stale or the timestamp series is absent. Every bounded label
combination is explicitly zero-filled by the emitter; an absent result after
freshness filtering means telemetry is unhealthy, not zero. The refresh-failure
counter is diagnostic because its process series resets/migrates; freshness is the
authoritative alarm.

The chart renders this invariant rather than relying on documentation: the configured
inventory freshness window must cover at least three values of
`OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS`, or Helm fails before producing the rule.

Routed provider operations emit
`opengeni_sandbox_operations_total{backend,op,outcome}` and
`opengeni_sandbox_operation_duration_seconds{backend,op}` at the common routing
boundary. `backend`, `op`, and `outcome` are fixed vocabularies; request, workspace,
session, sandbox, command, and path values are forbidden labels. Provider execution
is timed once per physical attempt, so a fenced retry remains visible rather than
being rewritten as one clean logical success. A physical attempt means one invocation
of a provider session method at the common routing boundary; backend-internal retries
remain the backend's own metric unless surfaced as another invocation. Telemetry
observer failure is isolated from provider correctness and increments
`opengeni_observability_observer_errors_total{observer="sandbox_operation"}`.

## Implementation graph

```text
P1 public PromQL + freshness ─┐
P2 routed operation metrics ──┼── P4 public PR / protected CI / merge
P3 dashboard + docs ──────────┘                         │
                                                   ▼
O1 ops imports exact public dashboards ─┐
O2 additive rules + probe correction ───┼── O4 ops PR / protected CI / merge
O3 semantic evidence + tests ───────────┘
                                                   │
                                                   ▼
                           serialized bootstrap / live verification (separate release)
```

Private ops must be based on the merged public commit (or consume it as an explicit
`source_sha`) before it can be reviewed as deployable. This is a hard dependency, not
parallel best effort.

## Work plan and acceptance criteria

### P1 — Public alert and query correctness

- Change the drain alert to match `5m_1h|1h_1d|gte_1d`; `lt_5m` is intentionally
  excluded as the grace interval.
- Add tests that parse the rule YAML and assert emitted/queried label parity.
- Add per-domain projection success/failure instrumentation around each independent DB
  read; a failure must not refresh that domain's timestamp.
- Test the family-to-domain selector mapping, stale and absent timestamps, and a failed
  projection retaining the prior gauge snapshot while its timestamp ages. Metric
  updates are synchronous within the worker's single JavaScript event loop, so the
  zero-fill loop is not interleaved with a `/metrics` scrape handler.
- Add alert tests for warming timeout and create-failure traffic gating so absent
  series and zero traffic do not produce nonsense ratios.
- Add per-domain freshness recording rules and staleness/absence alerts for leases,
  checkpoint artifacts, rotation backlog, retained processes, and expired drains.
- Assert all database inventory dashboard queries use freshness filtering plus `max`,
  never an unfiltered `sum` or `max`.

Acceptance: focused tests fail against the old expressions and pass with the new
ones; Helm template renders with the required rule names and expressions.

### P2 — Routed operation telemetry

- Add a fail-safe observer to the common `RoutingSandboxSession` provider-call
  boundary, including retained-process stdin/control paths that bypass ordinary
  pointer dispatch.
- Wire worker-turn and API-direct routes to their local observability registries.
- Normalize backend and operation labels against fixed allowlists and map any future
  value to `unknown` rather than accepting unbounded input.
- Test success, provider rejection, fenced retry, process control, observer failure,
  and label normalization without changing routing/settlement behavior. Observer
  exceptions must preserve the exact provider error and mutation-settlement ordering.

Acceptance: one provider call produces one observation, a physical retry produces a
second observation, observer failure never changes the operation result, and no
unbounded value reaches Prometheus.

### P3 — Canonical sandbox dashboard

- Add `deploy/observability/dashboards/sandbox-health.json` with fixed UIDs, bounded
  variables, descriptions explaining ownership semantics, units, thresholds, and
  deep links to logs where supported.
- Correct the worker-fleet lease panel to use authoritative `max by (liveness)` and
  clarify cold-history semantics.
- Update the dashboard README and deployment documentation.
- Add a structural dashboard test that loads all JSON, rejects duplicate UIDs/IDs,
  rejects forbidden high-cardinality labels, and pins required sandbox queries.

Acceptance: JSON parses, Grafana schema fields are present, all required lifecycle
signals have a panel, and the test proves replicated gauges are not summed.

### P4 — Public review gate

- Run formatting, lint, relevant unit tests, Helm rendering, and repository typecheck.
- Review the exact diff for four classes of failure: semantic truth, cardinality,
  absent-series behavior, and deployment compatibility.
- Open a ready PR, obtain exact-head review and protected CI, then merge only that
  reviewed head.

Acceptance: merge commit tree matches the reviewed head tree and public main contains
the canonical dashboard/rule contract.

### O1 — Deterministic installation from exact source

- During bootstrap, enumerate canonical dashboard JSON from the exact public
  `source_sha` checkout and generate one labeled ConfigMap per dashboard.
- Remove the private sandbox-dashboard duplicate. The on-call dashboard may remain a
  private cluster summary, but its sandbox PromQL must follow the public aggregation
  contract and link to `opengeni-sandbox-health`.
- Apply dashboards with deterministic names and prune obsolete managed dashboard
  ConfigMaps by management label.

Acceptance: a fixture run produces ConfigMaps whose dashboard bytes equal the exact
public checkout and a second run is idempotent.

### O2 — Additive alert and current probe contract

- Preserve the public chart rules; private cluster/API rules are appended in their own
  `PrometheusRule` instead of replacing chart defaults.
- Use `max_over_time(kube_job_status_failed{job_name=~"opengeni-synthetic-probe-.+"}[45m]) > 0`
  for the synthetic failure alert. Do not require a `reason` label that is not part of
  the portable kube-state-metrics contract.
- Alert when `kube_cronjob_status_last_successful_time` is absent or older than the
  bounded interval; this CronJob status survives child-Job TTL/history cleanup, while
  `last_schedule_time` alone is not proof of success.
- Generate the probe ConfigMap from the current checked-in script and retain the
  dynamic `/codex/status` API-contract discovery, model preflight, session creation,
  tool execution, durable ledger, and cleanup path. The probe observes the healthy
  live revision instead of baking an expected deployment SHA into the CronJob, reuses
  one idempotent session per observed revision, proves a marker-bearing sandbox command
  on every cycle, and clears model context after the receipt so routine probes neither
  accumulate sessions every 30 minutes nor build unbounded replay history.

Acceptance: generated manifests contain every required public sandbox alert plus the
private probe alert; the probe script contains dynamic contract discovery and no
hard-coded stale revision/model. It rejects a completed turn without exact sandbox
command output and rejects a cycle whose context cleanup did not complete. The failed-Job query is namespace/name scoped, the
CronJob keeps a bounded finished-Job history/TTL, and last-success age is the primary
standing signal. A fixture proves ledger failure exits non-zero; the missing-success
alert treats absent as failure and has enough `for` grace for one schedule interval
plus the maximum probe runtime.

### O3 — Semantic observability receipt

- Extend the private evidence checker to require the sandbox dashboard ConfigMap,
  exact required rule names and key expressions, and current probe script markers.
- Bind the receipt to the exact public `source_sha`, live workload deployment revision
  and image digests, and record any deliberate version skew explicitly.
- Record content hashes for the dashboard, rules, probe ConfigMap, and CronJob in the
  bootstrap evidence manifest.
- Assert Grafana sidecar discovery labels/folder metadata, reject public/private alert
  name collisions, and prune only ConfigMaps carrying the exact OpenGeni management
  label. Reject a generated dashboard before apply if it exceeds the Kubernetes
  ConfigMap size budget.
- Poll the live Prometheus rules API until every required rule is loaded and healthy,
  require a non-empty freshness-filtered lease recording rule, and poll Grafana until
  the imported sandbox dashboard contains both the fresh-inventory and routed-operation
  query contracts. UID presence alone is insufficient because a stale dashboard can
  retain the same UID.
- Fail bootstrap when any required object is missing, stale, or replaced.

Acceptance: tests cover missing dashboard, stale drain label, replacement of public
rules, stale probe script, and ephemeral-Job query regression; all must fail closed.

### O4 — Private review gate and merge

- Rebase on current private main after the public merge.
- Run `bun run check`, deterministic generated-bundle checks, and workflow fixture
  tests.
- Open a ready PR, obtain exact-head review and protected CI, and merge only the
  admitted head.
- Update the private tracking issue with exact public/private PRs, heads, CI runs,
  and merge commits.

Acceptance: both repositories are clean on authoritative main and the issue contains
reproducible receipts. The production rollout remains a separately serialized action.

## Rollout and rollback

Rollout is maintenance-less but ordered. First promote the ordinary OpenGeni release
containing the new projection-freshness and routed-operation emitters, verify the live
deployment revision and metrics, and only then apply the additive dashboard ConfigMaps,
Prometheus rules, and current synthetic CronJob. No database migration is required.
The private bootstrap fails closed if the live application revision/image evidence is
not compatible with its exact public `source_sha`; this prevents absence alerts from
being installed ahead of their emitters.

Post-deploy verification must prove:

1. Grafana lists the canonical sandbox dashboard and its data source resolves.
2. Prometheus parses every rule and the stale label matcher is absent.
3. The freshness-filtered `max by (liveness) (opengeni_sandbox_leases)` matches an
   authoritative recent control-replica sample instead of double-counting or accepting
   an older replica's retained value.
4. Current expired drains, checkpoint state, rotations, and retained processes are
   visible even when their value is zero.
5. Prometheus has loaded/evaluated the required rule group and Grafana has ingested the
   dashboard, rather than merely observing their Kubernetes objects.
6. A synthetic run creates or reuses the one revision-bound probe session, executes a
   sandbox tool, writes a successful durable ledger, clears replay context, and leaves
   the alert inactive.

Alert rules carry severity and runbook annotations. Environment-specific thresholds
may use schema-validated Helm values, but metric names, label vocabularies, ownership,
and aggregation semantics are not overrideable. For any future label-vocabulary
change, deploy a backward-compatible emitter before or in the same release as the new
matcher; never deploy a matcher that no live emitter can satisfy.

The compatible rollback pair is the prior immutable application release plus the prior
immutable observability bundle. Rolling back only the observability bundle is safe but
temporarily leaves the new emitter series unwatched. Rolling back only the application
image leaves the new absence alerts correctly firing on incompatible/missing emitter
series; operators must either complete the paired bundle rollback or explicitly
silence those named alerts for the bounded rollback incident. Neither direction touches
database state. Failed synthetic evidence is retained and never rewritten to success.
The install receipt proves compatibility at reconciliation time; the standing
projection-stale/absent and probe-success alerts continuously detect later skew.
