# Conversation context compaction

OpenGeni runs long-lived agent sessions. A per-customer "manager" can live for
weeks, accumulating one `session_history_items` row per conversation item
(message / reasoning / function_call / function_call_result). With no context
management that history grows unbounded until it overflows the model's context
window and the backend hard-fails **every** turn with
`Your input exceeds the context window of this model`. Every long-lived session
eventually dies. This document describes the provider-aware compaction that
structurally fixes that.

Code wins over this doc. The canonical sources are:

- `packages/config/src/index.ts` — settings + resolution helpers
  (`resolveContextCompactionMode`, `contextInputBudgetTokens`,
  `contextServerCompactThreshold`).
- `packages/runtime/src/index.ts` — `buildAgentCapabilities` (server path),
  `summarizeForCompaction` (the summarizer model call).
- `packages/runtime/src/context-compaction.ts` — the pure client-side planner
  (`planCompaction`, `findKeepBoundary`, summary prompt + item shaping).
- `apps/worker/src/activities/context-compaction.ts` — `maybeCompactContext`,
  the pre-turn client-path orchestrator.
- `apps/worker/src/activities/agent-turn.ts` — where the trigger is wired into
  the turn and where `last_input_tokens` is recorded.
- `packages/db/src/index.ts` — `applyContextCompaction`,
  `getActiveSessionHistoryItems`, `setSessionLastInputTokens`,
  `nextSessionHistoryPosition`.
- `packages/db/drizzle/0011_context_compaction.sql` and
  `0012_compaction_summary_fractional_position.sql` — the schema.

## Why provider-aware

There are two valid ways to compact a Responses-API conversation, and which one
is correct depends entirely on the backend:

- **OpenAI platform** supports server-side compaction (GA 2026-02-11).
  `context_management` is a top-level request field; the server compacts and
  emits an opaque **encrypted** `compaction` item (`encrypted_content`) that
  must not be pruned. On the platform it "just works" — we use it and run **no**
  client-side summarization.
- **Azure OpenAI** does **not** support it. Sending `context_management` returns
  `400 unsupported_parameter` ("compact_threshold is not enabled"). This matches
  the production symptom we saw on Azure: zero `compaction` items ever emitted,
  history grew past the window, every turn 400'd. OpenGeni currently runs on
  Azure, so on Azure we must do compaction **ourselves, client-side**.

The non-negotiable rule: detect the backend, pick exactly one path, never
silently double-compact, and never force client-side on a backend that already
has server-side.

### The SDK trap this fixes

The Agents SDK's `Capabilities.default()` **force-includes** `compaction()`,
whose sampling params emit `context_management:[{type:'compaction', …}]` to the
Responses transport. Attaching it unconditionally is exactly what produced the
Azure 400 in production. So `buildAgentCapabilities` rebuilds the base capability
set explicitly (`filesystem()`, `shell()`, `skills(...)`) and adds
`compaction()` **only on the server path**. See
`packages/runtime/src/index.ts:buildAgentCapabilities`.

## Mode resolution

`contextCompactionMode` (env `OPENGENI_CONTEXT_COMPACTION_MODE`) takes
`auto` (default) | `server` | `client` | `off`.

`resolveContextCompactionMode(settings)`:

| mode     | result                                                              |
| -------- | ------------------------------------------------------------------- |
| `auto`   | `server` when `openaiProvider === "openai"`, else `client` (Azure)  |
| `server` | force server-side regardless of provider                            |
| `client` | force client-side regardless of provider                            |
| `off`    | no compaction (escape hatch only)                                   |

Detection is driven by the explicit `OPENGENI_OPENAI_PROVIDER` config
(`openai` | `azure`) — the same flag that already selects the transport and
client construction. It is config, not a runtime probe, so the path is
deterministic and testable; `server`/`client` let an operator override if a
backend ever behaves unexpectedly.

## The model window (matters for BOTH paths)

