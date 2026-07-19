# Turn-worker density contract and reproducible profile

Date: 2026-07-16
Owner: OPE-52

## Contract

- A turn worker runs one process and an explicit fixed number of concurrent
  `runAgentTurn` activities. The temporary production setting is 16 turns per
  pod; changing it requires measured evidence rather than an SDK default or an
  inferred memory estimate.
- Target incremental worker memory is at most 50 MiB per active turn. The hard
  release ceiling is 100 MiB per active turn, including exceptionally long
  model histories. Fleet pod requests and limits must retain process/runtime
  headroom in addition to this incremental amount.
- The complete active model-facing transcript has a 32 MiB UTF-8 JSON
  materialization envelope. PostgreSQL measures `item::text` bytes before
  returning any JSONB row and the worker rejects an oversized transcript with
  non-retryable `active_history_too_large`; it never silently trims durable
  conversation truth or relies on compressed JSONB storage size. Normal
  token-driven compaction should keep valid sessions far below this final
  safety boundary.
- Production density evidence must use the exact production image and database
  shape. The reproducible local profile uses `ScriptedModel` and must not call
  an Azure or other external model endpoint.
- A timed-out auxiliary operation remains visible as resident until its actual
  promise settles. A caller deadline must not make background memory disappear
  from metrics.
- Recording bytes go directly from the sandbox to a short-lived, write-only
  object-storage URL. They never enter worker memory or a Temporal payload.

## Reproducible OPE-52 profile

Run the profile with:

```bash
OPENGENI_DENSITY_ARTIFACT_PATH=artifacts/turn-density.json \
  bun run profile:turn-density
```

The default sweep is exactly `1,2,4,8,12,16,24,32`, with three repeated waves
per density and a 15-second plateau sampled every 500 ms. The sweep can be
selected/reordered with `OPENGENI_DENSITY_SWEEP`, but values outside those
eight release-gate candidates and duplicate values are rejected. The following
inputs are configurable:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `OPENGENI_DENSITY_SWEEP` | `1,2,4,8,12,16,24,32` | Exact candidate densities to run |
| `OPENGENI_DENSITY_WAVES` | `3` | Repeated waves at every selected density |
| `OPENGENI_DENSITY_ACTIVE_HISTORY_BYTES` | `750000` | Bounded active long-history bytes per turn |
| `OPENGENI_DENSITY_INACTIVE_HISTORY_BYTES` | `8388608` | Bounded inactive durable-history bytes per turn |
| `OPENGENI_DENSITY_COMPACTION_TAIL_BYTES` | `200000` | Recent-user tail in the compaction-shaped active history |
| `OPENGENI_DENSITY_PLATEAU_SECONDS` | `15` | Time held at the model gate |
| `OPENGENI_DENSITY_PLATEAU_SAMPLE_INTERVAL_MS` | `500` | RSS sample interval during the plateau |
| `OPENGENI_DENSITY_TARGET_MIB_PER_TURN` | `50` | Advisory target threshold |
| `OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN` | `100` | Failing hard threshold |
| `OPENGENI_DENSITY_ARTIFACT_PATH` | unset | Optional pretty-printed JSON artifact path |

The history seed is deterministic and bounded. It writes inactive rows followed
by active rows, marks a compaction-checkpoint-shaped active item, and makes the
newest configured tail recent user input. The default active/inactive sizes are
the same shape as the original gate; the profile rejects more than 32 MiB for
either per-turn history class. The production active-history reader separately
measures the aggregate server-rendered UTF-8 JSON size under one repeatable-read
snapshot before keyset paging, so TOAST-compressible payloads and concurrent
appends cannot bypass the envelope. Sampling and synthetic allocation knobs are
also
bounded by the script so a profile cannot accidentally become an unbounded
memory test: at most 10 waves, a 300-second plateau, 100 baseline or settled
samples, 1,024 synthetic tool/fan-out/drain items, 2 MiB of synthetic working
bytes per turn, and a 60-second synthetic wait. Plateau sampling cannot be more
frequent than every 100 ms, and the per-wave timeout cannot exceed 30 minutes.

Each activity uses `sandboxBackend: "none"`, a zero-priced
`scripted-density-model`, no model-provider registry entries, and no API key.
The model wrapper holds each request at a deterministic gate, then drains it
only after plateau sampling. The turn-indexed synthetic mix cycles through:

