import { describe, expect, test } from "bun:test";
import {
  ComputerActionCommand,
  type ComputerActionCommand as Command,
  type ComputerTarget,
} from "@opengeni/contracts";
import {
  ComputerInteractionController,
  InteractionDefiniteDriverError,
  InteractionOutcomeUnknownDriverError,
} from "../src";

const computerSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const id = (sequence: number) => `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;
const target: ComputerTarget = {
  id: "screen-1",
  computerSessionId,
  controllerGeneration,
  targetGeneration: "target-1",
  kind: "screen",
  applicationId: null,
  processId: null,
  title: "Fixture screen",
  bounds: { x: 0, y: 0, width: 400, height: 300 },
  focused: true,
};
function click(sequence: number, first?: number): Command {
  return ComputerActionCommand.parse({
    protocolVersion: 1,
    operationId: id(sequence),
    computerSessionId,
    controllerGeneration,
    targetId: target.id,
    expectedTargetGeneration: target.targetGeneration,
    expectedObservationId: null,
    expectedFrameId: first ? "fresh-b" : "painted-a",
    actor: {
      kind: "human",
      subjectId: "human:fixture",
      sessionId: "33333333-3333-4333-8333-333333333333",
    },
    action: {
      type: "pointer",
      action: "click",
      clickCount: first ? 2 : 1,
      ...(first ? { continuationOfOperationId: id(first) } : {}),
      frameId: first ? "fresh-b" : "painted-a",
      x: 40,
      y: 60,
    },
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    dispatch?: (command: Command) => Promise<null>;
    authorizeDispatch?: (command: Command) => Promise<void>;
    onJournalRecord?: ConstructorParameters<
      typeof ComputerInteractionController
    >[0]["onJournalRecord"];
  } = {},
) {
  const calls: Command[] = [];
  const controller = new ComputerInteractionController({
    computerSessionId,
    controllerGeneration,
    ...(options.onJournalRecord ? { onJournalRecord: options.onJournalRecord } : {}),
    ...(options.authorizeDispatch
      ? { authority: { authorizeDispatch: options.authorizeDispatch } }
      : {}),
    driver: {
      target: async () => target,
      observe: async () => {
        throw new Error("unused fixture read");
      },
      dispatch: async (command) => {
        calls.push(command);
        return (await options.dispatch?.(command)) ?? null;
      },
    },
  });
  return { controller, calls };
}

describe("Computer click causal delivery", () => {
  test("a conflicting first-click retry cannot relabel a completed keyboard operation", async () => {
    const { controller, calls } = fixture();
    const keyboard = click(1);
    keyboard.expectedFrameId = null;
    keyboard.action = { type: "keyboard", action: "press", value: "Enter" };
    await controller.run(keyboard);
    expect(() => controller.run(click(1))).toThrow("operation id is already bound");
    expect((await controller.run(click(2, 1))).state).toBe("failed");
    expect(calls).toHaveLength(1);
  });
  test("queues a real second command behind registered first delivery and dedupes both operations", async () => {
    const entered = deferred();
    const finish = deferred();
    const { controller, calls } = fixture({
      dispatch: async (command) => {
        if (command.operationId === id(1)) {
          entered.resolve();
          await finish.promise;
        }
        return null;
      },
    });
    const first = controller.run(click(1));
    await entered.promise;
    const second = controller.run(click(2, 1));
    await Promise.resolve();
    expect(calls.map((command) => command.operationId)).toEqual([id(1)]);
    finish.resolve();
    const receipts = await Promise.all([first, second]);
    expect(receipts.map((receipt) => receipt.state)).toEqual(["completed", "completed"]);
    expect(calls.map((command) => command.operationId)).toEqual([id(1), id(2)]);
    expect(await controller.run(click(2, 1))).toEqual(receipts[1]);
    expect(await controller.run(click(1))).toEqual(receipts[0]);
    expect(calls).toHaveLength(2);
  });

  test("rejects a reordered second admission and never retries its failed operation", async () => {
    const { controller, calls } = fixture();
    const rejected = await controller.run(click(2, 1));
    expect(rejected.state).toBe("failed");
    expect(rejected.error?.code).toBe("invalid_action");
    expect((await controller.run(click(1))).state).toBe("completed");
    expect(await controller.run(click(2, 1))).toEqual(rejected);
    expect(calls).toHaveLength(1);
  });

  test.each(["failed", "outcome_unknown", "durable outcome_unknown"] as const)(
    "rejects fresh-frame continuation after first %s",
    async (outcome) => {
      const { controller, calls } = fixture({
        dispatch: async (command) => {
          if (command.operationId !== id(1) || outcome === "durable outcome_unknown") return null;
          if (outcome === "failed")
            throw new InteractionDefiniteDriverError("driver_failed", "Synthetic refusal");
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            "Synthetic unknown delivery",
          );
        },
        onJournalRecord: async (record) => {
          if (outcome === "durable outcome_unknown" && record.receipt.state === "completed")
            throw new Error("Synthetic journal refusal");
        },
      });
      expect((await controller.run(click(1))).state).toBe(
        outcome === "failed" ? "failed" : "outcome_unknown",
      );
      const second = await controller.run(click(2, 1));
      expect(second.state).toBe("failed");
      expect(second.error?.code).toBe("invalid_action");
      expect(calls).toHaveLength(1);
    },
  );

  test.each(["keyboard", "semantic", "count2"] as const)(
    "does not accept completed %s as a first click",
    async (type) => {
      const { controller, calls } = fixture();
      const first = click(1);
      if (type === "keyboard") {
        first.expectedFrameId = null;
        first.action = { type: "keyboard", action: "press", value: "Enter" };
      }
      if (type === "semantic") {
        first.expectedFrameId = null;
        first.action = {
          type: "semantic",
          action: "invoke",
          locator: { kind: "identifier", value: "fixture.button" },
        };
      }
      if (type === "count2") {
        await controller.run(click(3));
        first.action = { ...click(1, 3).action };
        first.expectedFrameId = "fresh-b";
      }
      expect((await controller.run(first)).state).toBe("completed");
      expect((await controller.run(click(2, 1))).state).toBe("failed");
      expect(calls).toHaveLength(type === "count2" ? 2 : 1);
    },
  );

  test.each([
    "actor",
    "source session",
    "execution generation",
    "target generation",
    "target",
  ] as const)("requires matching first %s", async (boundary) => {
    const { controller, calls } = fixture();
    const first = click(1);
    if (boundary === "execution generation")
      first.actor = {
        ...first.actor,
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      };
    await controller.run(first);
    const second = click(2, 1);
    if (boundary === "actor") second.actor.subjectId = "human:other";
    if (boundary === "source session")
      second.actor.sessionId = "66666666-6666-4666-8666-666666666666";
    if (boundary === "execution generation")
      second.actor = { ...first.actor, executionGeneration: 2 };
    if (boundary === "target generation") second.expectedTargetGeneration = "target-2";
    if (boundary === "target") second.targetId = "screen-2";
    expect((await controller.run(second)).state).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  test("rechecks current source authorization before a queued second command", async () => {
    const entered = deferred();
    const finish = deferred();
    let allowed = true;
    const { controller, calls } = fixture({
      authorizeDispatch: async () => {
        if (!allowed)
          throw new InteractionDefiniteDriverError("permission_denied", "Synthetic revoked source");
      },
      dispatch: async () => {
        entered.resolve();
        await finish.promise;
        return null;
      },
    });
    const first = controller.run(click(1));
    await entered.promise;
    const second = controller.run(click(2, 1));
    allowed = false;
    finish.resolve();
    expect((await first).state).toBe("completed");
    expect((await second).state).toBe("failed");
    expect(calls).toHaveLength(1);
  });
});
