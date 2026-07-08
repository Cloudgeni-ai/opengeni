import { describe, expect, mock, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import type { Settings } from "@opengeni/config";
import { SandboxImageConflictError, SandboxLeaseSupersededError } from "@opengeni/db";
import { sanitizeHistoryItemsForModel } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  acceptsPromptCacheKeyForTurn,
  classifyContextWindowOverflowError,
  computerToolModeForTurn,
  createTurnSandboxProvisioner,
  emitModelCallUsage,
  ensureTurnModalRegistryImage,
  filterUnmaterializedSandboxFileDownloads,
  historyRowsToAppend,
  isLazySandboxProvisionRetryable,
  isWorkerShutdownCancellation,
  modelUsageSourceKey,
  resolveActiveSandboxBackend,
  shouldStartOnTurnRecording,
  WORKER_SHUTDOWN_RESUME_TEXT,
} from "../src/activities/agent-turn";
import { settingsWithPackSandboxImage } from "../src/activities/packs";
import { withUnavailableSandboxFilesNote } from "../src/activities/run-input";

// Item shapes mirror the SDK history representation persisted into
// session_history_items (type discriminator, camelCase callId).
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function functionCall(callId: string) {
  return { type: "function_call", callId, name: "tool", arguments: "{}", status: "completed" };
}
function functionResult(callId: string) {
  return {
    type: "function_call_result",
    callId,
    status: "completed",
    output: { type: "text", text: "ok" },
  };
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
  return [...persistedByPosition.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
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
    expect(persisted).toEqual([
      userMessage("do A and B"),
      functionCall("call_a"),
      functionResult("call_a"),
    ]);
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
    expect(second.rows.map((row) => row.item)).toEqual([
      functionCall("call_x"),
      functionResult("call_x"),
    ]);
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
      userMessage("recent turn"), // slice idx 1 — already persisted at 6
      userMessage("brand new turn"), // slice idx 2 — NEW
      functionCall("call_z"), // slice idx 3 — NEW
      functionResult("call_z"), // slice idx 4 — NEW
    ];
    const result = historyRowsToAppend(
      sanitized,
      /* persistedHistoryCount */ 2,
      /* nextPosition */ 10,
    );
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
    const activeRows = [userMessage("hi"), functionCall("c1"), functionResult("c1")];
    expect(sanitizedSeed(activeRows)).toBe(activeRows.length);
  });
});

describe("model usage source key (re-dispatch charge stability)", () => {
  test("uses the provider responseId verbatim when present (stable + unique)", () => {
    expect(
      modelUsageSourceKey({
        responseId: "resp_abc",
        dispatchId: "act-1",
        positionalKey: "response-1",
      }),
    ).toBe("resp_abc");
    // The responseId path ignores the dispatch id, so a true activity retry
    // that re-emits the SAME responseId produces the SAME key and dedupes the
    // charge (no double-bill).
    expect(
      modelUsageSourceKey({
        responseId: "resp_abc",
        dispatchId: "act-2",
        positionalKey: "response-1",
      }),
    ).toBe("resp_abc");
  });

  test("positional fallback is unique per dispatch so a re-dispatch does not collide", () => {
    // The bug: without a responseId the old key was purely positional, so the
    // first model call of dispatch A and of dispatch B both keyed "response-1"
    // -> the second charge deduped away (undercharge). Folding the per-execution
    // dispatch id in keeps them distinct.
    const dispatchAFirst = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-A",
      positionalKey: "response-1",
    });
    const dispatchBFirst = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-B",
      positionalKey: "response-1",
    });
    expect(dispatchAFirst).not.toBe(dispatchBFirst);
    expect(dispatchAFirst).toBe("act-A:response-1");
    expect(dispatchBFirst).toBe("act-B:response-1");

    // The aggregate fallback (no per-response usage at all) has the same hazard
    // and the same fix.
    const aggA = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-A",
      positionalKey: "aggregate",
    });
    const aggB = modelUsageSourceKey({
      responseId: null,
      dispatchId: "act-B",
      positionalKey: "aggregate",
    });
    expect(aggA).not.toBe(aggB);
  });

  test("within one dispatch the positional fallback stays stable per call (in-dispatch dedupe)", () => {
    // Same dispatch id + same positional slot -> same key, so a retried record
    // within the one execution still dedupes (idempotent), while distinct calls
    // (response-1 vs response-2) stay distinct.
    expect(
      modelUsageSourceKey({ responseId: null, dispatchId: "act-A", positionalKey: "response-1" }),
    ).toBe(
      modelUsageSourceKey({ responseId: null, dispatchId: "act-A", positionalKey: "response-1" }),
    );
    expect(
      modelUsageSourceKey({ responseId: null, dispatchId: "act-A", positionalKey: "response-1" }),
    ).not.toBe(
      modelUsageSourceKey({ responseId: null, dispatchId: "act-A", positionalKey: "response-2" }),
    );
  });

  test("degrades to the bare positional key when no dispatch id is available", () => {
    // Outside a Temporal activity context (local/test) there is no activityId;
    // the key falls back to the positional value rather than throwing.
    expect(
      modelUsageSourceKey({ responseId: null, dispatchId: null, positionalKey: "aggregate" }),
    ).toBe("aggregate");
  });
});