1. streamed deltas plus a forced operator compaction;
2. a bounded tool-call/tool-output burst-shaped object set;
3. bounded sandbox manifest/operation envelopes;
4. bounded fan-out promises;
5. a bounded wait before the gate; and
6. unresolved drain promises that settle after release.

The forced-compaction selection rule is exactly `turnIndex % 6 === 0`, so each
wave must make `ceil(density / 6)` compaction calls. After activity settlement,
the harness also requires every selected request to be consumed and each
selected session to have fewer active history rows than it had before the
turn. This gives density 1 a real compaction boundary and larger densities a
stable mix of compacting and ordinary turns even when the default 750,000-byte
history would remain below the automatic token threshold.

The tool and sandbox entries are deliberately **in-process shapes**, not real
tool calls, MCP traffic, sandbox operations, provider calls, or Azure inference.
The JSON artifact records `externalModelProviderCalled: false`,
`azureInferenceCalled: false`, and `realSandboxProviderCalled: false` so a
consumer cannot mistake this profile for provider or sandbox evidence.

## Machine-readable measurements

The profile always emits one `OPENGENI_DENSITY_RESULT=<JSON>` line. When
`OPENGENI_DENSITY_ARTIFACT_PATH` is set, the same result is written as a
pretty-printed JSON file. The artifact contains per-wave baseline, plateau, and
settled RSS/heap/external summaries, the raw memory samples and derived series,
per-density statistics, an aggregate summary, cleanup totals, and thresholds.
Schema-v3 artifacts are independently checked from their exact file bytes:

```bash
bun run verify:turn-density -- artifacts/turn-density.json \
  --sha256 <expected-sha256>
```

The verifier hashes the exact UTF-8 file, then recomputes every memory summary,
per-turn value, percentile, retained/leak statistic, per-density and aggregate
threshold, raw sample count, truthful synthetic-buffer allocation, and expected
workspace/session cleanup total. It also derives `ceil(density / 6)` rather
than trusting stored compaction counts and requires the matching verified
active-history-shrink count in every wave. Stored summaries are never accepted
as proof of their own raw samples.

For each plateau RSS sample, incremental RSS per active turn is:

```text
max(0, (plateau_sample_rss - baseline_rss_median) / density)
```

`incrementalRssMiBPerTurn` reports `count`, `p50`, `p95`, `p99`, and `worst`
for those values. `worst` is the threshold value: a density passes the hard
gate only when its worst value is at most
`OPENGENI_DENSITY_HARD_LIMIT_MIB_PER_TURN`. The artifact also reports:

- `retainedAfterSettlementMiBPerTurn`: settled median minus baseline median,
  normalized by density, across waves;
- `plateauToSettledMiB`: plateau samples minus settled median, showing the
  drain after gate release; and
- `settledGrowthMiB`: first/last settled RSS, delta, and linear slope per wave,
  making repeated-wave leak or plateau drift visible.

The process exits with status 2 when any selected density breaches the hard
threshold, and status 1 for cleanup or artifact-write failure. A passing local
profile is not a production approval: CPU throttling, event-loop lag, turn
latency, real sandbox latency, capture residency, recording residency, and
worker restarts require separate provider/deployment evidence.

## Historical isolated profile evidence (2026-07-18, before schema v3)

The exact implementation commit `206da6c0` was profiled in this non-serving
Linux/x64 sandbox with Bun 1.3.14 and local PostgreSQL 17. The profile used no
external model, Azure inference, real sandbox provider, or serving pod. Raw
artifacts and timing logs remain outside the repository under `/tmp`; only
their checksums and reduced results are recorded here.

The canonical default three-wave sweep completed in 8:41.74 with exit 0 and a
maximum process RSS of 1,072,432 KiB. It emitted exactly one result line and
left zero profiling workspaces or sessions. Its artifact SHA-256 is
`5e715bd390a58193f88b882d42713628a9547ca707a2c53f2ad6ebc41bb4edee`.

