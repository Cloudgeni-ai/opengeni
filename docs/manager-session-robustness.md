# Long-lived manager-session robustness

OpenGeni's defining workload is the **long-lived "manager" session**: a
per-customer ops channel that lives for **weeks**, spawning and monitoring
short-lived **worker** sessions. A manager that bricks takes the whole customer
relationship down with it, silently, days into a run. This document is the
single place that explains the four failure modes that could brick or stall such
a session and how each is now fixed — with how each fix is verified, honestly,
including what was **not** re-confirmed.

A separate set of reliability fixes — bounded Temporal history
(`continueAsNew`), the reconciler watermark + orphan repair, and scheduled-task
+ billing integrity — is documented in
[`reliability-fixes.md`](./reliability-fixes.md); the two documents do not
overlap.

Code and the per-area docs win over this summary. Cross-references:

- Compaction internals: [`context-compaction.md`](./context-compaction.md).
- Parent wakeup on worker completion: `apps/worker/src/activities/parent-wake.ts`.
- Session-read byte caps: `apps/api/src/mcp/session-view.ts`.
- Interrupt control path: `apps/api/src/index.ts` (`signalInterrupt`),
  `apps/api/src/routes/sessions.ts` (events route),
  `apps/worker/src/workflows/session.ts` (the `interrupt` signal).

## The four failure modes and their fixes