The model is `gpt-5.5`: real context window **1,050,000** tokens, max output
**128,000**. `gpt-5.5` is **absent** from the SDK's hardcoded compaction
window map (it knows up to gpt-5.4), so the SDK's `DynamicCompactionPolicy`
would fall back to a wrong **240k** threshold and compact far too early. The SDK
exposes no window-registration API, so the fix is to pass an explicit
`StaticCompactionPolicy(threshold)` on the server path and to use the same
numbers to budget the client path.

Settings (all env-overridable, see `packages/config/src/index.ts`):

| setting                              | env                                            | default     | meaning |
| ------------------------------------ | ---------------------------------------------- | ----------- | ------- |
| `contextWindowTokens`                | `OPENGENI_CONTEXT_WINDOW_TOKENS`               | `1_050_000` | the model's real context window |
| `contextReservedOutputTokens`        | `OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS`      | `128_000`   | tokens reserved for output |
| `contextServerCompactThresholdTokens`| `OPENGENI_CONTEXT_SERVER_COMPACT_THRESHOLD_TOKENS` | unset   | server path: explicit `compact_threshold` override |
| `contextCompactSoftFraction`         | `OPENGENI_CONTEXT_COMPACT_SOFT_FRACTION`       | `0.70`      | client path: compact at this fraction of budget |
| `contextCompactHardFraction`         | `OPENGENI_CONTEXT_COMPACT_HARD_FRACTION`       | `0.85`      | client path: hard-force fraction |
| `contextKeepRecentTokens`            | `OPENGENI_CONTEXT_KEEP_RECENT_TOKENS`          | `32_000`    | client path: recent full turns kept verbatim |
| `contextSummaryMaxTokens`            | `OPENGENI_CONTEXT_SUMMARY_MAX_TOKENS`          | `20_000`    | client path: ceiling on generated summary body |

The usable **input budget** is `B = contextWindowTokens − contextReservedOutputTokens`
(`contextInputBudgetTokens`). With defaults, `B = 922,000`.

The **server-side threshold** (`contextServerCompactThreshold`) is the explicit
override when set, else `floor(B × softFraction)` = `floor(922,000 × 0.70)` =
**645,400** tokens. This is the number handed to `StaticCompactionPolicy`, and
it is what sidesteps the SDK's wrong 240k fallback.

## Server-side path (OpenAI platform)

When the resolved mode is `server`:

1. `buildAgentCapabilities` attaches
   `compaction({ policy: new StaticCompactionPolicy(645_400) })`. The SDK then
   emits `context_management` on each request and the platform compacts
   server-side, returning the encrypted `compaction` item, which the SDK's own
   `processContext` slices around. We add nothing client-side.
2. The request sets **`store: false`**. Server-side compaction's encrypted
   `compaction` item round-trips in the request rather than being anchored to a
   stored response, and `store: false` is the documented precondition. OpenGeni
   already runs storeless (provider item ids stripped, see issue #48), so this
   is consistent. `store: false` is set **only** on the server path —
   see `packages/runtime/src/index.ts` (`resolveContextCompactionMode(...) === "server"`).

That is the entire platform path. No DB writes, no synthetic summary, no
`session_history_items` mutation.

## Client-side path (Azure)

This is the substantive new machinery. It runs **pre-turn**, before the model
call, when the resolved mode is `client`.

### Trigger

The signal is the **last turn's actual `inputTokens`** (recorded on
`sessions.last_input_tokens` at the end of each turn from the response usage —
see `agent-turn.ts` `setSessionLastInputTokens`). When that is unavailable (a
brand-new session), the planner falls back to a char/4 estimate over the active
items. Compaction fires when the signal reaches `softFraction × B`
(≈ 645k with defaults); `hardFraction × B` (≈ 784k) is the hard-force point.
Both are config-driven; in the current planner both simply mean "compact now"
(the distinction exists for logging/tuning headroom).

### Boundary rule (orphan safety — critical)

