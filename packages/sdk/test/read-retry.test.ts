import { describe, expect, test } from "bun:test";

import { OpenGeniApiError, OpenGeniClient, isTransientRequestError, type FetchLike } from "../src";
import {
  DEFAULT_READ_RETRY_POLICY,
  parseRetryAfterMs,
  readRetryDelayMs,
  resolveReadRetryPolicy,
} from "../src/read-retry";

const SESSION = {
  id: "session-1",
  workspaceId: "workspace-1",
  lastSequence: 3,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

type Step = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

function scriptedFetch(steps: Step[]): {
  fetch: FetchLike;
  calls: { method: string; at: number }[];
} {
  const calls: { method: string; at: number }[] = [];
  const fetch: FetchLike = async (_input, init) => {
    calls.push({ method: init?.method ?? "GET", at: Date.now() });
    const step = steps.shift();
    if (!step) throw new Error("unexpected extra request");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return await step(init);
    return step;
  };
  return { fetch, calls };
}

function client(
  fetch: FetchLike,
  readRetry?: ConstructorParameters<typeof OpenGeniClient>[0]["readRetry"],
) {
  return new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "key",
    fetch,
    onDeprecation: false,
    // Fast, deterministic-enough backoff for tests; the default policy is covered below.
    readRetry: readRetry ?? { initialDelayMs: 1, maxDelayMs: 5 },
  });
}

describe("safe-read retry policy", () => {
  test("defaults are bounded: a few attempts within a few seconds", () => {
    expect(resolveReadRetryPolicy(undefined)).toEqual({ ...DEFAULT_READ_RETRY_POLICY });
    expect(DEFAULT_READ_RETRY_POLICY).toEqual({
      maxAttempts: 4,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      maxElapsedMs: 5_000,
    });
  });

  test("false or a single attempt turns retries off; invalid values fall back leniently", () => {
    expect(resolveReadRetryPolicy(false)).toBeNull();
    expect(resolveReadRetryPolicy({ maxAttempts: 1 })).toBeNull();
    expect(resolveReadRetryPolicy({ maxAttempts: 0 })).toBeNull();
    expect(
      resolveReadRetryPolicy({
        maxAttempts: Number.NaN,
        initialDelayMs: -5,
        maxDelayMs: Number.POSITIVE_INFINITY,
        maxElapsedMs: 10_000_000,
      }),
    ).toEqual({ maxAttempts: 4, initialDelayMs: 0, maxDelayMs: 2_000, maxElapsedMs: 60_000 });
    expect(resolveReadRetryPolicy({ maxAttempts: 99 })?.maxAttempts).toBe(10);
  });

  test("backoff doubles, is jittered within [half, full], and is capped", () => {
    const policy = {
      maxAttempts: 10,
      initialDelayMs: 200,
      maxDelayMs: 1_000,
      maxElapsedMs: 60_000,
    };
    expect(readRetryDelayMs(policy, 1, 0, null, () => 0)).toBe(100);
    expect(readRetryDelayMs(policy, 1, 0, null, () => 1)).toBe(200);
    expect(readRetryDelayMs(policy, 2, 0, null, () => 1)).toBe(400);
    expect(readRetryDelayMs(policy, 3, 0, null, () => 1)).toBe(800);
    expect(readRetryDelayMs(policy, 4, 0, null, () => 1)).toBe(1_000);
    expect(readRetryDelayMs(policy, 6, 0, null, () => 0.5)).toBe(750);
  });

  test("stops at maxAttempts and when the delay would exceed the elapsed budget", () => {
    const policy = { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 1_000 };
    expect(readRetryDelayMs(policy, 2, 0, null, () => 1)).toBe(200);
    expect(readRetryDelayMs(policy, 3, 0, null, () => 1)).toBeNull();
    expect(readRetryDelayMs(policy, 1, 950, null, () => 1)).toBeNull();
  });

  test("Retry-After is honored exactly when it fits, and ends retrying when it does not", () => {
    const policy = { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 200, maxElapsedMs: 5_000 };
    expect(readRetryDelayMs(policy, 1, 0, 3_000, () => 0)).toBe(3_000);
    expect(readRetryDelayMs(policy, 1, 0, 0, () => 1)).toBe(0);
    expect(readRetryDelayMs(policy, 1, 2_500, 3_000, () => 0)).toBeNull();
  });

  test("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(parseRetryAfterMs("2", now)).toBe(2_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
    expect(parseRetryAfterMs("Thu, 22 Oct 2026 12:00:03 GMT", now)).toBe(3_000);
    expect(parseRetryAfterMs("Thu, 22 Oct 2026 11:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs("-1", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  test("classifies only transport errors and retryable 502/503/504 as transient", () => {
    expect(isTransientRequestError(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isTransientRequestError(new OpenGeniApiError(status, ""))).toBe(true);
    }
    expect(
      isTransientRequestError(
        new OpenGeniApiError(503, JSON.stringify({ error: { message: "x", retryable: false } })),
      ),
    ).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      expect(isTransientRequestError(new OpenGeniApiError(status, ""))).toBe(false);
    }
    expect(isTransientRequestError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientRequestError(new Error("boom"))).toBe(false);
  });
});

