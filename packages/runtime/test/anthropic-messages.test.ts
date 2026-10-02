import { describe, expect, test } from "bun:test";
import { Agent, Runner, tool, setTracingDisabled, type ModelRequest } from "@openai/agents";
import { z } from "zod";
import { configuredProviders, type ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  AnthropicMessagesModel,
  anthropicMessages,
  anthropicResponse,
  buildAnthropicRequest,
} from "../src/anthropic-messages";
import { isModelCallFetch } from "../src/model-provider-transport";
import { projectHistoryForProvider } from "../src/provider-history-adapter";
import { MultiProviderModelProvider } from "../src/model-provider-routing";

setTracingDisabled(true);
const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};
const request = (input: ModelRequest["input"] = "Hello"): ModelRequest => ({
  input,
  systemInstructions: "Instructions",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
});
const response = (content: unknown[], stop = "end_turn") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  content,
  stop_reason: stop,
  usage: {
    input_tokens: 2,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 30,
    output_tokens: 7,
  },
});

test("initial system and developer instructions move to top-level while later policy stays in place", () => {
  const input: ModelRequest["input"] = [
    { role: "system", content: "Skill catalog" },
    { role: "developer", content: "Initial policy" },
    { role: "user", content: "Draw a chart" },
    { role: "system", content: "Later policy" },
    { role: "user", content: "Continue" },
  ];
  const before = JSON.stringify(input);
  const body = buildAnthropicRequest(request(input), "claude-opus-5-5", provider, true);
  expect(body.system.map((block: any) => block.text)).toEqual([
    "Instructions",
    "Skill catalog",
    "Initial policy",
  ]);
  expect(body.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  expect(body.messages.map((message: any) => message.role)).toEqual(["user", "system", "user"]);
  expect(body.messages[1].content[0].text).toBe("Later policy");
  expect(JSON.stringify(input)).toBe(before);
  expect(() =>
    buildAnthropicRequest(
      request([{ role: "system", content: "Only instructions" }]),
      "claude-opus-5-5",
      provider,
      true,
    ),
  ).toThrow("conversation message");
});

function stream(frames: unknown[], oneByte = false) {
  const bytes = new TextEncoder().encode(
    frames.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        if (oneByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", "request-id": "req_test" } },
  );
}
function events(blocks: any[], stop = "end_turn") {
  return [
    { type: "message_start", message: response([], null as any) },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
}
const collect = async (model: AnthropicMessagesModel, req = request()) => {
  const result = [];
  for await (const event of model.getStreamedResponse(req)) result.push(event);
  return result;
};

test("large tool batches retain the previous cache prefix with at most four markers", () => {
  const calls = Array.from({ length: 25 }, (_, index) => ({
    type: "function_call" as const,
    callId: `call_${index}`,
    name: "lookup",
    arguments: "{}",
  }));
  const req = request([
    { role: "user", content: "Initial conversation prefix" },
    ...calls,
    ...calls.map((call) => ({
      type: "function_call_result" as const,
      callId: call.callId,
      name: call.name,
      output: "Result",
    })),
  ]);
  req.tools = [
    {
      type: "function",
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ];
  const before = JSON.stringify(req);
  for (const ttl of ["5m", "1h"] as const) {
    const body = buildAnthropicRequest(
      req,
      "claude-opus-5-5",
      {
        anthropic: {
          auth: "api-key",
          cacheTtl: ttl,
          maxOutputTokens: 32000,
          streamIdleTimeoutMs: 600000,
        },
      },
      true,
    );
    const history = body.messages.flatMap((message: any) => message.content);
    expect(history.length).toBeGreaterThan(40);
    expect(history[0].cache_control).toEqual({ type: "ephemeral", ttl });
    expect(history.at(-1).cache_control).toEqual({ type: "ephemeral", ttl });
    const marked = [...body.tools, ...body.system, ...history].filter(
      (block: any) => block.cache_control,
    );
    expect(marked).toHaveLength(4);
    expect(
      marked.every((block: any) => !["thinking", "redacted_thinking"].includes(block.type)),
    ).toBe(true);
  }
  expect(JSON.stringify(req)).toBe(before);
});

test("streamed cache creation TTL details survive SDK usage without double counting", async () => {
  const frames = events([{ type: "text", text: "Done" }]);
  (frames[0] as any).message.usage.cache_creation = {
    ephemeral_5m_input_tokens: 10,
    ephemeral_1h_input_tokens: 20,
  };
  const model = new AnthropicMessagesModel(provider, "claude", (async () =>
    stream(frames)) as typeof fetch);
  const result: any = (await collect(model)).at(-1);
  expect(result.response.usage.inputTokens).toBe(132);
  expect(result.response.usage.inputTokensDetails[0]).toEqual({
    cached_tokens: 100,
    cache_write_tokens: 30,
    cache_write_tokens_5m: 10,
    cache_write_tokens_1h: 20,
  });
  const combined = new (await import("@openai/agents")).Usage();
  combined.add(result.response.usage);
  expect(combined.inputTokensDetails[0]).toEqual(result.response.usage.inputTokensDetails[0]);
});

describe("Claude full-history Messages adapter", () => {
  test("stable tool/system prefixes, three cache breakpoints, no thread references or mutation", () => {
    const req = request();
    req.tools = [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      } as any,
    ];
    const before = structuredClone(req);
    const body = buildAnthropicRequest(req, "claude-opus-4-6", provider, true);
    expect(body.tools[0].input_schema).toEqual(req.tools[0].parameters);
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(body.system[0].cache_control).toEqual(body.tools[0].cache_control);
    expect(body.messages[0].content[0].cache_control).toEqual(body.tools[0].cache_control);
    expect(body.thread).toBeUndefined();
    expect(body.max_tokens).toBe(32000);
    expect(req).toEqual(before);
    const uncached = buildAnthropicRequest(
      req,
      "claude",
      {
        anthropic: {
          auth: "api-key",
          cacheTtl: "off",
          maxOutputTokens: 9000,
          streamIdleTimeoutMs: 600000,
        },
      },
      false,
    );
    expect(JSON.stringify(uncached)).not.toContain("cache_control");
  });

  test("parallel tool results retain IDs, image content, error information and precede text", () => {
    const input: any[] = [
      { type: "message", role: "user", content: "inspect" },
      { type: "function_call", callId: "a", name: "read", arguments: "{}" },
      { type: "function_call", callId: "b", name: "read", arguments: "{}" },
      { role: "user", content: "continue" },
      {
        type: "function_call_result",
        callId: "b",
        output: [{ type: "image", image: "data:image/png;base64,aGVsbG8=" }],
      },
      {
        type: "function_call_result",
        callId: "a",
        output: "failed",
        providerData: { anthropic: { is_error: true } },
      },
    ];
    const messages = anthropicMessages(input);
    expect(messages).toHaveLength(3);
    expect(messages[2]!.content.map((block) => block.type)).toEqual([
      "tool_result",
      "tool_result",
      "text",
    ]);
    expect(messages[2]!.content[0]!.tool_use_id).toBe("b");
    expect(messages[2]!.content[0]!.content[0].source.type).toBe("base64");
    expect(messages[2]!.content[1]!.is_error).toBe(true);
    expect(() => anthropicMessages(input.slice(0, 3))).toThrow("missing");
  });

  test("signed thinking round trips exactly, including redacted blocks", () => {
    const signed = { type: "thinking", thinking: "A thought", signature: "opaque-signature" };
    const redacted = { type: "redacted_thinking", data: "opaque-data" };
    const result = anthropicResponse(
      response([signed, redacted, { type: "text", text: "answer" }]),
    );
    const messages = anthropicMessages([
      { role: "user", content: "question" },
      ...result.output,
    ] as any);
    expect(messages[1]!.content.slice(0, 2)).toEqual([signed, redacted]);
    expect(result.usage.inputTokens).toBe(132);
    expect(result.usage.totalTokens).toBe(139);
    expect(result.usage.inputTokensDetails[0]).toEqual({
      cached_tokens: 100,
      cache_write_tokens: 30,
    });
  });

  test("assembles fragmented JSON and split UTF-8 before exposing a completed call", async () => {
    const wire = [
      { type: "message_start", message: response([], null as any) },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "read", input: {} },
      },
      ...["", '{"path":', '"æ.txt"}'].map((partial_json) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    const model = new AnthropicMessagesModel(provider, "claude", (async () =>
      stream(wire, true)) as typeof fetch);
    const got = await collect(model);
    expect(got.filter((event) => event.type === "response_done")).toHaveLength(1);
    const done: any = got.at(-1);
    expect(done.response.output[0].arguments).toBe('{"path":"æ.txt"}');
    expect(done.response.usage.outputTokens).toBe(10);
    expect(done.response.usage.inputTokens).toBe(132);
    expect(done.response.requestId).toBe("req_test");
    const broken = new AnthropicMessagesModel(provider, "claude", (async () =>
      stream(wire.slice(0, -1))) as typeof fetch);
    await expect(collect(broken)).rejects.toThrow("without message_stop");
  });

  test("SSE errors and truncated tool calls never yield completion", async () => {
    for (const wire of [
      events([{ type: "tool_use", id: "x", name: "run", input: {} }], "max_tokens"),
      [{ type: "error", error: { type: "overloaded_error" } }],
    ]) {
      const model = new AnthropicMessagesModel(provider, "claude", (async () =>
        stream(wire)) as typeof fetch);
      await expect(collect(model)).rejects.toThrow();
    }
  });

  test("uses separate key/bearer headers; abort propagates; HTTP failures never retry", async () => {
    for (const auth of ["api-key", "oauth"] as const) {
      let calls = 0;
      const abort = new AbortController();
      const model = new AnthropicMessagesModel(
        {
          ...provider,
          anthropic: {
            auth,
            cacheTtl: "1h",
            maxOutputTokens: 1000,
            streamIdleTimeoutMs: 600000,
            identity: {
              accountUuid: "10000000-0000-4000-8000-000000000001",
              deviceId: "a".repeat(64),
            },
          },
        },
        "claude",
        (async (url, init) => {
          calls++;
          expect(String(url)).toBe(
            "https://api.anthropic.com/v1/messages" + (auth === "oauth" ? "?beta=true" : ""),
          );
          const headers = new Headers(init?.headers);
          expect(headers.get(auth === "oauth" ? "authorization" : "x-api-key")).toBe(
            auth === "oauth" ? "Bearer test-key" : "test-key",
          );
          expect(headers.has(auth === "oauth" ? "x-api-key" : "authorization")).toBe(false);
          expect(init?.signal).toBe(abort.signal);
          return new Response("secret upstream body", { status: 429 });
        }) as typeof fetch,
      );
      await expect(model.getResponse({ ...request(), signal: abort.signal })).rejects.toThrow(
        "HTTP 429",
      );
      expect(calls).toBe(1);
    }
  });

  test("native catalog routing and history projection never use Chat conversion", async () => {
    const settings = testSettings({
      modelProvidersJson: JSON.stringify([
        {
          id: "claude",
          api: "anthropic-messages",
          baseUrl: provider.baseUrl,
          apiKey: "test",
          anthropic: { cacheTtl: "1h" },
          models: [{ id: "claude/test", upstreamModelId: "claude-test" }],
        },
      ]),
    });
    const model = await new MultiProviderModelProvider(settings).getModel("claude/test");
    expect(model).toBeInstanceOf(AnthropicMessagesModel);
    expect(configuredProviders(settings).find((p) => p.id === "claude")?.anthropic?.cacheTtl).toBe(
      "1h",
    );
    const history = [{ type: "message", role: "developer", content: "policy" }];
    expect(projectHistoryForProvider(history, "anthropic-messages")[0]!.role).toBe("system");
    expect(history[0]!.role).toBe("developer");
    expect(() =>
      projectHistoryForProvider([{ type: "compaction" }], "anthropic-messages"),
    ).toThrow();
    expect(isModelCallFetch("https://api.anthropic.com/v1/messages?beta=true")).toBe(true);
  });

  test("existing Agents SDK executes a tool once and supplies its result on the next call", async () => {
    let executions = 0;
    const sent: any[] = [];
    const model = new AnthropicMessagesModel(provider, "claude", (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          sent.length === 1
            ? response(
                [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "hello" } }],
                "tool_use",
              )
            : response([{ type: "text", text: "Done" }]),
        ),
      );
    }) as typeof fetch);
    const agent = new Agent({
      name: "Test",
      model,
      tools: [
        tool({
          name: "lookup",
          description: "Lookup",
          parameters: z.object({ key: z.string() }),
          execute: async ({ key }) => {
            executions++;
            return key + " result";
          },
        }),
      ],
    });
    const result = await new Runner({ tracingDisabled: true }).run(agent, "Look it up");
    expect(result.finalOutput).toBe("Done");
    expect(executions).toBe(1);
    expect(sent[1].messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
    });
  });
});

