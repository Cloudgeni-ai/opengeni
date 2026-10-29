# Workspace activity facts on the session_events append path

Measured October 29, 2026 with `workspace-activity-events.bench.ts 2000 5`.

## What is measured

Migration 1100 adds an `AFTER INSERT` trigger on `session_events` that copies
the six offered chat types into `workspace_activity_events`. Its `WHEN`
clause (`duplicate_of_event_id IS NULL AND type = ANY (six types)`) is the
only cost for every other event type; for an offered type, the function
first checks that the workspace has an active "This workspace" source and
writes nothing otherwise.

Each case appends 2,000 events to one chat in one `INSERT ... SELECT` as the
application role under workspace row security, with every other
`session_events` trigger active (cursor advance, webhook fanout and the
rest). "Off" disables only the 1100 trigger. One warmup, then five
alternating runs; medians in microseconds per appended row.

## Results

| Case | Trigger off | Trigger on | Difference |
| --- | ---: | ---: | ---: |
| Ignored type (`agent.message.delta`), nobody listens | 74.6 | 73.7 | none measurable |
| Ignored type, someone listens | | 78.2 | within run-to-run noise |
| `turn.completed`, nobody listens | 857.8 | 867.0 | +9 µs (+1%) |
| `turn.completed`, someone listens (one fact written) | 864.0 | 1,032.1 | +168 µs (+19%) |

Streaming and tool events, the bulk of `session_events`, pay nothing
measurable. A turn end, which already costs about 0.86 ms per row through the
existing triggers, pays about 9 µs for the source check and about 0.17 ms when
a fact is written: the row, its two indexes, the foreign key, row security
and the causation lookups (the turn, at most eight parent chats, the run).
That is once per finished turn, approval request, question or notification,
not per streamed event.

Real PostgreSQL in the disposable test cluster on a development machine;
absolute numbers vary by host, the differences are what matter.
