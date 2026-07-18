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
either per-turn history class. Sampling and synthetic allocation knobs are also
bounded by the script so a profile cannot accidentally become an unbounded
memory test: at most 10 waves, a 300-second plateau, 100 baseline or settled
samples, 1,024 synthetic tool/fan-out/drain items, 2 MiB of synthetic working
bytes per turn, and a 60-second synthetic wait. Plateau sampling cannot be more
frequent than every 100 ms, and the per-wave timeout cannot exceed 30 minutes.

Each activity uses `sandboxBackend: "none"`, a zero-priced
`scripted-density-model`, no model-provider registry entries, and no API key.
The model wrapper holds each request at a deterministic gate, then drains it
only after plateau sampling. The turn-indexed synthetic mix cycles through:

1. streamed deltas;
2. a bounded tool-call/tool-output burst-shaped object set;
3. bounded sandbox manifest/operation envelopes;
4. bounded fan-out promises;
5. a bounded wait before the gate; and
6. unresolved drain promises that settle after release.

The tool and sandbox entries are deliberately **in-process shapes**, not real
tool calls, MCP traffic, sandbox operations, provider calls, or Azure inference.
The JSON artifact records `externalModelProviderCalled: false`,
`azureInferenceCalled: false`, and `realSandboxProviderCalled: false` so a
consumer cannot mistake this profile for provider or sandbox evidence.

## Machine-readable measurements

The profile always emits one `OPENGENI_DENSITY_RESULT=<JSON>` line. When
`OPENGENI_DENSITY_ARTIFACT_PATH` is set, the same result is written as a
pretty-printed JSON file. The artifact contains per-wave baseline, plateau, and
settled RSS/heap/external summaries, per-density statistics, an aggregate
summary, and thresholds.

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

A hard pod death still affects every slot admitted on that pod, at most 16. At
the observed placement of no more than two turn pods per node, the current hard
node-loss bound was 32 turns. At the 20-pod HPA maximum across six nodes, even
balanced placement can put four pods on one node, for a topology-dependent
64-turn hard node-loss bound. A PDB cannot constrain involuntary node loss.

## Non-serving execution requirement

A read-only forensic fingerprint over 3,823 sessions was previously run inside
a 1 GiB production serving API pod and exited 137. The child process did not
restart the API container, but it broke the routed shell and consumed serving
headroom. Heavy forensics and density profiling therefore run only in an
isolated non-serving execution class. They must never execute in API or worker
serving pods, and destructive shared-production OOM experiments are prohibited.

## Production release gate

Before increasing density above 16, run multiple waves at each candidate
against the exact production image and production database shape, then record
the same p50/p95/p99/worst incremental RSS plus CPU throttling, event-loop lag,
turn latency, capture residency, sandbox latency, and post-settlement
retention. Increase one lever at a time. Any hard-ceiling breach, unexplained
retained growth, failed capture/recording correctness proof, or worker restart
rejects the candidate. No production sweep was run as part of this leaf.