test("streamed namespaced tool names map back to the SDK's original identity", async () => {
  const req = request();
  req.tools = [
    {
      type: "function",
      name: "read",
      namespace: "workspace.files",
      description: "Read",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ];
  const body = buildAnthropicRequest(req, "claude", provider, true);
  const model = new AnthropicMessagesModel(provider, "claude", (async () =>
    stream(
      events(
        [{ type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: {} }],
        "tool_use",
      ),
    )) as typeof fetch);
  const result: any = (await collect(model, req)).at(-1);
  expect(result.response.output[0]).toMatchObject({ name: "read", namespace: "workspace.files" });
});

test("HTTP context overflow exposes a typed recovery signal without echoing input", async () => {
  const model = new AnthropicMessagesModel(
    provider,
    "claude",
    (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "prompt is too long: private user text",
          },
        }),
        { status: 400 },
      )) as typeof fetch,
  );
  try {
    await model.getResponse(request());
    throw new Error("expected failure");
  } catch (error: any) {
    expect(error.code).toBe("context_length_exceeded");
    expect(error.message).not.toContain("private user text");
  }
});

test("stream idle timeout cancels the body without accepting a partial response", async () => {
  let cancelled = false;
  const model = new AnthropicMessagesModel(
    {
      ...provider,
      anthropic: {
        auth: "api-key",
        cacheTtl: "off",
        maxOutputTokens: 100,
        streamIdleTimeoutMs: 10,
      },
    },
    "claude",
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  );
  await expect(collect(model)).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

test("stalled HTTP error diagnostics and cleanup preserve the known failure", async () => {
  let cancelled = false;
  const model = new AnthropicMessagesModel(
    { ...provider, anthropic: { streamIdleTimeoutMs: 10 } },
    "claude",
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        { status: 429, headers: { "request-id": "req_stalled", "retry-after": "7" } },
      )) as typeof fetch,
  );
  await expect(collect(model)).rejects.toMatchObject({
    status: 429,
    code: "anthropic_http_error",
    request_id: "req_stalled",
    headers: { "retry-after": "7" },
  });
  expect(cancelled).toBe(true);
}, 1000);

