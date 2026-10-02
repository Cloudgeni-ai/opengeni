import { expect, test } from "bun:test";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { CLAUDE_CODE_HEADERS, claudeCodeFingerprint } from "../src/claude-code-identity";
import type { ResolvedModelProvider } from "@opengeni/config";
import type { ModelRequest } from "@openai/agents";

const identity = { accountUuid: "10000000-0000-4000-8000-000000000001", deviceId: "a".repeat(64) };
const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-token",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
  anthropic: {
    auth: "oauth",
    cacheTtl: "1h",
    maxOutputTokens: 32000,
    streamIdleTimeoutMs: 600000,
    identity,
  },
};
const request: ModelRequest = {
  input: "A deterministic request for Claude.",
  systemInstructions: "OpenGeni instructions",
  modelSettings: {
    reasoning: { effort: "high" },
    providerData: { prompt_cache_key: "20000000-0000-4000-8000-000000000002" },
  },
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};
const result = {
  id: "msg_test",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

test("subscription wire identity matches the pinned client while request identifiers stay scoped", async () => {
  const sent: Array<{ url: URL; headers: Headers; body: any }> = [];
  const model = new AnthropicMessagesModel(provider, "claude-opus-5-5", (async (url, init) => {
    sent.push({
      url: new URL(String(url)),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json(result, { headers: { "request-id": `req_${sent.length}` } });
  }) as typeof fetch);
  const before = JSON.stringify(request);
  await model.getResponse(request);
  await model.getResponse(request);
  const a = sent[0]!,
    b = sent[1]!;
  expect(a.url.search).toBe("?beta=true");
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS))
    expect(a.headers.get(name)).toBe(value);
  expect(a.headers.get("authorization")).toBe("Bearer test-token");
  expect(a.headers.has("x-api-key")).toBe(false);
  expect(a.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(a.headers.get("x-client-request-id")).not.toBe(b.headers.get("x-client-request-id"));
  expect(a.headers.get("x-claude-code-prompt-id")).toBe(b.headers.get("x-claude-code-prompt-id"));
  const metadata = JSON.parse(a.body.metadata.user_id);
  expect(metadata).toEqual({
    account_uuid: identity.accountUuid,
    device_id: identity.deviceId,
    session_id: request.modelSettings.providerData!.prompt_cache_key,
  });
  expect(a.headers.get("x-claude-code-session-id")).toBe(metadata.session_id);
  expect(a.body.system[0].text).toContain(
    `cc_version=2.1.285.${claudeCodeFingerprint(request.input)};`,
  );
  expect(a.body.system[0].text).not.toContain("cc_prev_req");
  expect(b.body.system[0].text).toContain("cc_prev_req=req_1;");
  expect(a.body.system[1].text).toBe("OpenGeni instructions");
  expect(a.body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(a.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(a.body.output_config.effort).toBe("high");
  expect(a.body.max_tokens).toBe(32000);
  const betas = a.headers.get("anthropic-beta")!.split(",");
  expect(betas).toContain("claude-code-20250219");
  expect(betas).toContain("context-1m-2025-08-07");
  expect(betas).toContain("extended-cache-ttl-2025-04-11");
  expect(betas).not.toContain("message-threads-2026-08-12");
  expect(betas).not.toContain("advisor-tool-2026-03-01");
  expect(JSON.stringify(request)).toBe(before);
});

test("API-key calls do not inherit subscription identity or billing attribution", async () => {
  const model = new AnthropicMessagesModel(
    { ...provider, anthropic: { ...provider.anthropic!, auth: "api-key" } },
    "claude-opus-5-5",
    (async (url, init) => {
      expect(new URL(String(url)).search).toBe("");
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      expect(headers.has("x-app")).toBe(false);
      expect(headers.get("x-api-key")).toBe("test-token");
      expect(headers.get("anthropic-beta")?.split(",")).toContain("context-1m-2025-08-07");
      expect(body.metadata).toBeUndefined();
      expect(body.system[0].text).toBe("OpenGeni instructions");
      return Response.json(result);
    }) as typeof fetch,
  );
  await model.getResponse(request);
});

test("missing subscription account identity fails before any network call", async () => {
  let calls = 0;
  const model = new AnthropicMessagesModel(
    { ...provider, anthropic: { ...provider.anthropic!, identity: undefined } },
    "claude-opus-5-5",
    (async () => {
      calls++;
      return Response.json(result);
    }) as typeof fetch,
  );
  await expect(model.getResponse(request)).rejects.toThrow("identity is missing");
  expect(calls).toBe(0);
});

test("run-scoped native routing preserves prompt lineage but never shares it across runners", async () => {
  const { MultiProviderModelProvider } = await import("../src/model-provider-routing");
  const { testSettings } = await import("@opengeni/testing");
  const settings = testSettings({
    modelProvidersJson: JSON.stringify([
      {
        id: "claude",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "fixture",
        models: [{ id: "claude/test", upstreamModelId: "claude-opus-5-5" }],
      },
    ]),
  });
  const first = new MultiProviderModelProvider(settings);
  const a = await first.getModel("claude/test");
  expect(await first.getModel("claude/test")).toBe(a);
  expect(await new MultiProviderModelProvider(settings).getModel("claude/test")).not.toBe(a);
});

test("new turn adapters preserve session identity while separating prompt and request lineage", async () => {
  const sent: Array<{ headers: Headers; body: any }> = [];
  const capture = (async (_url, init) => {
    sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json(result, { headers: { "request-id": `req_${sent.length}` } });
  }) as typeof fetch;
  const firstTurn = new AnthropicMessagesModel(provider, "claude-opus-5-5", capture);
  const secondTurn = new AnthropicMessagesModel(provider, "claude-opus-5-5", capture);
  await firstTurn.getResponse(request);
  await firstTurn.getResponse(request);
  await secondTurn.getResponse(request);
  const expectedSessionId = request.modelSettings.providerData!.prompt_cache_key;
  for (const item of sent) {
    expect(item.headers.get("x-claude-code-session-id")).toBe(expectedSessionId);
    expect(JSON.parse(item.body.metadata.user_id).session_id).toBe(expectedSessionId);
    expect(item.body.prompt_cache_key).toBeUndefined();
  }
  expect(sent[0]!.headers.get("x-claude-code-prompt-id")).toBe(
    sent[1]!.headers.get("x-claude-code-prompt-id"),
  );
  expect(sent[2]!.headers.get("x-claude-code-prompt-id")).not.toBe(
    sent[0]!.headers.get("x-claude-code-prompt-id"),
  );
  expect(sent[1]!.body.system[0].text).toContain("cc_prev_req=req_1;");
  expect(sent[2]!.body.system[0].text).not.toContain("cc_prev_req=");
});
