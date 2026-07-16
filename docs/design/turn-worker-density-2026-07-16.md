# Turn-worker density contract and production evidence

Date: 2026-07-16
Owner: OPE-52

## Contract

- A turn worker runs one process and an explicit fixed number of concurrent
  `runAgentTurn` activities. The temporary production setting is 16 turns per
  pod; changing it requires a measured production sweep rather than an SDK
  default or an inferred memory estimate.
- Target incremental worker memory is at most 50 MiB per active turn. The hard
  release ceiling is 100 MiB per active turn, including exceptionally long
  model histories. Fleet pod requests and limits must retain process/runtime
  headroom in addition to this incremental amount.
- Density evidence must use the exact production image and production database
  shape. Model inference is replaced by `ScriptedModel`; a density run must not
  call an Azure or external model endpoint.
- A timed-out auxiliary operation remains visible as resident until its actual
  promise settles. A caller deadline must not make background memory disappear
  from metrics.
- Recording bytes go directly from the sandbox to a short-lived, write-only
  object-storage URL. They never enter worker memory or a Temporal payload.

## Baseline evidence

The exact production revision `ebf4a9e8e1590c2415c32e963cafa2328f56babb`
was profiled in an isolated production pod with 16 concurrent real
`runAgentTurn` activity invocations. Each invocation loaded 750,000 active
history bytes plus 8 MiB of inactive durable history and stopped concurrently
at a deterministic model gate.

- baseline RSS median: 284.1 MiB
- plateau RSS maximum: 441.8 MiB
- incremental RSS per active turn: 9.9 MiB
- settled RSS median: 332.1 MiB
- target and hard ceiling: passed

This result covers model-input construction, active-history residency, turn
settlement, and the ordinary activity path. It deliberately disables sandbox,
workspace capture, recording, integrations, and provider calls. It must not be
misrepresented as direct memory evidence for those disabled subsystems.

Historical Prometheus data showed earlier worker images at roughly 2.5–3.1 GiB
RSS with eight turns on a pod. Source and metric reconciliation found two memory
paths outside the deterministic baseline:

1. Workspace capture raced its 60-second caller timeout without cancelling the
   losing operation and retained a map containing as much as 200 MiB of changed
   file content per capture.
2. Recording finalize base64-decoded as much as 256 MiB into the worker and then
   cloned it for object-storage upload.

## Implemented correction

- Workspace capture uses cooperative abort checkpoints after every database,
  sandbox, and storage boundary. It holds and uploads one changed file at a
  time, bounded by the 5 MiB per-file guard, rather than retaining the whole
  capture. A second read refreshes the exact file metadata when live workspace
  churn occurs, so consistency does not require failing the whole capture.
- `opengeni_workspace_captures_inflight` decrements only when the underlying
  capture operation actually settles. A 60-second caller timeout therefore
  remains observable while an in-flight provider operation drains.
- Recording finalize stats and size-gates the artifact on the sandbox, then
  uses curl in that sandbox to PUT directly to the scoped URL. Codex's
  first-party `computer_*` function transport and the hosted `computer_call`
  transport share the same exact computer-use gate.
- Recording preparation is bounded and happens before every attempt-closing
  settlement, including approval suspension. The existing locked turn
  settlement atomically commits the exact recording row and its
  `recording.available` / `recording.failed` event under the same attempt fence
  as terminal turn truth. Artifact deletion occurs only after that transaction
  succeeds. A stale or aborted attempt can close only the recording named by its
  accepted `recording.started` receipt and emits no authoritative event.
- The old worker-buffered recording API and its live-test path are removed, not
  retained as a fallback.

## Reproducible gates

- `scripts/operator/turn-density-profile.ts` creates and cleans an identifiable
  synthetic workspace, holds 16 activity requests at a deterministic model
  gate, records RSS/heap/external memory, and fails when the hard per-turn limit
  is exceeded.
- `scripts/operator/recording-upload-profile.ts` is explicitly gated by
  `OPENGENI_RECORDING_UPLOAD_PROFILE=1`. Against production Azure Blob storage,
  a 32 MiB scoped PUT completed with a 39.5 MiB full-cgroup increase and exact
  stored-size verification. This is conservative for worker memory because the
  profile colocates curl and the temporary file; in production both live in the
  remote sandbox.
- The migrated P4.3 live test is the real-Modal gate for desktop activity,
  ffmpeg finalization, direct scoped PUT, stored MP4 validation, artifact
  cleanup, and sandbox termination.

## Production release gate

Before increasing density above 16, run multiple waves at each candidate
concurrency and record p50/p95/max RSS, CPU throttling, event-loop lag, turn
latency, capture residency, sandbox latency, and post-settlement retention.
Increase one lever at a time. Any hard-ceiling breach, unexplained retained
growth, failed capture/recording correctness proof, or worker restart rejects
the candidate.