| # | Failure mode | Symptom if unfixed | Fix | Shipped |
| - | ------------ | ------------------ | --- | ------- |
| 1 | **Unbounded overflow + re-brick** | History grows past the window; a turn that overflows records no usage, leaving a stale-low `last_input_tokens` → next pre-turn check doesn't compact → overflows again → permanent brick | `max(recorded, estimate)` trigger + hard-force shrunk tail + read-path budget guard | PR #69 (`cc17837`) |
| 2 | **Worker-monitoring bloat** ("parent ingests child") | A manager paging a worker's event stream piles 100k+ chars into its own context in one turn | Byte/token cap on the cross-session MCP read tools + the don't-busy-poll doctrine | PR #68 (`730eda5`) + Geni Pack 0.4.3 |
| 3 | **Un-cancellable runaway turn** | `POST {type:"user.interrupt"}` to an idle/closed-workflow session 500s → operator cannot stop a looping turn | `signalInterrupt` uses `signalWithStart` (start-or-signal) instead of `getHandle().signal()` | PR #70 (`2131583`) |
| 4 | **Single over-budget input** (backstop for #1) | Pre-turn compaction no-ops and an over-budget assembled input is still sent → 400 every turn | Hard-force path + `enforceInputBudget` read-path airbag | PR #69 (`cc17837`) |

All three PRs are merged to `origin/main` and **deployed to staging and
production** — both `/healthz` endpoints report
`deploymentRevision = 21315832b6cd92ec78ea6da677eb3b766a943d66` (the HEAD of
`origin/main`), re-read live on 2026-06-14.

---

## 1 + 4. Compaction self-heal and the over-budget backstop

Full detail is in [`context-compaction.md`](./context-compaction.md); the
robustness-critical parts:

- **`max(recorded, estimate)` trigger.** The pre-turn compaction decision uses
  `signalTokens = max(recorded last-turn input tokens, char/4 estimate of the
  active history)`. `sessions.last_input_tokens` is written **only** when a model
  response reports usage; a turn that **overflows on its first model call**
  records nothing, so the column keeps a **stale-positive** value (e.g. ~600k)
  from the last good turn. The old code *trusted* that stale-low number, slipped
  under the 645k soft limit, did **not** compact, and overflowed again — a
  permanent re-brick. Taking the **max** against a fresh estimate of the real
  history makes a bloated history compact regardless of the stale count, so the
  session **self-heals on the next turn**.
- **Hard-force path (`hardFraction × B`).** Previously `hardFraction` was
  informational. Now, at/over the hard ceiling, the boundary walk runs with a
  **shrunk keep-recent budget** (`min(keepRecent/2, B/4)`) so an over-budget
  history whose whole tail reads as "recent" still leaves a non-empty,
  summarizable prefix instead of stranding the session. The
  `session.context.compacted` event carries `trigger: "hard"` for observability.
- **Read-path budget guard (`enforceInputBudget`).** The airbag. At input
  assembly time (`prepareRunInput`), if the assembled request still exceeds `B`
  (compaction no-op'd, summarizer failed, or a fresh message arrived after a turn
  ballooned the history), the **oldest** history is dropped at a clean
  user-message turn boundary — orphan-safe by construction — until it fits,
  **always** keeping the most recent turn(s). Wired only on the Azure client path
  (production). It is a crude data-loss fallback (no summary), so a single
  over-budget input can never reach the model.

**Verified:**
- Unit suite `packages/runtime/test/context-compaction.test.ts` is green and
  covers the two regressions explicitly: stale-positive `last_input_tokens` +
  over-budget history MUST compact, and a post-overflow session self-heals; plus
  the hard-force shrunk-tail prefix guarantee and `enforceInputBudget`'s
  orphan-safe oldest-drop. `bun run typecheck` green; the compaction +
  session-view + api unit files re-run green this pass (`78 pass` /
  `19 pass` / etc., 0 fail).
- Deployed revision confirmed live on staging+prod (`/healthz` = `21315832`).
- **Not re-confirmed this pass:** a live compaction *firing* against the staging
  DB. The staging Postgres is a **private Azure endpoint** and this pass had no
  AKS/Azure credentials to open an in-cluster `psql` probe pod, so the
  "a real session crossed ~645k and produced a summary row" claim still rests on
  the **earlier point-in-time shipping run** (377k→29k tokens), not a fresh
  readback. The mechanism is proven by the real-Postgres integration test and
  the unit suite.

## 2a. Session-read byte cap (platform)

A manager monitors a worker by reading the worker's event timeline over the
first-party MCP. A worker's events carry **verbatim** model output and, worse,
verbatim **tool outputs** and raw tool-call items — sized for the *worker's* own
context, not the manager's. The DB `limit` caps event **count, not bytes**, so a
single `session_events` page can be tens of thousands of characters, and a
manager paging a busy worker piles **hundreds of thousands** of characters into
its own context in one monitoring turn. That is the "parent ingests child"
blow-up that bricks the manager.

`apps/api/src/mcp/session-view.ts` adds a pure, dependency-free cap, wired into
the two cross-session read MCP tools in `apps/api/src/mcp/server.ts`:

- **`session_events`** — two stages. (1) **Per-event field trim**: recursively
  clamp any over-long string / over-large nested blob to a per-field budget
  (`2,000` chars) with a head+tail `…N chars truncated…` marker; type-agnostic,
  so a new fat event type is capped automatically. (2) **Head+tail page budget**:
  if the per-event-trimmed page still exceeds the token budget (`~10,000`), keep
  the oldest `headEvents` + newest `tailEvents` (8 each) and drop the middle
  behind **one synthetic marker event** (typed `session.status.changed` so it
  still validates against the `SessionEvent` contract; payload carries
  `droppedCount`, the omitted sequence range, and how to page the gap or read the
  notebook). **Pagination is preserved**: `nextAfter` is the real highest
  `sequence` the DB returned, so the next page starts exactly where this one
  ended and never skips real events.
- **`session_get`** — clamps the only unbounded agent-controlled fields
  (`metadata`, and defensively `initialMessage`) to `~6,000` chars.

**REST routes and worker/UI consumers are untouched** — they call the DB
functions directly. Only the MCP tool result a *manager model* reads is shaped.

**Verified:**
- Unit suite `apps/api/test/session-view.test.ts` green (`19 pass / 0 fail`):
  string/nested/tiny-field/cyclic trimming, empty/small/over-budget pages,
  monotonic sequences, contract-validity of the capped page, no input mutation,
  and session-detail clamping.
- **Live on deployed staging (revision `21315832`):** through the first-party
  MCP endpoint (`POST /v1/workspaces/:ws/mcp`, `tools/call session_get`) against
  a throwaway session created with a **50,000-char** `metadata.huge` field, the
  raw REST `session_get` returned the full 50,000 chars (uncapped, by design)
  while the **MCP** `session_get` returned the same field clamped to **6,117
  chars** with the `…chars truncated…` marker present — the cap demonstrably
  fires live on the path a manager actually reads.
- The `session_events` head+tail page-drop was exercised live against a real
  ~100-event session, but that session's events were genuinely small (~8.3k
  tokens, under the 10k budget) so the page correctly returned **un-trimmed** —
  the cap only fires when over budget. The over-budget drop is covered by the
  unit suite.

## 2b. Don't-busy-poll doctrine (Geni pack — private repo)

The platform cap bounds the blast radius, but the manager should not be paging a
worker on a poll loop in the first place. opengeni **#60** auto-wakes the parent
session when a spawned worker reaches a terminal-for-now state (`idle` or
`failed`) — see `apps/worker/src/activities/parent-wake.ts`
(`notifyParentOfChildTerminal`, idempotent per terminal episode via the child's
`lastSequence`). So the manager should **spawn, then go idle and await the
wakeup**, not busy-poll; when it does need a status glance it uses a **single
bounded check**, not a poll loop.