| Density | Worst incremental RSS MiB/turn | Settled RSS slope MiB/wave |
| ---: | ---: | ---: |
| 1 | 8.0 | 3.0 |
| 2 | 3.0 | -0.5 |
| 4 | 1.6 | 10.2 |
| 8 | 3.8 | -11.0 |
| 12 | 2.2 | 2.0 |
| 16 | 1.8 | -6.0 |
| 24 | 2.3 | 0.8 |
| 32 | 0.2 | 18.0 |

Across all 744 canonical plateau samples, incremental RSS per turn was 0.2 MiB
p50, 3.6 MiB p95, and 8.0 MiB p99/worst. That historical harness did not force
compaction, and the ordinary 750,000-byte active history was below the
automatic threshold, so the artifact made zero compaction calls. It is useful
ordinary-path evidence but does **not** satisfy the current schema-v3
compaction-mix gate. Settled slopes are reported rather than hidden; they vary
in both directions as Bun's allocator retains and releases process arenas. No
density breached the target or hard gate, but three waves are not a proof that
allocator RSS will monotonically return to the first baseline.

The separate maximum-history sweep used one wave at every required density,
32 MiB active plus 32 MiB inactive durable history per turn, an 8 MiB recent
compaction tail, 2 MiB synthetic working data per turn, and 1,024 bounded
tool-burst, fan-out, and drain entries. It completed 99 turns in 3:10.27 with
exit 0 and a maximum process RSS of 2,059,064 KiB. It emitted one result line,
deleted every profiling workspace/session, and produced artifact SHA-256
`90c10e90bf7326b55f81a4b9b115ae5f44463f51fafe81e98b02b2710d8ee7a1`.

| Density | Compaction calls | Worst incremental RSS MiB/turn |
| ---: | ---: | ---: |
| 1 | 1 | 48.0 |
| 2 | 2 | 30.0 |
| 4 | 4 | 32.0 |
| 8 | 8 | 31.0 |
| 12 | 12 | 26.7 |
| 16 | 16 | 25.8 |
| 24 | 24 | 24.6 |
| 32 | 32 | 15.3 |

The maximum-history aggregate was 28.4 MiB p50 and 48.0 MiB p95/p99/worst,
passing both the 50 MiB target and 100 MiB hard ceiling. Compaction calls equal
the admitted turn count at every density, proving the memory result includes
the compaction path rather than only the ordinary model gate. A preceding
single-density smoke independently measured 48.0 MiB worst, exit 0, one
compaction, and artifact SHA-256
`4906ec9af496856393291302ba3878aa5e040745b940288bcd7f927078a276b4`.

The pathological result depends on allocation fixes. Active history is read in
ordered keyset pages of 16 while retaining exactly one logical transcript, and
the sanitized item count produced by that same runtime input is reused for
reconciliation instead of loading the full active history a second time. JSON
token estimation counts exact serialized UTF-16 or UTF-8 length without
allocating a second giant string for persisted plain JSON/JSONB. Objects with
non-persisted JavaScript semantics (proxies, accessors, custom `toJSON`, boxed
values, sparse or decorated arrays, and custom/cross-realm prototypes) are
rejected from the plain-JSON fast path; direct non-persisted callers use the
materializing fallback rather than receiving a false universal-parity claim.

The process maximum is intentionally reported but is not the per-turn gate: it
includes Bun, loaded application modules, database/runtime clients, native
allocator arenas, all concurrently active turns, and post-settlement retained
pages. Kubernetes sizing must therefore combine measured baseline/current
cgroup usage, the hard per-turn reservation, and explicit native headroom.

## Admission, resource sizing, and autoscaling contract

Turn workers use a Temporal custom activity-slot supplier instead of accepting
16 tasks unconditionally. The hard density remains 16, but each reservation
must satisfy both projections below using the pod cgroup v1/v2 current/limit:

```text
startup_baseline + reserved_after * 100 MiB + 512 MiB <= cgroup_limit
current_usage    + pending_after  * 100 MiB + 512 MiB <= cgroup_limit
```