describe("OpenGeniClient safe-read retry", () => {
  test("a GET that hits a transport error and gateway errors recovers quietly", async () => {
    const { fetch, calls } = scriptedFetch([
      new TypeError("Failed to fetch"),
      new Response("<html>bad gateway</html>", { status: 502 }),
      json({ error: { message: "deploying" } }, { status: 503 }),
      json(SESSION),
    ]);
    const session = await client(fetch).getSession("workspace-1", "session-1");
    expect(session).toMatchObject(SESSION);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET"]);
  });

  test("a persistent gateway failure surfaces the last error after maxAttempts", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("", { status: 504 }),
      new Response("", { status: 504 }),
      new Response("", { status: 504 }),
      new Response("", { status: 504 }),
    ]);
    const error = await client(fetch)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect(error).toMatchObject({ status: 504, retryable: true });
    expect(calls).toHaveLength(4);
  });

  test("a persistent transport failure rethrows the original TypeError", async () => {
    const failure = new TypeError("network down");
    const { fetch, calls } = scriptedFetch([failure, failure, failure]);
    const error = await client(fetch, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 })
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toBe(failure);
    expect(calls).toHaveLength(3);
  });

  test("definitive errors are not retried", async () => {
    for (const status of [401, 403, 404, 500]) {
      const { fetch, calls } = scriptedFetch([
        json({ error: { message: "no" } }, { status }),
        json(SESSION),
      ]);
      const error = await client(fetch)
        .getSession("workspace-1", "session-1")
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status });
      expect(calls).toHaveLength(1);
    }
  });

  test("a 503 whose body says it is not retryable is not retried", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ error: { message: "disabled here", retryable: false } }, { status: 503 }),
      json(SESSION),
    ]);
    const error = await client(fetch)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 503, retryable: false });
    expect(calls).toHaveLength(1);
  });

  test("mutations are never retried and keep outcome-unknown semantics", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const { fetch, calls } = scriptedFetch([new TypeError("reset"), json({ ok: true })]);
      const error = await client(fetch)
        .requestJson(method, "/v1/workspaces/workspace-1/things", {})
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ outcomeUnknown: true });
      expect(calls).toHaveLength(1);
    }
    const { fetch, calls } = scriptedFetch([new Response("", { status: 503 }), json({ ok: true })]);
    const error = await client(fetch)
      .updateSession("workspace-1", "session-1", { title: "x" })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  test("HEAD is a safe read and is retried", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("", { status: 503 }),
      new Response(null, { status: 204 }),
    ]);
    await client(fetch).requestJson("HEAD", "/v1/health", undefined, {}, { responseType: "void" });
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
  });

  test("readRetry: false keeps the single-attempt behavior", async () => {
    const { fetch, calls } = scriptedFetch([new Response("", { status: 503 }), json(SESSION)]);
    const error = await client(fetch, false)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  test("a malformed success response is not retried", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
      json(SESSION),
    ]);
    const error = await client(fetch)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 502, code: "upstream_unavailable" });
    expect(calls).toHaveLength(1);
  });

  test("honors Retry-After from a 503 before retrying", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("", { status: 503, headers: { "retry-after": "1" } }),
      json(SESSION),
    ]);
    await client(fetch, { initialDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 5_000 }).getSession(
      "workspace-1",
      "session-1",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950);
  });

  test("a Retry-After beyond the budget surfaces the error instead of waiting", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("", { status: 503, headers: { "retry-after": "120" } }),
      json(SESSION),
    ]);
    const started = Date.now();
    const error = await client(fetch)
      .getSession("workspace-1", "session-1")
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("aborting during the backoff stops retrying with the caller's reason", async () => {
    const { fetch, calls } = scriptedFetch([new Response("", { status: 503 }), json(SESSION)]);
    const controller = new AbortController();
    const reason = new DOMException("left the page", "AbortError");
    const pending = client(fetch, { initialDelayMs: 2_000, maxDelayMs: 2_000 })
      .getSession("workspace-1", "session-1", { signal: controller.signal })
      .catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  test("a request timeout is not retried", async () => {
    const { fetch, calls } = scriptedFetch([
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      json(SESSION),
    ]);
    const error = await client(fetch)
      .requestJson("GET", "/v1/slow", undefined, {}, { timeoutMs: 20 })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(calls).toHaveLength(1);
  });

  test("a connection reset while reading a GET body is retried", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new TypeError("upstream prematurely closed"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const { fetch, calls } = scriptedFetch([broken, json(SESSION)]);
    expect(await client(fetch).getSession("workspace-1", "session-1")).toMatchObject(SESSION);
    expect(calls).toHaveLength(2);
  });
});