describe("model call usage observability", () => {
  test("logs and emits normalized cache/reasoning usage fields", async () => {
    const infos: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    const observability = {
      info: (_message: string, attributes: Record<string, unknown>) => infos.push(attributes),
      warn: mock(),
    };

    await emitModelCallUsage({
      observability: observability as any,
      publish: async (batch) => {
        events.push(...batch.map((event) => ({ type: event.type, payload: event.payload })));
      },
      accountId: "acct-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.5",
      sourceKey: "resp-1",
      usage: {
        responseId: "resp-1",
        usage: {
          inputTokens: 1200,
          outputTokens: 100,
          totalTokens: 1300,
          inputTokensDetails: { cached_tokens: 1024 },
          outputTokensDetails: { reasoning_tokens: 12 },
        },
      },
    });

    expect(infos[0]).toMatchObject({
      provider: "openai",
      providerApi: "responses",
      model: "gpt-5.5",
      sourceKey: "resp-1",
      inputTokens: 1200,
      outputTokens: 100,
      cachedTokens: 1024,
      reasoningTokens: 12,
    });
    expect(events).toEqual([
      {
        type: "agent.model.usage",
        payload: expect.objectContaining({
          provider: "openai",
          providerApi: "responses",
          model: "gpt-5.5",
          sourceKey: "resp-1",
          inputTokens: 1200,
          outputTokens: 100,
          cachedTokens: 1024,
          reasoningTokens: 12,
        }),
      },
    ]);
  });
});

