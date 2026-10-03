import { describe, expect, test } from "bun:test";
import {
  Agent,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  Runner,
  tool,
  toolSearchTool,
} from "@openai/agents";
import { RunItemStreamEvent, RunMessageOutputItem } from "@openai/agents-core";
import { isStreamedAssistantMessageCompletion } from "@opengeni/contracts";
import { ChatTurnFold } from "@opengeni/sdk/chat";
import { assistantMessage, functionCall, ScriptedModel } from "@opengeni/testing";
import OpenAI from "openai";
import { z } from "zod";
import {
  AssistantMessagePhaseTracker,
  normalizeSdkEvent,
  type NormalizedRuntimeEvent,
} from "../src/run-events";

type ResponsesEvent = Record<string, unknown> & { type: string };

type Phase = "commentary" | "final_answer" | undefined;

function messageItem(id: string, phase: Phase, text: string | null): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "assistant",
    status: text === null ? "in_progress" : "completed",
    ...(phase ? { phase } : {}),
    content: text === null ? [] : [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

/** One provider response exactly as the Responses API streams it. */
function streamedResponse(
  responseId: string,
  messages: Array<{ id: string; phase: Phase; chunks: string[] }>,
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
    for (const text of message.chunks) {
      events.push({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: outputIndex,
        content_index: 0,
        delta: text,
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

function completions(events: NormalizedRuntimeEvent[]) {
  return events
    .filter((event) => event.type === "agent.message.completed")
    .map((event) => event.payload);
}

function normalizeStream(sdkEvents: unknown[]) {
  const messagePhases = new AssistantMessagePhaseTracker();
  return sdkEvents.flatMap((event) => normalizeSdkEvent(event as never, { messagePhases }));
}

/** Fold one turn's normalized events the way SDK chat clients read them. */
function foldTurn(events: NormalizedRuntimeEvent[], output: string) {
  const fold = new ChatTurnFold("workspace", "session", "turn");
  const settled = [...events, { type: "turn.completed", payload: { output } }];
  const text: string[] = [];
  settled.forEach((event, index) => {
    const step = fold.push({
      id: `event-${index}`,
      sequence: index + 1,
      type: event.type,
      payload: event.payload,
      turnId: "turn",
    } as never);
    for (const chunk of step.chunks) if (chunk.type === "text") text.push(chunk.text);
  });
  return { streamed: text.join(""), reply: fold.reply("completed").text };
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

  test("infers the SDK's own phase for undeclared messages", async () => {
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
    // Runs again after tool work: commentary. Returned as the final output:
    // final_answer. Both are the SDK's own run-again rule.
    expect(completions(normalized)).toEqual([
      { text: "Looking it up.", messageId: "msg_scripted_commentary", phase: "commentary" },
      { text: "Found it.", messageId: "msg_scripted_final", phase: "final_answer" },
    ]);
  });

  test("completes each message of one response before the next one streams", async () => {
    const note = "Checking the deploy.";
    const answer = "It is healthy.";
    const { stream, sdkEvents } = await runRealResponsesTurn([
      streamedResponse("resp_both", [
        { id: "msg_note", phase: "commentary", chunks: ["Checking ", "the deploy."] },
        { id: "msg_answer", phase: "final_answer", chunks: ["It is ", "healthy."] },
      ]),
    ]);
    expect(stream.finalOutput).toBe(answer);
    const normalized = normalizeStream(sdkEvents);
    // Provider order: the SDK reports both run items only after the whole
    // response, and that later copy is not emitted again.
    expect(messageEvents(normalized)).toEqual([
      delta("Checking ", "msg_note", "commentary"),
      delta("the deploy.", "msg_note", "commentary"),
      {
        type: "agent.message.completed",
        payload: { text: note, messageId: "msg_note", phase: "commentary" },
      },
      delta("It is ", "msg_answer", "final_answer"),
      delta("healthy.", "msg_answer", "final_answer"),
      {
        type: "agent.message.completed",
        payload: { text: answer, messageId: "msg_answer", phase: "final_answer" },
      },
    ]);
    expect(foldTurn(normalized, answer)).toEqual({ streamed: answer, reply: answer });
  });

  test("an undeclared message completes as soon as the response shows its phase", async () => {
    const { stream, sdkEvents } = await runRealResponsesTurn([
      streamedResponse(
        "resp_lookup",
        [{ id: "msg_lookup", phase: undefined, chunks: ["Looking ", "it up."] }],
        { id: "fc_lookup", callId: "call_lookup", name: "lookup" },
      ),
      streamedResponse("resp_summary", [
        { id: "msg_summary", phase: undefined, chunks: ["Summary: ", "ok."] },
        { id: "msg_details", phase: undefined, chunks: ["Details: ", "fine."] },
      ]),
    ]);
    expect(stream.finalOutput).toBe("Details: fine.");
    const normalized = normalizeStream(sdkEvents);
    expect(
      normalized
        .filter((event) => event.type !== "agent.message.delta")
        .map((event) =>
          event.type === "agent.message.completed"
            ? `${(event.payload as { messageId: string }).messageId}:${(event.payload as { phase: string }).phase}`
            : event.type,
        ),
    ).toEqual([
      // The tool call announced after the message makes it commentary.
      "msg_lookup:commentary",
      "agent.toolCall.created",
      "agent.toolCall.output",
      // A later message in the same response makes it commentary before that
      // message streams; the last one is what the SDK returns.
      "msg_summary:commentary",
      "msg_details:final_answer",
    ]);
    const summaryCompleted = normalized.findIndex(
      (event) =>
        event.type === "agent.message.completed" &&
        (event.payload as { messageId: string }).messageId === "msg_summary",
    );
    const detailsStreamed = normalized.findIndex(
      (event) =>
        event.type === "agent.message.delta" &&
        (event.payload as { messageId: string }).messageId === "msg_details",
    );
    expect(summaryCompleted).toBeLessThan(detailsStreamed);
    // Undeclared deltas were already streamed as reply text; each message is
    // its own paragraph and none repeats.
    const streamed = "Looking it up.\n\nSummary: ok.\n\nDetails: fine.";
    expect(foldTurn(normalized, "Details: fine.")).toEqual({ streamed, reply: streamed });
  });

  test("a client tool search makes the message beside it commentary", async () => {
    const model = new ScriptedModel([
      {
        output: [
          assistantMessage("Finding the right tool.", "msg_search_note"),
          {
            type: "tool_search_call",
            id: "ts_search",
            status: "completed",
            arguments: { query: "lookup" },
            providerData: { execution: "client", call_id: "call_search" },
          },
        ] as never,
      },
      { output: [assistantMessage("Found it.", "msg_found")] },
    ]);
    const agent = new Agent({
      name: "phase-test",
      model,
      tools: [toolSearchTool({ execution: "client", execute: (async () => []) as never })],
    });
    const stream = await new Runner({ tracingDisabled: true }).run(agent, "Find it.", {
      stream: true,
    });
    const sdkEvents: unknown[] = [];
    for await (const event of stream.toStream()) sdkEvents.push(event);
    await stream.completed;
    expect(stream.finalOutput).toBe("Found it.");
    expect(completions(normalizeStream(sdkEvents))).toEqual([
      { text: "Finding the right tool.", messageId: "msg_search_note", phase: "commentary" },
      { text: "Found it.", messageId: "msg_found", phase: "final_answer" },
    ]);
  });

  test("a provider without response ids still labels every streamed completion", async () => {
    const chunk = (change: Record<string, unknown>, finishReason: string | null = null) => ({
      object: "chat.completion.chunk",
      created: 0,
      model: "chat-model",
      choices: [{ index: 0, delta: change, finish_reason: finishReason }],
    });
    const responses = [
      [
        chunk({ role: "assistant", content: "Looking " }),
        chunk({ content: "it up." }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      [
        chunk({ role: "assistant", content: "Found " }),
        chunk({ content: "it." }),
        chunk({}, "stop"),
      ],
    ];
    let call = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://chat.example.test/v1",
      maxRetries: 0,
      fetch: async () => {
        const events = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(`${body}data: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const agent = new Agent({
      name: "phase-test",
      model: new OpenAIChatCompletionsModel(client, "chat-model"),
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
    const sdkEvents: unknown[] = [];
    for await (const event of stream.toStream()) sdkEvents.push(event);
    await stream.completed;
    expect(call).toBe(2);
    expect(stream.finalOutput).toBe("Found it.");
    const completed = normalizeStream(sdkEvents).filter(
      (event) => event.type === "agent.message.completed",
    );
    // No provider identity, but each completion still carries its phase, so it
    // is never mistaken for the phase-less settlement copy.
    expect(completed.map((event) => event.payload)).toEqual([
      { text: "Looking it up.", phase: "commentary" },
      { text: "Found it.", phase: "final_answer" },
    ]);
    expect(completed.every((event) => isStreamedAssistantMessageCompletion(event))).toBe(true);
  });
});

function delta(text: string, messageId: string, phase: string) {
  return { type: "agent.message.delta", payload: { text, messageId, phase } };
}
