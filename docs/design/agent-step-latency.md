# Agent-step latency

## Measurement

`scripts/bench-agent-steps.ts` runs the production turn activity and SDK runner
against migrated, restricted-role PostgreSQL and a local HTTP MCP server. A
scripted zero-latency model alternates a document-search call with its result,
then produces a final answer. No paid model, Temporal scheduling, remote MCP,
physical sandbox or subscription credential service is involved.

The model-end mark is immediately before the terminal response is yielded;
tool marks bracket the MCP HTTP exchange; dispatch is the transport observer
after admission/checkpoint/audit. SQL commands are captured at driver submission,
not inferred from event timestamps. Model settlement can overlap tool execution,
so its durations must not be added to the gap.

The original steady step issues roughly 113 SQL commands: 13 transactions,
tenant setup/validation, and five repeated exact-attempt write fences dominate.
These are not 113 distinct business facts. Request building and the final
history checkpoint are much smaller in this small-result fixture. This does
not establish the precise breakdown of an uninstrumented production turn or
represent large histories.

## End-state checkpoints

- A final tool result commits its pending receipt, output event, stable history
  and proven receipt retirement under one existing fence. Partial parallel
  results keep individual durable receipts; their SDK history is not stable yet.
- A canonical model-usage event projects its token signal and prepared stable
  history in the same transaction. Duplicate usage events cannot advance those
  signals. The completed-request event shares this response commit.
- Insights facts retain a savepoint so a soft fact-write failure cannot abort
  response truth. Incurred billing remains independently durable before ownership
  checks: a lost credential must not erase paid usage. This is intentionally not
  folded into attempt-owned state that can be refused or rolled back.
- History uses a savepoint within the checkpoint. If its SQL or preparation fails,
  the exact result/usage still commits, the history watermark does not advance,
  and the history error reaches the existing recovery path. No receipt is retired
  without its proven durable call/result pair.
- Background observations queued behind an append share a batch, and a subsequent
  awaited checkpoint absorbs that not-yet-started batch. An idle background lane
  starts immediately; there is no timer, threshold or added delay. Explicitly
  measured startup receipts keep their separate measurement boundary.

The live workspace/session control, authority, exact-attempt generation and
interruption checks still run at each write/admission boundary. They cannot be
cached for a turn: Pause, Steer, revocation and recovery may change them. Model
admission also rereads current usage and pending input after settlement. Frozen
settings/catalogs remain turn-level facts. No SQL pipelining, authority cache,
prompt change, tool schema change, history reordering or tuned constant is used.

Post-commit acknowledgements remain outside the transaction. A lost commit
acknowledgement never licenses a new external tool effect or advances the sink's
watermark. Database retries replay only the idempotent persistence boundary.

## Lifecycle events

Generic AI SDK/Gateway dispatch previously returned early after the first startup
preparation, suppressing every later request lifecycle. Startup preparation is
now recorded once while started/first_byte/completed are rearmed per call. Native
provider lifecycle publishers are unchanged. Each observation captures its own
timestamp before deferred delivery; the first request audit still commits before
fetch. Completion with usage commits in the response checkpoint; a response
without usage retains a separate completion audit.

## Reproduction

Baseline: `2e749ad058e325af29d0bd6d6ad17ab33a904ccf`. Install the frozen lockfile in
both baseline and candidate worktrees, and copy the benchmark script unchanged
to the baseline. Use a disposable pgvector-enabled PostgreSQL maintenance URL;
the shared harness creates and releases migrated restricted-role databases.

```sh
export OPENGENI_REQUIRE_REAL_DB=1
export OPENGENI_TEST_PG_URL=postgres://postgres:x@127.0.0.1:61440/postgres
export OPENGENI_BENCH_STEPS=30 OPENGENI_BENCH_RUNS=2
export OPENGENI_BENCH_DB_ONE_WAY_MS=1
bun "$BASELINE_WORKTREE/scripts/bench-agent-steps.ts" /tmp/steps-before-1.json
bun scripts/bench-agent-steps.ts /tmp/steps-after-1.json
bun scripts/bench-agent-steps.ts /tmp/steps-after-2.json
bun "$BASELINE_WORKTREE/scripts/bench-agent-steps.ts" /tmp/steps-before-2.json
bun scripts/compare-agent-steps.ts /tmp/steps-before-1.json /tmp/steps-after-1.json \
  /tmp/steps-before-2.json /tmp/steps-after-2.json
```

Each invocation warms a whole turn before collecting measured turns. Set delay
to zero for direct loopback. The optional delay is a controlled propagation
experiment, not a measured production RTT: chunks are scheduled from their
arrival times, not delayed serially (which would throttle throughput). The
comparator refuses differing ordered requests, normalizing only fixture UUIDs
and timestamps; it never sorts messages or tools. Compare against the original
baseline with full lifecycle events enabled on the candidate, so correctness
cost is included rather than hidden.

## Measured result

On the disposable PostgreSQL 17 fixture, four alternating A/B/B/A invocations,
each with two 30-step turns after a warmup, gave 120 measured steps per revision.
With a controlled 1 ms propagation delay in each database direction:

| Measurement | Original baseline | Consolidated, full lifecycle |
| --- | ---: | ---: |
| Model-end to tool-start mean | 4.50 ms | 3.39 ms |
| Last tool-output to next dispatch mean | 312.05 ms | 264.42 ms |
| Combined gap mean / median | 316.55 / 311.49 ms | 267.81 / 260.80 ms |
| Combined gap p90 | 380.63 ms | 312.70 ms |
| Dispatch-to-dispatch SQL commands, median | 113 | 105 |
| Request lifecycle triplets per 31-call turn | 1 | 31 |

The combined mean decreased 15.4% in this controlled run. Host variability was
material (the two baseline passes averaged 272 and 352 ms for tool-to-model),
so this is a reproducible local measurement, not a claimed production speedup.
The deterministic statement reduction and lifecycle counts are the stronger
evidence. All measured ordered model requests were identical after fixture-only
normalization (SHA-256 `81a5a3f90ada3d3459283eb07b45fd7f34feda2489d864a02b80e98f15493620`).

The same A/B/B/A direct-loopback cross-check (no injected delay, 120 steps per
revision) did **not** show a latency improvement: combined mean 107.62 → 113.42 ms,
median 99.18 → 107.25 ms, p90 151.04 → 156.89 ms. Median statements fell 113 → 106
and every candidate call still had its three lifecycle events. The combined
change therefore reduces database work and the controlled-RTT gap, but is not
claimed to improve zero-RTT latency; extra correct observations are not free.
