import { expect, test } from "bun:test";
import { setTracingDisabled, type ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  ANTHROPIC_API_KEYS_OUT_OF_CREDITS,
  AnthropicMessagesModel,
  anthropicApiKeyOrder,
  withAnthropicApiKeyRefusals,
} from "../src/anthropic-messages";

setTracingDisabled(true);

// An organization's Anthropic API connection with several keys (MP-KEYS-01..03).
const keys = [
  { id: "primary", apiKey: "sk-ant-api03-primary" },
  { id: "k2", apiKey: "sk-ant-api03-second" },
  { id: "k3", apiKey: "sk-ant-api03-third" },
];
const provider = (apiKeys?: typeof keys): ResolvedModelProvider => ({
  id: "organization-anthropic",
  label: "Anthropic API",
  kind: "anthropic-organization",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-ant-api03-primary",
  anthropic: {
    auth: "api-key",
    cacheTtl: "5m",
    maxOutputTokens: 32000,
    streamIdleTimeoutMs: 600000,
    ...(apiKeys ? { apiKeys } : {}),
  },
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
});
const modelRequest = (session: string): ModelRequest => ({
  input: "Hello",
  systemInstructions: "Instructions",
  modelSettings: { providerData: { prompt_cache_key: session } },
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
});
const message = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 1 },
};
const ok = () =>
  new Response(JSON.stringify(message), {
    headers: { "content-type": "application/json", "request-id": "req_ok" },
  });
const creditRefusal = () =>
  new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

/** A fake Anthropic: records the key and body of every request; `refuse` keys are out of credits. */
function anthropic(refuse: Set<string> = new Set(), respond = ok) {
  const sent: { key: string | null; authorization: string | null; body: string }[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const key = headers.get("x-api-key");
    sent.push({ key, authorization: headers.get("authorization"), body: String(init?.body) });
    return key && refuse.has(key) ? creditRefusal() : respond();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

test("MP-KEYS-01: one key is the connection's key alone, exactly as before", async () => {
  const { sent, fetch } = anthropic();
  await new AnthropicMessagesModel(provider(), "claude-test", fetch).getResponse(
    modelRequest("s-1"),
  );
  expect(sent.map((request) => request.key)).toEqual(["sk-ant-api03-primary"]);
  expect(sent[0]!.authorization).toBeNull();
});

test("MP-KEYS-02: a session keeps one key, and sessions spread over the keys", async () => {
  const { sent, fetch } = anthropic();
  const model = new AnthropicMessagesModel(provider(keys), "claude-test", fetch);
  for (let turn = 0; turn < 3; turn += 1) await model.getResponse(modelRequest("session-a"));
  expect(new Set(sent.map((request) => request.key)).size).toBe(1);
  // A fresh model (the next turn) picks the same key for the same session.
  const next = anthropic();
  await new AnthropicMessagesModel(provider(keys), "claude-test", next.fetch).getResponse(
    modelRequest("session-a"),
  );
  expect(next.sent[0]!.key).toBe(sent[0]!.key);
  const used = new Set<string>();
  for (let session = 0; session < 40; session += 1) {
    const spread = anthropic();
    await new AnthropicMessagesModel(provider(keys), "claude-test", spread.fetch).getResponse(
      modelRequest(`session-${session}`),
    );
    used.add(spread.sent[0]!.key!);
  }
  expect(used).toEqual(new Set(keys.map((key) => key.apiKey)));
});

test("MP-KEYS-02: removing a key moves only the sessions that were on it", () => {
  const sessions = Array.from({ length: 200 }, (_, index) => `session-${index}`);
  const before = new Map(
    sessions.map((session) => [session, anthropicApiKeyOrder(keys, session)[0]!.id]),
  );
  const remaining = keys.filter((key) => key.id !== "k2");
  for (const session of sessions) {
    const after = anthropicApiKeyOrder(remaining, session)[0]!.id;
    if (before.get(session) !== "k2") expect(after).toBe(before.get(session)!);
    else expect(after).not.toBe("k2");
  }
});

test("MP-KEYS-03: a key out of credits is reported and the same request goes to the next key", async () => {
  const session = "session-refused";
  const order = anthropicApiKeyOrder(keys, session);
  const { sent, fetch } = anthropic(new Set([order[0]!.apiKey]));
  const reported: [string, string][] = [];
  const model = new AnthropicMessagesModel(provider(keys), "claude-test", fetch);
  const result = await withAnthropicApiKeyRefusals(
    (providerId, keyId) => reported.push([providerId, keyId]),
    () => model.getResponse(modelRequest(session)),
  );
  expect(result.output.length).toBeGreaterThan(0);
  expect(sent.map((request) => request.key)).toEqual([order[0]!.apiKey, order[1]!.apiKey]);
  expect(sent[1]!.body).toBe(sent[0]!.body);
  expect(reported).toEqual([["organization-anthropic", order[0]!.id]]);
  // The model keeps the refused key out for the rest of its requests.
  await model.getResponse(modelRequest(session));
  expect(sent.at(-1)!.key).toBe(order[1]!.apiKey);
  expect(reported).toHaveLength(1);
});

test("MP-KEYS-03: a streamed request moves to the next key the same way", async () => {
  const session = "session-stream";
  const order = anthropicApiKeyOrder(keys, session);
  const stream = () =>
    new Response(
      [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream", "request-id": "req_stream" } },
    );
  const { sent, fetch } = anthropic(new Set([order[0]!.apiKey]), stream);
  const model = new AnthropicMessagesModel(provider(keys), "claude-test", fetch);
  const events = [];
  for await (const event of model.getStreamedResponse(modelRequest(session))) events.push(event);
  expect(events.at(-1)?.type).toBe("response_done");
  expect(sent.map((request) => request.key)).toEqual([order[0]!.apiKey, order[1]!.apiKey]);
});

test("MP-KEYS-03: when every key is out of credits the turn fails plainly", async () => {
  const { sent, fetch } = anthropic(new Set(keys.map((key) => key.apiKey)));
  const reported: string[] = [];
  const model = new AnthropicMessagesModel(provider(keys), "claude-test", fetch);
  const failure = await withAnthropicApiKeyRefusals(
    (_provider, keyId) => reported.push(keyId),
    () => model.getResponse(modelRequest("session-all")),
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: ANTHROPIC_API_KEYS_OUT_OF_CREDITS });
  expect(String((failure as Error).message)).toContain("out of credits");
  expect(sent).toHaveLength(3);
  expect(new Set(reported)).toEqual(new Set(keys.map((key) => key.id)));
  // No pool left at all (every key refused earlier): nothing is sent.
  const none = anthropic();
  const empty = new AnthropicMessagesModel(provider([]), "claude-test", none.fetch);
  await expect(empty.getResponse(modelRequest("session-none"))).rejects.toMatchObject({
    code: ANTHROPIC_API_KEYS_OUT_OF_CREDITS,
  });
  expect(none.sent).toHaveLength(0);
});

test("MP-KEYS-03: a rate limit is not a credit refusal and never moves the session", async () => {
  const { sent, fetch } = anthropic(
    new Set(),
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Slow down" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  );
  const reported: string[] = [];
  const model = new AnthropicMessagesModel(provider(keys), "claude-test", fetch);
  await expect(
    withAnthropicApiKeyRefusals(
      (_provider, keyId) => reported.push(keyId),
      () => model.getResponse(modelRequest("session-429")),
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(sent).toHaveLength(1);
  expect(reported).toEqual([]);
});