That behavioral doctrine lives in the **private** Geni pack
(`skills/geni-manager` §2 Orchestration), not in this OSS repo. It is shipped on
Geni `origin/main` as **Pack 0.4.3** (PR #20, commit `5ce7354`): the monitor
guidance now reads "await completion by going idle — do not busy-poll", aligned
with the shipped wakeup. No content from the private pack is reproduced here.

## 3. `user.interrupt` cleanly cancels a running turn

`POST {type:"user.interrupt"}` to
`/v1/workspaces/:ws/sessions/:sid/events` is the operator's stop button for a
runaway or looping turn. It was returning **500**.

**Root cause:** `signalInterrupt` used
`temporal.workflow.getHandle(workflowId).signal("interrupt", …)`. When the
session workflow has gone **idle/closed** (it returned after `markSessionIdle`,
so there is **no running execution**), `getHandle().signal()` throws
`WorkflowNotFoundError`, which surfaced as a 500 — leaving an operator unable to
stop a session that was running-then-idle, or looping in a way that closed and
reopened the workflow.

**Fix (PR #70):** make `signalInterrupt` use
`temporal.workflow.signalWithStart("sessionWorkflow", …)` — exactly mirroring
`wakeSessionWorkflow`. It delivers the `interrupt` signal to a live execution
when one exists, and otherwise **starts** a fresh `sessionWorkflow` that
immediately honors the buffered `interrupt` via the workflow's idle-interrupt
path (`pauseGoalForInterrupt` + `markSessionIdle`). This required threading
`accountId`/`workspaceId` (the `sessionWorkflow` args) into `signalInterrupt`;
the events route already holds both on the access grant. The route stays
**permission-gated on `sessions:control`**.

When a turn **is** active, the workflow races the turn against
`condition(() => interruptedEventId !== null)`; on interrupt it `scope.cancel()`s
the turn and calls `interruptActiveTurn` — the runaway turn is cancelled.

**Verified:**
- Integration tests (`temporal-workflow.integration`, `api.integration`):
  interrupt via `signalWithStart` against a **not-running** workflow starts it
  and runs the idle-interrupt path; the events route hands `signalInterrupt` the
  start-or-signal args and an interrupt on an idle session returns **202, not
  500**; running-turn cancellation is covered by the existing active-run test.
- **Live on deployed staging (revision `21315832`):** against a throwaway
  session told to "count upward forever and never stop":
  - `user.interrupt` **while the turn was actively counting** → **202**, and the
    session settled to `status: idle` — the runaway turn was cancelled. (The
    session's event sequence had advanced from ~7 to ~111, proving a real turn
    ran and was then stopped.)
  - `user.interrupt` **while the session was idle** (the exact 500-repro: no
    running execution) → **202**, **not 500**. The start-or-signal path works on
    the deployed image.

---

## Executive verdict

**Long-lived manager sessions are now robust against all four named failure
modes**, and the fixes are merged, deployed to staging **and** production
(`/healthz` = `21315832`, re-read live), and — for the two externally
observable ones — **live-verified on the deployed image**:

| Failure mode | Verdict | Strength of evidence |
| ------------ | ------- | -------------------- |
| **Unbounded overflow / re-brick** | **Fixed** | Code + unit + real-Postgres integration; deployed. Live *firing* readback NOT re-done this pass (private DB, no probe access). |
| **Worker-monitoring bloat** | **Fixed** | Platform cap: unit + **live MCP readback** (50k→6,117 char clamp on deployed staging). Doctrine: shipped on Geni Pack 0.4.3. |
| **Un-cancellable runaway turn** | **Fixed** | Code + integration + **live readback** (202 not 500, idle and active; runaway turn cancelled) on deployed staging. |
| **Single over-budget input** | **Fixed** | `enforceInputBudget` airbag, client-path-only, unit-covered; deployed. |

### Residual gaps / unconverged findings (LOUD)

- **Live compaction firing is NOT re-confirmed by a current DB readback.** The
  staging Postgres is a private Azure endpoint and this pass had no AKS/Azure
  credentials to open an in-cluster `psql` probe, so the "a real session crossed
  ~645k tokens and produced a summary row" claim rests on the earlier
  point-in-time shipping run, not a fresh readback. The deployed revision, the
  `last_input_tokens` write, and the `session.context.compacted` emitter are all
  confirmed present; the *firing* is the one unverified-this-pass link. **Watch
  the first long staging/prod session that crosses the soft threshold** for a
  `session.context.compacted` event (now carrying `trigger`) and superseded
  (`active = false`) rows.
- **`session_events` head+tail page-drop was not live-fired**, only the per-field
  / page-drop unit tests plus a live call that was legitimately under budget (so
  returned un-trimmed). To force a live page-drop, monitor a worker that emits
  large tool outputs and confirm the synthetic `_truncated` marker event appears
  with `nextAfter` still advancing.
- **Review rounds did not converge with a live reviewer.** Per the shipping
  record, both code-review rounds ended with "reviewer died"; the merges relied
  on CI + Bugbot being green, not on a converged human/agent review. The four
  fixes here were nonetheless independently re-verified against the merged code
  and (for #2a and #3) against the deployed image in this pass.
- **Server-side compaction path is unexercised in our production** (we run on
  Azure). It is unit-tested and correct per the platform's GA contract; validate
  live if/when OpenGeni moves to the OpenAI platform.
- **Single-turn-overflow is out of scope.** A single tool result large enough to
  overflow the window in one shot is bounded by `enforceInputBudget` (it drops
  it if it sits in older history) and `contextReservedOutputTokens` headroom, but
  a pathological single *current* item is not summarized away.
