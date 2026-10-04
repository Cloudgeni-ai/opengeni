import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse, ResponseStreamEvent } from "@openai/agents";
import { Agent, Runner, OpenAIResponsesModel } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import type { ResolvedModelProvider } from "@opengeni/config";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import {
  chatModelRequestPolicy,
  modelRequestPolicyForProvider,
} from "../src/model-provider-request-policy";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";
import { normalizeSdkEvent } from "../src/run-events";
import { chatReasoning, joinChatReasoningMessages, withChatReasoning } from "../src/chat-reasoning";

const base: Omit<ModelRequest, "input"> = {
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

function wireReply(body: Record<string, any>, field: string, toolCall: boolean): Response {
  const tool = {
    id: "call-fixture",
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  };
  const text = toolCall ? "Checking." : "Synthetic answer";
  const reason = "Compare the fixtures.";
  const common = { id: "reply-fixture", model: "fixture-model", created: 1 };
  const usage = {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 3 },
  };
  if (!body.stream)
    return Response.json({
      ...common,
      object: "chat.completion",
      usage,
      choices: [
        {
          index: 0,
          finish_reason: toolCall ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: text,
            [field]: reason,
            tools: [],
            annotations: [],
            ...(toolCall ? { tool_calls: [tool] } : {}),
          },
        },
      ],
    });
  const deltas = [
    { role: "assistant", [field]: "Compare " },
    { [field]: "the fixtures." },
    { content: text },
    ...(toolCall ? [{ tool_calls: [{ ...tool, index: 0 }] }] : []),
  ];
  return new Response(
    [
      ...deltas.map((delta) => ({
        ...common,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
      })),
      {
        ...common,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage,
      },
      { ...common, object: "chat.completion.chunk", choices: [] },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function response(
  model: OpenGeniChatCompletionsModel,
  input: ModelRequest["input"],
  stream: boolean,
) {
  if (!stream) {
    const result = await getOrCreateTrace(() => model.getResponse({ ...base, input }));
    return {
      output: result.output,
      events: [] as ReturnType<typeof normalizeSdkEvent>,
      usage: result.usage,
    };
  }
  let output: ModelResponse["output"] = [];
  let usage: unknown;
  const events: ReturnType<typeof normalizeSdkEvent> = [];
  for await (const event of model.getStreamedResponse({ ...base, input })) {
    events.push(
      ...normalizeSdkEvent({
        type: "raw_model_stream_event",
        data: event,
        source: event.providerData?.rawModelEventSource,
      } as never),
    );
    if (event.type === "response_done") {
      output = event.response.output;
      usage = event.response.usage;
    }
  }
  return { output, events, usage };
}

describe("shared Chat reasoning round trip", () => {
  for (const kind of ["api-key", "openrouter-workspace", "openrouter-organization"] as const) {
    for (const field of ["reasoning", "reasoning_content"] as const) {
      for (const stream of [true, false]) {
        test(`${kind}: ${field}, stream=${stream}, tool continuation and later user turn`, async () => {
          const requests: Record<string, any>[] = [];
          const provider: ResolvedModelProvider = {
            id: "fixture",
            label: "Fixture",
            kind,
            api: "chat",
            builtin: false,
          };
          const client = new ReplayableJsonOpenAI(
            {
              apiKey: "fixture-key",
              baseURL: "https://example.test/v1",
              maxRetries: 0,
              fetch: async (_url, init) => {
                const body = JSON.parse(await requestBodyText(init?.body));
                requests.push(body);
                for (const message of body.messages) {
                  if (message.role !== "assistant") continue;
                  expect(message[field]).toBe("Compare the fixtures.");
                  expect(
                    message[field === "reasoning" ? "reasoning_content" : "reasoning"],
                  ).toBeUndefined();
                  expect(message.content).not.toBeNull();
                  for (const part of message.content)
                    expect(Object.keys(part).sort()).toEqual(["text", "type"]);
                  for (const call of message.tool_calls ?? [])
                    expect(Object.keys(call).sort()).toEqual(["function", "id", "type"]);
                }
                return wireReply(body, field, requests.length === 1);
              },
            },
            { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
          );
          const model = new OpenGeniChatCompletionsModel(client, "fixture-model");
          const first = await response(model, "Start", stream);
          expect(first.output.map((item) => item.type)).toEqual([
            "reasoning",
            "message",
            "function_call",
          ]);
          expect(first.output[0]).toMatchObject({
            rawContent: [{ text: "Compare the fixtures." }],
          });
          expect(first.usage).toMatchObject({
            inputTokens: 12,
            outputTokens: 5,
            totalTokens: 17,
          });
          if (stream)
            expect(first.events.filter((event) => event.type === "agent.reasoning.delta")).toEqual([
              { type: "agent.reasoning.delta", payload: { text: "Compare " } },
              {
                type: "agent.reasoning.delta",
                payload: { text: "the fixtures." },
              },
            ]);
          // JSON round-trip models persistence/resume, with a new model instance.
          const input = JSON.parse(
            JSON.stringify([
              { role: "user", content: "Start" },
              ...first.output,
              {
                type: "function_call_result",
                callId: "call-fixture",
                name: "lookup",
                output: "Found",
                status: "completed",
              },
            ]),
          );
          const before = structuredClone(input);
          const second = await response(
            new OpenGeniChatCompletionsModel(client, "fixture-model"),
            input,
            !stream,
          );
          expect(requests[1]!.messages.map((message: any) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
          ]);
          expect(requests[1]!.messages[1]).toMatchObject({
            content: [{ type: "text", text: "Checking." }],
            tool_calls: [
              {
                id: "call-fixture",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          });
          expect(second.output.map((item) => item.type)).toEqual(["reasoning", "message"]);
          const thirdInput = [...input, ...second.output, { role: "user", content: "Continue" }];
          const thirdBefore = structuredClone(thirdInput);
          await response(model, thirdInput, stream);
          expect(requests[2]!.messages.map((message: any) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
            "assistant",
            "user",
          ]);
          expect(input).toEqual(before);
          expect(thirdInput).toEqual(thirdBefore);
        });
      }
    }
  }
});

test("recovers legacy nested reasoning while removing misplaced tools without mutation", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Answer",
            reasoning_content: "Legacy summary",
            tools: [],
            annotations: [],
            role: "assistant",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
  const before = structuredClone(body);
  const projected = chatModelRequestPolicy({
    path: "/chat/completions",
    body,
  })!;
  expect(projected.body?.messages).toEqual([
    {
      role: "assistant",
      reasoning_content: "Legacy summary",
      content: [{ type: "text", text: "Answer", cache_control: { type: "ephemeral" } }],
    },
  ]);
  expect(body).toEqual(before);
  expect(
    chatModelRequestPolicy({
      path: "/chat/completions",
      body: projected.body!,
    }),
  ).toBeUndefined();
  expect(chatModelRequestPolicy({ path: "/responses", body })).toBeUndefined();
});

test("only emits primary-choice Chat reasoning, once when aliases coexist", () => {
  const raw = (choices: unknown[]): ResponseStreamEvent => ({
    type: "model",
    event: { choices },
    providerData: { rawModelEventSource: "openai-chat-completions" },
  });
  const normalized = (event: ResponseStreamEvent) =>
    normalizeSdkEvent({
      type: "raw_model_stream_event",
      data: event,
      source: event.providerData?.rawModelEventSource,
    } as never);
  expect(normalized(raw([{ index: 1, delta: { reasoning_content: "Other choice" } }]))).toEqual([]);
  expect(
    normalized(raw([{ index: 0, delta: { reasoning_content: "Once", reasoning: "Once" } }])),
  ).toEqual([{ type: "agent.reasoning.delta", payload: { text: "Once" } }]);
  expect(
    normalized(raw([{ index: 0, delta: { reasoning_content: null, reasoning: "" } }])),
  ).toEqual([]);
  expect(chatReasoning({ reasoning_content: null, reasoning: "Fallback" })?.text).toBe("Fallback");
  // Arbitrary model events with similarly shaped payloads are not Chat events.
  expect(
    normalized({
      type: "model",
      event: {
        choices: [{ index: 0, delta: { reasoning: "Wrong protocol" } }],
      },
    }),
  ).toEqual([]);
});

test("never joins reasoning across tool/user boundaries or conflicting extensions", () => {
  const carrier = {
    role: "assistant",
    content: null,
    reasoning_content: "Summary",
    custom: "a",
  };
  for (const next of [
    { role: "tool", content: "Result" },
    { role: "user", content: "Continue" },
    { role: "assistant", content: "Other", reasoning_content: "New summary" },
    { role: "assistant", content: "Other", custom: "b" },
    { role: "assistant", content: null, audio: { id: "audio-fixture" } },
  ]) {
    const messages = [carrier, next];
    expect(joinChatReasoningMessages(messages)).toBe(messages);
  }
});

for (const field of ["reasoning", "reasoning_content"]) {
  test(`actual streamed Runner forwards ${field} to timeline events and history`, async () => {
    const client = new ReplayableJsonOpenAI(
      {
        apiKey: "fixture-key",
        baseURL: "https://example.test/v1",
        maxRetries: 0,
        fetch: async (_url, init) =>
          wireReply(JSON.parse(await requestBodyText(init?.body)), field, false),
      },
      { modelRequestPolicy: chatModelRequestPolicy },
    );
    const runner = new Runner({ tracingDisabled: true });
    const result = await runner.run(
      new Agent({
        name: "Fixture",
        model: new OpenGeniChatCompletionsModel(client, "fixture-model"),
      }),
      "Answer",
      { stream: true },
    );
    const events: ReturnType<typeof normalizeSdkEvent> = [];
    for await (const event of result) events.push(...normalizeSdkEvent(event));
    await result.completed;
    expect(events.filter((event) => event.type === "agent.reasoning.delta")).toEqual([
      { type: "agent.reasoning.delta", payload: { text: "Compare " } },
      { type: "agent.reasoning.delta", payload: { text: "the fixtures." } },
    ]);
    expect(result.history.filter((item) => item.type === "reasoning")).toMatchObject([
      {
        rawContent: [{ type: "reasoning_text", text: "Compare the fixtures." }],
      },
    ]);
    expect(result.finalOutput).toBe("Synthetic answer");
  });
}

test("legacy nonstreamed answer metadata stays with its following tool calls", async () => {
  const input = [
    { role: "user", content: "Start" },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Checking.",
          providerData: {
            role: "assistant",
            reasoning_content: "Legacy summary",
            tools: [],
            annotations: [],
          },
        },
      ],
    },
    { type: "function_call", name: "lookup", callId: "call-fixture", arguments: "{}" },
    { type: "function_call_result", name: "lookup", callId: "call-fixture", output: "Found" },
  ];
  const before = structuredClone(input);
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "fixture-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        expect(body.messages.map((message: any) => message.role)).toEqual([
          "user",
          "assistant",
          "tool",
        ]);
        expect(body.messages[1]).toEqual({
          role: "assistant",
          reasoning_content: "Legacy summary",
          content: [{ type: "text", text: "Checking." }],
          tool_calls: [
            { id: "call-fixture", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        });
        return wireReply(body, "reasoning_content", false);
      },
    },
    { modelRequestPolicy: chatModelRequestPolicy },
  );
  await response(new OpenGeniChatCompletionsModel(client, "fixture-model"), input as never, false);
  expect(input).toEqual(before);
});

