# Turn-worker queue-demand autoscaling

The public chart's `worker.turns.autoscaling.queueDemand` is a **default-off**
schema-v1 source contract. Enabling it is not evidence of production safety,
mixed-activity throughput or savings. Private production overlays keep their
own bounds (currently 14 minimum / 28 maximum); this feature changes neither
resource requests/limits nor application admission settings. The public Azure
example's 2/20 bounds are examples, not accepted production floors.

## Opt-in and policy

Merge the following with an operator-controlled values file and its existing
Prometheus selectors. Do not lower the existing minimum when opting in.

```yaml
worker:
  turns:
    autoscaling:
      enabled: true
      queueDemand:
        enabled: true
        schemaVersion: 1
        targetAverageValue: "8"
observability:
  metrics:
    enabled: true
  serviceMonitor:
    enabled: true
```

Helm rejects unsupported schema/target values, absent prerequisites, enabled
slot-saturation metrics, and arbitrary `customMetrics` in this mode. Empty
custom metrics or the exact historical `opengeni_turns_inflight` Pods
AverageValue `"8"` singleton are supported; the latter is rendered once, not
twice. Existing `autoscaling.behavior` is replaced by the schema-v1 policy.
Feature-off HPA metrics/behavior remain unchanged.

The feature renders exactly one autoscaling/v2 HPA for the turn Deployment:

| Signal | Native HPA target |
| --- | --- |
| CPU / memory | Resource Utilization 70 / 80 |
| Agent-only `opengeni_turns_inflight` | Pods AverageValue 8 |
| `opengeni_turn_worker_demand` = Q + R | Namespace Object AverageValue 8 |
| `opengeni_turn_worker_queued` = Q | Namespace Object AverageValue 8 |
| `opengeni_turn_worker_busy` = B | Namespace Object AverageValue 1 |

Object metrics describe the release namespace with `apiVersion: v1` and
`kind: Namespace`; their metric selector binds all five exact source labels:
`namespace`, `release`, `environment`, `temporal_namespace`, `task_queue`.
They are total demand for that identity with **AverageValue**, not Object Value or a per-pod
mean. In the ideal, fully observed case their recommendations are
`ceil((Q+R)/8)`, `ceil(Q/8)` and B, subject to native tolerance, multi-metric
selection, bounds and rate policies. The target of 8 is an experimental
headroom setting, not proof that a worker can execute eight simultaneous
mixed activities. CPU, memory and agent-only recommendations remain in the
maximum; agent-only inflight is not added to R.

Scale-up: zero stabilization, `selectPolicy: Max`, at most four Pods per 30
seconds. Scale-down: 600-second stabilization and one Pod per 300 seconds are
retained as policy fields, but `selectPolicy: Disabled` prevents downscale.
Downscale enablement and any future 2- or 4-pod production floor are separate,
recovery-qualified changes. A downscale-disabled HPA may still increase to its
ceiling and stay there; no savings claim follows from this source change.

## Raw metric and scrape contract

The ACTIVITY task queue is `${OPENGENI_TEMPORAL_TASK_QUEUE}-turns`, default
`opengeni-runs-ts-turns`, in `OPENGENI_TEMPORAL_NAMESPACE`, default `default`.
Rules scope exact `namespace`, Helm `release`, `environment`,
`component="worker-turn"`, `temporal_namespace` and `task_queue`. Chart config
must match the actual runtime values; a Secret/environment override that
changes this identity without updating chart config yields absent telemetry,
not a guessed queue. Queue readers must describe the actual worker queue.

| Metric | Meaning |
| --- | --- |
| `opengeni_turn_eligible_backlog` | Approximate shared Temporal ACTIVITY backlog Q; use MAX across successful readers, never SUM |
| `opengeni_turn_capacity_monitor_fresh` | Latest-read validity: 1 only for a successful queue observation |
| `opengeni_turn_capacity_monitor_last_success_timestamp_seconds` | Producer time of the successful queue read |
| `opengeni_turn_worker_activities_inflight` | SDK executing **non-local** activities on one worker, including preclaim, video and cleanup; not only agent turns |
| `opengeni_turn_worker_activities_last_read_success` | Latest SDK status-read validity |
| `opengeni_turn_worker_activities_last_observed_timestamp_seconds` | Producer time of the SDK observation, refreshed during drain |