describe("active sandbox backend resolution (Case B: clone-onto-real-disk gate)", () => {
  const selfhostedPointer = async () => ({ activeSandboxId: "sbx_machine" });
  const selfhostedKind = async () => "selfhosted";

  test("returns 'selfhosted' when an active swap points at a connected machine", async () => {
    // Home backend stays cloud (e.g. modal) but the active sandbox is a BYO
    // machine — buildAgent must be told "selfhosted" so the repository clone hook
    // is skipped (never `git clone` onto the user's real disk).
    expect(await resolveActiveSandboxBackend(true, selfhostedPointer, selfhostedKind)).toBe(
      "selfhosted",
    );
  });

  test("returns undefined when routing is off (flag gated; home backend default)", async () => {
    // The active pointer is only meaningful when the selfhosted feature is on; with
    // it off we never even query, and the cloud home backend governs unchanged.
    let queried = false;
    const backend = await resolveActiveSandboxBackend(
      false,
      async () => {
        queried = true;
        return { activeSandboxId: "sbx_machine" };
      },
      selfhostedKind,
    );
    expect(backend).toBeUndefined();
    expect(queried).toBe(false);
  });

  test("returns undefined when there is no active swap (null pointer == cloud group box)", async () => {
    expect(
      await resolveActiveSandboxBackend(true, async () => null, selfhostedKind),
    ).toBeUndefined();
    expect(
      await resolveActiveSandboxBackend(
        true,
        async () => ({ activeSandboxId: null }),
        selfhostedKind,
      ),
    ).toBeUndefined();
  });

  test("returns undefined when the active swap target is itself a cloud (modal) box", async () => {
    // A swap to a sibling cloud box is still cloud — the clone hook stays enabled.
    expect(
      await resolveActiveSandboxBackend(true, selfhostedPointer, async () => "modal"),
    ).toBeUndefined();
  });

  test("never throws: a pointer-load failure falls back to the home backend default", async () => {
    const backend = await resolveActiveSandboxBackend(
      true,
      async () => {
        throw new Error("db unreachable");
      },
      selfhostedKind,
    );
    expect(backend).toBeUndefined();
  });

  test("never throws: a sandbox-kind-load failure falls back to the home backend default", async () => {
    const backend = await resolveActiveSandboxBackend(true, selfhostedPointer, async () => {
      throw new Error("db unreachable");
    });
    expect(backend).toBeUndefined();
  });

  test("reuse contract (Stage D hoist): pre-loaded pointer + record memoized closures are each read at most once", async () => {
    // The activity loads the active pointer + its sandbox row ONCE at turn start and
    // threads memoized closures into resolveActiveSandboxBackend, so the SAME values
    // also feed the machine-primary establish branch (enrollmentId/epoch/workingDir)
    // with no double read / no read-skew. This pins that single-read reuse contract:
    // the gate reads each pre-loaded value at most once and still resolves selfhosted.
    let pointerReads = 0;
    let kindReads = 0;
    const pointer = { activeSandboxId: "sbx_machine", activeEpoch: 3 };
    const backend = await resolveActiveSandboxBackend(
      true,
      async () => {
        pointerReads += 1;
        return pointer;
      },
      async () => {
        kindReads += 1;
        return "selfhosted";
      },
    );
    expect(backend).toBe("selfhosted");
    expect(pointerReads).toBe(1);
    expect(kindReads).toBe(1);
  });
});

describe("turn-time Modal private-registry warm", () => {
  test("warms the pack-resolved Modal image ref before sandbox creation", async () => {
    const packImage = "acr.example.com/cloudgeni/f4c-gecko@sha256:abc";
    const runSettings = settingsWithPackSandboxImage(
      testSettings({
        sandboxBackend: "modal",
        modalImageRef: undefined,
        modalImageRegistrySecret: "acr-credentials-gecko",
      }),
      packImage,
    );
    const ensureRegistryImage = mock(async (_settings: Settings) => undefined);

    await ensureTurnModalRegistryImage(runSettings, "modal", ensureRegistryImage);

    expect(ensureRegistryImage).toHaveBeenCalledTimes(1);
    expect(ensureRegistryImage.mock.calls[0]?.[0].modalImageRef).toBe(packImage);
    expect(ensureRegistryImage.mock.calls[0]?.[0].modalImageRegistrySecret).toBe(
      "acr-credentials-gecko",
    );
  });

  test("keeps non-modal or public-image turns on the no-op path", async () => {
    const ensureRegistryImage = mock(async (_settings: Settings) => undefined);
    await ensureTurnModalRegistryImage(
      testSettings({
        sandboxBackend: "docker",
        modalImageRef: "acr.example.com/cloudgeni/f4c-gecko@sha256:abc",
        modalImageRegistrySecret: "acr-credentials-gecko",
      }),
      "docker",
      ensureRegistryImage,
    );
    await ensureTurnModalRegistryImage(
      testSettings({
        sandboxBackend: "modal",
        modalImageRef: "ghcr.io/cloudgeni/public:latest",
        modalImageRegistrySecret: undefined,
      }),
      "modal",
      ensureRegistryImage,
    );
    expect(ensureRegistryImage).not.toHaveBeenCalled();
  });
});

