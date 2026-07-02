# Reliability fixes: bounded history, no orphan brick, scheduled-task + billing integrity

OpenGeni runs **long-lived agent sessions** on Temporal + Postgres. The longer a
session lives — a weeks-long "manager" goal is the headline workload — the more a
slow, unbounded, or off-by-K failure has time to accumulate into a hard brick or
a silent double-charge. This document records five confirmed reliability bugs and
the fixes shipped for them, each with **how it is verified**, honestly, including
what was and was not re-confirmed live.

Companion doc: [`manager-session-robustness.md`](./manager-session-robustness.md)
covers a *separate* set of four manager-session failure modes (context
compaction, worker-monitoring byte caps, `user.interrupt`). The two documents do
not overlap; they were produced by two concurrent workstreams.

Code wins over this summary. Canonical sources:

- `apps/worker/src/workflows/session.ts` — the session workflow loop +
  continueAsNew.
- `apps/worker/src/activities/agent-turn.ts` — the turn activity, the
  conversation-truth reconcile, `historyRowsToAppend`, `modelUsageSourceKey`.
- `packages/db/src/index.ts` — `orphanedResultRowIndicesForRepair`,
  `claimNextQueuedTurn`, the reusable-session locked update.
- `packages/db/drizzle/0014_repair_orphaned_function_call_results.sql` — the
  one-time orphan repair.
- `packages/core/src/domain/scheduled-tasks.ts` — the manual-trigger idempotency
  helpers and `assertReusableSessionRevivable`.

## The five fixes

| # | Severity | Failure mode | Symptom if unfixed | Shipped |
| - | -------- | ------------ | ------------------ | ------- |
| 1 | CRITICAL | Session workflow never `continueAsNew`s | Temporal force-terminates the run at the ~51,200-event / 50 MB history cap → the session dies, guaranteed for weeks-long managers | PR #72 (`024e8e2`) |
| 2 | CRITICAL | Reconciler persists an orphaned `function_call_output` | Sanitization-dropped rows skew the watermark → a `function_call_result` is persisted whose `function_call` was skipped → replay 400 → permanent brick (issue-61 incompletely fixed) | PR #71 (`da78889`) |
| 3 | MAJOR | Scheduled task resurrects a cancelled session | A user-cancelled reusable session is revived and billed on the next scheduled fire | PR #73 (`5601713`) |
| 4 | MAJOR | Manual trigger idempotency key embeds a fresh UUID | A retried `/trigger` records usage twice and starts two workflow runs (double-charge + double-spawn) | PR #73 (`5601713`) |
| 5 | MINOR / billing | Positional usage `sourceKey` collides on re-dispatch | A re-dispatched model call reuses the prior dispatch's key → its charge is silently deduped away (undercharge) | PR #73 (`5601713`) |

