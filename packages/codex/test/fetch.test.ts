import { describe, expect, test } from "bun:test";
import {
  type CodexRequestContext,
  type CodexTokenSnapshot,
  type FetchLike,
  classifyCodexUsageLimitError,
  codexRequestStorage,
  codexSubscriptionFetch,
} from "../src";

type Capture = { url: string; init?: RequestInit | undefined };

function baseRecorder(statuses: number[] = [200]): { base: FetchLike; captures: Capture[] } {
  const captures: Capture[] = [];
  let i = 0;
  const base: FetchLike = async (input, init) => {
    captures.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init });
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return new Response("data: {}\n\n", { status, headers: { "content-type": "text/event-stream" } });
  };
  return { base, captures };
}

function ctx(overrides: Partial<CodexRequestContext> = {}): CodexRequestContext {
  const token: CodexTokenSnapshot = { accessToken: "AC1", chatgptAccountId: "acct_1", isFedramp: false };
  return {
    clientVersion: "1.2.3",
    getToken: async () => token,
    refresh: async () => ({ accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false }),
    resolveModel: (s) => s,
    ...overrides,
  };
}

describe("codexSubscriptionFetch", () => {
  test("rewrites /responses, swaps headers, normalizes the body", async () => {
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        headers: { "OpenAI-Beta": "responses=experimental", "x-api-key": "secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", store: true, max_output_tokens: 50, input: [{ type: "message", id: "m1", role: "user", content: [] }] }),
      }),
    );
    const cap = captures[0];
    expect(cap?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(cap?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer AC1");
    expect(headers.get("chatgpt-account-id")).toBe("acct_1");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("version")).toBe("1.2.3");
    expect(headers.get("openai-beta")).toBeNull(); // deleted
    expect(headers.get("x-api-key")).toBeNull(); // deleted
    const sent = JSON.parse(cap?.init?.body as string);
    expect(sent.store).toBe(false);
    expect("max_output_tokens" in sent).toBe(false);
    expect(sent.include).toEqual(["reasoning.encrypted_content"]);
    expect("id" in sent.input[0]).toBe(false);
  });

  test("does not double-rewrite when url already targets /codex/responses", async () => {
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" }),
    );
    expect(captures[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("retries once with a refreshed token on 401", async () => {
    const { base, captures } = baseRecorder([401, 200]);
    let refreshed = 0;
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(
      ctx({ refresh: async () => { refreshed += 1; return { accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false }; } }),
      () => fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: "{}" }),
    );
    expect(refreshed).toBe(1);
    expect(captures.length).toBe(2);
    expect(new Headers(captures[1]?.init?.headers).get("authorization")).toBe("Bearer AC2");
    expect(res.status).toBe(200);
  });

  // A realistic codex stream: the terminal response.completed leaves output EMPTY,
  // and the assistant message arrives via output_item.done (the quirk we repair).
  const CODEX_SSE = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"output_tokens":2}}}',
    "",
  ].join("\n\n");
  const codexBase: FetchLike = async () => new Response(CODEX_SSE, { status: 200 });

  test("non-streaming caller: SSE collapses to one JSON Response with output assembled from item events", async () => {
    const fetchImpl = codexSubscriptionFetch(codexBase);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", input: [] }) }),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json() as { status: string; output: Array<{ type: string }> };
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1); // assembled from output_item.done, not the empty terminal output
    expect(json.output[0]?.type).toBe("message");
  });

  test("streaming caller: stream is passed through with the terminal event's empty output repaired", async () => {
    const fetchImpl = codexSubscriptionFetch(codexBase);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }) }),
    );
    const text = await res.text();
    const terminal = text.split("\n\n").map((b) => b.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"))
      .filter(Boolean).map((d) => JSON.parse(d) as { type?: string; response?: { output?: unknown[] } })
      .find((e) => e.type === "response.completed");
    expect(terminal?.response?.output).toHaveLength(1); // injected; the SDK parser now sees the message
    expect(text).toContain("response.output_item.done"); // intermediate events still pass through for incremental UI
  });

  test("passes through untouched when there is no codex context", async () => {
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", headers: { "OpenAI-Beta": "x" }, body: '{"model":"gpt-5.5"}' });
    expect(captures[0]?.url).toBe("https://api.openai.com/v1/responses"); // not rewritten
    expect(new Headers(captures[0]?.init?.headers).get("openai-beta")).toBe("x"); // not stripped
    expect(captures[0]?.init?.body).toBe('{"model":"gpt-5.5"}'); // not normalized
  });

  test("P1-d: a 429 usage_limit_reached is re-emitted as JSON with x-should-retry:false (preserving the body)", async () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", message: "limit hit", resets_in_seconds: 3600 } });
    const base: FetchLike = async () => new Response(body, { status: 429, headers: { "content-type": "application/json" } });
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }) }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-should-retry")).toBe("false");
    // The JSON error body survives so the SDK can reconstruct error.error (no
    // "429 status code (no body)").
    const parsed = JSON.parse(await res.text()) as { error?: { type?: string; resets_in_seconds?: number } };
    expect(parsed.error?.type).toBe("usage_limit_reached");
    expect(parsed.error?.resets_in_seconds).toBe(3600);
  });

  test("P1-d: a generic 5xx error body is preserved WITHOUT forcing x-should-retry", async () => {
    const base: FetchLike = async () => new Response(JSON.stringify({ error: { type: "server_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }) }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("x-should-retry")).toBeNull(); // only usage caps are pinned non-retryable
    expect(JSON.parse(await res.text())).toEqual({ error: { type: "server_error", message: "boom" } });
  });

  test("the 401-refresh retry still fires; the final non-OK error is buffered", async () => {
    let call = 0;
    const base: FetchLike = async () => {
      call += 1;
      return call === 1
        ? new Response("unauth", { status: 401, headers: { "content-type": "text/plain" } })
        : new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), { status: 429, headers: { "content-type": "application/json" } });
    };
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }) }),
    );
    expect(call).toBe(2); // 401 → refresh → retry
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("false");
  });
});

describe("classifyCodexUsageLimitError", () => {
  test("detects an OpenAI-shaped 429 usage_limit_reached and extracts the reset window", () => {
    const err = Object.assign(new Error("429 limit"), { status: 429, type: "usage_limit_reached", error: { type: "usage_limit_reached", resets_in_seconds: 1800 } });
    expect(classifyCodexUsageLimitError(err)).toEqual({ resetsInSeconds: 1800 });
  });

  test("detects via the error body type when the top-level type is absent", () => {
    const err = Object.assign(new Error("boom"), { status: 429, error: { type: "usage_limit_reached" } });
    expect(classifyCodexUsageLimitError(err)).toEqual({ resetsInSeconds: null });
  });

  test("walks the cause chain (SDK re-wrap)", () => {
    const inner = Object.assign(new Error("inner"), { status: 429, error: { type: "usage_limit_reached", resets_in_seconds: 60 } });
    const outer = Object.assign(new Error("wrapped"), { cause: inner });
    expect(classifyCodexUsageLimitError(outer)).toEqual({ resetsInSeconds: 60 });
  });

  test("returns null for a plain rate-limit (no usage cap)", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), { status: 429, code: "rate_limit_exceeded" });
    expect(classifyCodexUsageLimitError(err)).toBeNull();
  });

  test("returns null for non-objects and unrelated errors", () => {
    expect(classifyCodexUsageLimitError(new Error("nope"))).toBeNull();
    expect(classifyCodexUsageLimitError("string")).toBeNull();
    expect(classifyCodexUsageLimitError(null)).toBeNull();
  });
});