This is the single most important correctness property. The read path already
ships a sanitizer (#61) that drops orphaned `function_call_result` (an output
with no matching call) and dangling `function_call` before sending to the model;
an earlier orphan bug 400'd the model. Compaction must **never create orphans**.

`findKeepBoundary` therefore cuts **only at a clean turn boundary** — the start
of a user `message`. The kept tail is the latest user-message boundary whose
`[boundary, end)` tail still fits `contextKeepRecentTokens`; everything before it
is the prefix to summarize. Because the cut lands on a user message:

- For every `function_call` in the dropped prefix, its
  `function_call_result` is also in the prefix (and vice versa) — no `call_id`
  straddles the cut.
- `reasoning` items drop or keep with their whole turn.

If no user-message boundary exists, or the only boundary is at position 0, the
planner returns "no useful cut" and the turn proceeds un-compacted.

The tail keeps **full recent turns** verbatim (recent tool results are the live
working set), not just user messages — `contextKeepRecentTokens` defaults to 32k.

### Single live summary (bounded drift)

The old prefix is summarized into **one** plain `message` item, role `user`,
carrying a `SUMMARY_PREFIX` bridge plus the model-generated summary body and a
marker key `opengeni_context_summary: true` in the item JSON. It is a **plain
user message, deliberately NOT the SDK `compaction` item type** — that type
requires server-minted `encrypted_content`, and a hand-rolled one risks an
Azure 400. (Codex's client-side compaction makes the same choice.)

Exactly one live summary exists at any time. Each compaction **folds the prior
summary forward**: it summarizes `[prior summary] + [items since]`, excludes
prior summaries from re-collection, and replaces them with the new one. This
bounds summary drift over a weeks-long session. If a candidate cut would leave
**only** a prior summary in the prefix (nothing new to fold), the planner
returns `nothing_to_summarize` and leaves the existing summary in place — this
prevents a re-wrap loop.

### Summary quality

The summarizer prompt (`SUMMARY_INSTRUCTIONS`) leans on OpenGeni's durable
structured memory: durable facts already live in the workspace notebook /
document bases (via MCP), so the conversation summary is a **light
working-memory bridge**, not the whole truth. It is told to capture: current
objective + key decisions, open blockers / in-progress work, deployed/infra
state, environment & credential facts **by reference only** (name env-var keys,
secret names, notebook/document ids — **never copy a secret value**), and
concrete next steps; and to state explicitly that durable facts are in the
notebook and that it lists pointers, not contents.

The summarizer is one plain, tool-less, non-streaming model call
(`summarizeForCompaction`). On the OpenAI platform it sets `store: false`; on
Azure it omits `store`. **Any failure returns `null` and skips compaction for
this turn** — the turn proceeds on the un-compacted history (the read-path
sanitizer keeps that safe). Compaction is best-effort and never throws into the
turn.

Doctrine/identity stays in the agent's resident instructions (not in history),
so it survives every compaction for free.

### Storage model (supersede, never delete)

The audit trail is sacrosanct. Compaction **never deletes** rows.

- `session_history_items.active` (boolean, default `true`) is the live-row flag.
  Summarized prefix rows are set `active = false` (superseded), not removed.
- The synthetic summary is inserted as a **new** active row at a **fractional
  position** `boundaryPosition − 0.5`. `position` is `numeric` (widened from
  `integer` in migration 0012). Real rows always have whole-number positions, so
  the half-step sorts immediately ahead of the kept tail, behind the last
  superseded prefix row, and **collides with no real row**.
- A partial index `session_history_items_active_idx` on
  `(workspace_id, session_id, position) WHERE active` keeps the live read fast.

> **Why fractional?** The first cut of this feature (migration 0011) placed the
> summary at the **integer** position `boundaryPosition − 1`. Because positions
> are contiguous from 0, that slot is **always** an occupied real prefix row, and
> the upsert overwrote that row's item JSON — destroying one real history row per
> compaction and violating "supersede, never delete". The fractional placement
> (migration 0012 + PR #63, folded into #62 before merge) fixes it at the source.
> `applyContextCompaction`'s `onConflictDoUpdate` conflict target is the
> fractional position, which can only ever collide with a **prior summary** row,
> so a retry merely re-activates the existing summary — idempotent, and it never
> touches a real row.

### Read-path assembly

`getActiveSessionHistoryItems` selects only `active` rows ordered by `position`,
so after a compaction it returns `[summary, …recent tail]`. The worker's
`run-input.ts` `messageInput` uses it to build the model request, then appends
the new user message. This mirrors the SDK's "slice after boundary" behavior,
but in our own SQL path with plain message items, so it works on Azure.

New rows continue to append at fresh **whole-number** positions via
`nextSessionHistoryPosition` (`floor(max(position)) + 1`), decoupled from the
in-memory history length (which, after a compaction, is the short active set,
far shorter than the total row count). See `historyRowsToAppend` and
`nextHistoryPosition` in `agent-turn.ts`.

### Events

A successful client-side compaction publishes a `session.context.compacted`
event carrying the summary position, for observability.

## How to operate and tune

- **Leave it on `auto`.** On Azure it resolves to `client`; if you move a
  workspace to the OpenAI platform (`OPENGENI_OPENAI_PROVIDER=openai`) it
  resolves to `server` automatically.
- **If a backend behaves unexpectedly**, force the path with
  `OPENGENI_CONTEXT_COMPACTION_MODE=server|client`. `off` disables compaction
  entirely — only for debugging; long sessions will overflow again.
- **If you change models**, set `OPENGENI_CONTEXT_WINDOW_TOKENS` and
  `OPENGENI_CONTEXT_RESERVED_OUTPUT_TOKENS` to the new model's real numbers.
  Everything else (server threshold, client soft/hard points) is derived from
  them. Do **not** rely on the SDK's built-in window map for any model it does
  not know.
- **Compacting too often / too rarely** (client path): lower/raise
  `OPENGENI_CONTEXT_COMPACT_SOFT_FRACTION`. **Tail too thin** (the agent forgets
  recent tool output): raise `OPENGENI_CONTEXT_KEEP_RECENT_TOKENS`. **Summary
  too long/expensive**: lower `OPENGENI_CONTEXT_SUMMARY_MAX_TOKENS`.
- **Force the server threshold** with
  `OPENGENI_CONTEXT_SERVER_COMPACT_THRESHOLD_TOKENS` if you want a value other
  than `floor(B × softFraction)`.

### Operator inspection

To see compaction activity for a workspace DB directly:

```sql
-- live summary rows (one active per compacted session)
SELECT session_id, position
FROM session_history_items
WHERE item->>'opengeni_context_summary' = 'true' AND active;

-- superseded (audit-trail) rows per session
SELECT session_id, count(*)
FROM session_history_items
WHERE active = false
GROUP BY session_id;

-- the trigger signal
SELECT id, last_input_tokens FROM sessions WHERE last_input_tokens IS NOT NULL;
```

## How it was verified

- **Unit gate (re-run on `origin/main` @ `0b8f8c0`):** `bun run typecheck`
  green (all packages, exit 0); full unit suite **511 pass / 0 fail** (37 files).
  The compaction-specific unit tests (`packages/runtime/test/context-compaction.test.ts`,
  `packages/config/test/context-compaction.test.ts`,
  `packages/runtime/test/capabilities.test.ts`, `apps/worker/test/agent-turn.test.ts`)
  contribute 39 of those and exercise: provider→mode resolution, the 645,400
  server threshold (not 240k), boundary selection, orphan-safe cuts, prior-summary
  fold-forward, the `nothing_to_summarize` no-loop guard, and fractional-position
  append decoupling.
- **Integration gate (real Postgres + NATS via testcontainers, re-run on
  `origin/main`):** the `maybeCompactContext` tests in
  `test/integration/worker-activity.integration.ts` — **4 pass / 0 fail** —
  prove end-to-end against a live DB that an over-budget Azure session compacts
  into an orphan-clean `[summary, …recent tail]` active read path, that the
  summarized prefix is **superseded not deleted** (the audit rows remain), that
  exactly one summary row exists, that no real row is overwritten, and that the
  summary is recorded under the current turn so per-turn counts stay correct.
- **Deploy state (re-read live):** staging `/healthz` reports
  `deploymentRevision = 0b8f8c08…`, `ok: true`. Staging and production AKS
  `opengeni-api`/`-web`/`-worker` deployments all run the
  `…-0b8f8c08a61b9cb3bff950effdb0a1e7c360bdce-…` image. The schema migration is
  applied on the staging DB (verified live: `session_history_items.position` is
  `numeric`, `.active` is `boolean`, `sessions.last_input_tokens` exists).
- **Earlier live proof (point-in-time, from the shipping run):** a real Azure
  staging session exercised the deployed client-side path and cut model input
  ~377k → ~29k tokens (~92%), creating a summary, superseding (not deleting) the
  prefix, with an orphan-safe read path. See the residual-gaps note below on
  re-confirmability.

## Residual gaps and caveats (read this)

- **No live compaction event is currently re-confirmable on staging.** At the
  time of writing, a fresh staging DB read shows **0** superseded rows, **0**
  summary items, **0** fractional positions, and **0** sessions with
  `last_input_tokens` set — because the latest session activity on staging
  (≈ 07:22Z) predates the #62 deploy (≈ 08:31Z): **no agent turn has run through
  the new code path on staging since it went live**, and the earlier 377k→29k
  test session's rows are no longer present (cleaned). The schema is live and the
  logic is proven by the integration test against a real DB, but the specific
  "it fired in production traffic" claim rests on the earlier point-in-time run,
  not on a current readback. The first long staging/prod session to cross the
  soft threshold will be the live confirmation; watch for `session.context.compacted`
  events and superseded rows.
- **`hardFraction` is currently informational.** Soft and hard thresholds both
  resolve to "compact now" in the planner; there is no distinct hard-force
  behavior (e.g. a more aggressive tail trim) yet. If a single turn's growth ever
  outpaces the soft trigger, this is where to add it.
- **Summarizer cost/latency.** Each client-side compaction is an extra model
  call (≤ `contextSummaryMaxTokens` output). On a busy long session this recurs;
  it is bounded by the single-live-summary fold-forward but is not free. Monitor
  via the compaction events if cost matters.
- **Trigger granularity is per-turn, pre-read.** Compaction cannot shrink a
  single turn that itself overflows the window in one shot (an enormous single
  tool result). The read-path sanitizer and `contextReservedOutputTokens`
  headroom are the backstops; a pathological single item is out of scope here.
- **Server-path live behavior is unexercised in our production.** We run on
  Azure, so the `server` path (and its `store: false` + `StaticCompactionPolicy`)
  is covered by unit tests and the SDK's own contract, but not by our own
  production traffic. It is the correct path per the platform's GA behavior; if
  OpenGeni moves to the OpenAI platform, validate it live then.

## Executive go/no-go

**GO.** Unbounded-history-overflow is now **structurally fixed** for Azure
long-lived sessions: the Azure path no longer attaches the SDK `compaction`
capability (so no more 400s), and a pre-turn client-side compaction summarizes
the old prefix into a single plain user message at an orphan-safe turn boundary,
supersedes (never deletes) the prefix, and assembles a bounded
`[summary, …recent tail]` read path — so history can no longer grow without
bound. Server-side compaction is **preserved and used** automatically on the
OpenAI platform (correct 645,400 threshold, `store: false`), with no
client-side double-compaction. The code is merged (`0b8f8c0`, PR #62, with the
audit-trail fix #63 folded in), deployed to staging and production, and
schema-migrated live. The one honest caveat is that **the live firing has not
been re-confirmed by a current readback** (no post-deploy traffic has crossed
the threshold on staging yet); the mechanism itself is proven by the
real-database integration test and the earlier point-in-time live run.
