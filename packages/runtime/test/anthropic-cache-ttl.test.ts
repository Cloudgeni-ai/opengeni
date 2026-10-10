import { beforeEach, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  AnthropicMessagesModel,
  anthropicCacheTtlForRequest,
  buildAnthropicRequest,
  resetAnthropicCacheTtlState,
} from "../src/anthropic-messages";

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
const MODEL = "claude-opus-5-5";
const MINUTE = 60_000;

function request(providerData?: Record<string, unknown>): ModelRequest {
  return {
    input: "Hello",
    systemInstructions: "Instructions",
    modelSettings: providerData ? { providerData } : {},
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      } as any,
    ],
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}
const session = (key = "session-1") => request({ prompt_cache_key: key });

beforeEach(() => resetAnthropicCacheTtlState());

function ttl(
  policy: "off" | "warm_1h" | "always_1h",
  req: ModelRequest,
  now = 0,
  options: { provider?: ResolvedModelProvider; model?: string } = {},
) {
  return anthropicCacheTtlForRequest({
    policy,
    provider: options.provider ?? provider,
    model: options.model ?? MODEL,
    request: req,
    now,
  }).ttl;
}

function okFetch(calls: string[]) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(JSON.stringify(body.tools?.[0]?.cache_control ?? null));
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

test("policy off and non-default TTLs keep the static configuration", () => {
  expect(ttl("off", session())).toBe("5m");
  for (const cacheTtl of ["1h", "off"] as const) {
    const configured = {
      ...provider,
      anthropic: {
        auth: "api-key" as const,
        cacheTtl,
        maxOutputTokens: 1000,
        streamIdleTimeoutMs: 1,
      },
    };
    expect(ttl("always_1h", session(), 0, { provider: configured })).toBe(cacheTtl);
    expect(ttl("warm_1h", session(), 0, { provider: configured })).toBe(cacheTtl);
  }
});

test("gateways, Bedrock-style endpoints and non-native models are never changed", () => {
  const gateway = { ...provider, baseUrl: "https://gateway.example/v1" };
  expect(ttl("always_1h", session(), 0, { provider: gateway })).toBe("5m");
  expect(ttl("always_1h", session(), 0, { model: "claude-test" })).toBe("5m");
  for (const kind of ["anthropic-workspace", "claude-subscription-organization"] as const) {
    expect(ttl("always_1h", session(), 0, { provider: { ...provider, kind } as never })).toBe("1h");
  }
});

test("always_1h marks every request and portable compaction writes nothing", () => {
  expect(ttl("always_1h", request())).toBe("1h");
  expect(ttl("always_1h", session())).toBe("1h");
  const compaction = request({ prompt_cache_key: "session-1", opengeni_portable_compaction: true });
  expect(ttl("always_1h", compaction)).toBe("off");
  expect(ttl("warm_1h", compaction)).toBe("off");
  const body = buildAnthropicRequest(compaction, MODEL, provider, false, "off");
  expect(JSON.stringify(body)).not.toContain("cache_control");
});

test("an explicit TTL marks every breakpoint", () => {
  const body = buildAnthropicRequest(session(), MODEL, provider, false, "1h");
  expect(body.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(body.system[0].cache_control).toEqual(body.tools[0].cache_control);
  expect(body.messages[0].content[0].cache_control).toEqual(body.tools[0].cache_control);
  expect(buildAnthropicRequest(session(), MODEL, provider, false).tools[0].cache_control).toEqual({
    type: "ephemeral",
    ttl: "5m",
  });
});

test("warm_1h upgrades only requests whose session cache is known to be alive", async () => {
  const calls: string[] = [];
  const model = new AnthropicMessagesModel(provider, MODEL, okFetch(calls), {
    cacheTtlPolicy: "warm_1h",
  });
  // No session identity: nothing to track.
  expect(ttl("warm_1h", request())).toBe("5m");
  // Cold first request writes the whole prefix at 5m and is remembered.
  await model.getResponse(session());
  expect(calls).toEqual(['{"type":"ephemeral","ttl":"5m"}']);
  const now = Date.now();
  expect(ttl("warm_1h", session(), now + 4 * MINUTE)).toBe("1h");
  expect(ttl("warm_1h", session(), now + 5 * MINUTE)).toBe("5m");
  expect(ttl("warm_1h", session("other"), now)).toBe("5m");
  expect(ttl("warm_1h", session(), now, { model: "claude-sonnet-5-5" })).toBe("5m");
  // The next request on a warm cache is marked 1h, which then lasts an hour.
  await model.getResponse(session());
  expect(calls[1]).toBe('{"type":"ephemeral","ttl":"1h"}');
  const after = Date.now();
  expect(ttl("warm_1h", session(), after + 50 * MINUTE)).toBe("1h");
  expect(ttl("warm_1h", session(), after + 60 * MINUTE)).toBe("5m");
});

test("failed requests and the default policy record no cache state", async () => {
  const off = new AnthropicMessagesModel(provider, MODEL, okFetch([]));
  await off.getResponse(session());
  expect(ttl("warm_1h", session(), Date.now())).toBe("5m");
  const failing = new AnthropicMessagesModel(
    provider,
    MODEL,
    (async () => new Response("no", { status: 500 })) as typeof fetch,
    { cacheTtlPolicy: "warm_1h" },
  );
  await expect(failing.getResponse(session())).rejects.toThrow();
  expect(ttl("warm_1h", session(), Date.now())).toBe("5m");
});
