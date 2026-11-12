import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import OpenAI from "openai";
import { OpenGeniChatCompletionsModel } from "../src/model-provider-routing";
import { ARTIFACT_ORIGIN_KEY, projectHistoryForProvider } from "../src/provider-history-adapter";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";

// Synthetic fixtures only: the signature is an arbitrary opaque string.
const SIGNATURE = "synthetic-thought-signature";
const EXTRA_CONTENT = { google: { thought_signature: SIGNATURE } };

function chunk(delta: Record<string, unknown>, finishReason: unknown = null) {
  return {
    id: "chat-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A Gemini-shaped streamed tool call: the signature rides on the call's first delta. */
const TOOL_CALL_CHUNKS = [
  chunk({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call_fixture",
        type: "function",
        function: { name: "lookup", arguments: '{"q":' },
        extra_content: EXTRA_CONTENT,
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
  chunk({}, "tool_calls"),
];

const TEXT_CHUNKS = [chunk({ content: "done" }), chunk({}, "stop")];

function sse(chunks: unknown[]): Response {
  return new Response(
    chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function recordingModel(chunks: unknown[], scope: string | undefined) {
  const bodies: Record<string, any>[] = [];
  const model = new OpenGeniChatCompletionsModel(
    new OpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse(chunks);
      },
    }),
    "gemini-fixture",
    undefined,
    scope,
  );
  return { model, bodies };
}

function request(input: ModelRequest["input"]): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

async function streamedOutput(model: OpenGeniChatCompletionsModel, input: ModelRequest["input"]) {
  for await (const event of model.getStreamedResponse(request(input)))
    if (event.type === "response_done") return event.response.output;
  throw new Error("no response_done");
}

async function firstStepHistory(scope: string) {
  const { model } = recordingModel(TOOL_CALL_CHUNKS, scope);
  const output = await streamedOutput(model, "look it up");
  // Canonical history round-trips through JSON storage.
  return JSON.parse(
    JSON.stringify([
      { type: "message", role: "user", content: "look it up" },
      ...output,
      {
        type: "function_call_result",
        callId: "call_fixture",
        name: "lookup",
        status: "completed",
        output: { type: "text", text: "found" },
      },
    ]),
  ) as Record<string, unknown>[];
}

function wireToolCalls(body: Record<string, any>) {
  return (body.messages as Record<string, any>[]).flatMap((message) => message.tool_calls ?? []);
}

/** Canonical history as stored after a Gemini tool call on `provider-a`. */
function storedHistory(): Record<string, unknown>[] {
  return [
    { type: "message", role: "user", content: "look it up" },
    {
      type: "function_call",
      id: "chat-fixture",
      callId: "call_fixture",
      name: "lookup",
      arguments: '{"q":"x"}',
      providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
    },
    {
      type: "function_call_result",
      callId: "call_fixture",
      name: "lookup",
      status: "completed",
      output: { type: "text", text: "found" },
    },
  ];
}

describe("Chat tool-call provider fields", () => {
  test("a streamed tool call keeps the provider's extra fields and records their origin", async () => {
    const { model } = recordingModel(TOOL_CALL_CHUNKS, "provider-a");
    const output = (await streamedOutput(model, "look it up")) as Record<string, any>[];
    const call = output.find((item) => item.type === "function_call");
    expect(call).toMatchObject({
      callId: "call_fixture",
      name: "lookup",
      arguments: '{"q":"x"}',
      providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
    });
  });

  test("the follow-up request to the same provider sends the thought signature back", async () => {
    const history = await firstStepHistory("provider-a");
    const { model, bodies } = recordingModel(TEXT_CHUNKS, "provider-a");
    await streamedOutput(model, history as ModelRequest["input"]);
    const [call] = wireToolCalls(bodies[0]!);
    expect(call).toMatchObject({
      id: "call_fixture",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
      extra_content: EXTRA_CONTENT,
    });
    expect(JSON.stringify(bodies[0])).not.toContain(ARTIFACT_ORIGIN_KEY);
  });

  test("another Chat provider receives the plain call without the signature", async () => {
    const { model, bodies } = recordingModel(TEXT_CHUNKS, "provider-b");
    await streamedOutput(model, storedHistory() as ModelRequest["input"]);
    const [call] = wireToolCalls(bodies[0]!);
    expect(call).toEqual({
      id: "call_fixture",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
    const wire = JSON.stringify(bodies[0]);
    expect(wire).not.toContain(SIGNATURE);
    expect(wire).not.toContain("extra_content");
    expect(wire).not.toContain(ARTIFACT_ORIGIN_KEY);
  });

  test("a Responses provider receives the plain call; a provider-neutral pass keeps it", async () => {
    const history = storedHistory();
    const responses = projectHistoryForProvider(history, "responses", {
      artifactScope: "responses-provider",
    });
    const call = responses.find((item) => item.type === "function_call")!;
    expect(call.providerData).toBeUndefined();
    expect(JSON.stringify(responses)).not.toContain(SIGNATURE);

    // The worker's provider-neutral pass leaves the decision to the request's route.
    const neutral = projectHistoryForProvider(history, "chat");
    expect(neutral.find((item) => item.type === "function_call")).toMatchObject({
      providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
    });
  });

  test("a non-streamed tool call records the same origin", async () => {
    const model = new OpenGeniChatCompletionsModel(
      new OpenAI({
        apiKey: "fixture",
        maxRetries: 0,
        fetch: async () =>
          Response.json({
            id: "chat-fixture",
            object: "chat.completion",
            created: 0,
            model: "fixture",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_fixture",
                      type: "function",
                      function: { name: "lookup", arguments: "{}" },
                      extra_content: EXTRA_CONTENT,
                    },
                  ],
                },
              },
            ],
          }),
      }),
      "gemini-fixture",
      undefined,
      "provider-a",
    );
    const response = await getOrCreateTrace(() => model.getResponse(request("look it up")));
    expect(response.output.find((item) => item.type === "function_call")).toMatchObject({
      providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
    });
  });
});

describe("array-wrapped provider error bodies", () => {
  test("the provider's message and status code replace '(no body)'", async () => {
    const client = new ReplayableJsonOpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify([
            {
              error: {
                code: 400,
                message: "Function call is missing a thought_signature in functionCall parts.",
                status: "INVALID_ARGUMENT",
              },
            },
          ]),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const model = new OpenGeniChatCompletionsModel(client, "gemini-fixture", undefined, "a");
    let error: any;
    try {
      await streamedOutput(model, "look it up");
    } catch (caught) {
      error = caught;
    }
    expect(error?.status).toBe(400);
    expect(error?.message).toBe(
      "400 Function call is missing a thought_signature in functionCall parts.",
    );
    expect(error?.code).toBe("INVALID_ARGUMENT");
  });

  test("a long wrapped message is bounded and other bodies are unchanged", async () => {
    const { unwrappedErrorBody, WRAPPED_PROVIDER_ERROR_MESSAGE_MAX_CHARS } =
      await import("../src/replayable-json-body");
    const long = unwrappedErrorBody([{ error: { message: "x".repeat(10_000) } }]) as {
      error: { message: string };
    };
    expect(long.error.message.length).toBe(WRAPPED_PROVIDER_ERROR_MESSAGE_MAX_CHARS + 1);
    const plain = { error: { message: "plain" } };
    expect(unwrappedErrorBody(plain)).toBe(plain);
    const unrelated = [{ detail: "not an error envelope" }];
    expect(unwrappedErrorBody(unrelated)).toBe(unrelated);
  });
});
