# 16. Observability: wide events, small metrics, zero alarms

Status: Proposed, 2026-10-16

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

## Consequences

Finding the one slow sandbox means querying events in a log store behind
the collector. A guest slow for reasons inside itself may show no host
pressure; only the canary and Opengeni's own timings see end-to-end
latency. The canary costs one small sandbox per host and a little storage
traffic.