test("native Chat provenance never becomes a Responses wire field", async () => {
  const output = withChatReasoning([], { field: "reasoning_content", text: "Synthetic summary" });
  const before = structuredClone(output);
  const client = new ReplayableJsonOpenAI({
    apiKey: "fixture-key",
    baseURL: "https://example.test/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const text = await requestBodyText(init?.body);
      expect(text).not.toContain("chatCompletions");
      expect(text).not.toContain("chat_completions");
      expect(text).not.toContain("reasoningField");
      const body = JSON.parse(text);
      expect(body.input[0]).toEqual({ type: "reasoning", summary: [] });
      return Response.json({
        id: "response-fixture",
        object: "response",
        status: "completed",
        output: [],
      });
    },
  });
  const model = new OpenAIResponsesModel(client, "fixture-model");
  await getOrCreateTrace(() => model.getResponse({ ...base, input: output }));
  expect(output).toEqual(before);
});

test("identical reasoning in separate responses keeps both assistant boundaries", async () => {
  const input = ["First answer", "Second answer"].flatMap((text) =>
    withChatReasoning(
      [
        {
          type: "message" as const,
          role: "assistant" as const,
          status: "completed" as const,
          content: [{ type: "output_text" as const, text }],
        },
      ],
      { field: "reasoning_content", text: "Same summary" },
    ),
  );
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "fixture-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        expect(body.messages).toEqual(
          ["First answer", "Second answer"].map((text) => ({
            role: "assistant",
            reasoning_content: "Same summary",
            content: [{ type: "text", text }],
          })),
        );
        return wireReply(body, "reasoning_content", false);
      },
    },
    { modelRequestPolicy: chatModelRequestPolicy },
  );
  await response(new OpenGeniChatCompletionsModel(client, "fixture-model"), input, false);
});

test("reasoning and tool-only parallel calls form one assistant message", () => {
  const body = {
    messages: [
      { role: "assistant", content: [], reasoning_content: "Compare" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "lookup", arguments: "{}" } },
          { id: "call-b", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "One", tool_call_id: "call-a" },
      { role: "tool", content: "Two", tool_call_id: "call-b" },
    ],
  };
  const before = structuredClone(body);
  const projected = chatModelRequestPolicy({ path: "/chat/completions", body })!;
  expect(projected.body?.messages).toEqual([
    { ...body.messages[1], reasoning_content: "Compare" },
    ...body.messages.slice(2),
  ]);
  expect(body).toEqual(before);
  expect(
    chatModelRequestPolicy({ path: "/chat/completions", body: projected.body! }),
  ).toBeUndefined();
});
