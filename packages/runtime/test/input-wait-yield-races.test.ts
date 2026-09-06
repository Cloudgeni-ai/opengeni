import { describe, expect, test } from "bun:test";
import { MaxTurnsExceededError, tool } from "@openai/agents";
import { functionCall, ScriptedModel, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, InputWaitYield, runAgentStream } from "../src/index";

const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
const emptyParameters = { type: "object" as const, properties: {}, additionalProperties: false };

describe("accepted input wait terminal authority", () => {
  for (const acceptFirst of [false, true]) {
    test(`wait success concurrent with dispatch-drain abort retains cancellation barrier (acceptFirst=${acceptFirst})`, async () => {
      const gate = new InputWaitYield();
      const cancellation = new AbortController();
      const binding = gate.beginStream(cancellation.signal);
      const complete = gate.beginWait();
      const dispatch = binding.modelDispatchFilter({ modelData: {} } as never);
      if (acceptFirst) complete(true);
      cancellation.abort(new Error("attempt cancelled"));
      if (!acceptFirst) complete(true);
      await expect(Promise.resolve(dispatch)).rejects.toBe(cancellation.signal.reason);
      expect(gate.requested).toBe(true);
      expect(gate.yielded).toBe(false);
      expect(() => gate.beginWait()).toThrow("sealed");
    });
  }

  test("stale stream callbacks cannot close or reopen a recovery successor", async () => {
    const gate = new InputWaitYield();
    const first = gate.beginStream();
    const staleClose = gate.captureStreamClose();
    const staleToolStart = gate.beginToolExecution;
    await first.modelDispatchFilter({ modelData: {} } as never);
    staleClose();
    expect(() => gate.beginStream()).toThrow("still active");
    first.endStream();
    const second = gate.beginStream();
    first.endStream();
    first.endStream(true);
    staleClose();
    const receipt = gate.beginWait();
    receipt(false); // stale end callbacks did not close the successor
    await second.modelDispatchFilter({ modelData: {} } as never);
    first.beginToolExecution();
    staleToolStart();
    expect(() => gate.beginWait()).toThrow("sealed");
    expect(() => first.modelInputFilter({ modelData: {} } as never)).toThrow("superseded");
    await expect(
      Promise.resolve(first.modelDispatchFilter({ modelData: {} } as never)),
    ).rejects.toThrow("superseded");
    await expect((first.toolUseBehavior as () => Promise<unknown>)()).rejects.toThrow("superseded");
    second.beginToolExecution();
    gate.beginWait()(false);
    expect(gate.yielded).toBe(false);
    gate.closeAdmission();
    second.beginToolExecution();
    expect(() => gate.beginWait()).toThrow("sealed");
    expect(() => gate.beginStream()).toThrow("terminal");
  });

  test("an obsolete asynchronous tool drain cannot latch a successor yield", async () => {
    const gate = new InputWaitYield();
    const first = gate.beginStream();
    const complete = gate.beginWait();
    const oldDrain = (first.toolUseBehavior as () => Promise<unknown>)();
    first.endStream();
    const second = gate.beginStream();
    complete(true);
    await expect(oldDrain).rejects.toThrow("superseded");
    expect(gate.requested).toBe(true);
    expect(gate.yielded).toBe(false);
    await expect(
      Promise.resolve(second.modelDispatchFilter({ modelData: {} } as never)),
    ).rejects.toBeInstanceOf(MaxTurnsExceededError);
    expect(gate.yielded).toBe(false);
  });

  test("overlapping SDK streams cannot obtain a new generation", () => {
    const gate = new InputWaitYield();
    const first = gate.beginStream();
    expect(() => gate.beginStream()).toThrow("still active");
    first.endStream();
    gate.beginStream();
    gate.closeAdmission();
    expect(() => gate.beginStream()).toThrow("terminal");
  });

  test("a cancelled stream never grants same-attempt retry authority", () => {
    const gate = new InputWaitYield();
    const cancellation = new AbortController();
    const first = gate.beginStream(cancellation.signal);
    cancellation.abort(new Error("attempt cancelled"));
    first.endStream();
    expect(() => gate.beginStream()).toThrow("attempt cancelled");
    expect(() => gate.beginWait()).toThrow("sealed");
  });

  test("a sibling execution failure remains a failure after wait acceptance", async () => {
    const yieldState = new InputWaitYield();
    const failure = new Error("sibling execution failed");
    const model = new ScriptedModel([
      { output: [functionCall("wait", {}, "wait"), functionCall("sibling", {}, "sibling")] },
      { error: new Error("must not reach another inference") },
    ]);
    const agent = buildOpenGeniAgent(settings, [], { model, inputWaitYield: yieldState });
    agent.tools.push(
      tool({
        name: "wait",
        parameters: emptyParameters,
        strict: false,
        execute: () => {
          yieldState.beginWait()(true);
          return "wait accepted";
        },
      }),
      tool({
        name: "sibling",
        parameters: emptyParameters,
        strict: false,
        errorFunction: null,
        execute: () => {
          throw failure;
        },
      }),
    );
    const stream = await runAgentStream(agent, "wait", settings);
    await expect(
      (async () => {
        for await (const _event of stream) {
          /* consume the real SDK stream */
        }
        await stream.completed;
      })(),
    ).rejects.toThrow("sibling execution failed");
    expect(yieldState.requested).toBe(true);
    expect(yieldState.yielded).toBe(false);
    expect(model.calls).toBe(1);
    expect(stream.error).not.toBeNull();
  });

  test("parallel approval remains an interruption rather than normal wait completion", async () => {
    const yieldState = new InputWaitYield();
    const model = new ScriptedModel([
      { output: [functionCall("wait", {}, "wait"), functionCall("approval", {}, "approval")] },
      { error: new Error("must not reach another inference") },
    ]);
    const agent = buildOpenGeniAgent(settings, [], { model, inputWaitYield: yieldState });
    let executed = false;
    agent.tools.push(
      tool({
        name: "wait",
        parameters: emptyParameters,
        strict: false,
        execute: () => {
          yieldState.beginWait()(true);
          return "wait accepted";
        },
      }),
      tool({
        name: "approval",
        parameters: emptyParameters,
        strict: false,
        needsApproval: true,
        execute: () => {
          executed = true;
          return "approved";
        },
      }),
    );
    const stream = await runAgentStream(agent, "wait", settings);
    for await (const _event of stream) {
      /* consume the real SDK stream */
    }
    await stream.completed;
    expect(yieldState.requested).toBe(true);
    expect(yieldState.yielded).toBe(false);
    expect(model.calls).toBe(1);
    expect(executed).toBe(false);
    expect(stream.interruptions).toHaveLength(1);
    expect(stream.finalOutput).toBeUndefined();
    expect(JSON.stringify(stream.history)).toContain("wait accepted");
  });

  test("an aborted attempt cannot normalize its accepted wait into successful completion", async () => {
    const yieldState = new InputWaitYield();
    yieldState.beginWait()(true);
    const controller = new AbortController();
    controller.abort();
    const state = { _maxTurns: 1, _currentTurn: 2 };
    const error = new MaxTurnsExceededError("turn limit");
    Object.assign(error, { state });
    const handler = yieldState.runErrorHandlers(controller.signal).maxTurns!;
    expect(await handler({ error, runData: { state } } as never)).toBeUndefined();
    expect(yieldState.yielded).toBe(false);
  });

  test("settlement drains reservations without claiming yield and cannot reopen", async () => {
    const gate = new InputWaitYield();
    const complete = gate.beginWait();
    let settled = false;
    const settlement = gate.sealForSettlement().then(() => {
      settled = true;
    });
    expect(() => gate.beginWait()).toThrow("sealed");
    gate.beginToolExecution();
    expect(() => gate.beginWait()).toThrow("sealed");
    await Promise.resolve();
    expect(settled).toBe(false);
    complete(true);
    await settlement;
    expect(gate.requested).toBe(true);
    expect(gate.yielded).toBe(false);
    expect(() => gate.beginWait()).toThrow("sealed");
  });

  test("a real SDK cap joins pending wait success before selecting yield", async () => {
    const gate = new InputWaitYield();
    const complete = gate.beginWait();
    const state = { _maxTurns: 1, _currentTurn: 2 };
    const error = new MaxTurnsExceededError("turn limit");
    Object.assign(error, { state });
    const handled = gate.runErrorHandlers().maxTurns!({ error, runData: { state } } as never);
    expect(gate.yielded).toBe(false);
    expect(() => gate.beginWait()).toThrow("sealed");
    complete(true);
    expect(await handled).toEqual({ finalOutput: "", includeInHistory: false });
    expect(gate.yielded).toBe(true);
  });

  test("settlement racing the pending dispatch drain cannot permit dispatch", async () => {
    const gate = new InputWaitYield();
    const complete = gate.beginWait();
    const dispatch = gate.modelDispatchFilter({ modelData: {} } as never);
    const settled = gate.sealForSettlement();
    complete(false);
    await expect(Promise.resolve(dispatch)).rejects.toThrow("gate is settled");
    await settled;
    expect(gate.yielded).toBe(false);
  });

  for (const boundary of ["settlement", "dispatch", "tools", "cap"] as const) {
    test(`cancellation releases a hanging ${boundary} drain without reopening admission`, async () => {
      const gate = new InputWaitYield();
      const cancellation = new AbortController();
      const handlers = gate.runErrorHandlers(cancellation.signal);
      const complete = gate.beginWait();
      const state = { _maxTurns: 1, _currentTurn: 2 };
      const error = new MaxTurnsExceededError("turn limit");
      Object.assign(error, { state });
      const pending =
        boundary === "settlement"
          ? gate.sealForSettlement(cancellation.signal)
          : boundary === "dispatch"
            ? gate.modelDispatchFilter({ modelData: {} } as never)
            : boundary === "tools"
              ? (gate.toolUseBehavior as () => unknown)()
              : handlers.maxTurns!({ error, runData: { state } } as never);
      cancellation.abort(new Error("attempt cancelled"));
      if (boundary === "tools") {
        expect(await pending).toEqual({ isFinalOutput: false, isInterrupted: undefined });
      } else if (boundary === "cap") {
        expect(await pending).toBeUndefined();
      } else {
        await expect(Promise.resolve(pending)).rejects.toThrow("attempt cancelled");
      }
      expect(gate.yielded).toBe(false);
      // Remote completion is allowed to report truth, never to reopen admission
      // or retroactively select a successful terminal result after cancellation.
      complete(true);
      gate.beginToolExecution();
      expect(gate.requested).toBe(true);
      expect(gate.yielded).toBe(false);
      expect(() => gate.beginWait()).toThrow("sealed");
    });
  }
});