All five are merged to `origin/main` and **deployed to staging and production**.
Both `/healthz` endpoints report
`deploymentRevision = 5601713ae5be8c32ea2cbbd66ed4d4c103ff396f` (the HEAD of
`origin/main`, the commit carrying #73 and so all five fixes), re-read live on
2026-06-14. The full ops chain (Build Staging Artifacts → Deploy Staging →
Promote Production Artifacts → Deploy Production) ran green that day, and the
staging migration job for that revision completed (`opengeni-migrate-*`).

---

## 1. Session workflow `continueAsNew` to bound Temporal history

**The bug.** `sessionWorkflow` is a `while (true)` loop that runs turns and
synthesizes goal continuations on the **same workflow run**. Every signal,
activity schedule/complete, and timer adds to the run's Temporal **event
history**, which grows without bound. Temporal **force-terminates** a run at its
hard history limit (~51,200 events / 50 MB) — so a weeks-long manager session was
**guaranteed** to be killed mid-life, with no recovery.

**The fix** (`apps/worker/src/workflows/session.ts`). At the **top of the loop**
— the only safe boundary, where no turn is mid-flight — the workflow checks
whether it should hand off to a fresh run and, if so, calls
`continueAsNew(SessionWorkflowInput)`:

```
const shouldContinue = info.continueAsNewSuggested || turnsThisRun >= maxTurnsPerRun;
if (shouldContinue && interruptedEventId === null) { ... await continueAsNew(...) }
```

- **Primary trigger:** `workflowInfo().continueAsNewSuggested` — the server's own
  "you're getting big, hand off soon" flag, which fires well before the hard cap.
- **Deterministic backstop:** a per-run `turnsThisRun` counter against
  `TURNS_PER_RUN_BACKSTOP` (2,000), guaranteeing a hand-off even if the
  suggestion never arrives (e.g. a deployment that never raises it). Conservative
  relative to the event budget; rare enough not to be a per-turn cost. Tests
  override it via `maxTurnsPerRun` to exercise the boundary without thousands of
  real turns.
- **Gated by `patched("session-continue-as-new")`** so in-flight histories
  recorded before the branch existed stay deterministic on replay.

**Correctness — nothing is stranded across the boundary:**

- The new run carries only the **self-contained** `SessionWorkflowInput` (no
  `initialEventId`): it does **not** replay a seed event, it **re-claims from the
  durable Postgres queue** on its first `claimNextQueuedTurn`. The queue living in
  Postgres is the safety net.
- A buffered `userMessage` / `queueChanged` signal only bumps an in-memory
  `wakeups` counter, and **its turn was written to Postgres before the signal was
  sent**, so the fresh run re-claims it — losing the counter strands nothing.
- A pending `interrupt` is unbacked in-memory state the new run could not
  reconstruct, so the guard **refuses to `continueAsNew` while one is set**
  (`interruptedEventId === null`) and lets the loop handle it first.
- The stale **approval queue** is cleared at the boundary on purpose: a genuinely
  pending approval keeps the workflow blocked **inside** `runTurn`, so it never
  reaches the top of the loop; any `approvalQueue` entry observed here is
  necessarily a stale surplus decision. Coupling the guard to
  `approvalQueue.length === 0` would let one stale entry wedge it forever,
  re-introducing the exact overflow this fixes.

**Verified.**

- Real-Temporal integration tests in
  `test/integration/temporal-workflow.integration.ts`:
  - `continues-as-new at the turn boundary, carrying state and stranding no
    queued turn` — the handle follows the continueAsNew chain; both turns run
    exactly once, in order, across the split; the input payload carries state.
  - `a queueChanged signal buffered at the continueAsNew boundary is not
    stranded` — the in-memory wakeup is dropped but the durable-queue turn is
    re-claimed by the continued run.
  - `a stale approval left in the queue does not wedge the continueAsNew
    boundary` — the regression guard: the continueAsNew still fires and the
    continued run dispatches the next turn.
- Deployed revision confirmed live (`/healthz` = `5601713…`, staging + prod). The
  deployed `session.ts` is byte-identical to the merged file.
- **Not re-confirmed live:** an actual production session crossing
  `continueAsNewSuggested` and handing off. The boundary, carry-over, and
  no-strand guarantees rest on the real-Temporal integration suite, not a live
  weeks-long readback (no such session has yet reached the threshold on staging).

---

## 2. Reconciler: seed the watermark from the sanitized history (no orphan brick)

**The bug (issue-61, incompletely fixed).** Conversation truth is replayed
verbatim into the model every turn. The Responses API **rejects the whole
request with HTTP 400** when a tool-call **result** row
(`function_call_result` / `computer_call_result` / `shell_call_output` /
`apply_patch_call_output`) has no matching **call** earlier in the active
sequence. Such an orphan, replayed every turn, **permanently bricks** the session
across revival.

The dual-write seeded `persistedHistoryCount` (the slice index telling the
reconcile which items are already persisted) from the **raw**
`countActiveSessionHistoryItems` row count. But the reconcile slices the
**sanitized** history (`sanitizeHistoryItemsForModel`, which drops dangling /
orphaned pairs). When sanitization dropped **K** rows, the raw count was K **too
high**, so the slice **skipped K genuinely-new items** — and a `function_call`
left in that skipped region could later have its `function_call_result`
persisted **alone**. That is the orphan. Worse, it **self-perpetuates** on
legacy-orphan sessions: an existing orphan inflates the raw count, producing the
next one.

**The fix** (`apps/worker/src/activities/agent-turn.ts`). Seed
`persistedHistoryCount` from the **sanitized** active-row length — count what was
actually kept, exactly what `prepareRunInput` builds `state.history` from:

```
const activeSeedRows = await getActiveSessionHistoryItems(db, ws, session);
persistedHistoryCount = sanitizeHistoryItemsForModel(
  activeSeedRows.map((row) => row.item),
).length;
```

The sanitized seed is already orphan-free, so it is a **stable prefix** of the
re-sanitized history and the slice begins exactly at the first genuinely-new
item. `historyRowsToAppend` holds steady (`sanitized.length <=
persistedHistoryCount → no rows`) when prior rows already exceed the sanitized
length, so a legacy orphan can no longer push the watermark past unwritten items.
The **preempt-path reconcile** uses the same `persistedHistoryCount` basis, so the
two write paths are consistent.

**Self-heal for already-corrupted sessions** — migration **0014**
(`0014_repair_orphaned_function_call_results.sql`). The read-path sanitizer and
the write-path seed fix stop *new* orphans, but sessions corrupted **before** the
fix still carry the orphaned row on disk (the audit trail keeps surfacing a
result with no call, and the row needlessly re-triggers the sanitizer every
turn). Migration 0014 strips them **once**, paired and audited:

- An **orphan** is defined to mirror the sanitizer's rule exactly — an **active**
  result-type row with **no active matching call at a strictly earlier
  position** in the same `(workspace, session)`; correlation id read from both
  camelCase `callId` and snake_case `call_id`.
- **Dangling calls** (a call with no result yet) are deliberately **not** touched
  — valid mid-turn, not corruption.
- Every deleted row is first copied verbatim into a permanent
  `session_history_items_repair_audit` table (reason
  `orphaned_tool_call_result_no_matching_call`), so the repair is **reversible
  and auditable**. The DELETE and the audit INSERT share one CTE definition of an
  orphan.

**Verified.**

- Unit (`apps/worker/test/agent-turn.test.ts`): `a K-orphan legacy active history
  seeds K-too-high under the raw count and strands a new item` and `raw seed can
  persist a function_call_result whose function_call was in the skipped region`
  reproduce the skew and the resulting orphan; `holds steady when prior rows
  already exceed the sanitized length (legacy orphans)` and `orphan-free active
  history: sanitized seed equals raw count (common path unchanged)` pin the fix
  and the no-regression common path.
- Unit (`packages/db/test/orphan-repair.test.ts`): the pure-TS
  `orphanedResultRowIndicesForRepair` spec — which mirrors the migration's WHERE
  clause — covers the brick, valid pairs, ordering, dangling calls, snake/camel
  ids, every SDK pair, interleaving, and duplicate-result existence semantics.
- Integration (real Postgres): `db.integration` — *migration 0014 repair strips a
  legacy orphaned function_call_result, audits it, and spares valid pairs +
  dangling calls*; `worker-activity.integration` — *runs a turn whose stored
  history carries an orphaned tool output instead of 400ing*.
- **Live on the deployed staging DB (revision `5601713`), read-only probe on
  2026-06-14:**
  - `session_history_items_repair_audit` table **exists**.
  - `repair_audit_rows = 1`, `repair_reasons =
    orphaned_tool_call_result_no_matching_call` — exactly **one** pre-existing
    legacy orphan was captured and removed by the live migration.
  - `remaining_active_orphans = 0` — no active orphan remains under the
    sanitizer's own definition (the self-heal cleared the legacy row and the
    write-path seed fix is preventing new ones).