The worker rejects startup if even one turn is unsafe. After startup, available
slots are the minimum of the density remainder, baseline-contract remainder,
and live cgroup-usage remainder after pending permits. Advertised capacity is
already-reserved slots plus those currently available slots, so retained native
memory contracts new admission without pretending admitted work disappeared.
Malformed, partial, unreadable, nonpositive, or unsafe finite cgroup controller
values fail closed; only explicit v2 `max` and valid v1 unlimited sentinels are
unlimited. The worker publishes capacity, reserved/used/available slots,
saturation, baseline/current/limit memory, hard turn bytes, and native headroom
as bounded gauges. OOM is never used as an admission mechanism. The production
Azure 3 GiB request / 6 GiB limit and
500m / 2 CPU envelope remains conservative: the observed current-revision
maximum working set was about 0.93 GiB, while the contract reserves 1.56 GiB
for 16 turns plus 0.5 GiB native headroom and the measured startup baseline.
Lowering the limit or request without measuring the exact image would reduce
schedule/admission headroom rather than constitute right-sizing.

Runnable pressure comes from Temporal's turn activity task queue, not prompt or
session counts. The exported series cover eligible backlog/count/age/rates,
monitor read success/timestamp/age/freshness, and slot
capacity/reservation/use/availability/saturation. A failed or hung Temporal
read leaves the old value visible for diagnosis but marks it stale; backlog and
saturation alerts require a successful sample less than 45 seconds old.
Dashboard queries use `max`, not `sum`, for queue state because each worker
observes the same task queue, and require one exact namespace, environment, and
Helm release so independent fleets cannot aggregate by default. A Pods HPA
metric named `opengeni_turn_slot_saturation_ratio` targets
`750m`; it is deliberately disabled until a verified `custom.metrics.k8s.io`
adapter exists. CPU 70% and memory 80% remain the production fallback. This is
truthful degradation: a missing adapter must not make an HPA depend on an
unavailable metric, and the removed aggregate paused-prompt gauge must never be
reintroduced as runnable demand.

## Previously recorded evidence

The following baseline is a pre-existing historical record from before this
profile expansion. This OPE-52 leaf does **not** rerun, validate, or claim a new
production result from it.

The exact production revision `ebf4a9e8e1590c2415c32e963cafa2328f56babb`
was previously profiled in an isolated production pod with 16 concurrent real
`runAgentTurn` activity invocations. Each invocation loaded 750,000 active
history bytes plus 8 MiB of inactive durable history and stopped concurrently
at a deterministic model gate.

- baseline RSS median: 284.1 MiB
- plateau RSS maximum: 441.8 MiB
- incremental RSS per active turn: 9.9 MiB
- settled RSS median: 332.1 MiB
- target and hard ceiling: passed

That record covers model-input construction, active-history residency, turn
settlement, and the ordinary activity path. It deliberately disabled sandbox,
workspace capture, recording, integrations, and provider calls; it is not direct
memory evidence for those disabled subsystems. Historical Prometheus data and
the recording/capture fixes are retained in the original production record but
are not exercised by this synthetic local sweep.

## Read-only production fleet evidence (2026-07-18)

The production turn fleet had 10 replicas with HPA bounds 10–20, requests of
500m CPU / 3 GiB memory, and limits of 2 CPU / 6 GiB memory. The HPA used CPU
70% and memory 80%; neither `custom.metrics.k8s.io` nor
`external.metrics.k8s.io` was installed, so an eligible-backlog or slot metric
cannot truthfully be enabled there until a metrics adapter is verified.

For current-revision pods over three days, Prometheus reported:

- maximum/average working set: 997,953,536 / 349,212,644 bytes;
- maximum process RSS: 1,048,006,656 bytes;
- maximum/average five-minute CPU: 0.333 / 0.0275 cores;
- maximum CPU throttle ratio: 0.0185; and
- maximum in-flight activities on one pod: 2.

The same observation window had zero current-revision restarts or OOM reasons.
An old aggregate gauge simultaneously counted 412 paused human prompts even
though only six turns were in flight. Paused prompts are durable but are not
eligible `runAgentTurn` work, which is why the aggregate gauge was removed and
the Temporal turn-activity task queue is now the authoritative runnable
backlog.

The live turn-worker PDB was `minAvailable: 1` with 10 replicas, permitting nine
simultaneous voluntary disruptions. At 16 admitted turns per pod, that exposed
as many as 144 turns to concurrent checkpoint/drain pressure. The source PDB is
now `maxUnavailable: 1`, matching the Deployment rollout bound and limiting a
voluntary disruption to one pod / 16 turns. The live Deployment had drifted to
`maxUnavailable: 25%` even though the source value was one and must be
reconciled through the serialized release lane.