All queue/status metrics have `temporal_namespace` and `task_queue` labels.
All three occupancy metrics additionally carry nonempty `worker_pod_uid`, from
`OPENGENI_POD_UID`; the chart supplies `metadata.uid` via Downward API and
forbids a worker extraEnv override. Missing UID is not replaced with a pod
name. Idle workers must actually emit occupancy zero. Backlog is approximate,
includes video and retries, and is not an exact count of customer turns.
The SQL `opengeni_turns_queued` prompt count is not a scaler input.
The producer contract assumes one turn SDK poller for each registry/queue/pod
UID, as in the normal chart Deployment. Embedded hosts running multiple
same-identity workers must aggregate their SDK occupancy first; scrape
deduplication cannot repair an incomplete producer.

The worker ServiceMonitor relabels discovery `__meta_kubernetes_pod_uid` to
`pod_uid` and pod name to `pod`, on both raw series and `up`. This identity is
independent of the producer's UID; a producer/scrape UID disagreement is
rejected. Required target labels are namespace/release/pod/pod_uid/job/instance,
with `opengeni_workload_component="worker-turns"` on `up`. If using a different
scraper, reproduce these labels and healthy-target checks exactly.

Require kube-state-metrics with UID-bearing `kube_pod_info`, `kube_pod_labels`,
`kube_pod_status_phase` and `kube_pod_deletion_timestamp`, fresh
`kube_deployment_status_replicas`, and healthy KSM `up`
sharing `job,instance`. Allowlist pod labels
`app.kubernetes.io/instance,app.kubernetes.io/component`. A deletion timestamp
is absent for ordinary nondeleting pods; that absence alone is normal.
Present deletion values must be finite, positive, no more than five seconds
ahead, and freshly sampled from a healthy KSM target. Invalid, stale or failed
present observations are incomplete UID evidence, never treated as absence.
An old deletion event is valid during a long drain if its sample stays fresh;
the event's age is not the producer-observation TTL.
Do not relabel away KSM's `uid`. Pod inventory is scoped to this release's
`<fullname>-worker-turns-.*` pods and exact release/component labels.

The dedicated `worker-scaler-prometheusrule.yaml` is installed only with the
opt-in; it uses `observability.prometheusRule.labels/annotations` for Operator
selection, independently of the legacy alerts' enabled switch. Confirm the
Operator actually selects this new object. Helm requires the
`monitoring.coreos.com/v1` API; offline renders must pass
`--api-versions monitoring.coreos.com/v1`.
The five identity labels are declared on **every recording rule**, not the
group. This avoids the newer `group.labels` field and keeps explicit probe
labels and atomic completion-marker labels intact. Source rule checks and
semantic fixtures are tested with Prometheus **2.55.1 and 3.5.0**; this is not
a blanket engine/Operator/CRD compatibility claim. Confirm the installed
engine and CRD accept and evaluate the actual rendered rules; the Operator
API capability alone is not runtime qualification.

## Freshness and completeness

