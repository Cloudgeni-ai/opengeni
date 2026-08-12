import { describe, expect, test } from "bun:test";
import type {
  BrowserActionCommand,
  BrowserActionReceipt,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  BrowserTarget,
} from "@opengeni/contracts";
import {
  BrowserInteractionController,
  BrowserProtectedAuthController,
  InteractionControllerError,
  type BrowserInteractionDriver,
} from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const observedAt = "2026-08-09T12:00:00.000Z";

function operationId(sequence: number): string {
  return `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;
}

function target(id = "target-1", documentGeneration = "document-1"): BrowserTarget {
  return {
    id,
    browserSessionId,
    controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration,
    kind: "page",
    title: "Fixture",
    url: `https://${id}.test/`,
    selected: id === "target-1",
    attached: true,
    createdAt: observedAt,
  };
}

function observation(currentTarget: BrowserTarget, sequence = 1): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: `observation-${sequence}`,
    browserSessionId,
    target: currentTarget,
    frameId: "frame-1",
    semantic: {
      kind: "snapshot",
      roots: [],
      nodeCount: 0,
    },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt,
  };
}

function command(
  sequence: number,
  targetId = "target-1",
  documentGeneration = "document-1",
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: operationId(sequence),
    browserSessionId,
    controllerGeneration,
    targetId,
    expectedTargetGeneration: "target-1",
    expectedDocumentGeneration: documentGeneration,
    expectedFrameId: "frame-1",
    actor: {
      kind: "agent",
      subjectId: "agent:fixture",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    action: { type: "click", locator: { kind: "ref", ref: "e1" } },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function driver(
  targets: Map<string, BrowserTarget>,
  dispatch: BrowserInteractionDriver["dispatch"],
  observeOverride?: BrowserInteractionDriver["observe"],
): BrowserInteractionDriver {
  return {
    async target(targetId) {
      return targets.get(targetId) ?? null;
    },
    observe:
      observeOverride ??
      (async (targetId) => {
        const current = targets.get(targetId);
        if (!current) throw new Error("missing fixture target");
        return observation(current);
      }),
    dispatch,
  };
}

describe("BrowserInteractionController", () => {
  test("deduplicates concurrent operation ids and rejects conflicting reuse", async () => {
    const targets = new Map([["target-1", target()]]);
    const started = deferred();
    const release = deferred();
    let dispatchCount = 0;
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver: driver(targets, async () => {
        dispatchCount += 1;
        started.resolve();
        await release.promise;
        return observation(targets.get("target-1")!);
      }),
    });

    const first = controller.run(command(1));
    const duplicate = controller.run(command(1));
    expect(first).toBe(duplicate);
    await started.promise;
    expect(dispatchCount).toBe(1);
    expect(() =>
      controller.run({
        ...command(1),
        action: { type: "navigate", url: "https://different.test/" },
      }),
    ).toThrow(InteractionControllerError);

    release.resolve();
    expect((await first).state).toBe("completed");
    expect((await duplicate).state).toBe("completed");
    expect(dispatchCount).toBe(1);
  });

  test("serializes mutations per target while different targets run concurrently", async () => {
    const targets = new Map([
      ["target-1", target("target-1")],
      ["target-2", target("target-2")],
    ]);
    const releases = new Map([
      [operationId(1), deferred()],
      [operationId(2), deferred()],
      [operationId(3), deferred()],
    ]);
    const starts = new Map([
      [operationId(1), deferred()],
      [operationId(2), deferred()],
      [operationId(3), deferred()],
    ]);
    const calls: string[] = [];
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver: driver(targets, async (current) => {
        calls.push(current.operationId);
        starts.get(current.operationId)!.resolve();
        await releases.get(current.operationId)!.promise;
        return observation(targets.get(current.targetId)!, calls.length);
      }),
    });

    const first = controller.run(command(1));
    const sameTarget = controller.run(command(2));
    const otherTarget = controller.run(command(3, "target-2"));
    await Promise.all([starts.get(operationId(1))!.promise, starts.get(operationId(3))!.promise]);
    expect(calls).toEqual([operationId(1), operationId(3)]);

    releases.get(operationId(3))!.resolve();
    await otherTarget;
    expect(calls).not.toContain(operationId(2));
    releases.get(operationId(1))!.resolve();
    await starts.get(operationId(2))!.promise;
    expect(calls).toEqual([operationId(1), operationId(3), operationId(2)]);
    releases.get(operationId(2))!.resolve();
    expect((await first).state).toBe("completed");
    expect((await sameTarget).state).toBe("completed");
  });

  test("revalidates target and attempt authority immediately before queued dispatch", async () => {
    const targets = new Map([["target-1", target()]]);
    const firstStarted = deferred();
    const firstRelease = deferred();
    let authorityCurrent = true;
    const calls: string[] = [];
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      authority: {
        authorizeDispatch() {
          if (!authorityCurrent) {
            throw new InteractionControllerError(
              "attempt_stale",
              "attempt no longer has execution authority",
            );
          }
        },
      },
      driver: driver(targets, async (current) => {
        calls.push(current.operationId);
        firstStarted.resolve();
        await firstRelease.promise;
        return observation(targets.get(current.targetId)!);
      }),
    });

    const first = controller.run(command(1));
    const queued = controller.run(command(2));
    await firstStarted.promise;
    authorityCurrent = false;
    targets.set("target-1", target("target-1", "document-2"));
    firstRelease.resolve();

    expect((await first).state).toBe("completed");
    const queuedReceipt = await queued;
    expect(queuedReceipt.state).toBe("failed");
    expect(queuedReceipt.error?.code).toBe("attempt_stale");
    expect(calls).toEqual([operationId(1)]);
  });

  test("rejects a queued command when its document generation changes", async () => {
    const targets = new Map([["target-1", target()]]);
    const firstStarted = deferred();
    const firstRelease = deferred();
    const calls: string[] = [];
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver: driver(targets, async (current) => {
        calls.push(current.operationId);
        if (current.operationId === operationId(1)) {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        return observation(targets.get(current.targetId)!);
      }),
    });

    const first = controller.run(command(1));
    const queued = controller.run(command(2));
    await firstStarted.promise;
    targets.set("target-1", target("target-1", "document-2"));
    firstRelease.resolve();

    expect((await first).state).toBe("completed");
    const queuedReceipt = await queued;
    expect(queuedReceipt.state).toBe("failed");
    expect(queuedReceipt.error?.code).toBe("document_stale");
    expect(calls).toEqual([operationId(1)]);
  });

  test("reports an ambiguous post-dispatch failure once and never blindly replays it", async () => {
    const targets = new Map([["target-1", target()]]);
    let sideEffects = 0;
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver: driver(targets, async () => {
        sideEffects += 1;
        throw new Error("connection disappeared after click");
      }),
    });

    const first = await controller.run(command(1));
    const retry = await controller.run(command(1));
    expect(first.state).toBe("outcome_unknown");
    expect(first.error?.code).toBe("controller_lost");
    expect(retry).toEqual(first);
    expect(sideEffects).toBe(1);
  });

  test("durably journals preparation and dispatch before invoking the driver", async () => {
    const targets = new Map([["target-1", target()]]);
    const preparedRelease = deferred();
    const dispatchedRelease = deferred();
    const states: BrowserActionReceipt["state"][] = [];
    let dispatchCount = 0;
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      onJournalRecord: async ({ receipt }) => {
        states.push(receipt.state);
        if (receipt.state === "prepared") await preparedRelease.promise;
        if (receipt.state === "dispatched") await dispatchedRelease.promise;
      },
      driver: driver(targets, async () => {
        dispatchCount += 1;
        return observation(targets.get("target-1")!);
      }),
    });

    const completion = controller.run(command(1));
    await Promise.resolve();
    expect(states).toEqual(["prepared"]);
    expect(dispatchCount).toBe(0);
    preparedRelease.resolve();
    while (!states.includes("dispatched")) await Promise.resolve();
    expect(dispatchCount).toBe(0);
    dispatchedRelease.resolve();

    expect((await completion).state).toBe("completed");
    expect(states).toEqual(["prepared", "dispatched", "completed"]);
    expect(dispatchCount).toBe(1);
  });

  test("does not dispatch when the operation journal rejects preparation", async () => {
    const targets = new Map([["target-1", target()]]);
    let dispatchCount = 0;
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      onJournalRecord({ receipt }) {
        if (receipt.state === "prepared") throw new Error("disk unavailable");
      },
      driver: driver(targets, async () => {
        dispatchCount += 1;
        return observation(targets.get("target-1")!);
      }),
    });

    const receipt = await controller.run(command(1));
    expect(receipt.state).toBe("failed");
    expect(receipt.dispatchedAt).toBeNull();
    expect(receipt.error?.retryable).toBe(true);
    expect(dispatchCount).toBe(0);
  });

  test("downgrades an unrecordable completion to outcome unknown", async () => {
    const targets = new Map([["target-1", target()]]);
    const states: BrowserActionReceipt["state"][] = [];
    let dispatchCount = 0;
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      onJournalRecord({ receipt }) {
        states.push(receipt.state);
        if (receipt.state === "completed") throw new Error("journal unavailable");
      },
      driver: driver(targets, async () => {
        dispatchCount += 1;
        return observation(targets.get("target-1")!);
      }),
    });

    const receipt = await controller.run(command(1));
    expect(receipt.state).toBe("outcome_unknown");
    expect(states).toEqual(["prepared", "dispatched", "completed", "outcome_unknown"]);
    expect(dispatchCount).toBe(1);
    expect((await controller.run(command(1))).state).toBe("outcome_unknown");
    expect(dispatchCount).toBe(1);
  });

  test("recovers nonterminal journal records conservatively after restart", () => {
    const baseReceipt = {
      protocolVersion: 1 as const,
      browserSessionId,
      controllerGeneration,
      targetId: "target-1",
      dispatchedAt: null,
      settledAt: null,
      observation: null,
      error: null,
    };
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      initialJournal: [
        {
          operationId: operationId(1),
          commandDigest: "digest-1",
          receipt: { ...baseReceipt, operationId: operationId(1), state: "prepared" },
        },
        {
          operationId: operationId(2),
          commandDigest: "digest-2",
          receipt: {
            ...baseReceipt,
            operationId: operationId(2),
            state: "dispatched",
            dispatchedAt: observedAt,
          },
        },
      ],
      driver: driver(new Map([["target-1", target()]]), async () => {
        throw new Error("must not dispatch during recovery");
      }),
    });

    expect(controller.receipt(operationId(1))).toMatchObject({
      state: "failed",
      error: { code: "controller_lost", retryable: true },
    });
    expect(controller.receipt(operationId(2))).toMatchObject({
      state: "outcome_unknown",
      error: { code: "controller_lost", retryable: false },
    });
  });

  test("rejects observations outside the controller's resource authority", async () => {
    const targets = new Map([["target-1", target()]]);
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver: driver(
        targets,
        async () => observation(targets.get("target-1")!),
        async () => ({
          ...observation(targets.get("target-1")!),
          browserSessionId: "99999999-9999-4999-8999-999999999999",
        }),
      ),
    });

    await expect(controller.observe("target-1")).rejects.toMatchObject({
      code: "driver_failed",
    });
  });
});

