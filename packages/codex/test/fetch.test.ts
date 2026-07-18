import { describe, expect, test } from "bun:test";
import {
  CODEX_TRANSPORT_ERROR_HEADER,
  type CodexRequestContext,
  type CodexTokenSnapshot,
  type CodexUsageHeaderSnapshot,
  type FetchLike,
  classifyCodexUsageLimitError,
  codexRequestStorage,
  codexSubscriptionFetch,
  isCodexTransportError,
  parseCodexUsageHeaders,
} from "../src";

type Capture = { url: string; init?: RequestInit | undefined };

function baseRecorder(statuses: number[] = [200]): { base: FetchLike; captures: Capture[] } {
  const captures: Capture[] = [];
  let i = 0;
  const base: FetchLike = async (input, init) => {
    captures.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      init,
    });
    const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return new Response(
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n',
      {
        status,
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
  return { base, captures };
}

function ctx(overrides: Partial<CodexRequestContext> = {}): CodexRequestContext {
  const token: CodexTokenSnapshot = {
    accessToken: "AC1",
    chatgptAccountId: "acct_1",
    isFedramp: false,
  };
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
        headers: {
          "OpenAI-Beta": "responses=experimental",
          "x-api-key": "secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          store: true,
          max_output_tokens: 50,
          input: [{ type: "message", id: "m1", role: "user", content: [] }],
        }),
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

  test("sends the session_id affinity header when the context carries a sessionId", async () => {
    // The backend's sticky cache-routing key: without it, byte-identical
    // resends miss the prompt cache ~50% (measured shard lottery); with it
    // they pin to the warm shard. Must ride EVERY request of the session.
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await codexRequestStorage.run(ctx({ sessionId: "11111111-2222-4333-8444-555555555555" }), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: "{}" }),
    );
    const headers = new Headers(captures[0]?.init?.headers);
    expect(headers.get("session_id")).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("omits the session_id header when the context has none (legacy behavior)", async () => {
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: "{}" }),
    );
    expect(new Headers(captures[0]?.init?.headers).get("session_id")).toBeNull();
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
      ctx({
        refresh: async () => {
          refreshed += 1;
          return { accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false };
        },
      }),
      () => fetchImpl("https://chatgpt.com/backend-api/responses", { method: "POST", body: "{}" }),
    );
    expect(refreshed).toBe(1);
    expect(captures.length).toBe(2);
    expect(new Headers(captures[1]?.init?.headers).get("authorization")).toBe("Bearer AC2");
    expect(res.status).toBe(200);
  });

  test("a second 401 is returned after exactly one refresh and two requests", async () => {
    const { base, captures } = baseRecorder([401, 401, 200]);
    let refreshed = 0;
    const response = await codexRequestStorage.run(
      ctx({
        refresh: async () => {
          refreshed += 1;
          return { accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false };
        },
      }),
      () =>
        codexSubscriptionFetch(base)("https://chatgpt.com/backend-api/responses", {
          method: "POST",
          body: "{}",
        }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe("1");
    expect(refreshed).toBe(1);
    expect(captures).toHaveLength(2);
  });

  test("403 is definitive and never spends the refresh retry", async () => {
    const { base, captures } = baseRecorder([403, 200]);
    let refreshed = 0;
    const response = await codexRequestStorage.run(
      ctx({
        refresh: async () => {
          refreshed += 1;
          return { accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false };
        },
      }),
      () =>
        codexSubscriptionFetch(base)("https://chatgpt.com/backend-api/responses", {
          method: "POST",
          body: "{}",
        }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe("1");
    expect(refreshed).toBe(0);
    expect(captures).toHaveLength(1);
  });

  test("malformed non-streaming SSE fails truthfully without a transport replay", async () => {
    let calls = 0;
    const response = await codexRequestStorage.run(ctx(), () =>
      codexSubscriptionFetch(async () => {
        calls += 1;
        return new Response("data: not-json\n\n", { status: 200 });
      })("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: false }),
      }),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe("1");
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_sse_terminal",
        code: "invalid_sse_terminal",
        message: "The Codex response stream ended without a terminal response",
      },
    });
    expect(calls).toBe(1);
  });

  test("non-streaming response.failed becomes a normal SDK error response", async () => {
    let calls = 0;
    const failure = [
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"code":"context_length_exceeded","message":"input too large"}}}',
      "",
    ].join("\n");
    const response = await codexRequestStorage.run(ctx(), () =>
      codexSubscriptionFetch(async () => {
        calls += 1;
        return new Response(failure, { status: 200, headers: { "x-request-id": "req_failed" } });
      })("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: false }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get(CODEX_TRANSPORT_ERROR_HEADER)).toBe("1");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toEqual({
      error: {
        type: "context_length_exceeded",
        code: "context_length_exceeded",
        message: "input too large",
      },
    });
    expect(calls).toBe(1);
  });

  test("non-streaming top-level error and response.error terminal forms do not become empty success", async () => {
    for (const event of [
      { type: "error", code: "server_error", message: "backend unavailable", param: null },
      {
        type: "response.error",
        error: { code: "server_error", message: "backend unavailable" },
      },
    ]) {
      const response = await codexRequestStorage.run(ctx(), () =>
        codexSubscriptionFetch(
          async () => new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 }),
        )("https://chatgpt.com/backend-api/responses", {
          method: "POST",
          body: JSON.stringify({ stream: false }),
        }),
      );
      expect(response.status).toBe(502);
      expect((await response.json()) as { error?: { code?: string } }).toMatchObject({
        error: { code: "server_error" },
      });
    }
  });

  test("non-streaming response.incomplete is a provider failure like Codex CLI", async () => {
    const response = await codexRequestStorage.run(ctx(), () =>
      codexSubscriptionFetch(
        async () =>
          new Response(
            'data: {"type":"response.incomplete","response":{"id":"resp_inc","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
            { status: 200 },
          ),
      )("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: false }),
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: {
        code: "response_incomplete",
        message: "The Codex response was incomplete (max_output_tokens)",
      },
    });
  });

  test("partial streaming body failure is surfaced without a transport replay", async () => {
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_item.done","item":{"type":"message"}}\n\n',
          ),
        );
        controller.error(new Error("injected partial stream failure"));
      },
    });
    const response = await codexRequestStorage.run(ctx(), () =>
      codexSubscriptionFetch(async () => {
        calls += 1;
        return new Response(body, { status: 200 });
      })("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true }),
      }),
    );
    let observed: unknown;
    try {
      await response.text();
    } catch (error) {
      observed = error;
    }
    expect(String(observed)).toContain("injected partial stream failure");
    expect(calls).toBe(1);
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
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
      }),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { status: string; output: Array<{ type: string }> };
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1); // assembled from output_item.done, not the empty terminal output
    expect(json.output[0]?.type).toBe("message");
  });

  test("non-streaming caller accepts canonical CRLF SSE framing", async () => {
    const fetchImpl = codexSubscriptionFetch(
      async () => new Response(CODEX_SSE.replaceAll("\n", "\r\n"), { status: 200 }),
    );
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "r1", status: "completed" });
  });

  test("streaming caller: stream is passed through with the terminal event's empty output repaired", async () => {
    const fetchImpl = codexSubscriptionFetch(codexBase);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }),
      }),
    );
    const text = await res.text();
    const terminal = text
      .split("\n\n")
      .map((b) =>
        b
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n"),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d) as { type?: string; response?: { output?: unknown[] } })
      .find((e) => e.type === "response.completed");
    expect(terminal?.response?.output).toHaveLength(1); // injected; the SDK parser now sees the message
    expect(text).toContain("response.output_item.done"); // intermediate events still pass through for incremental UI
  });

  test("passes through untouched when there is no codex context", async () => {
    const { base, captures } = baseRecorder();
    const fetchImpl = codexSubscriptionFetch(base);
    await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "OpenAI-Beta": "x" },
      body: '{"model":"gpt-5.6-sol"}',
    });
    expect(captures[0]?.url).toBe("https://api.openai.com/v1/responses"); // not rewritten
    expect(new Headers(captures[0]?.init?.headers).get("openai-beta")).toBe("x"); // not stripped
    expect(captures[0]?.init?.body).toBe('{"model":"gpt-5.6-sol"}'); // not normalized
  });

  test("P1-d: a 429 usage_limit_reached is re-emitted as JSON with x-should-retry:false (preserving the body)", async () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", message: "limit hit", resets_in_seconds: 3600 },
    });
    const base: FetchLike = async () =>
      new Response(body, { status: 429, headers: { "content-type": "application/json" } });
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-should-retry")).toBe("false");
    // The JSON error body survives so the SDK can reconstruct error.error (no
    // "429 status code (no body)").
    const parsed = JSON.parse(await res.text()) as {
      error?: { type?: string; resets_in_seconds?: number };
    };
    expect(parsed.error?.type).toBe("usage_limit_reached");
    expect(parsed.error?.resets_in_seconds).toBe(3600);
  });

  test("P1-d: a generic 5xx error body is preserved WITHOUT forcing x-should-retry", async () => {
    const base: FetchLike = async () =>
      new Response(JSON.stringify({ error: { type: "server_error", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }),
      }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("x-should-retry")).toBeNull(); // only usage caps are pinned non-retryable
    expect(JSON.parse(await res.text())).toEqual({
      error: { type: "server_error", message: "boom" },
    });
  });

  test("the 401-refresh retry still fires; the final non-OK error is buffered", async () => {
    let call = 0;
    const base: FetchLike = async () => {
      call += 1;
      return call === 1
        ? new Response("unauth", { status: 401, headers: { "content-type": "text/plain" } })
        : new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
    };
    const fetchImpl = codexSubscriptionFetch(base);
    const res = await codexRequestStorage.run(ctx(), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }),
      }),
    );
    expect(call).toBe(2); // 401 → refresh → retry
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("false");
  });
});

