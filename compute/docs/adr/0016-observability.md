# 16. Observability: wide events, small metrics, zero alarms

Status: Proposed, 2026-10-16

## Context

We need to answer, for any host and any sandbox: what happened, how long
each part took, whether anything unsafe happened, and whether a sandbox felt
slow. A host may run a thousand sandboxes, so a metric series per sandbox
would cost more than the agent itself. The host runs no extra services
([1](0001-own-fabric-one-agent-per-host.md)), and the agent already samples
every sandbox's cgroup for activity ([3](0003-activity-idle-and-sleep-levels.md)).

## Decision

- **One wide event per step and per request.** When a step or request ends,
  the agent writes one structured log line holding everything about it:
  sandbox, step, levels before and after, time per phase (queue, fetch,
  load, resume), bytes moved, outcome, error kind and the caller's trace id.
  Questions about one sandbox are answered by querying these events.
- **Metrics only without per-sandbox labels.** Counters and fixed-bucket
  histograms per step kind and outcome; sandboxes and memory per level;
  host gauges (available and reclaimable memory, zswap, free huge pages,
  CPU, memory and IO pressure from `/proc/pressure`, transfer queues and
  bytes). They live in fixed arrays updated with atomic adds and are read
  through `status` or a local-only Prometheus endpoint. A few hundred series
  per host, whatever the number of sandboxes.
- **Trace ids pass through.** A request may carry a W3C `traceparent`; every
  step it causes logs that id, so a slow create in Opengeni can be followed
  into the host. The agent exports no spans itself.
- **Safety counters that must stay at zero:** copies kept because the only
  good one was at stake, failed verifications, quarantines, memory lost,
  blocked and unsavable sandboxes. Any increase alerts.
- **Felt slowness is measured, not guessed.** The existing activity sample
  also reads each sandbox's memory pressure stall time and major faults, so
  a badly tuned zswap or huge-page pool shows up as stall seconds per
  sandbox-hour. A small canary sandbox per host sleeps, wakes and runs a
  fixed command every few minutes and reports its end-to-end latency.
- **Budget:** under 0.1% of one core and 2 MiB of memory per host at a
  thousand sandboxes, measured in the lab like any other cost. Profilers
  (`perf`, off-CPU tracing) stay tools we run when needed.

## Consequences

- Dashboards show distributions and totals; finding the one slow sandbox
  means querying events, which needs a log pipeline (journald to any store).
- Events are written only at step and request boundaries: dozens per
  sandbox per day, not per page fault or per packet.
- The canary costs one small sandbox per host and catches what internal
  counters miss, such as a slow store or a broken guest image.