---

## 3. Scheduled tasks do not resurrect a cancelled session

**The bug.** The `reusable_session` scheduled-task path looked up the stored
session with a **null-only** `requireSession`, and the locked update set the
session status **without checking the current status**. A user-cancelled (or
otherwise terminal) reusable session was therefore **revived and billed** on the
next scheduled fire — the opposite of what cancelling a session should mean.

**The fix.** A shared
`assertReusableSessionRevivable(status)` (mirrors the core session guard in
`packages/core/src/domain/sessions.ts`) refuses **only** `cancelled` (failed / idle
stay revivable, matching the revivable-failed-sessions contract). It is called
**twice** in `apps/worker/src/activities/scheduled-tasks.ts`: once on the early
read after `requireSession`, and again **inside the row lock** on the freshly
locked status — closing the TOCTOU where a cancel lands between the early read
and the lock. Throwing aborts the dispatch rather than resurrecting the session.

**Verified.**

- Unit (`apps/worker/test/scheduled-tasks-common.test.ts`): `refuses to revive a
  cancelled (terminal) reusable session`, `allows revivable states so a recurring
  task keeps working`, `mirrors the API guard's terminal set exactly (only
  cancelled is rejected)`.
- Integration (real Postgres, `worker-activity.integration`): *refuses to revive a
  cancelled reusable session on the next fire*.