Rules evaluate every 15 seconds. Every raw sample must be younger than 60
seconds and no more than five seconds in the future relative to Prometheus.
Producer timestamps must also be positive and no more than five seconds ahead.
The queue read must be **strictly younger than 45 seconds**, preserving the
producer's existing default 45-second budget; at exactly 45 seconds Q is absent.
Occupancy observations retain their separate strict 60-second budget. Do not
extend the queue budget to 60 seconds or shorten all raw/scrape/activity TTLs
to 45 seconds. Validity must be exactly 1;
counts must be finite and nonnegative. Failed/latest-invalid reads are not
rescued by a previously successful producer timestamp. Each intermediate
record dependency is independently fenced to less than 30 seconds old and
at most five seconds ahead, including inventory stages, and must carry the
same evaluation timestamp as the consuming rule. An intermediate failure
cannot combine a last-evaluation inventory with this evaluation's occupancy.
Every inventory/classification/completeness stage emits an atomic
`scaler_stage_complete="true"` marker in the **same recording rule** as its
data. A positive gate requires all markers from this evaluation, including
legitimately empty deletion and incomplete-UID vectors. Data selectors
explicitly exclude markers, and every recorded-series selector binds the
full five-label source identity. A missing or stalled stage cannot be
interpreted as an empty successful result. These markers are rule-completion
evidence, not pod observations, occupancy zeros or proof of complete raw data.
The three final metrics also have identically scoped
`<metric>_valid_until_timestamp_seconds` companions: minimum original raw
sample, producer-observation and scrape-health expiries, including KSM and
controller inventory for R/B. The queue producer's original expiry is
`lastSuccess + 45`; raw samples/scrape health and R/B expiry remain `+60`.
Recording a fresh timestamp never moves this
original deadline forward. Missing per-UID deadlines fail coverage too.

Q requires only one individually healthy successful fresh global reader.
Thus a failing peer does not suppress a useful scale-up lower bound. Duplicate
scrapes cannot inflate MAX queue inventory.

R and B require an observed complete physical fleet. Independent KSM pod info,
release labels, phase and scrape-target identities are checked as **sets of
namespace/pod/UID**, not equal counts of unrelated pods. All Running/Unknown pods and
all deleting/draining pods remain relevant, including unready pods. Every
relevant UID must have valid occupancy and healthy scrape identity before the
deduplicated per-UID MAX is summed or counted busy. One missing idle zero,
wrong UID, rollout replacement or unsampled draining worker removes R/B and
combined demand; fresh Q can remain. Pending nondeleting pods do not execute
and are excluded once a valid phase is observed. Empty or missing inventory
never manufactures an all-zero fleet. KSM/discovery are asynchronous observed
inventories, not a linearizable Kubernetes snapshot. A supplemental fresh
Deployment replica-count check requires observed nondeleting inventory to
match controller active replicas, detecting omissions from both pod lists
and scrape discovery. It is not a substitute for the exact UID set checks;
controller lag or a version with differing terminating-replica semantics
conservatively suppresses R/B. Production acceptance must measure
rollout/discovery lag and actual UID coverage.

Unready draining pods may disappear from Service endpoints. If they cannot be
scraped, occupancy becomes absent and the combined/busy metrics fail closed;
they are never assumed idle. Native missing-metric behavior must be verified
on the deployed adapter/controller version: healthy queue-only metrics may
allow scale-up while a missing/error metric must prevent a metric-driven
downscale. Independently, this source policy disables downscale outright.
Never insert `or vector(0)`, adapter zero-fill or SQL prompt backlog fallback.

## Adapter and runtime acceptance

Use the existing official custom.metrics adapter's Namespace mapping, not
KEDA, a second HPA or an external metrics API. The public
[`prometheus-adapter.queue-demand.example.yaml`](../deploy/helm/opengeni/prometheus-adapter.queue-demand.example.yaml)
is an example fragment, not an installed adapter. It retains the existing
Pods metric and adds the three exact names. Merge its rules with your existing
authenticated Prometheus connection, APIService/TLS and operational values.
Keep all five HPA metric selector labels in adapter LabelMatchers. Bind
**both discovery and every metricsQuery selector** to the exact authorized
source identity as well; request matchers alone are not sufficient because
clients can omit them. The public fragment explicitly selects
`namespace="opengeni", release="opengeni", environment="production",
temporal_namespace="default", task_queue="opengeni-runs-ts-turns"`.
Replace all five literals in **every** selector from the unanimous identity
labels on **every rendered recording rule** before use. Do not infer identity
from a group label or only one rule: validate all records against the HPA.
A partial request must select only
that source; a conflicting request must return absent, never another queue.
Private source selection, maintenance capture/restore and runtime proof must
retain those exact candidate-derived values. Do not combine different
environments/Temporal namespaces/queues within one Helm release. No other
custom metrics are approved by this source mode.

