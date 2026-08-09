import { describe, expect, test } from "bun:test";
import { OpenAIChatCompletionsModel, OpenAIResponsesModel, RunContext } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  configuredProviders,
  resolveModelProvider,
  type ResolvedModelProvider,
} from "@opengeni/config";
import {
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
  CODEX_TRANSPORT_ERROR_HEADER,
  MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
  MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES,
  boundModelToolOutputItem,
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexRequestContext,
} from "@opengeni/codex";
import { testSettings } from "@opengeni/testing";
import OpenAI from "openai";
import {
  buildModelInstance,
  buildOpenGeniAgent,
  buildOpenAIClientFromSettings,
  buildProviderClient,
  CodexSubscriptionUnavailableError,
  HUMAN_INPUT_TOOL_NAME,
  modelRequestPolicyForProvider,
  MultiProviderModelProvider,
  resolveTurnModel,
  summarizeForCompaction,
  vercelGatewayRoutingFetch,
} from "../src/index";
import { ReplayableJsonOpenAI, requestBodyText } from "../src/replayable-json-body";

describe("Vercel AI Gateway request fence", () => {
  test("replaces caller routing for both Gateway billing paths", async () => {
    for (const kind of ["vercel-gateway-managed", "vercel-gateway-workspace"] as const) {
      let captured: Record<string, unknown> | null = null;
      const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const routed = vercelGatewayRoutingFetch(kind, inner);
      await routed("https://ai-gateway.vercel.sh/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash-0731",
          providerOptions: {
            gateway: { only: ["somewhere-else"], models: ["fallback/model"] },
            deepseek: { includeReasoning: true },
          },
        }),
      });
      expect(captured?.providerOptions).toEqual({
        gateway: {
          only: ["baseten", "novita", "deepinfra"],
          order: ["baseten", "novita", "deepinfra"],
          caching: "auto",
        },
        deepseek: { includeReasoning: true },
      });
    }
  });

  test("orders normal Kimi across only the approved Baseten and Fireworks routes", async () => {
    let captured: Record<string, unknown> | null = null;
    const routed = vercelGatewayRoutingFetch("vercel-gateway-managed", (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await routed("https://ai-gateway.vercel.sh/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "moonshotai/kimi-k3" }),
    });
    expect(captured?.providerOptions).toEqual({
      gateway: {
        only: ["baseten", "fireworks"],
        order: ["baseten", "fireworks"],
        caching: "auto",
      },
    });
  });

  test("pairs only complete Kimi parallel call/result batches without changing their fields", async () => {
    let captured: Record<string, unknown> | null = null;
    const routed = vercelGatewayRoutingFetch("vercel-gateway-managed", (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const callA = {
      type: "function_call",
      call_id: "call-a",
      name: "alpha",
      arguments: "{}",
      status: "completed",
    };
    const callB = {
      type: "function_call",
      call_id: "call-b",
      name: "beta",
      arguments: "{}",
      status: "completed",
    };
    const resultA = {
      type: "function_call_output",
      call_id: "call-a",
      output: "alpha-result",
      status: "completed",
    };
    const resultB = {
      type: "function_call_output",
      call_id: "call-b",
      output: "beta-result",
      status: "completed",
    };
    await routed("https://ai-gateway.vercel.sh/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        parallel_tool_calls: true,
        input: [{ type: "reasoning", summary: [] }, callA, callB, resultA, resultB],
      }),
    });

    expect(captured?.parallel_tool_calls).toBe(true);
    expect(captured?.input).toEqual([
      { type: "reasoning", summary: [] },
      callA,
      resultA,
      callB,
      resultB,
    ]);
  });

  test("does not alter incomplete Kimi or complete DeepSeek call/result batches", async () => {
    for (const value of [
      {
        model: "moonshotai/kimi-k3",
        input: [
          {
            type: "function_call",
            call_id: "a",
            name: "alpha",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "b",
            name: "beta",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "a", output: "done" },
        ],
      },
      {
        model: "deepseek/deepseek-v4-flash-0731",
        input: [
          {
            type: "function_call",
            call_id: "a",
            name: "alpha",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "b",
            name: "beta",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "a", output: "one" },
          { type: "function_call_output", call_id: "b", output: "two" },
        ],
      },
    ]) {
      let captured: Record<string, unknown> | null = null;
      const routed = vercelGatewayRoutingFetch("vercel-gateway-managed", (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }) as typeof fetch);
      await routed("https://ai-gateway.vercel.sh/v1/responses", {
        method: "POST",
        body: JSON.stringify(value),
      });
      expect(captured?.input).toEqual(value.input);
    }
  });

  test("unknown models fail before network I/O", async () => {
    let calls = 0;
    const routed = vercelGatewayRoutingFetch("vercel-gateway-managed", (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch);
    await expect(
      routed("https://ai-gateway.vercel.sh/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "unreviewed/model" }),
      }),
    ).rejects.toThrow("approved catalogue");
    expect(calls).toBe(0);
  });

  test("cancels an upstream error body before returning the synthetic error", async () => {
    let cancelled = false;
    const routed = vercelGatewayRoutingFetch(
      "vercel-gateway-managed",
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("upstream detail"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        )) as typeof fetch,
    );
    const response = await routed("https://ai-gateway.vercel.sh/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "moonshotai/kimi-k3" }),
    });
    expect(response.status).toBe(503);
    expect(cancelled).toBe(true);
    expect(await response.json()).toEqual({
      error: {
        type: "model_unavailable",
        message: "The selected model is temporarily unavailable.",
      },
    });
  });
});

// The synthetic codex-subscription provider the worker overlay
// (settingsWithCodexCredential → withCodexProvider) injects into runSettings for
// a workspace with an ACTIVE Codex subscription. Mirrors capabilities.ts.
const CODEX_TURN_MODEL = `${CODEX_MODEL_ID_PREFIX}gpt-5.6-sol`;

type PinnedResponsesModule = {
  getInputItems: (input: unknown[]) => unknown[];
};

async function pinnedResponsesModule(): Promise<PinnedResponsesModule> {
  const request = createRequire(import.meta.url);
  const agentsRequest = createRequire(request.resolve("@openai/agents"));
  const modulePath = join(
    dirname(agentsRequest.resolve("@openai/agents-openai")),
    "openaiResponsesModel.mjs",
  );
  return (await import(modulePath)) as PinnedResponsesModule;
}

function codexTestContext(): CodexRequestContext {
  const token = {
    accessToken: "test-token",
    chatgptAccountId: "test-account",
    isFedramp: false,
  };
  return {
    clientVersion: "largeoutput-test",
    getToken: async () => token,
    refresh: async () => token,
    resolveModel: (model) => model,
  };
}

function codexProviderJson(): string {
  return JSON.stringify([
    {
      kind: "codex-subscription",
      id: CODEX_PROVIDER_ID,
      label: "Codex (ChatGPT subscription)",
      api: "responses",
      baseUrl: CODEX_PROVIDER_BASE_URL,
      models: [{ id: CODEX_TURN_MODEL, label: "gpt-5.6-sol", reasoningEffort: true }],
    },
  ]);
}