- Deployed live (`/healthz` = `5601713…`, staging + prod).

---

## 4. Manual scheduled-task trigger is idempotent (one charge, one run)

**The bug.** The manual `/trigger` path built the
`agentRunUsageIdempotencyKey` with `crypto.randomUUID()`, so a **retried**
trigger (network blip, lambda re-invocation) never collided — it recorded usage
**twice** and started **two** workflow runs (double-charge + double-spawn).

**The fix** (`packages/core/src/domain/scheduled-tasks.ts`). Derive everything from a
**stable trigger token**:

- `scheduledTaskTriggerToken(clientTriggerId)` — uses a client-supplied id when
  present (sanitized to the Temporal workflow-id-safe charset, length-clamped, so
  a client value cannot smuggle a collision into another task's id space); mints
  a fresh UUID **per request** only when none is supplied, so two genuinely
  distinct manual triggers still each get their own run.
- `manualScheduledTaskTriggerWorkflowId(taskId, token)` — a **deterministic**
  workflow id; combined with `workflowIdReusePolicy: "REJECT_DUPLICATE"`, a retry
  with the same token collapses the second start into a **no-op** instead of
  spawning a second run.
- `manualScheduledTaskTriggerUsageKey(workspaceId, taskId, token)` — the usage
  idempotency key shares the **same** token, so the charge and the run **dedupe
  together** under retry.

**Verified.**

- Unit (`apps/api/test/scheduled-task-trigger.test.ts`): `a client-supplied
  trigger id derives a stable token -> idempotent retry`, `usage key and workflow
  id share the token so charge and run dedupe together`, `absent trigger id mints
  a fresh token -> distinct triggers stay distinct`, plus blank/whitespace,
  charset-sanitization (no id-space smuggling), determinism-after-sanitization,
  and overlong-token clamping.
- Integration (real API + Temporal, `api.integration`): `a retried manual trigger
  (same triggerId) charges once and starts one run`, `a manual trigger without a
  triggerId stays a distinct run each time`, `does not record manual scheduled
  trigger usage when workflow start fails`.
- Deployed live (`/healthz` = `5601713…`, staging + prod).

---

## 5. Stable + unique usage `sourceKey` per model call (no undercharge)

**The bug.** The per-model-call usage `sourceKey` was **positional**
(`"response-1"`, `"aggregate"`). Because the same `turnId` is shared across a
**re-dispatch** of the same turn (preemption resume, approval rerun, activity
retry), dispatch B's first call reused dispatch A's `"response-1"` key — and its
charge was **silently deduped away** (undercharge).

**The fix** (`modelUsageSourceKey` in
`apps/worker/src/activities/agent-turn.ts`). A provider `responseId` is globally
stable + unique, so reuse it verbatim — a true activity retry that re-emits the
same `responseId` correctly **dedupes** (one charge) while two distinct calls get
distinct ids. When there is **no** `responseId`, qualify the positional fallback
with the **per-execution dispatch id** (the Temporal `activityId`, unique per
scheduled execution): `${dispatchId}:${positionalKey}`. Re-dispatched calls are
then distinct (no dropped charge) while a same-execution retry still dedupes.

**Verified.**

- Unit (`apps/worker/test/agent-turn.test.ts`): `positional fallback is unique
  per dispatch so a re-dispatch does not collide`, `within one dispatch the
  positional fallback stays stable per call (in-dispatch dedupe)`, `degrades to
  the bare positional key when no dispatch id is available`.
- Integration (`worker-activity.integration`): `records and debits model usage
  once per streamed provider response` (the `responseId` dedupe path).
- Deployed live (`/healthz` = `5601713…`, staging + prod).

---

## Executive verdict

All five reliability bugs are **fixed, merged to `origin/main`, and deployed to
staging and production** (`/healthz` = `5601713…`, re-read live on 2026-06-14).
The orphan-repair self-heal is **live-verified by a read-only staging DB probe**
(audit table present; exactly one legacy orphan captured + removed; zero active
orphans remain). The scheduled-task + billing integrity fixes are covered by unit
**and** real-API/Temporal integration tests; the continueAsNew bound is covered
by the real-Temporal integration suite.

| # | Verdict | Strength of evidence |
| - | ------- | -------------------- |
| 1 Unbounded Temporal history | **Fixed** | Code + 3 real-Temporal integration tests (boundary fires, carries state, no strand; buffered signal; stale-approval); deployed. Live *firing* not yet observed (no session has crossed the threshold). |
| 2 Orphaned `function_call_output` brick | **Fixed** | Unit (skew repro + fix) + DB/worker integration + migration integration; **live staging DB probe** (1 orphan repaired, 0 remain); deployed. |
| 3 Cancelled-session resurrection | **Fixed** | Unit + real-Postgres integration (no revive on next fire); deployed. |
| 4 Non-idempotent manual trigger | **Fixed** | Unit + real-API/Temporal integration (charge once, one run; no usage on start failure); deployed. |
| 5 Positional usage-key collision | **Fixed** | Unit (per-dispatch uniqueness + in-dispatch dedupe) + usage integration; deployed. |

### Residual gaps / unconverged findings (LOUD)

- **continueAsNew has not been observed firing on a live long session.** No
  staging/prod session has yet accumulated enough history to cross
  `continueAsNewSuggested` or the 2,000-turn backstop, so the *hand-off* is proven
  only by the real-Temporal integration suite, not a live readback. **Watch the
  first multi-week manager session** for a continueAsNew chain on its workflow id
  and confirm it re-claims its queue seamlessly.
- **Live staging history is currently empty** (`total_active_history_items = 0`):
  the staging DB carries only transient test sessions, which were cleared after
  the migration ran. The single repaired orphan was captured by the migration at
  deploy time; the `remaining_active_orphans = 0` readback is therefore a
  *necessary* but not a *busy-state* confirmation. The fix's behaviour under a
  large, real legacy-orphan corpus is proven by the integration test against real
  Postgres, not by a populated staging table.
- **Code review did not converge with a live reviewer.** Per the shipping record,
  the review rounds for these PRs relied on CI + Bugbot being green rather than a
  converged human/agent review. The five fixes were nonetheless independently
  re-verified against the merged `origin/main` code and (for #2) against the live
  staging DB in this pass.
- **No live double-charge / double-spawn negative test on the deployed image.**
  Fixes #4 and #5 are proven by integration tests (real API + Temporal) and the
  deployed-revision readback, not by deliberately retrying a real production
  trigger and confirming a single charge on the live billing ledger.
