# 16. Observability: wide events, small metrics, zero alarms

Status: Proposed, 2026-10-16

## Context

We need to answer, for any host and any sandbox: what happened, how long
each part took, whether anything unsafe happened, and whether a sandbox felt
slow. A host may run a thousand sandboxes and runs no extra services
([1](0001-own-fabric-one-agent-per-host.md)). Today `status` already has
step counts with total and longest duration, launches, health flags and
memory totals, and the agent samples every sandbox's cgroup for activity
([3](0003-activity-idle-and-sleep-levels.md)). Everything below is new.

## Decision

- **One wide event per step, request and stream.** Each step gets an
  operation id. Its event holds the sandbox, levels before and after, time
  per phase (queue, fetch, load, resume), bytes moved, outcome, error kind,
  its cause (a request, idle, memory pressure, recovery) and the initiating
  caller's W3C trace id if there was one. A request that joins a step
  already in flight logs that operation id. Request latency ends at the
  reply; a connection logs once when it is established and once when it
  closes, with its lifetime and bytes. Requests that change nothing (hold
  renewals, status reads) are only counted.
- **Metrics with bounded cardinality.** Counters and fixed-bucket
  histograms per step kind, cause and outcome; sandboxes and memory per
  level; host gauges (available memory, zswap, free huge pages, `some` and
  `full` pressure from `/proc/pressure`, transfer queues and bytes); the age
  of the oldest unfinished operation per step kind; and the time of the last
  sample, so a hung loop is visible. Never a sandbox id as a label.
- **Host-side pressure per sandbox.** The activity sampler also reads each
  VM cgroup's `memory.pressure` stall total and its major faults. These are
  stalls of the sandbox's host processes (a vCPU waiting on host memory),
  not guest response time; a kernel without PSI leaves the field absent, not
  zero. Each step event carries the stall time since the sandbox's previous
  event, and an awake sandbox also emits a summary event every hour.
- **Zero alarms.** Occurrence counters that must stay at zero: copies kept
  because the only good one was at stake, failed verifications,
  quarantines, trusted local or remote copies lost unexpectedly, sandboxes
  turned broken, and programs actually lost (not every intermediate memory
  error, since recovery can still restore a valid image). Gauges count the
  sandboxes currently broken, blocked or unsavable. One incident should
  raise one alert, so alerting groups by host and sandbox.
- **A canary that exercises each path.** A small sandbox per host runs, on
  a fixed rotation with a timeout each: resume from memory, restore from a
  saved image after being dropped from memory, wake from object storage
  after the local copy is dropped, and a fresh create from the image
  currently deployed. Results are metrics with a timestamp, and the
  collector alarms when they stop arriving, which also catches a dead agent.
- **OpenTelemetry, with a narrow exporter of our own.** Events are OTLP
  log records, metrics are OTLP sums, gauges and explicit-bucket histograms,
  and trace context is attached to log records; no spans are exported.
  Transport is OTLP over HTTP with its JSON encoding, so it needs only what
  the agent already depends on. Resource attributes follow the semantic
  conventions (`service.*`, `host.*`, `cloud.*`); compute concepts use
  `compute.*` attributes. The exporter owns a bounded buffer, timeouts,
  retries only for responses OTLP marks retryable, never retries a partial
  success, and counts what it drops. Events are also written to the local
  journal, so nothing depends on the collector being up. `status` reads the
  same counters locally. Compatibility is claimed only after a test against
  a real OpenTelemetry Collector.
- **Budget targets, not yet measured:** under 0.1% of one core and 2 MiB of
  memory per host at a thousand sandboxes, at one request per second and the
  default sampling interval, including sampling, encoding and export but
  not the canary. Profilers stay tools we run when needed.

## Consequences

- Dashboards show distributions and totals; finding the one slow sandbox
  means querying events, which needs a log store behind the collector.
- A guest that is slow for reasons inside itself shows no host pressure;
  only the canary and Opengeni's own timings see end-to-end latency.
- The canary costs one small sandbox per host, plus a little storage
  traffic for its remote wakes.