test("failed HTTP diagnostic reads do not replace status with a transport error", async () => {
  const model = new AnthropicMessagesModel(
    provider,
    "claude",
    (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private transport detail"));
          },
        }),
        { status: 503, headers: { "request-id": "req_failed_body", "retry-after": "2" } },
      )) as typeof fetch,
  );
  await expect(model.getResponse(request())).rejects.toMatchObject({
    status: 503,
    request_id: "req_failed_body",
    headers: { "retry-after": "2" },
    message: "Claude request failed (HTTP 503)",
  });
});

test("caller abort interrupts HTTP diagnostics even when transport cleanup stalls", async () => {
  const abort = new AbortController();
  const reason = new Error("caller stopped request");
  let cancelled = false;
  const model = new AnthropicMessagesModel(
    provider,
    "claude",
    (async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              abort.abort(reason);
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 429 },
      )) as typeof fetch,
  );
  await expect(model.getResponse({ ...request(), signal: abort.signal })).rejects.toBe(reason);
  expect(cancelled).toBe(true);
}, 1000);

test("native title and compaction calls handle output limits without accepting incomplete summaries", async () => {
  const { generateSessionTitle, summarizeForCompaction } = await import("../src/index");
  let stop = "end_turn";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/messages");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body.stream).toBe(false);
      return Response.json(response([{ type: "text", text: "Fix native stream truncat" }], stop));
    },
  });
  try {
    const native = { ...provider, baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const history = [{ type: "message", role: "user", content: "Repair streaming" }];
    const client = {} as any;
    expect(
      await summarizeForCompaction(testSettings(), history, {
        provider: native,
        client,
        model: "claude-test",
      }),
    ).toBe("Fix native stream truncat");
    stop = "max_tokens";
    await expect(
      summarizeForCompaction(testSettings(), history, {
        provider: native,
        client,
        model: "claude-test",
      }),
    ).rejects.toThrow();
    const title = await generateSessionTitle(testSettings(), "Repair streaming", {
      provider: native,
      client,
      modelName: "claude-test",
    });
    expect(title.title).toBe("Fix native stream");
    expect(history).toEqual([{ type: "message", role: "user", content: "Repair streaming" }]);
  } finally {
    server.stop(true);
  }
});

