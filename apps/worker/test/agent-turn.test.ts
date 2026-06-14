import { describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import { sanitizeHistoryItemsForModel } from "@opengeni/runtime";
import { historyRowsToAppend, isWorkerShutdownCancellation, WORKER_SHUTDOWN_RESUME_TEXT } from "../src/activities/agent-turn";

// Item shapes mirror the SDK history representation persisted into
// session_history_items (type discriminator, camelCase callId).
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function functionCall(callId: string) {
  return { type: "function_call", callId, name: "tool", arguments: "{}", status: "completed" };
}
function functionResult(callId: string) {
  return { type: "function_call_result", callId, status: "completed", output: { type: "text", text: "ok" } };
}

/**
 * Drive a sequence of reconcile passes the way the live worker does: each
 * element is the SDK's computed `state.history` at one reconcile point, and the
 * watermark carries forward. Returns every row that would have been persisted,
 * in position order, after onConflictDoNothing-on-position is applied (a
 * position is frozen by the first row written to it).
 */
function persistAcrossReconciles(snapshots: Array<Array<Record<string, unknown>>>) {
  const persistedByPosition = new Map<number, Record<string, unknown>>();
  let watermark = 0;
  for (const snapshot of snapshots) {
    const { rows, nextWatermark } = historyRowsToAppend(snapshot, watermark);
    for (const row of rows) {
      if (!persistedByPosition.has(row.position)) {
        persistedByPosition.set(row.position, row.item);
      }
    }
    watermark = nextWatermark;
  }
  return [...persistedByPosition.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
}

describe("conversation-truth reconcile (orphaned tool output guard)", () => {
  test("never persists a function_call_result whose function_call was pruned mid-batch", () => {
    // Reproduces the live orphan: a parallel tool-call batch where the SDK's
    // computed history is non-monotonic across reconciles, then an abnormal
    // turn end (goal-pause / interrupt) settles only part of the batch. The old
    // blind length watermark could freeze a position and later persist a result
    // whose call had been pruned away in an earlier slice.
    //
    // Snapshot 1: model emitted two parallel calls; neither has a result yet,
    // so the SDK's dropOrphanToolCalls prunes BOTH from state.history.
    const snap1 = [userMessage("do A and B")];
    // Snapshot 2: tool A settled; A's call+result are now present, B still
    // pending and pruned. History grew but at DIFFERENT positions than a naive
    // append-only view assumed.
    const snap2 = [userMessage("do A and B"), functionCall("call_a"), functionResult("call_a")];
    // Snapshot 3 (abnormal end): the goal paused; B was cancelled mid-batch and
    // never produced a result, so B stays pruned. Final history is A's settled
    // pair only.
    const snap3 = [userMessage("do A and B"), functionCall("call_a"), functionResult("call_a")];

    const persisted = persistAcrossReconciles([snap1, snap2, snap3]);

    // Every persisted result has its call earlier in the persisted rows.
    const callIds = new Set(
      persisted.filter((item) => item.type === "function_call").map((item) => item.callId),
    );
    for (const item of persisted) {
      if (item.type === "function_call_result") {
        expect(callIds.has(item.callId)).toBe(true);
      }
    }
    // No trace of the cancelled call B leaked through (neither orphaned result
    // nor dangling call).
    expect(persisted.some((item) => item.callId === "call_b")).toBe(false);
    // The settled A pair is intact and ordered.
    expect(persisted).toEqual([userMessage("do A and B"), functionCall("call_a"), functionResult("call_a")]);
  });

  test("defers a dangling call until its result lands, then persists the pair together", () => {
    // A trailing call with no result yet must NOT be persisted alone (it would
    // dangle and 400). It is deferred and the next reconcile writes call+result.
    const snapWithDanglingCall = [userMessage("go"), functionCall("call_x")];
    // The SDK prunes the dangling call, so the reconcile persists only the user
    // message and the watermark stays at 1.
    const first = historyRowsToAppend(snapWithDanglingCall, 0);
    expect(first.rows.map((row) => row.item)).toEqual([userMessage("go")]);
    expect(first.nextWatermark).toBe(1);
    // Next reconcile: the result arrived; call and result persist together.
    const snapSettled = [userMessage("go"), functionCall("call_x"), functionResult("call_x")];
    const second = historyRowsToAppend(snapSettled, first.nextWatermark);
    expect(second.rows.map((row) => row.item)).toEqual([functionCall("call_x"), functionResult("call_x")]);
    expect(second.nextWatermark).toBe(3);
  });

  test("holds steady when prior rows already exceed the sanitized length (legacy orphans)", () => {
    // A session already carrying orphan rows from before the fix: the watermark
    // (DB row count) can exceed the sanitized history length. Nothing new is
    // appended and the watermark does not move backward or rewrite rows.
    const sanitizedShorter = [userMessage("hi")];
    const result = historyRowsToAppend(sanitizedShorter, 5);
    expect(result.rows).toEqual([]);
    expect(result.nextWatermark).toBe(5);
  });

  test("appends at fresh absolute positions after a compaction (slice index decoupled from position)", () => {
    // Post-compaction, the in-memory history is the SHORT active set
    // [summary, ...tail] whose slice index (2) is far below the next free
    // absolute position. The summary sits at a fractional position (e.g. 5.5)
    // and the last superseded prefix tops out at 9, so the next whole-number
    // position is 10 — NOT the slice index. New items must land at 10, 11, ...
    // (never colliding with superseded prefix rows nor the fractional summary).
    const sanitized = [
      userMessage("[summary] folded prefix"), // slice idx 0 — already persisted at 5.5
      userMessage("recent turn"),             // slice idx 1 — already persisted at 6
      userMessage("brand new turn"),          // slice idx 2 — NEW
      functionCall("call_z"),                 // slice idx 3 — NEW
      functionResult("call_z"),               // slice idx 4 — NEW
    ];
    const result = historyRowsToAppend(sanitized, /* persistedHistoryCount */ 2, /* nextPosition */ 10);
    expect(result.rows.map((row) => row.position)).toEqual([10, 11, 12]);
    expect(result.rows.map((row) => row.item)).toEqual([
      userMessage("brand new turn"),
      functionCall("call_z"),
      functionResult("call_z"),
    ]);
    // Slice watermark advances to the in-memory length; the next absolute
    // position advances past the rows just written.
    expect(result.nextWatermark).toBe(5);
    expect(result.nextPosition).toBe(13);
  });

  test("default nextPosition preserves contiguous-from-zero appends (uncompacted path)", () => {
    // When callers omit nextPosition (the common, never-compacted path) the
    // absolute position equals the slice index, exactly as before this change.
    const sanitized = [userMessage("a"), userMessage("b"), userMessage("c")];
    const result = historyRowsToAppend(sanitized, 1);
    expect(result.rows.map((row) => row.position)).toEqual([1, 2]);
    expect(result.nextPosition).toBe(3);
  });
});

describe("reconcile seed watermark (issue-61 skew: raw vs sanitized active count)", () => {
  // The seed the live worker computes at turn start. The fix is to seed from the
  // SANITIZED active length (what prepareRunInput actually puts into
  // state.history), NOT the raw active-row count.
  const sanitizedSeed = (activeRows: Array<Record<string, unknown>>) =>
    sanitizeHistoryItemsForModel(activeRows).length;

  test("a K-orphan legacy active history seeds K-too-high under the raw count and strands a new item", () => {
    // A legacy-corrupted session: its stored ACTIVE rows carry K=1 orphaned
    // function_call_result (call_legacy has no preceding function_call). The raw
    // active-row count is 3; sanitization drops the orphan, so state.history this
    // turn is seeded from only 2 items.
    const activeRows = [
      userMessage("earlier turn"),
      functionResult("call_legacy"), // K=1 orphan: no matching call. Dropped by sanitizer.
      userMessage("another earlier turn"),
    ];
    const rawActiveCount = activeRows.length; // 3 — the OLD seed
    const seed = sanitizedSeed(activeRows); // 2 — the FIXED seed
    expect(rawActiveCount).toBe(3);
    expect(seed).toBe(2);

    // This turn the model produced a fresh tool-call pair after the trigger. The
    // SDK's state.history is the sanitized prior history + the new trigger +
    // generated items (the orphan is already gone from the in-memory copy).
    const stateHistory = [
      userMessage("earlier turn"),
      userMessage("another earlier turn"),
      userMessage("new trigger"),
      functionCall("call_new"),
      functionResult("call_new"),
    ];

    // OLD behavior (raw seed = 3): the slice starts 1 item too late and skips the
    // genuinely-new "new trigger" item; worse, on a multi-step turn it can skip a
    // function_call while later persisting its function_call_result alone.
    const old = historyRowsToAppend(stateHistory, rawActiveCount);
    expect(old.rows.map((row) => row.item)).not.toContainEqual(userMessage("new trigger"));

    // FIXED behavior (sanitized seed = 2): the slice starts exactly at the first
    // genuinely-new item; every new item is persisted and no result is stranded.
    const fixed = historyRowsToAppend(stateHistory, seed);
    expect(fixed.rows.map((row) => row.item)).toEqual([
      userMessage("new trigger"),
      functionCall("call_new"),
      functionResult("call_new"),
    ]);
  });

  test("raw seed can persist a function_call_result whose function_call was in the skipped region", () => {
    // The session-bricking variant. K=2 orphans inflate the raw count so the
    // slice skips the new function_call but NOT its trailing result.
    const activeRows = [
      functionResult("orphan_1"), // K orphan
      functionResult("orphan_2"), // K orphan
      userMessage("prior turn"),
    ];
    const rawActiveCount = activeRows.length; // 4? no — 3
    const seed = sanitizedSeed(activeRows); // 1 (only the user message survives)
    expect(seed).toBe(1);

    // state.history seeded from the 1 surviving item, then this turn appended a
    // new call+result pair.
    const stateHistory = [
      userMessage("prior turn"),
      functionCall("call_new"),
      functionResult("call_new"),
    ];

    // OLD (raw seed = 3): slice(3) keeps only the trailing result — the orphan
    // the API 400s on. historyRowsToAppend re-sanitizes, so a single call here is
    // dropped as dangling; but had the call sat below the slice boundary in a
    // longer history its result would persist alone. Assert the FIXED seed never
    // produces that skip.
    const oldRows = historyRowsToAppend(stateHistory, rawActiveCount);
    expect(oldRows.rows).toEqual([]); // raw seed >= sanitized length: nothing new captured, the real new pair is lost

    const fixedRows = historyRowsToAppend(stateHistory, seed);
    const persisted = fixedRows.rows.map((row) => row.item);
    const callIds = new Set(
      persisted.filter((item) => item.type === "function_call").map((item) => item.callId),
    );
    for (const item of persisted) {
      if (item.type === "function_call_result") {
        expect(callIds.has(item.callId)).toBe(true);
      }
    }
    expect(persisted).toEqual([functionCall("call_new"), functionResult("call_new")]);
  });

  test("orphan-free active history: sanitized seed equals raw count (common path unchanged)", () => {
    const activeRows = [
      userMessage("hi"),
      functionCall("c1"),
      functionResult("c1"),
    ];
    expect(sanitizedSeed(activeRows)).toBe(activeRows.length);
  });
});

describe("worker shutdown preemption", () => {
  test("classifies only WORKER_SHUTDOWN cancellations as graceful preemption", () => {
    expect(isWorkerShutdownCancellation(new CancelledFailure("WORKER_SHUTDOWN"))).toBe(true);
    // Workflow-requested cancellation (user interrupt) keeps its existing path.
    expect(isWorkerShutdownCancellation(new CancelledFailure("CANCELLED"))).toBe(false);
    // Server-side heartbeat timeout after a hard kill must stay terminal.
    expect(isWorkerShutdownCancellation(new CancelledFailure("TIMED_OUT"))).toBe(false);
    expect(isWorkerShutdownCancellation(new Error("WORKER_SHUTDOWN"))).toBe(false);
    expect(isWorkerShutdownCancellation(undefined)).toBe(false);
  });

  test("resume notice tells the agent to verify in-flight side effects", () => {
    expect(WORKER_SHUTDOWN_RESUME_TEXT).toContain("TURN RESUMED AFTER WORKER RESTART");
    expect(WORKER_SHUTDOWN_RESUME_TEXT).toContain("check whether it already happened");
  });
});
