import { describe, expect, test } from "bun:test";
import {
  ComputerAction,
  ComputerActionCommand,
  ComputerLocator,
  type ComputerActionCommand as ComputerActionCommandValue,
  type ComputerActionReceipt,
  type ComputerObservation,
  type ComputerTarget,
} from "@opengeni/contracts";
import {
  ComputerInteractionController,
  InteractionControllerError,
  recoverComputerOperationJournalRecord,
  type ComputerInteractionDriver,
} from "../src";

const computerSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const observedAt = "2026-08-10T12:00:00.000Z";

function operationId(sequence: number): string {
  return `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;
}

function target(id = "window:42", targetGeneration = "launch-1:window-1"): ComputerTarget {
  return {
    id,
    computerSessionId,
    controllerGeneration,
    targetGeneration,
    kind: "window",
    applicationId: "org.example.fixture",
    processId: id === "window:42" ? 42 : 43,
    title: `Fixture ${id}`,
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    focused: id === "window:42",
  };
}

function observation(
  currentTarget: ComputerTarget,
  observationId = "observation-1",
  frameId = "frame-1",
): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId,
    computerSessionId,
    target: currentTarget,
    frameId,
    semantic: {
      kind: "snapshot",
      roots: [
        {
          ref: "e1",
          role: "button",
          identifier: "fixture.submit",
          name: "Submit",
          states: ["enabled"],
          actions: ["invoke", "focus"],
          native: { platform: "at_spi", data: { interface: "Action" } },
        },
      ],
      nodeCount: 1,
    },
    screenshot: null,
    focusedRef: "e1",
    changedRegions: [],
    observedAt,
  };
}

function command(
  sequence: number,
  targetId = "window:42",
  targetGeneration = "launch-1:window-1",
): ComputerActionCommandValue {
  return {
    protocolVersion: 1,
    operationId: operationId(sequence),
    computerSessionId,
    controllerGeneration,
    targetId,
    expectedTargetGeneration: targetGeneration,
    expectedObservationId: "observation-1",
    expectedFrameId: null,
    actor: {
      kind: "agent",
      subjectId: "agent:fixture",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    action: {
      type: "semantic",
      locator: { kind: "ref", ref: "e1" },
      action: "invoke",
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function driver(
  targets: Map<string, ComputerTarget>,
  dispatch: ComputerInteractionDriver["dispatch"],
  validate?: ComputerInteractionDriver["validate"],
): ComputerInteractionDriver {
  return {
    async target(targetId) {
      return targets.get(targetId) ?? null;
    },
    async observe(targetId) {
      const current = targets.get(targetId);
      if (!current) throw new Error("missing fixture target");
      return observation(current);
    },
    ...(validate ? { validate } : {}),
    dispatch,
  };
}

describe("Computer interaction contracts", () => {
  test("keeps native locators separate from web-only selectors", () => {
    expect(ComputerLocator.safeParse({ kind: "identifier", value: "submit-button" }).success).toBe(
      true,
    );
    expect(ComputerLocator.safeParse({ kind: "css", selector: "#submit" }).success).toBe(false);
    expect(
      ComputerAction.safeParse({
        type: "semantic",
        locator: { kind: "ref", ref: "e1" },
        action: "set_value",
      }).success,
    ).toBe(false);
  });

  test("requires exact observation/frame fences for ref and pointer actions", () => {
    expect(
      ComputerActionCommand.safeParse({
        ...command(1),
        expectedObservationId: null,
      }).success,
    ).toBe(false);
    expect(
      ComputerActionCommand.safeParse({
        ...command(1),
        expectedObservationId: null,
        expectedFrameId: "frame-2",
        action: {
          type: "pointer",
          frameId: "frame-1",
          action: "click",
          x: 10,
          y: 20,
        },
      }).success,
    ).toBe(false);
  });
});

describe("ComputerInteractionController", () => {
  test("uses the shared idempotent journal and target-local queues", async () => {
    const targets = new Map([
      ["window:42", target()],
      ["window:43", target("window:43")],
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
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver: driver(targets, async (current) => {
        calls.push(current.operationId);
        starts.get(current.operationId)!.resolve();
        await releases.get(current.operationId)!.promise;
        return observation(targets.get(current.targetId)!);
      }),
    });

    const first = controller.run(command(1));
    expect(controller.run(command(1))).toBe(first);
    const sameTarget = controller.run(command(2));
    const otherTarget = controller.run(command(3, "window:43"));
    await Promise.all([starts.get(operationId(1))!.promise, starts.get(operationId(3))!.promise]);
    expect(calls).toEqual([operationId(1), operationId(3)]);

    releases.get(operationId(3))!.resolve();
    await otherTarget;
    releases.get(operationId(1))!.resolve();
    await starts.get(operationId(2))!.promise;
    releases.get(operationId(2))!.resolve();
    expect((await first).state).toBe("completed");
    expect((await sameTarget).state).toBe("completed");
  });

  test("revalidates attempt, target, and adapter state immediately before dispatch", async () => {
    const targets = new Map([["window:42", target()]]);
    let currentObservationId = "observation-1";
    let dispatches = 0;
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver: driver(
        targets,
        async () => {
          dispatches += 1;
          return observation(targets.get("window:42")!);
        },
        (current) => {
          if (current.expectedObservationId !== currentObservationId) {
            throw new InteractionControllerError("frame_stale", "native observation changed");
          }
        },
      ),
    });

    currentObservationId = "observation-2";
    const receipt = await controller.run(command(1));
    expect(receipt).toMatchObject({
      state: "failed",
      dispatchedAt: null,
      error: { code: "frame_stale" },
    });
    expect(dispatches).toBe(0);
  });

  test("never replays an ambiguous native side effect and recovers journals conservatively", async () => {
    const targets = new Map([["window:42", target()]]);
    let sideEffects = 0;
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver: driver(targets, async () => {
        sideEffects += 1;
        throw new Error("AX call completed while the adapter disconnected");
      }),
    });

    const receipt = await controller.run(command(1));
    expect(receipt).toMatchObject({
      state: "outcome_unknown",
      error: { code: "controller_lost", retryable: false },
    });
    expect(await controller.run(command(1))).toEqual(receipt);
    expect(sideEffects).toBe(1);

    const interrupted: ComputerActionReceipt = {
      ...receipt,
      operationId: operationId(2),
      state: "dispatched",
      dispatchedAt: observedAt,
      settledAt: null,
      observation: null,
      error: null,
    };
    expect(
      recoverComputerOperationJournalRecord(
        {
          operationId: operationId(2),
          commandDigest: "digest",
          receipt: interrupted,
        },
        "2026-08-10T12:01:00.000Z",
      ).receipt,
    ).toMatchObject({
      state: "outcome_unknown",
      error: { code: "controller_lost", retryable: false },
    });
  });
});