describe("classifyCodexUsageLimitError", () => {
  test("recognizes only buffered Codex transport provenance through an SDK cause chain", () => {
    const inner = Object.assign(new Error("provider refusal"), {
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    expect(isCodexTransportError(Object.assign(new Error("wrapped"), { cause: inner }))).toBe(true);
    expect(
      isCodexTransportError(Object.assign(new Error("unrelated MCP refusal"), { status: 403 })),
    ).toBe(false);
  });
  test("detects an OpenAI-shaped 429 usage_limit_reached and extracts the reset window", () => {
    const err = Object.assign(new Error("429 limit"), {
      status: 429,
      type: "usage_limit_reached",
      error: { type: "usage_limit_reached", resets_in_seconds: 1800 },
    });
    expect(classifyCodexUsageLimitError(err)).toEqual({ resetsInSeconds: 1800 });
  });

  test("detects via the error body type when the top-level type is absent", () => {
    const err = Object.assign(new Error("boom"), {
      status: 429,
      error: { type: "usage_limit_reached" },
    });
    expect(classifyCodexUsageLimitError(err)).toEqual({ resetsInSeconds: null });
  });

  test("walks the cause chain (SDK re-wrap)", () => {
    const inner = Object.assign(new Error("inner"), {
      status: 429,
      error: { type: "usage_limit_reached", resets_in_seconds: 60 },
    });
    const outer = Object.assign(new Error("wrapped"), { cause: inner });
    expect(classifyCodexUsageLimitError(outer)).toEqual({ resetsInSeconds: 60 });
  });

  test("returns null for a plain rate-limit (no usage cap)", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    expect(classifyCodexUsageLimitError(err)).toBeNull();
  });

  test("returns null for non-objects and unrelated errors", () => {
    expect(classifyCodexUsageLimitError(new Error("nope"))).toBeNull();
    expect(classifyCodexUsageLimitError("string")).toBeNull();
    expect(classifyCodexUsageLimitError(null)).toBeNull();
  });
});

// Multi-account P4 (Part A): the free per-turn usage scrape.
describe("parseCodexUsageHeaders", () => {
  test("both windows present → full 5-column snapshot (epoch seconds → ms)", () => {
    const resetPrimary = 1782700000;
    const resetSecondary = 1783200000;
    const snap = parseCodexUsageHeaders(
      new Headers({
        "x-codex-primary-used-percent": "42",
        "x-codex-primary-reset-at": String(resetPrimary),
        "x-codex-secondary-used-percent": "7",
        "x-codex-secondary-reset-at": String(resetSecondary),
      }),
    );
    expect(snap).not.toBeNull();
    expect(snap!.primaryUsedPercent).toBe(42);
    expect(snap!.secondaryUsedPercent).toBe(7);
    expect(snap!.primaryResetAt.getTime()).toBe(resetPrimary * 1000);
    expect(snap!.secondaryResetAt.getTime()).toBe(resetSecondary * 1000);
    expect(snap!.checkedAt).toBeInstanceOf(Date);
  });

  test("primary-only (missing secondary) → null (NO partial-window clobber)", () => {
    expect(
      parseCodexUsageHeaders(
        new Headers({
          "x-codex-primary-used-percent": "42",
          "x-codex-primary-reset-at": "1782700000",
        }),
      ),
    ).toBeNull();
  });

  test("absent / non-integer used-percent → null (safe no-op)", () => {
    expect(parseCodexUsageHeaders(new Headers({}))).toBeNull();
    expect(
      parseCodexUsageHeaders(
        new Headers({
          "x-codex-primary-used-percent": "n/a",
          "x-codex-secondary-used-percent": "3",
        }),
      ),
    ).toBeNull();
  });

  test("reset-after-seconds fallback when no absolute reset-at", () => {
    const before = Date.now();
    const snap = parseCodexUsageHeaders(
      new Headers({
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-reset-after-seconds": "3600",
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-reset-after-seconds": "7200",
      }),
    );
    expect(snap).not.toBeNull();
    expect(snap!.primaryResetAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(snap!.secondaryResetAt.getTime()).toBeGreaterThanOrEqual(before + 7200 * 1000);
  });
});

describe("codexSubscriptionFetch — usage-header sink (P4 Part A)", () => {
  function usageBase(status: number, headers: Record<string, string>): FetchLike {
    return async () =>
      new Response("data: {}\n\n", {
        status,
        headers: { "content-type": "text/event-stream", ...headers },
      });
  }

  test("fires onUsageHeaders on the OK path with the parsed snapshot", async () => {
    const seen: CodexUsageHeaderSnapshot[] = [];
    const fetchImpl = codexSubscriptionFetch(
      usageBase(200, {
        "x-codex-primary-used-percent": "55",
        "x-codex-primary-reset-at": "1782700000",
        "x-codex-secondary-used-percent": "12",
        "x-codex-secondary-reset-at": "1783200000",
      }),
    );
    await codexRequestStorage.run(ctx({ onUsageHeaders: (s) => seen.push(s) }), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true }),
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.primaryUsedPercent).toBe(55);
    expect(seen[0]!.secondaryUsedPercent).toBe(12);
  });

  test("fires on the 429 hard-cap path too (an exhausted account stamps its own usage)", async () => {
    const seen: CodexUsageHeaderSnapshot[] = [];
    const fetchImpl = codexSubscriptionFetch(
      usageBase(429, {
        "x-codex-primary-used-percent": "100",
        "x-codex-secondary-used-percent": "100",
      }),
    );
    await codexRequestStorage.run(ctx({ onUsageHeaders: (s) => seen.push(s) }), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true }),
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.primaryUsedPercent).toBe(100);
  });

  test("does NOT fire when headers are absent/partial (safe no-op)", async () => {
    const seen: CodexUsageHeaderSnapshot[] = [];
    const fetchImpl = codexSubscriptionFetch(
      usageBase(200, { "x-codex-primary-used-percent": "55" }),
    );
    await codexRequestStorage.run(ctx({ onUsageHeaders: (s) => seen.push(s) }), () =>
      fetchImpl("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ stream: true }),
      }),
    );
    expect(seen).toHaveLength(0);
  });
});