describe("pinned Responses large-output boundary", () => {
  test("serializes a 10,000-part mixed bounded result entirely inside the pinned wire union", async () => {
    const { getInputItems } = await pinnedResponsesModule();
    const raw = {
      type: "function_call_result",
      callId: "call_mixed_10000",
      status: "completed",
      output: Array.from({ length: 10_000 }, (_, index): Record<string, unknown> => {
        if (index % 3 === 0) return { type: "input_text", text: `text-${index}` };
        if (index % 3 === 1) {
          return {
            type: "input_image",
            image: `data:image/png;base64,a${index}`,
          };
        }
        return {
          type: "input_file",
          file: { id: `file_${index}` },
          filename: `${index}.txt`,
        };
      }),
    };

    const bounded = boundModelToolOutputItem(raw);
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
    const [wire] = getInputItems([bounded]) as Array<Record<string, unknown>>;
    expect(wire).toMatchObject({
      type: "function_call_output",
      call_id: "call_mixed_10000",
      status: "completed",
    });
    const output = wire.output as Array<Record<string, unknown>>;
    expect(output.length).toBeGreaterThan(1);
    expect(output.length).toBeLessThanOrEqual(256);
    for (const part of output) {
      expect(["input_text", "input_image", "input_file"]).toContain(part.type);
      if (part.type === "input_text") expect(typeof part.text).toBe("string");
      if (part.type === "input_image") {
        expect(typeof (part.image_url ?? part.file_id)).toBe("string");
      }
      if (part.type === "input_file") {
        expect(typeof (part.file_data ?? part.file_url ?? part.file_id)).toBe("string");
      }
    }
    expect(output.at(-1)).toEqual({
      type: "input_text",
      text: expect.stringMatching(/^\[OpenGeni omitted \d+ structured array items\]$/),
    });
  });

  test("serializes oversized file omission as pinned input_text, never a fake file_url", async () => {
    const { getInputItems } = await pinnedResponsesModule();
    const bounded = boundModelToolOutputItem({
      type: "function_call_result",
      callId: "call_oversized_file",
      output: [
        {
          type: "input_file",
          file: `data:application/pdf;base64,${"a".repeat(
            MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES,
          )}`,
          filename: "oversized.pdf",
        },
      ],
    });
    const [wire] = getInputItems([bounded]) as Array<Record<string, unknown>>;
    expect(wire.output).toEqual([
      {
        type: "input_text",
        text: expect.stringMatching(/^\[OpenGeni omitted file payload: \d+ bytes exceeded/),
      },
    ]);
    expect(JSON.stringify(wire.output)).not.toContain("file_url");
  });

  test("serializes exhausted image IDs as omission image_url values, never fake file_id values", async () => {
    const { getInputItems } = await pinnedResponsesModule();
    const prefix = "data:application/octet-stream;base64,";
    const bounded = boundModelToolOutputItem({
      type: "function_call_result",
      callId: "call_exhausted_image_ids",
      output: [
        {
          type: "input_file",
          fileData: `${prefix}${"a".repeat(
            MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES - Buffer.byteLength(prefix, "utf8"),
          )}`,
          filename: "allowance.bin",
        },
        { type: "input_image", fileId: "file_123" },
        { type: "input_image", image: { id: "file_456" } },
      ],
    });

    const [wire] = getInputItems([bounded]) as Array<Record<string, unknown>>;
    const output = wire.output as Array<Record<string, unknown>>;
    expect(output.slice(1)).toEqual([
      {
        type: "input_image",
        image_url: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
      },
      {
        type: "input_image",
        image_url: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
      },
    ]);
    expect(output.slice(1).some((part) => "file_id" in part)).toBe(false);
    expect(JSON.stringify(output.slice(1))).not.toContain("file_123");
    expect(JSON.stringify(output.slice(1))).not.toContain("file_456");
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
  });
});

describe("pinned Responses streamed terminal failures", () => {
  const terminalCases = [
    {
      name: "response.failed",
      event: {
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: {
            type: "server_error",
            code: "server_error",
            message: "SECRET response.failed provider detail",
          },
        },
      },
      expected: {
        status: 502,
        code: "server_error",
        type: "server_error",
        eventType: "response.failed",
        responseId: "resp_failed",
        responseStatus: "failed",
      },
      sentinel: "SECRET response.failed provider detail",
    },
    {
      name: "nested response.error",
      event: {
        type: "response.error",
        response: {
          id: "resp_error",
          status: "failed",
          error: {
            code: "invalid_prompt",
            message: "SECRET nested response.error provider detail",
          },
        },
      },
      expected: {
        status: 400,
        code: "invalid_prompt",
        type: "invalid_prompt",
        eventType: "response.error",
        responseId: "resp_error",
        responseStatus: "failed",
      },
      sentinel: "SECRET nested response.error provider detail",
    },
    {
      name: "top-level error",
      event: {
        type: "error",
        code: "rate_limit_exceeded",
        message: "SECRET top-level error provider detail",
      },
      expected: {
        status: 429,
        code: "rate_limit_exceeded",
        type: "rate_limit_exceeded",
        eventType: "error",
      },
      sentinel: "SECRET top-level error provider detail",
    },
    {
      name: "response.incomplete",
      event: {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete",
          status: "incomplete",
          incomplete_details: { reason: "SECRET provider incomplete reason" },
        },
      },
      expected: {
        status: 502,
        code: "response_incomplete",
        type: "response_incomplete",
        eventType: "response.incomplete",
        responseId: "resp_incomplete",
        responseStatus: "incomplete",
      },
      sentinel: "SECRET provider incomplete reason",
    },
    {
      name: "missing terminal",
      event: { type: "response.created", response: { id: "resp_missing" } },
      expected: {
        status: 502,
        code: "invalid_sse_terminal",
        type: "invalid_sse_terminal",
      },
    },
  ] as const;

  for (const terminalCase of terminalCases) {
    test(`real OpenAIResponsesModel rejects ${terminalCase.name} without response_done or replay`, async () => {
      let calls = 0;
      const client = new OpenAI({
        apiKey: "test-key",
        baseURL: CODEX_PROVIDER_BASE_URL,
        maxRetries: 2,
        fetch: codexSubscriptionFetch(async () => {
          calls += 1;
          return new Response(`data: ${JSON.stringify(terminalCase.event)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      });
      const model = new OpenAIResponsesModel(client, "gpt-5.6-sol");
      const events: Array<{ type?: unknown }> = [];
      let observed: unknown;

      await codexRequestStorage.run(codexTestContext(), async () => {
        try {
          for await (const event of model.getStreamedResponse({
            input: "bounded terminal test",
            modelSettings: {},
            tools: [],
            handoffs: [],
            outputType: "text",
            tracing: false,
          } as never)) {
            events.push(event);
          }
        } catch (error) {
          observed = error;
        }
      });

      expect(calls).toBe(1);
      expect(events.some((event) => event.type === "response_done")).toBe(false);
      expect(observed).toMatchObject(terminalCase.expected);
      expect((observed as { headers?: Headers }).headers?.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe(
        "1",
      );
      const serialized = JSON.stringify({
        message: (observed as Error).message,
        error: (observed as { error?: unknown }).error,
      });
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(2_000);
      if ("sentinel" in terminalCase) {
        expect(serialized).toContain(terminalCase.sentinel);
      } else {
        expect(serialized).not.toContain("SECRET");
      }
    });
  }

  test("real OpenAIResponsesModel rejects a null accepted stream without response_done or replay", async () => {
    let calls = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: CODEX_PROVIDER_BASE_URL,
      maxRetries: 2,
      fetch: codexSubscriptionFetch(async () => {
        calls += 1;
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });
    const model = new OpenAIResponsesModel(client, "gpt-5.6-sol");
    const events: Array<{ type?: unknown }> = [];
    let observed: unknown;

    await codexRequestStorage.run(codexTestContext(), async () => {
      try {
        for await (const event of model.getStreamedResponse({
          input: "null terminal test",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        } as never)) {
          events.push(event);
        }
      } catch (error) {
        observed = error;
      }
    });

    expect(calls).toBe(1);
    expect(events.some((event) => event.type === "response_done")).toBe(false);
    expect(observed).toMatchObject({
      status: 502,
      code: "invalid_sse_terminal",
      type: "invalid_sse_terminal",
    });
    expect((observed as { headers?: Headers }).headers?.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe(
      "1",
    );
  });
});

type DirectResponsesEvent = Record<string, unknown> & { type: string };

function responseMessage(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

async function consumeDirectResponses(
  events: DirectResponsesEvent[],
  options: { keepSocketOpenAfterEvents?: boolean } = {},
) {
  let calls = 0;
  let streamCancelled = false;
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://responses.example.test/v1",
    maxRetries: 0,
    fetch: async () => {
      calls += 1;
      const encodedEvents = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const body = options.keepSocketOpenAfterEvents
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(encodedEvents));
            },
            cancel() {
              streamCancelled = true;
            },
          })
        : encodedEvents;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const model = new OpenAIResponsesModel(client, "test-model");
  const observed: Array<Record<string, unknown>> = [];
  let error: unknown;
  try {
    for await (const event of model.getStreamedResponse({
      input: "test",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as never)) {
      observed.push(event as unknown as Record<string, unknown>);
    }
  } catch (caught) {
    error = caught;
  }
  return { calls, events: observed, error, streamCancelled };
}

async function consumeDirectNonStreaming(status?: string) {
  let calls = 0;
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://responses.example.test/v1",
    maxRetries: 0,
    fetch: async () => {
      calls += 1;
      return Response.json({
        id: "direct-response",
        ...(status === undefined ? {} : { status }),
        output: [],
        usage: null,
      });
    },
  });
  const model = new OpenAIResponsesModel(client, "test-model");
  try {
    const response = await getOrCreateTrace(() =>
      model.getResponse({
        input: "test",
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as never),
    );
    return { calls, response, error: undefined };
  } catch (error) {
    return { calls, response: undefined, error };
  }
}

describe("pinned Responses protocol conformance", () => {
  for (const terminal of [
    {
      type: "response.failed",
      response: {
        id: "failed",
        status: "failed",
        output: [],
        error: { message: "provider failed" },
      },
    },
    {
      type: "response.incomplete",
      response: {
        id: "incomplete",
        status: "incomplete",
        output: [],
        incomplete_details: { reason: "limit" },
      },
    },
  ]) {
    test(`fails closed on ${terminal.type}`, async () => {
      const result = await consumeDirectResponses([terminal]);
      expect(result.calls).toBe(1);
      expect(result.error).toBeInstanceOf(Error);
      expect(String((result.error as Error).message)).toContain(terminal.type);
      expect(String((result.error as Error).message)).not.toContain("provider failed");
      expect(result.events.some((event) => event.type === "response_done")).toBe(false);
    });
  }

  for (const status of ["failed", "incomplete", "cancelled", "queued", "in_progress"]) {
    test(`fails closed on non-streaming ${status} status`, async () => {
      const result = await consumeDirectNonStreaming(status);
      expect(result.calls).toBe(1);
      expect(result.response).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(String((result.error as Error).message)).toContain(
        status === "failed" || status === "incomplete"
          ? `response.${status}`
          : "response.non_completed",
      );
    });
  }

  for (const status of ["completed", undefined]) {
    test(`accepts a non-streaming ${status ?? "omitted"} status`, async () => {
      const result = await consumeDirectNonStreaming(status);
      expect(result.calls).toBe(1);
      expect(result.error).toBeUndefined();
      expect(result.response?.responseId).toBe("direct-response");
    });
  }

  test("fails closed when the stream ends without a terminal", async () => {
    const result = await consumeDirectResponses([
      {
        type: "response.created",
        response: { id: "missing", status: "in_progress" },
      },
    ]);
    expect(String((result.error as Error).message)).toContain("without a terminal");
    expect(result.events.some((event) => event.type === "response_done")).toBe(false);
  });

  test("reconstructs empty terminal output by output_index, not arrival order", async () => {
    const result = await consumeDirectResponses([
      {
        type: "response.output_item.done",
        output_index: 1,
        item: responseMessage("message-b", "B"),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage("message-a", "A"),
      },
      {
        type: "response.completed",
        response: {
          id: "completed",
          status: "completed",
          output: [],
          usage: null,
        },
      },
    ]);
    expect(result.error).toBeUndefined();
    const terminalModel = result.events.find(
      (event) =>
        event.type === "model" &&
        (event.event as { type?: unknown } | undefined)?.type === "response.completed",
    );
    const output = (terminalModel?.event as { response?: { output?: Array<{ id?: string }> } })
      ?.response?.output;
    expect(output?.map((item) => item.id)).toEqual(["message-a", "message-b"]);
    expect(result.events.filter((event) => event.type === "response_done")).toHaveLength(1);
  });

  test("fails closed on duplicate output indices", async () => {
    const result = await consumeDirectResponses([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage("message-a", "A"),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage("message-b", "B"),
      },
      {
        type: "response.completed",
        response: {
          id: "completed",
          status: "completed",
          output: [],
          usage: null,
        },
      },
    ]);
    expect(String((result.error as Error).message)).toContain("duplicate output_item.done index");
    expect(result.events.some((event) => event.type === "response_done")).toBe(false);
  });

  test("treats the first successful terminal as the protocol boundary", async () => {
    const result = await consumeDirectResponses([
      {
        type: "response.completed",
        response: { id: "first", status: "completed", output: [], usage: null },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage("late", "late"),
      },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "response_done")).toHaveLength(1);
    expect(
      result.events.some(
        (event) =>
          event.type === "model" &&
          (event.event as { type?: unknown } | undefined)?.type === "response.output_item.done",
      ),
    ).toBe(false);
  });

  test("does not wait for socket EOF after a successful terminal", async () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        consumeDirectResponses(
          [
            {
              type: "response.completed",
              response: {
                id: "terminal",
                status: "completed",
                output: [],
                usage: null,
              },
            },
          ],
          { keepSocketOpenAfterEvents: true },
        ),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("terminal event did not stop stream consumption")),
            1_000,
          );
        }),
      ]);
      expect(result.error).toBeUndefined();
      expect(result.streamCancelled).toBe(true);
      expect(result.events.filter((event) => event.type === "response_done")).toHaveLength(1);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });

  test("keeps a non-empty terminal output authoritative", async () => {
    const result = await consumeDirectResponses([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: responseMessage("done-copy", "done"),
      },
      {
        type: "response.completed",
        response: {
          id: "completed",
          status: "completed",
          output: [responseMessage("terminal-copy", "terminal")],
          usage: null,
        },
      },
    ]);
    expect(result.error).toBeUndefined();
    const terminalModel = result.events.find(
      (event) =>
        event.type === "model" &&
        (event.event as { type?: unknown } | undefined)?.type === "response.completed",
    );
    const output = (terminalModel?.event as { response?: { output?: Array<{ id?: string }> } })
      ?.response?.output;
    expect(output?.map((item) => item.id)).toEqual(["terminal-copy"]);
  });

  test("deterministically fuzzes valid permutations and malformed terminal traces", async () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const shuffle = <T>(values: T[]): T[] => {
      const out = [...values];
      for (let index = out.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [out[index], out[other]] = [out[other]!, out[index]!];
      }
      return out;
    };

    for (let iteration = 0; iteration < 32; iteration += 1) {
      const count = 1 + Math.floor(random() * 6);
      const items = Array.from({ length: count }, (_, outputIndex) => ({
        type: "response.output_item.done",
        output_index: outputIndex,
        item: responseMessage(`message-${outputIndex}`, String(outputIndex)),
      }));
      const result = await consumeDirectResponses([
        ...shuffle(items),
        {
          type: "response.completed",
          response: {
            id: `valid-${iteration}`,
            status: "completed",
            output: [],
            usage: null,
          },
        },
      ]);
      expect(result.error).toBeUndefined();
      expect(result.events.filter((event) => event.type === "response_done")).toHaveLength(1);
      const rawTerminal = result.events.find(
        (event) =>
          event.type === "model" &&
          (event.event as { type?: unknown } | undefined)?.type === "response.completed",
      );
      const output = (rawTerminal?.event as { response?: { output?: Array<{ id?: string }> } })
        ?.response?.output;
      expect(output?.map((item) => item.id)).toEqual(
        Array.from({ length: count }, (_, index) => `message-${index}`),
      );
    }

    const malformedCases: DirectResponsesEvent[][] = [
      [{ type: "response.created", response: { id: "unterminated" } }],
      [
        {
          type: "response.output_item.done",
          output_index: 2,
          item: responseMessage("sparse", "sparse"),
        },
        {
          type: "response.completed",
          response: {
            id: "sparse",
            status: "completed",
            output: [],
            usage: null,
          },
        },
      ],
      [
        {
          type: "response.output_item.done",
          output_index: 0,
          item: responseMessage("duplicate-a", "a"),
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: responseMessage("duplicate-b", "b"),
        },
      ],
      [
        {
          type: "response.failed",
          response: {
            id: "failed",
            status: "failed",
            output: [],
            error: { message: "failed" },
          },
        },
      ],
    ];
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const result = await consumeDirectResponses(
        malformedCases[Math.floor(random() * malformedCases.length)]!,
      );
      expect(result.error).toBeInstanceOf(Error);
      expect(result.events.some((event) => event.type === "response_done")).toBe(false);
    }
  });
});

// A host exposing the built-in OpenAI provider plus Fireworks (the `chat` wire
// API) serving GLM 5.2, mirroring the canonical example in
// docs/model-providers.md. webSearch and encrypted reasoning are OFF for the
// Fireworks model (hostedWebSearch defaults false; chat has no encrypted
// reasoning), which is exactly the gating the runtime must apply.
function multiProviderSettings(overrides: Parameters<typeof testSettings>[0] = {}) {
  return testSettings({
    sandboxBackend: "none",
    openaiProvider: "openai",
    openaiModel: "gpt-5.6-sol",
    openaiAllowedModels: "gpt-5.6-sol,gpt-5.4",
    modelProvidersJson: JSON.stringify([
      {
        id: "fireworks",
        label: "Fireworks AI",
        api: "chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "fw-test-key",
        defaultHeaders: { "x-fireworks": "on" },
        models: [
          {
            id: "accounts/fireworks/models/glm-5p2",
            label: "GLM 5.2",
            contextWindowTokens: 1_048_576,
            reasoningEffort: true,
            hostedWebSearch: false,
          },
        ],
      },
    ]),
    ...overrides,
  });
}

const FIREWORKS_MODEL = "accounts/fireworks/models/glm-5p2";

describe("buildModelInstance — chat vs responses Model selection per provider api", () => {
  const client = new OpenAI({ apiKey: "test" });

  test("a chat provider yields an OpenAIChatCompletionsModel", () => {
    const provider: ResolvedModelProvider = {
      id: "fireworks",
      label: "Fireworks AI",
      kind: "api-key",
      api: "chat",
      builtin: false,
    };
    const model = buildModelInstance(provider, client, FIREWORKS_MODEL);
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(model).not.toBeInstanceOf(OpenAIResponsesModel);
  });

  test("a responses provider yields an OpenAIResponsesModel", () => {
    const provider: ResolvedModelProvider = {
      id: "openai",
      label: "OpenAI",
      kind: "api-key",
      api: "responses",
      builtin: true,
    };
    const model = buildModelInstance(provider, client, "gpt-5.6-sol");
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    expect(model).not.toBeInstanceOf(OpenAIChatCompletionsModel);
  });

  test("normalizes a subscription request at the owned object stage and strips internal handoff headers", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders = new Headers();
    let requestIds = 0;
    const opaqueObservations: Array<{
      requestId: string;
      fingerprints: readonly string[];
    }> = [];
    const provider: ResolvedModelProvider = {
      id: CODEX_PROVIDER_ID,
      label: "Subscription",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
    };
    const subscriptionClient = new ReplayableJsonOpenAI(
      {
        apiKey: "placeholder",
        baseURL: CODEX_PROVIDER_BASE_URL,
        maxRetries: 0,
        fetch: codexSubscriptionFetch(async (_input, init) => {
          capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
          capturedHeaders = new Headers(init?.headers);
          return new Response(
            'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":null}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }),
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    const model = buildModelInstance(provider, subscriptionClient, "gpt-5.6-sol");
    await codexRequestStorage.run(
      {
        ...codexTestContext(),
        nextRequestId: () => `request-${++requestIds}`,
        onRequestOpaqueArtifacts: (observation) => opaqueObservations.push(observation),
      },
      async () => {
        for await (const _event of model.getStreamedResponse({
          input: "hello",
          modelSettings: { maxTokens: 123 },
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        } as never)) {
          // consume
        }
      },
    );
    expect(requestIds).toBe(1);
    expect(capturedBody).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(capturedBody && "max_output_tokens" in capturedBody).toBe(false);
    expect(capturedHeaders.get("x-opengeni-request-body-normalized")).toBeNull();
    expect(capturedHeaders.get("x-opengeni-request-model")).toBeNull();
    expect(capturedHeaders.get("x-opengeni-request-id")).toBeNull();
    expect(capturedHeaders.get("idempotency-key")).toBe("request-1");
    expect(opaqueObservations).toEqual([{ requestId: "request-1", fingerprints: [] }]);
  });

  test("collects subscription compaction through the object-stage streaming path", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders = new Headers();
    const provider: ResolvedModelProvider = {
      id: CODEX_PROVIDER_ID,
      label: "Subscription",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
    };
    const compactionClient = new ReplayableJsonOpenAI(
      {
        apiKey: "placeholder",
        baseURL: CODEX_PROVIDER_BASE_URL,
        maxRetries: 0,
        fetch: codexSubscriptionFetch(async (_input, init) => {
          capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
          capturedHeaders = new Headers(init?.headers);
          return new Response(
            [
              'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"compact","annotations":[],"logprobs":[]}]}}',
              'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":null}}',
              "",
            ].join("\n\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }),
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    const summary = await codexRequestStorage.run(codexTestContext(), () =>
      summarizeForCompaction(
        multiProviderSettings(),
        [{ type: "message", role: "user", content: "compact me" }],
        {
          client: compactionClient,
          provider,
          api: "responses",
          model: "gpt-5.6-sol",
          maxOutputTokens: 50,
        },
      ),
    );

    expect(summary).toBe("compact");
    expect(capturedBody).toMatchObject({ stream: true, store: false });
    expect(capturedBody && "max_output_tokens" in capturedBody).toBe(false);
    expect(capturedHeaders.get("x-opengeni-request-body-normalized")).toBeNull();
  });

  test("preserves a non-streaming subscription caller over the streaming-only wire", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders = new Headers();
    const provider: ResolvedModelProvider = {
      id: CODEX_PROVIDER_ID,
      label: "Subscription",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
    };
    const subscriptionClient = new ReplayableJsonOpenAI(
      {
        apiKey: "placeholder",
        baseURL: CODEX_PROVIDER_BASE_URL,
        maxRetries: 0,
        fetch: codexSubscriptionFetch(async (_input, init) => {
          capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
          capturedHeaders = new Headers(init?.headers);
          return new Response(
            [
              'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done","annotations":[],"logprobs":[]}]}],"usage":null}}',
              "",
            ].join("\n\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }),
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    const model = buildModelInstance(provider, subscriptionClient, "gpt-5.6-sol");

    const response = await codexRequestStorage.run(codexTestContext(), () =>
      getOrCreateTrace(() =>
        model.getResponse({
          input: "hello",
          modelSettings: {},
          tools: [],
          handoffs: [],
          outputType: "text",
          tracing: false,
        } as never),
      ),
    );

    expect(capturedBody).toMatchObject({ stream: true, store: false });
    expect(capturedHeaders.get("x-opengeni-request-caller-stream")).toBeNull();
    expect(response.output).toHaveLength(1);
  });

  test("normalizes Gateway routing at the owned object stage without leaking its handoff header", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders = new Headers();
    const provider: ResolvedModelProvider = {
      id: "gateway",
      label: "Gateway",
      kind: "vercel-gateway-managed",
      api: "responses",
      builtin: false,
    };
    const gatewayClient = new ReplayableJsonOpenAI(
      {
        apiKey: "test",
        baseURL: "https://ai-gateway.vercel.sh/v1",
        maxRetries: 0,
        fetch: vercelGatewayRoutingFetch("vercel-gateway-managed", async (_input, init) => {
          capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
          capturedHeaders = new Headers(init?.headers);
          return new Response(
            'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":null}}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }),
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );
    const model = buildModelInstance(provider, gatewayClient, "moonshotai/kimi-k3");
    for await (const _event of model.getStreamedResponse({
      input: "hello",
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as never)) {
      // consume
    }
    expect(capturedBody?.providerOptions).toEqual({
      gateway: {
        only: ["baseten", "fireworks"],
        order: ["baseten", "fireworks"],
        caching: "auto",
      },
    });
    expect(capturedHeaders.get("x-opengeni-gateway-request-body-normalized")).toBeNull();
  });

  test("applies the same Gateway object policy to Chat Completions", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const provider: ResolvedModelProvider = {
      id: "gateway-chat",
      label: "Gateway Chat",
      kind: "vercel-gateway-managed",
      api: "chat",
      builtin: false,
    };
    const gatewayChatClient = new ReplayableJsonOpenAI(
      {
        apiKey: "test",
        baseURL: "https://ai-gateway.vercel.sh/v1",
        maxRetries: 0,
        fetch: vercelGatewayRoutingFetch("vercel-gateway-managed", async (_input, init) => {
          capturedBody = JSON.parse(await requestBodyText(init?.body)) as Record<string, unknown>;
          return Response.json({
            id: "chat-1",
            object: "chat.completion",
            created: 0,
            model: "moonshotai/kimi-k3",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
            ],
          });
        }),
      },
      { modelRequestPolicy: modelRequestPolicyForProvider(provider) },
    );

    await gatewayChatClient.chat.completions.create({
      model: "moonshotai/kimi-k3",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedBody?.providerOptions).toEqual({
      gateway: {
        only: ["baseten", "fireworks"],
        order: ["baseten", "fireworks"],
        caching: "auto",
      },
    });
  });

  test("provider policies never mutate converted input retained for the next request", () => {
    const callA = Object.freeze({ type: "function_call", call_id: "a" });
    const callB = Object.freeze({ type: "function_call", call_id: "b" });
    const resultA = Object.freeze({ type: "function_call_output", call_id: "a" });
    const resultB = Object.freeze({ type: "function_call_output", call_id: "b" });
    const gatewayInput = Object.freeze([callA, callB, resultA, resultB]);
    const gatewayBody = Object.freeze({
      model: "moonshotai/kimi-k3",
      input: gatewayInput,
    });
    const gatewayPolicy = modelRequestPolicyForProvider({
      id: "gateway-copy-on-write",
      label: "Gateway",
      kind: "vercel-gateway-managed",
      api: "responses",
      builtin: false,
    });
    const gatewayResult = gatewayPolicy({ path: "/responses", body: gatewayBody });
    expect(gatewayBody.input).toEqual([callA, callB, resultA, resultB]);
    expect(gatewayResult?.body?.input).toEqual([callA, resultA, callB, resultB]);
    expect(gatewayResult?.body?.input).not.toBe(gatewayInput);

    const computerCall = Object.freeze({
      type: "computer_call",
      action: Object.freeze({ type: "screenshot" }),
      actions: Object.freeze([{ type: "screenshot" }]),
    });
    const screenshotOutput = Object.freeze({ type: "computer_screenshot", image_url: "" });
    const computerOutput = Object.freeze({
      type: "computer_call_output",
      output: screenshotOutput,
    });
    const azureInput = Object.freeze([computerCall, computerOutput]);
    const azureBody = Object.freeze({ model: "gpt-5.6-sol", input: azureInput });
    const azurePolicy = modelRequestPolicyForProvider({
      id: "azure",
      label: "Azure OpenAI",
      kind: "api-key",
      api: "responses",
      builtin: true,
    });
    const azureResult = azurePolicy({ path: "/responses", body: azureBody });
    const projected = azureResult?.body?.input as Array<Record<string, unknown>>;
    expect(computerCall).toHaveProperty("action");
    expect(screenshotOutput.image_url).toBe("");
    expect(projected[0]).not.toHaveProperty("action");
    expect(projected[0]?.actions).toEqual([{ type: "screenshot" }]);
    const projectedImageUrl = (projected[1]?.output as Record<string, unknown> | undefined)
      ?.image_url;
    expect(projectedImageUrl).toBeString();
    expect((projectedImageUrl as string).length).toBeGreaterThan(0);
  });
});

describe("buildProviderClient", () => {
  test("a registry provider gets a client pointed at its base URL with its key/headers, cached by id", () => {
    const settings = multiProviderSettings();
    const provider = configuredProviders(settings).find(
      (candidate) => candidate.id === "fireworks",
    )!;
    expect(provider).toBeDefined();
    const client = buildProviderClient(provider, settings);
    expect(client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(client.apiKey).toBe("fw-test-key");
    expect(client.maxRetries).toBe(settings.openaiMaxRetries);
    // One client per provider id (module-level cache).
    expect(buildProviderClient(provider, settings)).toBe(client);
  });

  test("Codex disables blind SDK retries and leaves timeout ownership to its transport", () => {
    const settings = multiProviderSettings();
    const provider: ResolvedModelProvider = {
      id: "codex-subscription-no-retry-test",
      label: "Codex subscription",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
      apiKey: "placeholder",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const client = buildProviderClient(provider, settings);
    expect(settings.openaiMaxRetries).toBeGreaterThan(0);
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(35 * 60_000);
  });
});

describe("resolveTurnModel", () => {
  test("returns null for a model not in any provider (legacy global-client fallback)", () => {
    expect(resolveTurnModel(multiProviderSettings(), "model-that-does-not-exist")).toBeNull();
  });

  test("keeps the canonical product id in configuration while binding the provider model to the upstream slug", () => {
    const settings = multiProviderSettings({
      modelProvidersJson: JSON.stringify([
        {
          id: "acme",
          api: "responses",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "acme-test-key",
          models: [
            {
              id: "acme/product-model",
              upstreamModelId: "provider-deployment-slug",
            },
          ],
        },
      ]),
    });

    const resolved = resolveTurnModel(settings, "acme/product-model");
    expect(resolved).not.toBeNull();
    expect(resolved!.configured.id).toBe("acme/product-model");
    expect(resolved!.configured.upstreamModelId).toBe("provider-deployment-slug");
    expect((resolved!.model as unknown as { _model: string })._model).toBe(
      "provider-deployment-slug",
    );
  });

  test("resolves a registry model to its provider, client, chat Model, and configured shape", () => {
    const resolved = resolveTurnModel(multiProviderSettings(), FIREWORKS_MODEL);
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("fireworks");
    expect(resolved!.provider.api).toBe("chat");
    expect(resolved!.client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(resolved!.model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(resolved!.configured.id).toBe(FIREWORKS_MODEL);
    expect(resolved!.configured.contextWindowTokens).toBe(1_048_576);
    expect(resolved!.configured.hostedWebSearch).toBe(false);
  });

  test("resolves the built-in model to the responses provider + an OpenAIResponsesModel", () => {
    const resolved = resolveTurnModel(multiProviderSettings(), "gpt-5.6-sol");
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("openai");
    expect(resolved!.provider.api).toBe("responses");
    expect(resolved!.model).toBeInstanceOf(OpenAIResponsesModel);
  });
});

// The agent the worker builds for a Fireworks turn passes the resolved gating
// into buildOpenGeniAgent. These tests pin that the gating actually changes the
// constructed agent the way the multi-provider contract requires.
function webSearchHostedTools(
  agent: ReturnType<typeof buildOpenGeniAgent>,
): Array<Record<string, unknown>> {
  return ((agent as { tools?: Array<Record<string, unknown>> }).tools ?? []).filter(
    (tool) =>
      tool.type === "hosted_tool" &&
      (tool.providerData as { type?: unknown } | undefined)?.type === "web_search",
  );
}

describe("multi-provider gating in buildOpenGeniAgent", () => {
  test("publishes a final Office artifact only through the verified host adapter", async () => {
    const settings = multiProviderSettings({ sandboxBackend: "docker" });
    const environment = {
      OPENGENI_ARTIFACT_RUNTIME_MANIFEST: "/opt/opengeni/artifacts/installation.json",
      OPENGENI_ARTIFACT_TOOL_ENTRY: "/opt/opengeni/artifacts/skill-facade-entry.mjs",
    };
    expect(
      buildOpenGeniAgent(settings, [], {
        artifactRuntimeAvailable: true,
        sandboxEnvironment: environment,
      }).tools.some(
        (tool) => tool.type === "function" && tool.name === "publish_editable_artifact",
      ),
    ).toBe(false);
    expect(() =>
      buildOpenGeniAgent(settings, [], {
        editableArtifactPublication: {
          execute: async () => {
            throw new Error("unreachable");
          },
        },
      }),
    ).toThrow("requires a verified artifact runtime");

    const calls: unknown[] = [];
    const receipt = {
      type: "editable_artifact" as const,
      schemaVersion: 1 as const,
      artifact: {
        id: "a".repeat(32),
        modality: "document" as const,
        title: "Board report",
      },
      sourceFile: {
        id: "11111111-1111-4111-8111-111111111111",
        filename: "board-report.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
        sizeBytes: 4_096,
        sha256: "b".repeat(64),
      },
      editorPath: `/workspaces/22222222-2222-4222-8222-222222222222/artifacts/editable/${"a".repeat(32)}`,
    };
    const agent = buildOpenGeniAgent(settings, [], {
      artifactRuntimeAvailable: true,
      sandboxEnvironment: environment,
      editableArtifactPublication: {
        execute: async (input, context) => {
          calls.push({ input, context });
          return receipt;
        },
      },
    });
    const tool = agent.tools.find(
      (candidate) =>
        candidate.type === "function" && candidate.name === "publish_editable_artifact",
    );
    if (!tool || tool.type !== "function") throw new Error("publication tool missing");
    expect(
      await tool.invoke(
        new RunContext(),
        JSON.stringify({
          path: "/workspace/board-report.docx",
          title: "Board report",
          modality: "document",
        }),
        {
          toolCall: {
            type: "function_call",
            callId: "call-publish-1",
            name: "publish_editable_artifact",
            arguments: "{}",
          },
        },
      ),
    ).toEqual(receipt);
    expect(calls).toEqual([
      {
        input: {
          path: "/workspace/board-report.docx",
          title: "Board report",
          modality: "document",
        },
        context: { toolCallId: "call-publish-1" },
      },
    ]);
  });

  test("selects exactly one image transport without changing the stable tool intent", async () => {
    const settings = multiProviderSettings();
    const native = buildOpenGeniAgent(settings, [], {
      imageGeneration: { kind: "native_hosted" },
    });
    const nativeImageTools = native.tools.filter(
      (tool) =>
        tool.type === "hosted_tool" &&
        (tool.providerData as { type?: unknown } | undefined)?.type === "image_generation",
    );
    expect(nativeImageTools).toHaveLength(1);
    expect(
      native.tools.some((tool) => tool.type === "function" && tool.name === "generate_image"),
    ).toBe(false);

    const calls: Array<{ prompt: string; toolCallId: string }> = [];
    const adapter = buildOpenGeniAgent(settings, [], {
      imageGeneration: {
        kind: "provider_adapter",
        execute: async (input, context) => {
          calls.push({ ...input, ...context });
          return {
            type: "generated_image",
            artifact: { artifactId: "artifact-1" },
          };
        },
      },
    });
    expect(
      adapter.tools.some(
        (tool) =>
          tool.type === "hosted_tool" &&
          (tool.providerData as { type?: unknown } | undefined)?.type === "image_generation",
      ),
    ).toBe(false);
    const tool = adapter.tools.find(
      (candidate) => candidate.type === "function" && candidate.name === "generate_image",
    );
    if (!tool || tool.type !== "function") throw new Error("generate_image tool missing");
    const output = await tool.invoke(
      new RunContext(),
      JSON.stringify({ prompt: "a blue sphere" }),
      {
        toolCall: {
          type: "function_call",
          callId: "call-image-1",
          name: "generate_image",
          arguments: "{}",
        },
      },
    );
    expect(calls).toEqual([{ prompt: "a blue sphere", toolCallId: "call-image-1" }]);
    expect(output).toEqual({ type: "generated_image", artifact: { artifactId: "artifact-1" } });
  });

  test("a resolved chat provider turn: no web_search tool, no encrypted reasoning, no server store", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, FIREWORKS_MODEL)!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    // hostedWebSearch off removes only web search; structured human input is a
    // provider-neutral built-in on every agent.
    expect(webSearchHostedTools(agent)).toHaveLength(0);
    expect(
      ((agent as { tools?: Array<{ name?: unknown }> }).tools ?? []).map((tool) => tool.name),
    ).toEqual([HUMAN_INPUT_TOOL_NAME]);
    // encryptedReasoning off (chat wire API) → no providerData.include.
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toBeUndefined();
    // Durable local compaction does not add provider-side context management.
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBeUndefined();
    // The provider-bound Model instance is the one passed in (chat routing).
    expect((agent as { model?: unknown }).model).toBe(resolved.model);
  });

  test("the built-in responses turn keeps web_search and encrypted reasoning without inline compaction", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, "gpt-5.6-sol")!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    expect(webSearchHostedTools(agent)).toHaveLength(1);
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toEqual({ include: ["reasoning.encrypted_content"] });
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBeUndefined();
    expect(
      (agent as { modelSettings: { providerData?: Record<string, unknown> } }).modelSettings
        .providerData?.context_management,
    ).toBeUndefined();
  });

  test("an accepted responses transport carries the stable session prompt_cache_key", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, "gpt-5.6-sol")!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
      promptCacheKey: "session-123",
    });
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toEqual({
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
    });
  });

  test("an excluded registry chat transport does not carry prompt_cache_key when no key is passed", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, FIREWORKS_MODEL)!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    expect(
      (agent as { modelSettings: { providerData?: Record<string, unknown> } }).modelSettings
        .providerData?.prompt_cache_key,
    ).toBeUndefined();
  });

  test("resolveModelProvider/configuredProviders agree on each provider's wire API", () => {
    const settings = multiProviderSettings();
    const fireworks = resolveModelProvider(settings, FIREWORKS_MODEL);
    expect(fireworks?.provider.api).toBe("chat");
    const builtin = resolveModelProvider(settings, "gpt-5.6-sol");
    expect(builtin?.provider.api).toBe("responses");
  });
});

describe("MultiProviderModelProvider — routes a model NAME to its provider (the sandbox-path fix)", () => {
  // The bug: on the SandboxAgent/Modal path the per-agent Model instance is
  // dropped and the model NAME is re-resolved through the default model
  // provider. Without this router that hit the built-in (Azure) client, so a
  // Fireworks model 404'd ("deployment does not exist"). The router resolves
  // names back to their provider regardless of path.
  const routedFireworksModel = "accounts/fireworks/models/glm-5p2";

  test("routes a registry model name to a chat-completions Model (NOT the built-in)", async () => {
    const provider = new MultiProviderModelProvider(multiProviderSettings());
    const model = await provider.getModel(routedFireworksModel);
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(model).not.toBeInstanceOf(OpenAIResponsesModel);
  });

  test("with an AZURE built-in (the staging config), glm still routes to Fireworks chat, not Azure", async () => {
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    const provider = new MultiProviderModelProvider(settings);
    const glm = await provider.getModel(FIREWORKS_MODEL);
    expect(glm).toBeInstanceOf(OpenAIChatCompletionsModel);
    const builtin = await provider.getModel("gpt-5.6-sol");
    expect(builtin).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("a codex/<slug> id with NO codex provider in settings throws the actionable error (NOT an Azure fallback)", async () => {
    // The staging failure: codex_subscription_credentials empty → the worker
    // overlay never injects the codex provider → resolveTurnModel returns null
    // for "codex/gpt-5.6-sol". The router must NOT fall through to the built-in
    // (Azure) client (which 404'd with "DeploymentNotFound"); it must throw a
    // user-actionable error telling the user to connect their subscription.
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    const provider = new MultiProviderModelProvider(settings);
    let thrown: unknown;
    try {
      await provider.getModel("codex/gpt-5.6-sol");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexSubscriptionUnavailableError);
    expect((thrown as Error).message).toContain("codex/gpt-5.6-sol");
    expect((thrown as Error).message).toContain("Codex subscription");
    expect((thrown as Error).message).toContain("Settings");
    // No status/code → agentRunFailurePayload surfaces it as a non-retryable
    // turn.failed (not a rate-limit retry).
    expect((thrown as { status?: unknown }).status).toBeUndefined();
    expect((thrown as { code?: unknown }).code).toBeUndefined();
  });

  test("codex × selfhosted/connected-machine: a codex/<slug> turn routes to the CODEX client, never Azure", async () => {
    // The staging incident: a codex turn on workspace 3989dda7 (ACTIVE codex
    // subscription) ran on the selfhosted/connected-machine backend and 404'd
    // with Azure DeploymentNotFound. Model resolution is backend-agnostic — it
    // runs in the worker through the one shared MultiProviderModelProvider(runSettings)
    // path — so a `selfhosted` backend with the codex provider injected must
    // resolve codex/gpt-5.6-sol to the codex-subscription client (baseUrl =
    // chatgpt.com/backend-api, fetch: codexSubscriptionFetch), NOT the Azure
    // built-in. runSettings.openaiModel is the codex id (the worker overwrites
    // it per-turn) — exactly the input that used to trigger the built-in shadow.
    const settings = multiProviderSettings({
      sandboxBackend: "selfhosted",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL, // worker per-turn overwrite (runSettings)
      modelProvidersJson: codexProviderJson(),
    });
    const resolved = resolveTurnModel(settings, CODEX_TURN_MODEL)!;
    expect(resolved).not.toBeNull();
    expect(resolved.provider.kind).toBe("codex-subscription");
    expect(resolved.provider.builtin).toBe(false);
    // The client points at the ChatGPT backend, NOT the Azure deployment URL.
    expect(resolved.client.baseURL).toBe(CODEX_PROVIDER_BASE_URL);
    expect(resolved.client.baseURL).not.toBe("https://example.openai.azure.com/openai/v1");
    // It is a distinct client from the built-in (Azure) one configureOpenAI builds.
    expect(resolved.client).not.toBe(buildOpenAIClientFromSettings(settings));
    // The router (the load-bearing sandbox-path resolver) agrees.
    const model = await new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL);
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("codex × in-process (sandboxBackend 'none') still routes to the codex client (unchanged by the fix)", async () => {
    const settings = multiProviderSettings({
      sandboxBackend: "none",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL,
      modelProvidersJson: codexProviderJson(),
    });
    const resolved = resolveTurnModel(settings, CODEX_TURN_MODEL)!;
    expect(resolved.provider.kind).toBe("codex-subscription");
    expect(resolved.client.baseURL).toBe(CODEX_PROVIDER_BASE_URL);
    const model = await new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL);
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("fail-loud floor: a codex/ id that resolves to a NON-codex provider is refused (never shipped to Azure)", async () => {
    // Defense in depth (the getModel kind-guard): even if a future settings path
    // re-introduced a shadow binding codex/gpt-5.6-sol to the built-in (Azure)
    // provider, the router must refuse it rather than ship the id as an Azure
    // deployment name. Construct exactly that pathological resolution by putting
    // the codex id in the built-in allow-list WITHOUT the codex provider, then
    // assert the router throws instead of returning an Azure-bound model.
    // (configuredModels filters codex/ out of the built-in list, so this asserts
    // the runtime guard independently of the config-layer fix.)
    const settings = multiProviderSettings({
      sandboxBackend: "selfhosted",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL,
      openaiAllowedModels: CODEX_TURN_MODEL,
      modelProvidersJson: "[]", // codex provider NOT injected → no real owner
    });
    // With the config fix, codex/ is filtered from the built-in list, so the id
    // is unexposed and getModel throws via the no-resolution codex branch.
    await expect(
      new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL),
    ).rejects.toBeInstanceOf(CodexSubscriptionUnavailableError);
  });

  test("P0 regression: a codex-active run provider resolves codex/* even after the GLOBAL default is clobbered by a non-codex turn", async () => {
    // The staging incident: the worker runs ~100 activities concurrently. A codex
    // turn injects the codex provider into ITS settings, but a concurrent
    // non-codex turn's configureOpenAI overwrote the PROCESS-GLOBAL default
    // provider with settings that have NO codex provider. The fix pins a
    // run-scoped provider built from the run's OWN settings, so name resolution is
    // immune to the global clobber. This test simulates the clobber and asserts
    // the per-run provider still resolves codex/<slug>.
    const { configureOpenAI } = await import("../src/index");
    const codexProvider = {
      kind: "codex-subscription" as const,
      id: "codex-subscription",
      label: "Codex (ChatGPT subscription)",
      api: "responses" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      models: [
        {
          id: "codex/gpt-5.6-sol",
          label: "gpt-5.6-sol",
          reasoningEffort: true,
        },
      ],
    };
    // The codex turn's OWN settings (codex provider injected).
    const codexSettings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      modelProvidersJson: JSON.stringify([codexProvider]),
    });
    // A foreign, concurrent non-codex turn clobbers the process-global default.
    const nonCodexSettings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    // Build the run-scoped provider FIRST (as runScopedRunner does at run start)…
    const runScopedProvider = new MultiProviderModelProvider(codexSettings);
    // …then let the foreign turn overwrite the global default provider mid-run.
    configureOpenAI(nonCodexSettings);
    // The run-scoped provider resolves codex/* from its own settings — no throw.
    const model = await runScopedProvider.getModel("codex/gpt-5.6-sol");
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    // Proof the clobber matters: a provider built from the FOREIGN turn's
    // (non-codex) settings — i.e. what the process-global default now points at —
    // would throw on the very same name. The run-scoped provider's immunity is
    // exactly what the fix buys.
    const clobberedProvider = new MultiProviderModelProvider(nonCodexSettings);
    await expect(clobberedProvider.getModel("codex/gpt-5.6-sol")).rejects.toBeInstanceOf(
      CodexSubscriptionUnavailableError,
    );
  });

  test("falls back to the built-in default provider for a model in no provider's allow-list", async () => {
    // In production configureOpenAI sets a global default key/client; mirror that
    // so the SDK fallback OpenAIProvider can construct a model rather than erroring
    // on missing credentials.
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-fallback";
    try {
      const provider = new MultiProviderModelProvider(multiProviderSettings());
      const model = await provider.getModel("some-unconfigured-model");
      expect(model).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("registry model shadowing is closed — the built-in never claims a namespaced registry id", () => {
  // The worker overrides settings.openaiModel to the TURN's model. For a turn on
  // a registry model that override USED to make the built-in provider claim the
  // id (configuredModels derived the built-in's models from openaiModel) and
  // shadow the registry entry — resolving the turn to the built-in (Azure)
  // client and 404'ing on a sandbox/connected-machine backend that re-resolves
  // the model NAME. configuredModels now filters any `<provider>/<model>`-namespaced
  // id a registry owns (and any `codex/` id) out of the built-in allow-list, so
  // the registry provider wins even when its id is the turn's openaiModel.
  const azure = () =>
    multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });

  test("against deployment-default settings, a registry model resolves to its registry provider with gating off", () => {
    const resolved = resolveTurnModel(azure(), FIREWORKS_MODEL)!;
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.provider.api).toBe("chat");
    expect(resolved.configured.hostedWebSearch).toBe(false);
  });

  test("against turn-overridden settings (openaiModel = the registry id) the registry provider STILL wins — no Azure shadow", () => {
    const resolved = resolveTurnModel(
      { ...azure(), openaiModel: FIREWORKS_MODEL },
      FIREWORKS_MODEL,
    )!;
    // Previously the built-in (Azure) shadowed this; the namespaced-id filter
    // keeps it bound to its registry provider and a chat-completions Model.
    expect(resolved.provider.builtin).toBe(false);
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.provider.api).toBe("chat");
    expect(resolved.configured.hostedWebSearch).toBe(false);
    expect(resolved.model).toBeInstanceOf(OpenAIChatCompletionsModel);
  });

  test("the run-scoped provider routes a unique bare registry turn model to its registry provider", async () => {
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: "scripted-1",
      openaiAllowedModels: "gpt-5.6-sol,gpt-5.4",
      modelProvidersJson: JSON.stringify([
        {
          id: "scripted",
          baseUrl: "http://127.0.0.1:8399/v1",
          apiKey: "dummy",
          models: [{ id: "scripted-1", label: "Scripted" }],
        },
      ]),
    });
    const model = await new MultiProviderModelProvider(settings).getModel("scripted-1");
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
  });

  test("fails loud when a registry redeclares a bare built-in product id", () => {
    // Ambiguous canonical ownership must never depend on declaration order or
    // silently choose a provider/billing path.
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: "gpt-5.6-sol",
      modelProvidersJson: JSON.stringify([
        {
          id: "shadow",
          baseUrl: "https://api.shadow.test/v1",
          apiKey: "shadow-key",
          models: [{ id: "gpt-5.6-sol", label: "Shadowed" }, { id: "shadow/only" }],
        },
      ]),
    });
    expect(() => resolveTurnModel(settings, "gpt-5.6-sol")).toThrow(
      'model id "gpt-5.6-sol" is declared by both azure and shadow',
    );
  });
});
