import { expect, test } from "bun:test";
import { Agent, Runner, tool } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing/scripted-model";
import {
  createModelCallAdmission,
  responseSettlementOverlaps,
  settlesAlongsideResponseItems,
} from "../src/activities/agent-turn/model-call-admission";
import { pendingToolCallFromSdkEvent } from "../src/activities/agent-turn/history";

function harness() {
  const controller = new AbortController();
  const admission = createModelCallAdmission({
    signal: controller.signal,
    admit: async () => undefined,
  });
  const executed: string[] = [];
  const agent = new Agent({
    name: "tool-durability",
    model: new ScriptedModel([
      { output: [functionCall("local", {}, "call-a"), functionCall("local", {}, "call-b")] },
      { output: [assistantMessage("done")] },
    ]),
    tools: [
      tool({
        name: "local",
        description: "Offline fixture",
        parameters: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
        strict: false,
        execute: async (_input: unknown, _context: unknown, details: unknown) => {
          executed.push((details as { toolCall: { callId: string } }).toolCall.callId);
          return "ok";
        },
      }),
    ],
  });
  const run = () =>
    new Runner({ tracingDisabled: true }).run(agent, "test", {
      stream: true,
      beforeToolExecution: ({ items }) =>
        admission.awaitToolCallsDurable(
          items.flatMap((item) => {
            const call = pendingToolCallFromSdkEvent({ type: "run_item_stream_event", item });
            return call ? [call.callId] : [];
          }),
        ),
    });
  return { admission, executed, run, controller };
}

test("no tool of a response runs before every call of that response is durable", async () => {
  const { admission, executed, run } = harness();
  const stream = await run();
  const iterator = stream.toStream()[Symbol.asyncIterator]();
  const seen: string[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const call = pendingToolCallFromSdkEvent(next.value);
    if (!call) continue;
    seen.push(call.callId);
    // Let the producer run as far as it can before this call is durable.
    await Bun.sleep(20);
    expect(executed).toEqual([]);
    admission.toolCallDurable(call.callId);
  }
  await stream.completed;
  expect(seen).toEqual(["call-a", "call-b"]);
  expect(executed.sort()).toEqual(["call-a", "call-b"]);
  admission.close();
});

test("a consumer failure before a call is durable fails the run without running any tool", async () => {
  const { admission, executed, run } = harness();
  const stream = await run();
  void stream.completed.catch(() => undefined);
  const iterator = stream.toStream()[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    if (pendingToolCallFromSdkEvent(next.value)) {
      admission.fail(new Error("event append fenced"));
      break;
    }
  }
  await expect(stream.completed).rejects.toThrow("event append fenced");
  expect(executed).toEqual([]);
});

test("durability may be reported before the producer asks, and a closed consumer releases a waiting producer", async () => {
  const controller = new AbortController();
  const admission = createModelCallAdmission({
    signal: controller.signal,
    admit: async () => undefined,
  });
  admission.toolCallDurable("early");
  await admission.awaitToolCallsDurable(["early"]);
  await admission.awaitToolCallsDurable([]);
  const waiting = admission.awaitToolCallsDurable(["never-recorded"]);
  admission.close();
  await expect(waiting).rejects.toThrow("Model stream closed before tool-call durability");
});

test("only a response's own pre-tool items settle alongside its usage", () => {
  expect(
    settlesAlongsideResponseItems({
      type: "raw_model_stream_event",
      data: { type: "response_done" },
    }),
  ).toBe(true);
  expect(
    settlesAlongsideResponseItems({
      type: "raw_model_stream_event",
      data: { type: "output_text_delta" },
    }),
  ).toBe(false);
  const item = (name: string, rawItem: Record<string, unknown> = { type: "function_call" }) => ({
    type: "run_item_stream_event",
    name,
    item: { rawItem },
  });
  for (const name of [
    "message_output_created",
    "reasoning_item_created",
    "tool_called",
    "tool_search_called",
  ])
    expect(responseSettlementOverlaps(item(name))).toBe(true);
  for (const name of [
    "tool_output",
    "tool_search_output_created",
    "tool_approval_requested",
    "handoff_requested",
  ])
    expect(responseSettlementOverlaps(item(name))).toBe(false);
  // Provider-hosted calls carry their own results and media.
  expect(responseSettlementOverlaps(item("tool_called", { type: "hosted_tool_call" }))).toBe(false);
  expect(responseSettlementOverlaps({ type: "raw_model_stream_event" })).toBe(false);
});