describe("on-turn recording gate (selfhosted machines have no in-box capture plumbing)", () => {
  const base: Parameters<typeof shouldStartOnTurnRecording>[0] = {
    recordingEnabled: true,
    desktopEnabled: true,
    establishedBackendId: "modal",
    effectiveBackend: undefined,
  };

  test("modal cloud box: records (unchanged behavior)", () => {
    expect(shouldStartOnTurnRecording({ ...base })).toBe(true);
  });

  test("selfhosted EFFECTIVE backend: does NOT start recording (no recording.started emitted)", () => {
    // The machine-primary turn establishes the SelfhostedSession (backendId
    // "selfhosted", which is desktop-capable), so the desktop-capable check alone
    // would over-trigger. The effective-backend gate is what suppresses it.
    expect(
      shouldStartOnTurnRecording({
        ...base,
        establishedBackendId: "selfhosted",
        effectiveBackend: "selfhosted",
      }),
    ).toBe(false);
  });

  test("modal-home session swapped ONTO a machine: skips (gate is the effective backend, not home)", () => {
    // Home backend is a cloud box (established could even still read modal in the
    // degraded no-enrollment edge), but the ACTIVE pointer resolves selfhosted —
    // recording must skip.
    expect(
      shouldStartOnTurnRecording({
        ...base,
        establishedBackendId: "modal",
        effectiveBackend: "selfhosted",
      }),
    ).toBe(false);
  });

  test("machine-home turn degraded back to its cloud group box: records (effective backend undefined)", () => {
    expect(
      shouldStartOnTurnRecording({
        ...base,
        establishedBackendId: "modal",
        effectiveBackend: undefined,
      }),
    ).toBe(true);
  });

  test("recording disabled by policy: skips regardless of backend", () => {
    expect(shouldStartOnTurnRecording({ ...base, recordingEnabled: false })).toBe(false);
    expect(shouldStartOnTurnRecording({ ...base, desktopEnabled: false })).toBe(false);
  });

  test("headless / non-desktop established backend: skips (existing static feasibility gate holds)", () => {
    expect(shouldStartOnTurnRecording({ ...base, establishedBackendId: "none" })).toBe(false);
  });
});

