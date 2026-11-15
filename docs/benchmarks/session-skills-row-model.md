# Session Skill folders stay out of hot session reads

A session's inline Skill folders (`sessions.skills`) are by far its largest
value: hosts that attach their own Skills store hundreds of KB of Markdown per
session, compressed out of line in TOAST. Reading that column decompresses it,
so every statement that selected the whole row paid for it. That included each
event-write lock and nearly every internal row read, though almost none of them
use the folders.

The `sessions` Drizzle table no longer declares the column. Every
`select().from(sessions)`, every `.returning()` and `getTableColumns(sessions)`
(including the event-write lock's default projection) therefore reads the row
without it. The column is reached only through `schema.sessionSkillSets`, a
second table object over the same physical table:

- Readers that return a complete `Session` select `sessionRowWithSkillsColumns`,
  the row and the folders in one statement.
- Writers that hold the row lock (the locked session update behind
  `PUT .../skills`, session creation) write the folders through it, under the
  same lock.
- Responses that never carry the folders pass `skills: "omit"` to the session,
  list and lineage readers. SQL substitutes an empty placeholder, as the summary
  list already did, and the reader removes the key from its result, typed as
  `SessionWithoutSkills`. The compact chat projection used by current SDKs and
  the web app reads this way, and so does Slack App Home.

No schema change or migration: the physical column and its data are unchanged.
The worker still reads the folders once per turn, from the same column, to build
the model's Skills. What the model receives is unchanged.

## Measurements

Local PostgreSQL 17 with `shared_buffers = 1GB`. Server figures come from
`pg_stat_statements` (top-level statements that read the sessions table) and
`pg_statio_all_tables` (sessions TOAST blocks).

### Statements on a realistic dataset

```sh
OPENGENI_BENCH_SESSIONS=3000 bun scripts/operator/bench-session-skills-reads.ts
```

3,000 sessions, each with about 265 KB of inline Skills built from this
repository's Markdown, stored at 140 KB per session after compression: a 2.8 MB
heap and 439 MB of TOAST. The same script ran unchanged on the parent revision.

| Statement (per call) | Before | After |
|---|---:|---:|
| Event-write lock of one session, mean | 1.87 ms | 0.071 ms |
| Event-write lock, buffer blocks | 30 | 9 |
| Event-write lock, TOAST blocks | 19.6 | 0 to 1.2 |
| Compact session read, mean | 0.71 ms | 0.056 ms |
| Compact lineage read of a root with 49 children, mean | 16.8 ms | 0.66 ms |
| Compact lineage read, TOAST blocks | 932 | 0 |

Client time per operation: an event-write lock transaction 5.57 → 1.64 ms, a
compact session read 12.3 → 3.9 ms, a compact lineage read 230 → 16.6 ms. The
residual TOAST blocks after the change are statistics flushed late from the
fixture's own vacuum: the lock statement no longer selects the column.

The data is fully cached here, so the before-figures are decompression CPU
alone. On a server where TOAST does not fit in memory, or CPU is contended, the
same statements also wait for I/O and CPU and hold row locks longer.

A 200-row compact list page improves less (338 → 265 ms per statement), because
its descendant-statistics statement (`sessionTreeStatsForSessions`) dominates it
and reads no Skill folders either way.

### One worker turn

```sh
OPENGENI_BENCH_WORKER_SKILLS_BYTES=265000 OPENGENI_BENCH_WORKER_TOOLS=5 \
OPENGENI_BENCH_WORKER_SAMPLES=8 bun scripts/operator/bench-worker-resources.ts
```

A real worker turn with five tool calls, a scripted model and 265 KB of inline
Skills. Means of the seven warm samples, two runs per revision:

| Per turn | Before | After |
|---|---:|---:|
| Statements reading `sessions.skills` | 7 | 1 |
| Database response bytes | 2.69 MB | 1.04 MB |
| Model input digest | `a6f50a46…` | `a6f50a46…` |

The digest hashes every model request of the turn with ids and times masked; it
was identical on every sample of every run on both revisions, so the model input
is byte-identical. The remaining read is the turn's own session load, which the
model's Skills come from.
