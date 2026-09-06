import { describe, expect, test } from "bun:test";
import { MaxTurnsExceededError, tool } from "@openai/agents";
import { functionCall, ScriptedModel, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, InputWaitYield, runAgentStream } from "../src/index";

const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
const emptyParameters = { type: "object" as const, properties: {}, additionalProperties: false };

describe("accepted input wait terminal authority", () => {
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
          yieldState.recordSuccess();
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
          yieldState.recordSuccess();
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
    expect(model.calls).toBe(1);
    expect(executed).toBe(false);
    expect(stream.interruptions).toHaveLength(1);
    expect(stream.finalOutput).toBeUndefined();
    expect(JSON.stringify(stream.history)).toContain("wait accepted");
  });

  test("an aborted attempt cannot normalize its accepted wait into successful completion", () => {
    const yieldState = new InputWaitYield();
    yieldState.recordSuccess();
    const controller = new AbortController();
    controller.abort();
    const state = { _maxTurns: 1, _currentTurn: 2 };
    const error = new MaxTurnsExceededError("turn limit");
    Object.assign(error, { state });
    const handler = yieldState.runErrorHandlers(controller.signal).maxTurns!;
    expect(handler({ error, runData: { state } } as never)).toBeUndefined();
  });
});
