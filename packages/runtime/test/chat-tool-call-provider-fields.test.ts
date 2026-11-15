import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import { canonicalizePersistedHistoryItem } from "@opengeni/codex";
import type { ResolvedModelProvider } from "@opengeni/config";
import OpenAI from "openai";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";
import {
  OpenGeniChatCompletionsModel,
  OpenGeniResponsesModel,
} from "../src/model-provider-routing";
import { ARTIFACT_ORIGIN_KEY, projectHistoryForProvider } from "../src/provider-history-adapter";
import {
  unwrappedErrorBody,
  WRAPPED_PROVIDER_ERROR_MESSAGE_MAX_CHARS,
} from "../src/provider-quota";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

// Synthetic fixtures only: signatures are arbitrary opaque strings.
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

/** Gemini on AI Studio streams each tool call whole, in one chunk, without an `index`. */
const UNINDEXED_TOOL_CALL_CHUNKS = [
  chunk({
    role: "assistant",
    tool_calls: [
      {
        id: "call_fixture",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"x"}' },
        extra_content: EXTRA_CONTENT,
      },
    ],
  }),
  chunk({}, "tool_calls"),
];

/** An indexed call whose arguments arrive in pieces (Vertex sends `index`). */
const INDEXED_TOOL_CALL_CHUNKS = [
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

async function streamedCalls(chunks: unknown[], scope = "provider-a") {
  const { model } = recordingModel(chunks, scope);
  for await (const event of model.getStreamedResponse(request("look it up")))
    if (event.type === "response_done")
      return (event.response.output as Record<string, any>[]).filter(
        (item) => item.type === "function_call",
      );
  throw new Error("no response_done");
}

async function send(model: OpenGeniChatCompletionsModel, input: ModelRequest["input"]) {
  for await (const _event of model.getStreamedResponse(request(input))) {
    // drain
  }
}

/** History as the worker stores and reloads it after the first step. */
function persisted(output: unknown[]): Record<string, unknown>[] {
  return sanitizeHistoryItemsForModel(
    JSON.parse(
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
    ).map(canonicalizePersistedHistoryItem),
  ) as Record<string, unknown>[];
}

/** Canonical history as stored after a Gemini tool call on `provider-a`. */
function storedHistory(): Record<string, unknown>[] {
  return persisted([
    {
      type: "function_call",
      id: "chat-fixture",
      callId: "call_fixture",
      name: "lookup",
      arguments: '{"q":"x"}',
      providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
    },
  ]);
}

function wireToolCalls(body: Record<string, any>) {
  return (body.messages as Record<string, any>[]).flatMap((message) => message.tool_calls ?? []);
}

const PLAIN_CALL = {
  id: "call_fixture",
  type: "function",
  function: { name: "lookup", arguments: '{"q":"x"}' },
};

describe("streamed Chat tool calls keep provider fields", () => {
  for (const [shape, chunks] of [
    ["an unindexed whole call", UNINDEXED_TOOL_CALL_CHUNKS],
    ["an indexed call in pieces", INDEXED_TOOL_CALL_CHUNKS],
  ] as const)
    test(`${shape} keeps its signature and records its origin`, async () => {
      const [call, ...rest] = await streamedCalls(chunks);
      expect(rest).toEqual([]);
      expect(call).toMatchObject({
        callId: "call_fixture",
        name: "lookup",
        arguments: '{"q":"x"}',
        providerData: { extra_content: EXTRA_CONTENT, [ARTIFACT_ORIGIN_KEY]: "provider-a" },
      });
    });

  test("parallel unindexed calls stay separate, each with its own fields", async () => {
    const calls = await streamedCalls([
      chunk({
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"a"}' },
            extra_content: EXTRA_CONTENT,
          },
        ],
      }),
      chunk({
        tool_calls: [
          { id: "call_b", type: "function", function: { name: "lookup", arguments: '{"q":"b"}' } },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);
    expect(calls.map(({ callId, arguments: args }) => [callId, args])).toEqual([
      ["call_a", '{"q":"a"}'],
      ["call_b", '{"q":"b"}'],
    ]);
    expect(calls[0]!.providerData.extra_content).toEqual(EXTRA_CONTENT);
    expect(calls[1]!.providerData).toBeUndefined();
  });

  test("parallel unindexed calls without ids stay separate", async () => {
    const calls = await streamedCalls([
      chunk({
        tool_calls: [
          {
            id: "",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"a"}' },
            extra_content: EXTRA_CONTENT,
          },
          { type: "function", function: { name: "fetch", arguments: '{"q":"b"}' } },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);
    expect(calls.map(({ name, arguments: args }) => [name, args])).toEqual([
      ["lookup", '{"q":"a"}'],
      ["fetch", '{"q":"b"}'],
    ]);
    expect(calls[0]!.providerData.extra_content).toEqual(EXTRA_CONTENT);
    expect(calls[1]!.providerData).toBeUndefined();
  });

  test("fields that arrive before the id or in pieces are merged onto the call", async () => {
    const [first, second] = await streamedCalls([
      chunk({
        tool_calls: [
          { index: 0, extra_content: { google: { thought_signature: SIGNATURE } } },
          { index: 1, id: "call_b", type: "function", function: { name: "lookup" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "lookup" } },
          { index: 0, function: { arguments: "{}" }, extra_content: { google: { other: "y" } } },
          { index: 1, function: { arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);
    expect(first).toMatchObject({
      callId: "call_a",
      providerData: { extra_content: { google: { thought_signature: SIGNATURE, other: "y" } } },
    });
    expect(second).toMatchObject({ callId: "call_b", arguments: "{}" });
    expect(second!.providerData).toBeUndefined();
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
                  tool_calls: [{ ...PLAIN_CALL, extra_content: EXTRA_CONTENT }],
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

describe("replaying tool-call provider fields", () => {
  test("the follow-up request to the same provider sends the signature back", async () => {
    const history = persisted(await streamedCalls(UNINDEXED_TOOL_CALL_CHUNKS));
    // The worker's provider-neutral pass runs first; it must keep the fields.
    const neutral = projectHistoryForProvider(history, "chat");
    const { model, bodies } = recordingModel(TEXT_CHUNKS, "provider-a");
    await send(model, neutral as ModelRequest["input"]);
    expect(wireToolCalls(bodies[0]!)).toEqual([{ ...PLAIN_CALL, extra_content: EXTRA_CONTENT }]);
    expect(JSON.stringify(bodies[0])).not.toContain(ARTIFACT_ORIGIN_KEY);
  });

  test("another Chat provider receives the plain call", async () => {
    const neutral = projectHistoryForProvider(storedHistory(), "chat");
    const { model, bodies } = recordingModel(TEXT_CHUNKS, "provider-b");
    await send(model, neutral as ModelRequest["input"]);
    expect(wireToolCalls(bodies[0]!)).toEqual([PLAIN_CALL]);
    const wire = JSON.stringify(bodies[0]);
    expect(wire).not.toContain("extra_content");
    expect(wire).not.toContain(ARTIFACT_ORIGIN_KEY);
  });

  test("a Responses provider receives the plain call on the wire", async () => {
    const bodies: Record<string, any>[] = [];
    const provider: ResolvedModelProvider = {
      id: "responses-provider",
      label: "responses-provider",
      kind: "api-key",
      api: "responses",
      builtin: false,
      baseUrl: "https://example.test/v1",
      apiKey: "fixture-key",
    };
    const reply = {
      id: "response-fixture",
      object: "response",
      status: "completed",
      output: [
        {
          id: "message-fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const model = new OpenGeniResponsesModel(
      new ReplayableJsonOpenAI({
        apiKey: "fixture-key",
        baseURL: provider.baseUrl,
        maxRetries: 0,
        fetch: (async (_url, init) => {
          bodies.push(JSON.parse(await requestBodyText(init?.body)));
          return Response.json(reply);
        }) as typeof globalThis.fetch,
      }),
      "fixture",
      provider,
    );
    await getOrCreateTrace(() =>
      model.getResponse(
        request(projectHistoryForProvider(storedHistory(), "responses") as ModelRequest["input"]),
      ),
    );
    const call = (bodies[0]!.input as Record<string, unknown>[]).find(
      (item) => item.type === "function_call",
    );
    expect(call).toMatchObject({ call_id: "call_fixture", name: "lookup" });
    const wire = JSON.stringify(bodies[0]);
    expect(wire).not.toContain("extra_content");
    expect(wire).not.toContain(ARTIFACT_ORIGIN_KEY);
  });

  test("other providers keep Opengeni's own records on the call", () => {
    const [, call] = storedHistory();
    const marked = {
      ...call,
      providerData: {
        ...(call!.providerData as Record<string, unknown>),
        "opengeni.lazy_dispatch.v1": { version: 1, arguments: "{}" },
      },
    };
    const projected = projectHistoryForProvider([marked], "chat", { artifactScope: "provider-b" });
    expect(projected[0]!.providerData).toEqual({
      "opengeni.lazy_dispatch.v1": { version: 1, arguments: "{}" },
    });
  });
});

describe("array-wrapped provider error bodies", () => {
  test("the provider's message and status code replace '(no body)'", async () => {
    const client = new ReplayableJsonOpenAI({
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async () =>
        Response.json(
          [
            {
              error: {
                code: 400,
                message: "Function call is missing a thought_signature in functionCall parts.",
                status: "INVALID_ARGUMENT",
              },
            },
          ],
          { status: 400 },
        ),
    });
    const model = new OpenGeniChatCompletionsModel(client, "gemini-fixture", undefined, "a");
    let error: any;
    try {
      await send(model, "look it up");
    } catch (caught) {
      error = caught;
    }
    expect(error?.status).toBe(400);
    expect(error?.message).toBe(
      "400 Function call is missing a thought_signature in functionCall parts.",
    );
    expect(error?.code).toBe("INVALID_ARGUMENT");
  });

  test("a long wrapped message is bounded and other bodies are unchanged", () => {
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
