# Compaction and tool-ledger incident — 2026-07-19

## Status

Closed in production. OpenGeni PR #482 merged as
`28290a023e09b59a9288da7a1bf845e43fc8f691`; private-ops production deploy
`29681125238` installed its exact digest-pinned API, worker, and web artifacts.
The affected production session
`aed24825-71d0-465e-8f9b-37f4d51b8eac` compacted successfully and resumed its
existing goal work on the Codex subscription provider.

Exact upstream baseline: `@openai/codex` 0.144.6, tag `rust-v0.144.6`, commit
`5d1fbf26c43abc65a203928b2e31561cb039e06d`. Durable Fable review session:
`ebedfd2b-d916-4567-b949-85bd8cc13079` (`claude-fable-5`, Claude Code 2.1.205).

## Production root causes

1. A 503 recovery found 220 pending tool receipts. Of those, 208 already had
   completed results and 12 were genuinely unresolved.
2. Mid-turn compaction correctly made old call/result rows inactive and
   installed a small replacement. Turn-end settlement queried active history
   only, treated the compacted completed pairs as missing, reinserted them into
   active history, emitted duplicate tool-output events, and deleted the
   receipts. This undid the checkpoint and rebuilt a multi-megabyte prompt.
3. Receipt clearing waited for every unresolved call across the whole logical
   turn. One orphan from an older model response could therefore pin every
   later completed response and grow the ledger indefinitely.
4. Canonical per-output truncation worked, but hundreds of individually bounded
   outputs still made the aggregate checkpoint request much larger than the
   model window. The old fallback issued one failing provider request, removed
   one oldest item, and repeated. It could orphan protocol units and make dozens
   of enormous failed calls.
5. `CompactionProviderResponseError` wrapped the provider overflow; the old
   classifier inspected only the wrapper, so the intended overflow fallback did
   not run.
6. Goal continuation was already held after `context_compaction_failed`, but
   `peekSessionWork` still marked any pending internal update runnable. Child or
   lifecycle updates repeatedly started new system turns against unchanged
   history, producing the observed loop.

## Clean end state

- No batch migration or compatibility state. The active worker tracks the call
  IDs emitted by one model response in memory. A stable response reconciles and
  clears only those IDs; approval resume can clear one standalone completed
  receipt. Durable recovery remains call/result based.
- Both the normal clear path and turn-end settlement inspect active and inactive
  canonical history. A correctly ordered complete pair made inactive by
  compaction is consumed silently and is never reactivated or re-emitted. A
  still-active complete pair retains its recovery projection for the crash
  boundary before original event publication, unless that exact output event
  is already durable. The live path clears the receipt only after the
  structural output event has durably flushed. A genuinely unresolved
  side-effecting call still gets exactly one explicit
  `interrupted / outcome unknown` result.
- Explicit compaction pre-fits a temporary summarizer copy: oldest aggregate
  tool output is minimized first, then whole oldest user-delimited units are
  removed and the suffix is protocol-sanitized. The provider gets at most two
  calls; the one overflow retry uses half the first input budget to cover the
  greater-than-2× estimator skew measured here. Durable replacement is still
  built from the unmodified active input and is installed only after a
  successful summary under the exact attempt fence.
- Overflow classification walks bounded wrapper `cause`, `error`, and
  diagnostics chains. A failed checkpoint leaves the prior active history
  unchanged.
- After the latest terminal compaction failure, ordinary internal updates stay
  pending without starting inference. Human/API work, Agent Steer, and explicit
  Compact are recovery exits; no machine queue row is introduced.

## Rejected designs

- A required durable `tool_batch_id` plus historical backfill: no durable
  consumer needs it, and historical rows cannot be assigned an honest provider
  response boundary.
- Restoring superseded pairs from active history only: this directly undoes
  compaction.
- Unbounded oldest-item provider retries: expensive, slow, and protocol-unsafe.
- Deterministic or placeholder summaries: they would publish invented memory.
- Codex remote-v2 encrypted compaction items: safe inside one fixed Codex
  identity, not portable across OpenGeni's independent subscription rotation.

## Verification completed

- Repository typecheck: all 20 projects clean.
- Repository-wide suite with mandatory real PostgreSQL: 3,289 passing, 3 gated
  live-Modal tests skipped, 0 failing. The final receipt/event ordering change
  was followed by the focused gates below.
- Final pure/runtime/worker and real-PostgreSQL focused suite: 176 passing.
- Worker-activity integration at the successful-tool-output / transport-failure
  boundary: 1 passing.
- Format, lint, documentation-reference, diff, and all-project typecheck gates
  pass.
- Incident regressions prove response-local clearing, inactive-pair silent
  settlement, output-event-before-receipt-clear ordering, already-projected
  output suppression, bounded checkpoint input, nested overflow recognition,
  atomic history preservation, and internal-update hold with explicit Compact
  escape.

## Production proof

- Public implementation: OpenGeni PR #482, source
  `28290a023e09b59a9288da7a1bf845e43fc8f691`; public CI run `29679007617`
  passed.
- Immutable artifact build: private-ops run `29679460990`, tag
  `production-main-28290a023e09b59a9288da7a1bf845e43fc8f691-20260719082400`.
  Production deploy `29681125238` passed provenance, digest, schema-contract,
  maintenance-drain, migration, rollout, public-health, and evidence gates.
- The production workloads independently reported API `2/2`, turn workers
  `10/10`, control workers `4/4`, and web `1/1` on the exact new digests;
  `/healthz` reported deployment revision
  `28290a023e09b59a9288da7a1bf845e43fc8f691`. The unrelated relay remained on
  its prior digest.
- Before the canary, the affected session was idle at event `260074`, with 577
  active history rows (`1,005,277` bytes), a `132,354`-token durable signal,
  and no live attempt. Its 91 internal updates were deferred and did not create
  another retry after deployment.
- Explicit Compact created one maintenance turn, not a queue row. Event
  `260080` installed a replacement after one provider call, rewrote 155 tool
  outputs only in the temporary summarizer input, dropped zero history units,
  and reduced active history to 113 rows (`66,903` bytes) with an `18,371`-
  token signal. No Azure model tokens were used.
- The existing goal then resumed as turn
  `96010b95-98c0-4621-a29f-e8fa5f86abbf` on `codex/gpt-5.6-sol`. Repeated
  model/tool batches left the pre-existing historical receipt baseline flat,
  proving new response-local receipt clearing instead of renewed accumulation.
- The resumed turn naturally crossed the automatic boundary. Event `260587`
  compacted proactively inside that same logical turn after one provider call,
  reduced the durable signal to `18,497`, and continued sampling in the same
  attempt. There was no queued prompt, replacement turn, post-deploy
  `context_compaction_failed`, history reactivation, or compaction loop.
- A later, unrelated receipt-registration database error failed that goal turn
  before its proposed tool executed. An exact rollback-only replay of the same
  row and call item succeeded, confirming an intermittent write/diagnostics
  defect rather than a compaction or schema failure. The subsequent system turn
  continued normally; the cross-session issue is tracked separately as
  Linear OPE-74.