function protectedCommand(value: string): BrowserProtectedAuthFillCommand {
  const base = command(20);
  return {
    protocolVersion: 1,
    operationId: base.operationId,
    browserSessionId,
    controllerGeneration,
    targetId: base.targetId,
    expectedTargetGeneration: base.expectedTargetGeneration,
    expectedDocumentGeneration: "document-1",
    expectedFrameId: "frame-1",
    actor: base.actor,
    authorityId: "password-authority",
    credentialVersion: 7,
    allowedOrigins: ["https://target-1.test"],
    fields: [
      {
        fieldId: "password",
        locator: { kind: "ref", ref: "e-password" },
        purpose: "password",
        value,
      },
    ],
    submit: { type: "press", key: "Enter" },
  };
}

describe("BrowserProtectedAuthController", () => {
  test("journals a secret-free digest and deduplicates retries without comparing value bytes", async () => {
    const records: unknown[] = [];
    let dispatchCount = 0;
    const currentTarget = target();
    const controller = new BrowserProtectedAuthController({
      browserSessionId,
      controllerGeneration,
      onJournalRecord(record) {
        records.push(record);
      },
      driver: {
        async target(targetId) {
          return targetId === currentTarget.id ? currentTarget : null;
        },
        async observe() {
          return { target: currentTarget, status: "working" };
        },
        async dispatch() {
          dispatchCount += 1;
          return { target: currentTarget, status: "submitted" };
        },
      },
    });

    const first = await controller.run(protectedCommand("correct horse battery staple"));
    const retry = await controller.run(protectedCommand("different one-time value"));
    expect(first.state).toBe("completed");
    expect(retry).toEqual(first);
    expect(dispatchCount).toBe(1);
    expect(JSON.stringify(records)).not.toContain("correct horse battery staple");
    expect(JSON.stringify(records)).not.toContain("different one-time value");
    expect(controller.journalSnapshot()[0]?.commandDigest).toMatch(/^[0-9a-f]{64}$/u);

    expect(() =>
      controller.run({
        ...protectedCommand("correct horse battery staple"),
        fields: [
          {
            ...protectedCommand("unused").fields[0]!,
            locator: { kind: "ref", ref: "another-field" },
          },
        ],
      }),
    ).toThrow(InteractionControllerError);
  });
});