describe("lazy sandbox provisioner single-flight", () => {
  test("concurrent callers share one establish promise", async () => {
    let establishes = 0;
    const provisioner = createTurnSandboxProvisioner(async () => {
      establishes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, attempt: establishes };
    });

    const results = await Promise.all(Array.from({ length: 12 }, () => provisioner.get()));

    expect(establishes).toBe(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(results[0]).toEqual({ ok: true, attempt: 1 });
  });

  test("final failure rejects all waiters and resets the memo for the next op", async () => {
    let establishes = 0;
    const provisioner = createTurnSandboxProvisioner(async () => {
      establishes += 1;
      throw new SandboxImageConflictError("group-1", "old", "new");
    });

    const first = await Promise.allSettled(Array.from({ length: 5 }, () => provisioner.get()));
    expect(first.every((result) => result.status === "rejected")).toBe(true);
    expect(establishes).toBe(1);

    await expect(provisioner.get()).rejects.toThrow(SandboxImageConflictError);
    expect(establishes).toBe(2);
  });

  test("transient supersession retries inside the single-flight", async () => {
    let establishes = 0;
    const provisioner = createTurnSandboxProvisioner(
      async () => {
        establishes += 1;
        if (establishes === 1) {
          throw new SandboxLeaseSupersededError("group-1", 7);
        }
        return "ready";
      },
      { backoffMs: 1 },
    );

    await expect(provisioner.get()).resolves.toBe("ready");
    expect(establishes).toBe(2);
  });

  test("image conflict is actionable and not retried", async () => {
    expect(
      isLazySandboxProvisionRetryable(new SandboxImageConflictError("group-1", "old", "new")),
    ).toBe(false);
    expect(isLazySandboxProvisionRetryable(new SandboxLeaseSupersededError("group-1", 1))).toBe(
      true,
    );
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

describe("sandbox file materialization note", () => {
  test("filters downloads already materialized on the current box", () => {
    const downloads = [
      {
        fileId: "file-1",
        mountPath: "files/file-1",
        filename: "one.txt",
        url: "https://example.com/1",
      },
      {
        fileId: "file-2",
        mountPath: "files/file-2",
        filename: "two.txt",
        url: "https://example.com/2",
      },
    ];

    expect(filterUnmaterializedSandboxFileDownloads(downloads, new Set(["file-1"]))).toEqual([
      downloads[1],
    ]);
    expect(filterUnmaterializedSandboxFileDownloads(downloads, new Set())).toBe(downloads);
  });

  test("appends unavailable attachment details to model-facing text", () => {
    const text = withUnavailableSandboxFilesNote(
      "Analyze the attachment",
      [
        "The following attached files could not be loaded into the sandbox and are unavailable this turn:",
        "- report.csv (Sandbox file resource download file-1 failed with exit code 2)",
        "Continue without them or tell the user.",
      ].join("\n"),
    );

    expect(text).toContain("Analyze the attachment");
    expect(text).toContain("report.csv");
    expect(text).toContain("failed with exit code 2");
    expect(text).toContain("Continue without them or tell the user.");
  });
});

describe("context window overflow classifier", () => {
  test("matches OpenAI/Azure context-window variants", () => {
    const byCode = Object.assign(new Error("Bad Request"), {
      code: "context_length_exceeded",
      status: 400,
    });
    expect(classifyContextWindowOverflowError(byCode)?.code).toBe("context_length_exceeded");

    expect(
      classifyContextWindowOverflowError(
        new Error("Your input exceeds the context window of this model"),
      )?.message,
    ).toContain("exceeds the context window");

    expect(
      classifyContextWindowOverflowError(
        new Error("This model's maximum context length is 128000 tokens"),
      )?.message,
    ).toContain("maximum context length");

    const nested = {
      status: 400,
      error: {
        code: "BadRequest",
        message: "The request failed because the input exceeds the context window.",
      },
    };
    expect(classifyContextWindowOverflowError(nested)?.detail).toContain(
      "exceeds the context window",
    );
  });

  test("does not match unrelated provider failures", () => {
    expect(classifyContextWindowOverflowError(new Error("Too Many Requests"))).toBeNull();
    expect(
      classifyContextWindowOverflowError(
        Object.assign(new Error("invalid tool call"), { status: 400 }),
      ),
    ).toBeNull();
    expect(
      classifyContextWindowOverflowError({ code: "rate_limit_exceeded", message: "rate limit" }),
    ).toBeNull();
  });
});

// The worker is the ONE place provider identity is authoritative, so it derives the
// EXPLICIT computer-use tool transport there instead of letting the runtime string-sniff
// the model instance's constructor name. This seam pins the provider→mode mapping.
describe("computerToolModeForTurn (explicit computer-use transport derivation)", () => {
  const resolved = (kind: RegistryProviderKind, api: ModelProviderApi) =>
    ({ provider: { kind, api } }) as Parameters<typeof computerToolModeForTurn>[0];

  test("codex-subscription → function-image (ChatGPT backend rejects hosted tools, SEES structured images)", () => {
    // api is irrelevant once kind is codex-subscription — codex wins.
    expect(computerToolModeForTurn(resolved("codex-subscription", "responses"))).toBe(
      "function-image",
    );
    expect(computerToolModeForTurn(resolved("codex-subscription", "chat"))).toBe("function-image");
  });

  test("a chat-wire (OpenAIChatCompletionsModel) provider → function-text", () => {
    expect(computerToolModeForTurn(resolved("api-key", "chat"))).toBe("function-text");
  });

  test("a registry responses provider → hosted", () => {
    expect(computerToolModeForTurn(resolved("api-key", "responses"))).toBe("hosted");
  });

  test("the LEGACY global-client fallback (resolveTurnModel → null) → hosted EXPLICITLY", () => {
    expect(computerToolModeForTurn(null)).toBe("hosted");
  });
});

describe("acceptsPromptCacheKeyForTurn", () => {
  const resolved = (kind: RegistryProviderKind, api: ModelProviderApi, builtin = false) =>
    ({ provider: { kind, api, builtin } }) as Parameters<typeof acceptsPromptCacheKeyForTurn>[0];

  test("accepts the legacy built-in OpenAI/Azure fallback", () => {
    expect(acceptsPromptCacheKeyForTurn(null)).toBe(true);
  });

  test("accepts built-in OpenAI/Azure providers and the codex backend", () => {
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "responses", true))).toBe(true);
    expect(acceptsPromptCacheKeyForTurn(resolved("codex-subscription", "responses"))).toBe(true);
  });

  test("excludes registry providers such as Fireworks or Z.AI/GLM", () => {
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "chat"))).toBe(false);
    expect(acceptsPromptCacheKeyForTurn(resolved("api-key", "responses"))).toBe(false);
  });
});

type RegistryProviderKind = "api-key" | "codex-subscription";
type ModelProviderApi = "responses" | "chat";
