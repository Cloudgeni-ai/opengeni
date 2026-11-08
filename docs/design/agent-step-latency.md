# Agent-step latency

## What the local trace establishes

`scripts/bench-agent-steps.ts` runs the production turn activity and SDK runner
against migrated, restricted-role PostgreSQL and a local HTTP MCP server. A
scripted zero-latency model alternates a document-search call with its result,
then produces a final answer. No paid model, Temporal scheduling, remote MCP,
physical sandbox or subscription credential service is involved.

The model-end mark is immediately before the terminal response is yielded;
tool marks bracket the MCP HTTP exchange; dispatch is the actual transport
observer after the worker's admission/checkpoint/audit. SQL commands are captured
at driver submission, not inferred from event timestamps. Model settlement can
overlap tool execution, so its durations must not be added to the step gap.

The dominant gap is after tool output. Each step still performs roughly 113 SQL
commands: tool call/result receipts and history, response usage/metering, the
usage event, Insights fact, attempt-owned token signal, and fresh model admission.
Request building and the final history checkpoint are much smaller in this
fixture. This does not establish the precise breakdown of an uninstrumented
production turn, and the small fake result does not represent large histories.

## Change and invariants

The write fence already knows all of its IDs, but waited for several database
responses before submitting the next lock statement. Submit the existing
statements together on the transaction-pinned connection, in exactly this order:

1. Workspace-control advisory lock and control row.
2. Workspace row, session rows, event cursor rows.
3. Exact turn rows and exact attempt rows.

The server executes separate statements in order, retaining fresh READ COMMITTED
snapshots. This is not parallel locking on multiple connections and not a joined
query with one old snapshot. Raw KEY SHARE writers still re-read the session
after owning its cursor, before locking turns/attempts. Explicit control-lock
budgets retain their sequential remaining-budget calculations. Site admission
still precedes the complete control prefix, including a control-aware write for
another session. Integrity and authority checks remain before any mutation.

No SQL check, lock, transaction, recovery receipt or authorization read is removed.
No model-visible bytes, schemas, history order or cache prefix change. No timing
constant, heuristic, authority cache or background persistence queue is added.

## Reproduction

Baseline: `2e749ad058e325af29d0bd6d6ad17ab33a904ccf`. Install the frozen lockfile in
both baseline and candidate worktrees, and copy the benchmark script unchanged
to the baseline. Use a disposable pgvector-enabled PostgreSQL maintenance URL;
the shared harness creates and releases its own migrated app-role databases.

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

Each invocation warms up a whole turn before collecting its measured turns.
Set the delay to zero for direct loopback. The optional delay is a controlled
propagation experiment, not a measured production RTT: chunks are scheduled
from their arrival times, not delayed serially (which would throttle throughput
and conceal pipelining). The comparator refuses differing ordered requests,
normalizing only fixture UUIDs and timestamps; it never sorts messages or tools.

The independent generic-request lifecycle fix adds the missing durable events
on follow-up requests. Compare that correctness cost separately; do not attribute
its additional writes to the lock-pipeline optimization.