A hard pod death still affects every slot admitted on that pod, a hard maximum
of 16 turns. Production happened to place no more than two turn pods on one
node during the read-only observation, so that observed topology exposed up to
32 turns to one node loss; placement policy does not enforce that number. At
the 20-pod HPA maximum across six nodes, a balanced four-pods-on-one-node
placement would expose an estimated 64 turns, and worse skew remains possible.
A PDB cannot constrain involuntary node loss.

## Rollout, node-loss, and OOM fault contract

The safe fault matrix separates graceful rollout from abrupt process loss:

- graceful worker shutdown interrupts a turn after a checkpointed MCP side
  effect, moves the exact existing turn to `recovering`, and finishes it on a
  healthy worker without replaying that side effect;
- graceful shutdown before model progress recovers the same turn and original
  trigger without creating a prompt, recovery message, or second turn;
- a late activity settlement after Pause is rejected by the attempt fence and
  cannot override the durable recovery/control winner;
- a real Temporal heartbeat timeout simulates the observable result of a node
  loss, `SIGKILL`, or cgroup OOM: the exact attempt is recovered and the same
  logical turn is dispatched once to a surviving worker; and
- an atomic redispatch ceiling of three makes repeated worker deaths terminal
  once, rather than creating an unbounded duplicate loop.

The integration assertions require one logical turn row, one recovery request,
no failure on a successful recovery, the canonical conversation input on the
successor attempt, and no second invocation of an already-completed MCP tool.
Unit tests independently prove cgroup memory-limit admission, exact attempt
ownership, stale-successor rejection, and one terminal settlement/wakeup at the
redispatch ceiling.

No destructive OOM was injected into a shared production pod. The heartbeat
timeout uses a real Temporal server and a deliberately non-heartbeating
activity in isolated test services, exercising the same orchestration boundary
seen after an ungraceful pod/node/OOM death without consuming serving headroom.
The rollout/node blast-radius numbers above are topology bounds, not a claim
that PDBs can prevent involuntary disruption.

Exact implementation/docs head `7ad07113` was validated on 2026-07-18 with
isolated PostgreSQL 17, checksum-verified NATS 2.14.3, and checksum-verified
Temporal CLI 1.8.0 / server 1.31.2:

- standalone DB-backed context compaction: 7 passed, 0 failed;
- real heartbeat timeout redispatch plus atomic redispatch ceiling: 2 passed,
  0 failed, 7 assertions, 249.01 seconds;
- graceful mid-turn and pre-model worker shutdown against real DB/NATS/Temporal:
  2 passed, 0 failed, 32 assertions, 17.17 seconds; and
- exact attempt ownership, cancellation settlement, memory admission, and
  eligible-capacity metrics: 17 passed, 0 failed, 56 assertions.

The graceful mid-turn case asserts that the already-completed MCP call occurs
exactly once. The early-shutdown case asserts one `turn.started` after recovery.
The heartbeat case uses Temporal's real `HEARTBEAT` timeout type, and the
ceiling case proves the durable terminal result does not issue a second failure
write. No external model or sandbox provider participates in these tests.

## Non-serving execution requirement

A read-only forensic fingerprint over 3,823 sessions was previously run inside
a 1 GiB production serving API pod and exited 137. The child process did not
restart the API container, but it broke the routed shell and consumed serving
headroom. Heavy forensics and density profiling therefore run only in an
isolated non-serving execution class. They must never execute in API or worker
serving pods, and destructive shared-production OOM experiments are prohibited.

The three historical raw density artifacts named above are private and
immutable; only their SHA-256 fingerprints and reduced evidence belong in this
open-source repository. They predate schema v3. New evidence must use schema v3
and pass `verify:turn-density` before its checksum or reduced result is cited.

## Production release gate

Before increasing density above 16, run multiple waves at each candidate
against the exact production image and production database shape, then record
the same p50/p95/p99/worst incremental RSS plus CPU throttling, event-loop lag,
turn latency, capture residency, sandbox latency, and post-settlement
retention. Increase one lever at a time. Any hard-ceiling breach, unexplained
retained growth, failed capture/recording correctness proof, or worker restart
rejects the candidate. No production sweep was run as part of this leaf.