test("forced tool selection suppresses incompatible adaptive thinking", () => {
  const req = request();
  req.tools = [
    {
      type: "function",
      name: "lookup",
      description: "lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ];
  req.modelSettings = {
    toolChoice: "required",
    reasoning: { effort: "high" },
    parallelToolCalls: false,
  };
  const body = buildAnthropicRequest(req, "claude-test", provider, false);
  expect(body.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
  expect(body.thinking).toBeUndefined();
});

test("HTTP and SSE rate limits preserve retry timing without leaking response data", async () => {
  const { providerRetryAfterMs } =
    await import("../../../apps/worker/src/activities/agent-turn/errors");
  for (const streamed of [false, true]) {
    const headers = { "retry-after": "120", "set-cookie": "private-cookie" };
    const model = new AnthropicMessagesModel(provider, "claude-test", (async () =>
      streamed
        ? new Response(
            stream([
              {
                type: "error",
                error: { type: "rate_limit_error", message: "private-provider-message" },
              },
            ]).body,
            { headers },
          )
        : new Response(
            JSON.stringify({
              error: { type: "rate_limit_error", message: "private-provider-message" },
            }),
            { status: 429, headers },
          )) as typeof fetch);
    let error: any;
    try {
      if (streamed) {
        for await (const _ of model.getStreamedResponse(request())) {
        }
      } else await model.getResponse(request());
    } catch (e) {
      error = e;
    }
    expect(error.status).toBe(429);
    expect(providerRetryAfterMs(error)).toBe(120000);
    expect(JSON.stringify(error)).not.toContain("private");
  }
});

test("malformed completed responses cannot create duplicate tools or unsigned thinking", () => {
  const call = { type: "tool_use", id: "same", name: "lookup", input: {} };
  expect(() => anthropicResponse(response([call, call], "tool_use"))).toThrow("Duplicate");
  expect(() => anthropicResponse(response([], "tool_use"))).toThrow("no tool calls");
  expect(() => anthropicResponse(response([{ type: "thinking", thinking: "hello" }]))).toThrow(
    "signature",
  );
  expect(() => anthropicResponse(response([{ type: "text", text: null }]))).toThrow(
    "response text",
  );
});

test("forced namespaced tools use their wire name and ambiguous identities fail locally", () => {
  const req = request();
  req.tools = [
    {
      type: "function",
      name: "lookup",
      namespace: "catalog",
      description: "lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ];
  req.modelSettings = { toolChoice: "lookup" };
  const body = buildAnthropicRequest(req, "claude-test", provider, false);
  expect(body.tool_choice.name).toBe(body.tools[0].name);
  req.tools.push({ ...req.tools[0]!, namespace: "other" } as any);
  expect(() => buildAnthropicRequest(req, "claude-test", provider, false)).toThrow("exactly one");
  req.modelSettings = {};
  req.tools = [req.tools[0]!, req.tools[0]!];
  expect(() => buildAnthropicRequest(req, "claude-test", provider, false)).toThrow("Duplicate");
});

test("stream authentication failures remain permanent rather than becoming retryable server errors", async () => {
  const model = new AnthropicMessagesModel(provider, "claude-test", (async () =>
    stream([
      { type: "error", error: { type: "authentication_error", message: "do not persist" } },
    ])) as typeof fetch);
  let error: any;
  try {
    for await (const _ of model.getStreamedResponse(request())) {
    }
  } catch (e) {
    error = e;
  }
  expect(error.status).toBe(401);
  expect(String(error)).not.toContain("do not persist");
});
