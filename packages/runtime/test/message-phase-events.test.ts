import { describe, expect, test } from "bun:test";
import { Agent, OpenAIResponsesModel, Runner, tool } from "@openai/agents";
import { RunItemStreamEvent, RunMessageOutputItem } from "@openai/agents-core";
import { assistantMessage, functionCall, ScriptedModel } from "@opengeni/testing";
import OpenAI from "openai";
import { z } from "zod";
import {
  AssistantMessagePhaseTracker,
  normalizeSdkEvent,
  type NormalizedRuntimeEvent,
} from "../src/run-events";

type ResponsesEvent = Record<string, unknown> & { type: string };

function messageItem(
  id: string,
  phase: "commentary" | "final_answer",
  text: string | null,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "assistant",
    status: text === null ? "in_progress" : "completed",
    phase,
    content: text === null ? [] : [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

/** One provider response exactly as the Responses API streams it. */
function streamedResponse(
  responseId: string,
  messages: Array<{ id: string; phase: "commentary" | "final_answer"; chunks: string[] }>,
  call?: { id: string; callId: string; name: string },
): ResponsesEvent[] {
  const events: ResponsesEvent[] = [
    { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
  ];
  const output: Record<string, unknown>[] = [];
  messages.forEach((message, outputIndex) => {
    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: messageItem(message.id, message.phase, null),
    });
    for (const delta of message.chunks) {
      events.push({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    const done = messageItem(message.id, message.phase, message.chunks.join(""));
    output.push(done);
    events.push({ type: "response.output_item.done", output_index: outputIndex, item: done });
  });
  if (call) {
    const item = {
      type: "function_call",
      id: call.id,
      call_id: call.callId,
      name: call.name,
      arguments: "{}",
      status: "completed",
    };
    output.push(item);
    events.push({ type: "response.output_item.added", output_index: messages.length, item });
    events.push({ type: "response.output_item.done", output_index: messages.length, item });
  }
  events.push({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return events;
}

/**
 * Drive the real Agents SDK runner against the real Responses model over an
 * SSE transport, so every run item and raw event has its production shape.
 */
async function runRealResponsesTurn(responses: ResponsesEvent[][]) {
  let call = 0;
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://responses.example.test/v1",
    maxRetries: 0,
    fetch: async () => {
      const events = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const agent = new Agent({
    name: "phase-test",
    instructions: "Answer.",
    model: new OpenAIResponsesModel(client, "gpt-5.6-sol"),
    tools: [
      tool({
        name: "lookup",
        description: "Look something up.",
        parameters: z.object({}),
        execute: async () => "found",
      }),
    ],
  });
  const stream = await new Runner({ tracingDisabled: true }).run(agent, "Check the file.", {
    stream: true,
  });
  const sdkEvents: unknown[] = [];
  for await (const event of stream.toStream()) sdkEvents.push(event);
  await stream.completed;
  return { stream, sdkEvents, calls: call };
}

function messageEvents(events: NormalizedRuntimeEvent[]) {
  return events.filter(
    (event) => event.type === "agent.message.completed" || event.type === "agent.message.delta",
  );
}

describe("assistant message phase on runtime events", () => {
  test("emits one completion per real SDK message with provider identity and phase", async () => {
    const { stream, sdkEvents, calls } = await runRealResponsesTurn([
      streamedResponse(
        "resp_commentary",
        [{ id: "msg_commentary", phase: "commentary", chunks: ["Checking ", "the file."] }],
        { id: "fc_lookup", callId: "call_lookup", name: "lookup" },
      ),
      streamedResponse("resp_final", [
        { id: "msg_final", phase: "final_answer", chunks: ["All ", "good."] },
      ]),
    ]);
    expect(calls).toBe(2);
    expect(stream.finalOutput).toBe("All good.");

    const messagePhases = new AssistantMessagePhaseTracker();
    const normalized = sdkEvents.flatMap((event) =>
      normalizeSdkEvent(event as never, { messagePhases }),
    );
    expect(messageEvents(normalized)).toEqual([
      delta("Checking ", "msg_commentary", "commentary"),
      delta("the file.", "msg_commentary", "commentary"),
      {
        type: "agent.message.completed",
        payload: { text: "Checking the file.", messageId: "msg_commentary", phase: "commentary" },
      },
      delta("All ", "msg_final", "final_answer"),
      delta("good.", "msg_final", "final_answer"),
      {
        type: "agent.message.completed",
        payload: { text: "All good.", messageId: "msg_final", phase: "final_answer" },
      },
    ]);
    // The durable message order interleaves with the tool call it narrated.
    expect(
      normalized.filter((event) => event.type !== "agent.message.delta").map((event) => event.type),
    ).toEqual([
      "agent.message.completed",
      "agent.toolCall.created",
      "agent.toolCall.output",
      "agent.message.completed",
    ]);

    // Without per-stream memory a completion still reports its declared phase.
    const stateless = sdkEvents
      .flatMap((event) => normalizeSdkEvent(event as never))
      .filter((event) => event.type === "agent.message.completed")
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(stateless).toEqual(["commentary", "final_answer"]);
  });

  test("keeps the text of every output_text part and ignores refusal parts", () => {
    const agent = new Agent({ name: "phase-test" });
    const [completed] = normalizeSdkEvent(
      new RunItemStreamEvent(
        "message_output_created",
        new RunMessageOutputItem(
          {
            type: "message",
            id: "msg_parts",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "First part. " },
              { type: "refusal", refusal: "not text" },
              { type: "output_text", text: "Second part." },
            ],
          } as never,
          agent,
        ),
      ) as never,
    );
    expect(completed).toEqual({
      type: "agent.message.completed",
      payload: { text: "First part. Second part.", messageId: "msg_parts" },
    });
  });

  test("never reports the Chat Completions placeholder id as provider identity", () => {
    const agent = new Agent({ name: "phase-test" });
    const [completed] = normalizeSdkEvent(
      new RunItemStreamEvent(
        "message_output_created",
        new RunMessageOutputItem(
          {
            ...(assistantMessage("No provider id.", "FAKE_ID") as Record<string, unknown>),
          } as never,
          agent,
        ),
      ) as never,
    );
    expect(completed).toEqual({
      type: "agent.message.completed",
      payload: { text: "No provider id." },
    });
  });

  test("infers commentary for undeclared messages that the SDK runs past", async () => {
    const model = new ScriptedModel([
      {
        output: [
          assistantMessage("Looking it up.", "msg_scripted_commentary"),
          functionCall("lookup", {}, "call_scripted_lookup"),
        ],
      },
      { output: [assistantMessage("Found it.", "msg_scripted_final")] },
    ]);
    const agent = new Agent({
      name: "phase-test",
      model,
      tools: [
        tool({
          name: "lookup",
          description: "Look something up.",
          parameters: z.object({}),
          execute: async () => "found",
        }),
      ],
    });
    const stream = await new Runner({ tracingDisabled: true }).run(agent, "Find it.", {
      stream: true,
    });
    const messagePhases = new AssistantMessagePhaseTracker();
    const normalized: NormalizedRuntimeEvent[] = [];
    for await (const event of stream.toStream()) {
      normalized.push(...normalizeSdkEvent(event, { messagePhases }));
    }
    await stream.completed;
    expect(stream.finalOutput).toBe("Found it.");
    // The final message is not labelled: only the SDK's own run-again rule is
    // strong enough to call an undeclared message commentary.
    expect(
      normalized
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload),
    ).toEqual([
      { text: "Looking it up.", messageId: "msg_scripted_commentary", phase: "commentary" },
      { text: "Found it.", messageId: "msg_scripted_final" },
    ]);
  });
});

function delta(text: string, messageId: string, phase: string) {
  return { type: "agent.message.delta", payload: { text, messageId, phase } };
}
