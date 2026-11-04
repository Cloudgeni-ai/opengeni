import { expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  runAgentStream,
  normalizeSdkEvent,
  findCompactionNeededError,
  takeWithheldCompactionInput,
} from "../src/index";

test("compaction preserves completed parallel tool events for a delayed consumer", async () => {
  let executed = 0;
  const model = new ScriptedModel([
    { output: [functionCall("work", {}, "first"), functionCall("work", {}, "second")] },
  ]);
  const agent = new Agent({
    name: "fixture",
    model,
    tools: [
      tool({
        name: "work",
        description: "Count a side effect",
        strict: false,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          executed++;
          return "committed";
        },
      }),
    ],
  });
  let handover: unknown;
  const stream = await runAgentStream(agent, "run", testSettings({ sandboxBackend: "none" }), {
    contextCompactionRequested: () => executed === 2,
    onCompactionHandover: (error) => {
      handover = error;
    },
  });
  // Real worker event persistence can be slower than SDK tool completion.
  await stream.completed.catch(() => undefined);
  const events: ReturnType<typeof normalizeSdkEvent> = [];
  let error: unknown;
  try {
    for await (const event of stream) events.push(...normalizeSdkEvent(event));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeUndefined();
  expect(
    events.filter((e) => e.type === "agent.toolCall.output").map((e) => (e.payload as any).id),
  ).toEqual(["first", "second"]);
  expect(findCompactionNeededError(handover)?.trigger).toBe("operator");
  const withheld = takeWithheldCompactionInput(agent)!;
  expect(withheld.filter((item) => item.type === "function_call_result")).toHaveLength(2);
  expect(takeWithheldCompactionInput(agent)).toBeUndefined();
  expect(executed).toBe(2);
  expect(model.calls).toBe(1);
});