Adapter queries must validate **both the final recording-series and companion
sample timestamps** to less than 30 seconds old and at most five seconds
ahead, as in the example. Require an identically labeled companion with
`time() < validUntil <= time() + 65` (60-second TTL plus the five-second clock
allowance). Missing, nonfinite, expired, unbounded-future or differently
scoped deadlines cannot support demand, even with freshly timestamped values.
Also require **equal value/companion sample timestamps**, matched on every
label except `__name__`, **before aggregation**. An older value must not inherit
a newer expiry, nor may a newly observed fleet inherit an older fleet's expiry.
Matching only namespace, or comparing MAX timestamps after aggregation, can
mix evaluations or disjoint HA cohorts. Both healthy positive counts and real
zeros must retain their matching companion from the same evaluation.
Prometheus's default lookback otherwise resurrects old demand after stalled
or erroring rules. Empty series and Prometheus/adapter errors must stay
missing/errors, not zero. Original-deadline checks and evaluation-stall checks
are both required; neither substitutes for the other. Validate the real
custom.metrics response (including all five identity selectors and Namespace
object) and HPA readback, not discovery alone.

Source checks do not prove native HPA semantics, scheduling latency, headroom,
recovery, or production runtime acceptance. Before any downscale/floor change,
exercise the deployed producer → scrape → rules → adapter → native HPA path,
with duplicate scrapes, wrong/replaced UIDs, incomplete KSM, one/all failed
queue readers, stale/future clocks, lost endpoints, rule/adapter stalls and
errors. Verify full HPA metric identities, targets, selectors and policies,
maintenance capture/restore and release-source support. Old charts/binaries
must not receive unsupported queueDemand overlays.

Burst/recovery acceptance must include mixed video/agent/cleanup activities,
surge/rolling deletion, drain beyond natural grace, SDK force-stop,
SIGKILL/heartbeat recovery and unavailable dependencies. Prove durable
checkpoint/continuation and exact-attempt writer quiescence, with no replay of
unknown effects or duplicate inference. Compare latency and actual admitted
activity density against resources and DB/provider headroom. A configured
32-turn admission ceiling is not 32 proven executable slots.

## Deletion and shutdown limitations

B bounds a replica recommendation; it does **not** cause Kubernetes to delete
an idle worker. Deployment/ReplicaSet chooses deletion victims independently
and may remove a busy worker even when other workers are idle. PDBs govern
voluntary eviction, not HPA/Deployment scale-down deletion.

The worker currently uses SDK `shutdownGraceTime: "5s"` (natural completion
before cancellation) and `shutdownForceTime: "100s"`, inside the chart's
120-second Kubernetes termination grace. The 120-second setting does not
provide 120 seconds of natural activity completion. Force-stop or SIGKILL can
leave uncertain physical writers and delay exact-receipt-gated recovery;
recoverability is not the same as accepted disruption-free downscale. Keep
downscale disabled and production bounds intact until this is demonstrated.

## Local source verification

```sh
helm lint deploy/helm/opengeni
bun test ./deploy/helm/opengeni/test/queue-demand.test.ts
# Full chart regression, all examples, and focused upgrade contracts;
# each test file gets its own process, as in the deployment CI job.
bun install --frozen-lockfile
bun scripts/check-worker-queue-demand.ts
```

Tests run actual Helm rendering/schema validation and official promtool
**2.55.1 and 3.5.0** on the **rendered** dedicated rules, not an
extracted/reimplemented expression. All semantic, completion, identity,
pairing and expiry fixtures run on both engines.
Linux x64 can download checksum-verified pinned test binaries; other platforms
provide `OPENGENI_HELM`, `OPENGENI_PROMTOOL_2_55_1` and
`OPENGENI_PROMTOOL_3_5_0`. The remaining chart checks use `OPENGENI_PROMTOOL`
or PATH. Versioned compatibility checks never substitute a generic PATH
binary for a pinned engine, and verify the reported versions. Tests
must not silently skip Prometheus evaluation. These are local source proofs,
not a production/staging deployment or recovery acceptance result.
