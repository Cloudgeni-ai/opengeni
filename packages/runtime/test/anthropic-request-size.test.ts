import { expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { anthropicCompactionRequest } from "../src/anthropic-compaction";
import { buildSummaryItem } from "../src/context-compaction";
import {
  ANTHROPIC_REQUEST_MAX_BYTES,
  AnthropicRequestSizeError,
  anthropicRequestSize,
  findAnthropicRequestSizeError,
} from "../src/anthropic-request-size";

const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://example.test/v1",
  apiKey: "synthetic-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};
const request = (input: string): ModelRequest => ({
  input,
  systemInstructions: "Synthetic instructions",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
});
const response = () =>
  Response.json({
    id: "msg_synthetic",
    content: [{ type: "text", text: "Done" }],
    stop_reason: "end_turn",
    usage: {},
  });

test("size facts use UTF-8 wire bytes and only count actual image blocks", () => {
  const body = {
    system: [{ type: "text", text: "你好" }],
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "YWJj" } },
          {
            type: "tool_result",
            content: [
              { type: "image", source: { type: "url", url: "https://example.test/image" } },
            ],
          },
          {
            type: "tool_use",
            input: { type: "image", source: { type: "base64", data: "do not count" } },
          },
        ],
      },
    ],
  };
  const serialized = JSON.stringify(body);
  expect(anthropicRequestSize(body, serialized)).toEqual({
    requestBytes: Buffer.byteLength(serialized),
    imageCount: 2,
    imageBase64Bytes: 4,
    systemBytes: Buffer.byteLength(JSON.stringify(body.system)),
    toolsBytes: 2,
    limitBytes: ANTHROPIC_REQUEST_MAX_BYTES,
  });
});

test("preflight rejects a UTF-8 oversized body without dispatch or secret diagnostics", async () => {
  let calls = 0;
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () => {
    calls++;
    return response();
  }) as typeof fetch);
  const error = await model
    .getResponse(request("界".repeat(8_000_001)))
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AnthropicRequestSizeError);
  expect(calls).toBe(0);
  const failure = error as AnthropicRequestSizeError;
  expect(failure.rejection).toBe("preflight");
  expect(failure.requestSize.requestBytes).toBeGreaterThan(ANTHROPIC_REQUEST_MAX_BYTES);
  expect(JSON.stringify(failure)).not.toContain("synthetic-key");
  expect(JSON.stringify(failure)).not.toContain("界");
});

test.each(["api-key", "oauth"] as const)(
  "measurement includes final %s identity additions",
  async (auth) => {
    let sentBytes = 0;
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
      "claude-opus-5-5",
      (async (_url, init) => {
        sentBytes = Buffer.byteLength(String(init?.body));
        return response();
      }) as typeof fetch,
    );
    const input = request("Hello 👋");
    const measured = await model.measureRequest(input);
    expect(sentBytes).toBe(0);
    await model.getResponse(input);
    expect(measured.requestBytes).toBe(sentBytes);
  },
);

test("the first HTTP 413 is typed, retains only size facts, and is never retried by transport", async () => {
  let calls = 0;
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async () => {
    calls++;
    return new Response("do not retain an echoed secret", {
      status: 413,
      headers: { "request-id": "req_synthetic" },
    });
  }) as typeof fetch);
  const failure = await model
    .getResponse(request("small proxy rejection"))
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AnthropicRequestSizeError);
  expect(calls).toBe(1);
  expect((failure as AnthropicRequestSizeError).rejection).toBe("http_413");
  expect((failure as AnthropicRequestSizeError).request_id).toBe("req_synthetic");
  expect(findAnthropicRequestSizeError(new Error("SDK wrapper", { cause: failure }))).toBe(failure);
  expect(
    findAnthropicRequestSizeError({ status: 413, message: "unrelated upload error" }),
  ).toBeNull();
  expect(JSON.stringify(failure)).not.toContain("echoed secret");
});

test.each(["checkpoint", "continuation"] as const)(
  "%s uses the supported thinking reset without altering signed history",
  async (phase) => {
    const signed = {
      type: "thinking",
      thinking: "synthetic thought",
      signature: "unchanged-signature",
    };
    const input = [
      ...(phase === "continuation" ? [buildSummaryItem("Earlier work is checkpointed.")] : []),
      { type: "message", role: "user", content: "Inspect" },
      { type: "reasoning", providerData: { anthropic: { block: signed } } },
      { type: "function_call", callId: "done", name: "inspect", arguments: "{}" },
      { type: "function_call_result", callId: "done", output: "Already completed; do not replay." },
    ];
    const req =
      phase === "checkpoint"
        ? anthropicCompactionRequest(input, { maxOutputTokens: 4096 })
        : ({ ...request(""), input } as ModelRequest);
    const before = JSON.stringify(req);
    let sentBytes = 0;
    const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (_url, init) => {
      sentBytes = Buffer.byteLength(String(init?.body));
      expect(new Headers(init?.headers).get("anthropic-beta")).toContain(
        "thinking-binding-controls-2026-08-01",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toMatchObject({
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      });
      expect(body.messages.flatMap((message: any) => message.content)).toContainEqual(signed);
      return Response.json({
        id: "msg_synthetic",
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
        usage: {},
        input_transformations: [
          {
            type: "thinking_dropped",
            reason: "prefix_binding_mismatch",
            path: "messages.1.content.0",
            ignoredSecret: "not retained",
          },
          { type: "thinking_dropped", reason: "unknown-secret-value" },
        ],
      });
    }) as typeof fetch);
    const measured = await model.measureRequest(req);
    const result = await model.getResponse(req);
    expect(measured.requestBytes).toBe(sentBytes);
    expect(result.providerData?.anthropic?.thinkingBlocksDropped).toEqual({
      prefix_binding_mismatch: 1,
    });
    expect(JSON.stringify(result.providerData)).not.toContain("secret");
    expect(JSON.stringify(req)).toBe(before);
  },
);

test("ordinary unchanged prefixes and older models do not opt into thinking resets", async () => {
  for (const modelId of ["claude-opus-5-5", "claude-opus-4-6"]) {
    const model = new AnthropicMessagesModel(provider, modelId, (async (_url, init) => {
      expect(new Headers(init?.headers).get("anthropic-beta") ?? "").not.toContain(
        "thinking-binding-controls",
      );
      expect(JSON.parse(String(init?.body)).thinking?.block_binding).toBeUndefined();
      return response();
    }) as typeof fetch);
    await model.getResponse(
      modelId === "claude-opus-4-6"
        ? anthropicCompactionRequest([{ role: "user", content: "Old model checkpoint" }], {
            maxOutputTokens: 4096,
          })
        : request("An unchanged ordinary request"),
    );
  }
});
