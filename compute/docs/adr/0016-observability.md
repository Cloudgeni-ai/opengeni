# 16. Observability: wide events, small metrics, zero alarms

Status: Accepted, 2026-10-17. Built.

## Context

For any host and sandbox we need to know what happened, how long each part
took, whether anything unsafe happened, and whether a sandbox felt slow.
Today `status` has step counts with total and longest duration, launches,
health flags and memory totals, and the agent samples live sandbox cgroups
for activity ([3](0003-activity-idle-and-sleep-levels.md)).

## Decision

- **One wide event per step, request and stream.** Each step gets an
  operation id, and its event holds everything about it (levels, time per
  phase, bytes, outcome, cause such as a request, idle, pressure or
  recovery, and the caller's W3C trace id if any). A request that joins a
  step in flight logs that operation id. Request latency ends at the reply;
  a connection logs once when established and once when closed. Requests
  that change nothing (hold renewals, status reads) are only counted.
- **Metrics with bounded cardinality.** Counters and fixed-bucket
  histograms per step kind, cause and outcome; sandboxes and memory per
  level; host gauges (available memory, zswap, free huge pages, `some` and
  `full` pressure, transfer queues); the age of the oldest unfinished
  operation per step kind; and the time of the last sample, so a hung loop
  shows. Never a sandbox id as a label.
- **Host-side pressure per sandbox.** The sampler also reads each VM
  cgroup's `memory.pressure` stall total and major faults: stalls of the
  sandbox's host processes, not guest response time. Without PSI the field
  is absent, not zero. Step events carry the stall time since the previous
  event, and an awake sandbox emits a summary event every hour.
- **Zero alarms.** Occurrence counters that must stay at zero: copies kept
  because the only good one was at stake, failed verifications,
  quarantines, trusted local or remote copies lost unexpectedly, sandboxes
  turned broken, and programs actually lost (not every intermediate memory
  error, since recovery can still restore a valid image). Gauges count
  sandboxes currently broken, blocked or unsavable. Each occurrence also
  writes an event naming the sandbox, which is what alerts group on, so one
  incident raises one alert.
- **A canary that exercises each path.** A small sandbox per host rotates,
  each with a timeout, through resume from memory, restore after being
  dropped from memory, wake from object storage after the local copy is
  dropped, and a fresh create from the deployed image. The monitoring
  backend alerts on failed results and on results that stop arriving, which
  also catches a dead agent.
- **OpenTelemetry, with a narrow exporter of our own.** Events are OTLP
  log records carrying trace context (no spans are exported); metrics are
  OTLP sums, gauges and explicit-bucket histograms; transport is OTLP over
  HTTP with JSON encoding. Resource attributes follow the semantic
  conventions and compute concepts use `compute.*` attributes. The exporter
  keeps a bounded buffer, times out, retries retryable transport failures
  and responses but never a partial success, and counts what it drops.
  Events also go to the local journal, so nothing depends on the collector.
  Compatibility is claimed only after a test against a real OpenTelemetry
  Collector.
- **Budget targets, not yet measured:** under 0.1% of one core and 2 MiB of
  memory per host at a thousand sandboxes and one request per second per
  host, including sampling, encoding and export but not the canary.

## What building it taught us

- **Causes.** A wake is caused by the request that asked for it (wake,
  connect, touch or hold). Without one, it is pressure when pressure had
  paused the sandbox and the host now has room, a request when holds keep
  it wanted awake, and recovery otherwise. A sleep is pressure when the
  host pushed it deeper than its own settings, a request when someone
  asked for that level, and idle otherwise. Every step while the agent
  takes back what it found at start is recovery. A sleep consumes the
  request to wake that came before it, so the next wake needs a reason of
  its own; a wake consumes the request to sleep.
- **Trace context.** Any request may carry `traceparent` beside its own
  fields. One that is not valid is ignored. The request's event carries
  the trace, and so do the steps it caused: the wake it asked for, or each
  step of a sleep down to the level it asked for. No spans are made.
- **Requests.** A request's event is written after its reply. A client
  that hangs up before its reply gets an event with result `hung_up` and
  is not counted. A `connect` writes its request event when the stream is
  established and a `compute.stream` event when it closes, with the bytes
  it moved each way and how it ended (`finished`, `slept` or `failed`).
- **Phases and bytes.** Restore steps time verify, load, commit, prefetch,
  resume and notice; saves time prepare, snapshot and merge; boots time
  prepare and launch. Steps that move objects count `uploaded` bytes (only
  chunks the store did not already hold, as stored, so compressed) and
  `fetched` bytes (decoded). Pages fetched in the background after a wake
  are not counted on any step.
- **Pressure per sandbox.** Exported as the stall time and major faults
  since the sandbox's previous step or summary event, from cumulative
  totals the sampler reads. A reading is taken at the start of each step
  that has a live VM, except a wake. A sandbox whose VM was replaced
  starts counting again from zero. Host pressure is exported as the
  cumulative `some` and `full` totals, as sums whose start time is the
  host's boot, since the kernel counts from then.
- **Store alarms name the object.** A stored object that failed its
  checksum names its key, not a sandbox: chunks are shared.
- **Canary.** It uses two fixed sandbox ids of its own (ending in `01` for
  the rotating sandbox and `02` for the one each create path makes and
  removes), asks at background priority, and runs only with
  `--canary-every`. With `--canary-port`, each wake also connects to that
  guest port. A host without a store skips the remote path. Each run
  writes a `compute.canary` event and updates `compute.canary.count`,
  `compute.canary.duration` and `compute.canary.last_run` per path.
- **Exporter.** `--otlp-endpoint` turns it on. Events wait in a buffer of
  2,048 and go in batches of up to 512 every second; metrics go every ten
  seconds. One request per signal is in flight at a time, each attempt
  times out after 10 s, and retries stop after a minute. When the buffer is
  full the oldest event goes. `compute.export.dropped` counts what was
  dropped, by signal and reason (`buffer_full`, `rejected`, `failed`).
  An agent told to stop (SIGINT or SIGTERM) sends what is left, each
  request with a single attempt, and waits at most 5 s for it.
  Compatibility was checked against OpenTelemetry Collector 0.163.1.

## Consequences

Finding the one slow sandbox means querying events in a log store behind
the collector. A guest slow for reasons inside itself may show no host
pressure; only the canary and Opengeni's own timings see end-to-end
latency. The canary costs one small sandbox per host and a little storage
traffic.
