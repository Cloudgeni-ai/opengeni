import { describe, expect, test } from "bun:test";
import {
  JEV_DEFAULT_LIMITS,
  JevClient,
  JevLimiter,
  JevRequestError,
  JevUnavailableError,
  estimateJevTokens,
  jevCostUsd,
  noul,
  planChunks,
  type JevFetch,
} from "../src";

type Call = { url: string; init: RequestInit; body: any };

function client(
  fetchImpl: JevFetch,
  extra: Partial<ConstructorParameters<typeof JevClient>[0]> = {},
) {
  return new JevClient({
    apiKey: "sk-test-secret",
    baseUrl: "http://jev.local/",
    fetch: fetchImpl,
    retryBaseDelayMs: 1,
    ...extra,
  });
}

function recording(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: JevFetch = async (url, init) => {
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

const okAnswers = (call: Call) =>
  Response.json({
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.keys(call.body.questions).map((id) => [id, { type: "noul", noul: 0.75 }]),
    ),
    usage: { input_tokens: 1000, output_tokens: 20 },
  });

describe("request shape and answers", () => {
  test("posts {state, model, questions} with a bearer key and normalizes answers", async () => {
    const { calls, fetchImpl } = recording(() =>
      Response.json({
        model: "jev-1.13.0",
        answers: {
          a: { type: "noul", noul: 0.95 },
          b: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.88, technical: 0.12 },
            confidence: 0.81,
          },
          c: {
            type: "score",
            score: 1.05,
            legend: { "0": "Calm", "1": "Frustrated" },
            probabilities: { "0": 0.05, "1": 0.95 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 2_000_000, output_tokens: 50 },
      }),
    );
    const r = await client(fetchImpl).ask("state text", {
      a: noul("Is it urgent?"),
      b: {
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: null, technical: null },
      },
      c: { type: "score", instructions: "How frustrated?", criteria: ["Calm", "Frustrated"] },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://jev.local/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test-secret",
    );
    expect(Object.keys(calls[0]!.body)).toEqual(["state", "model", "questions"]);
    expect(calls[0]!.body.model).toBe("jev-latest");
    expect(r.answers.a).toEqual({ type: "noul", probability: 0.95 });
    expect(r.answers.b).toEqual({
      type: "choice",
      option: "billing",
      probabilities: { billing: 0.88, technical: 0.12 },
      confidence: 0.81,
    });
    expect(r.answers.c).toMatchObject({
      type: "score",
      score: 1.05,
      legend: { "0": "Calm", "1": "Frustrated" },
    });
    expect(r.model).toBe("jev-1.13.0");
    expect(r.usage.inputTokens).toBe(2_000_000);
    expect(r.requests).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.084, 10);
  });

  test("cost is $0.042 per 1M input tokens", () => {
    expect(jevCostUsd(1_000_000)).toBeCloseTo(0.042, 12);
    expect(jevCostUsd(0)).toBe(0);
  });

  test("a missing answer or an invalid body is JevUnavailableError", async () => {
    const missing = recording(() =>
      Response.json({ model: "m", answers: {}, usage: { input_tokens: 1 } }),
    );
    await expect(client(missing.fetchImpl).ask("s", { a: noul("q") })).rejects.toThrow(
      /missing the answer "a"/,
    );
    const invalid = recording(() => new Response("not json", { status: 200 }));
    await expect(client(invalid.fetchImpl).ask("s", { a: noul("q") })).rejects.toBeInstanceOf(
      JevUnavailableError,
    );
  });

  test("an empty question map is a request error; an empty key refuses construction", async () => {
    await expect(client(recording(okAnswers).fetchImpl).ask("s", {})).rejects.toBeInstanceOf(
      JevRequestError,
    );
    expect(() => new JevClient({ apiKey: "" })).toThrow(JevUnavailableError);
  });
});

describe("chunking", () => {
  test("planChunks respects the all-questions cap and the per-request question cap", () => {
    const q = Array.from({ length: 10 }, (_, i) => [`q${i}`, 10_000] as const);
    const chunks = planChunks(1000, q);
    // 57,600 usable; base 1,300; each question 10,012 -> 5 per request
    expect(chunks.map((c) => c.length)).toEqual([5, 5]);
    const many = Array.from({ length: 600 }, (_, i) => [`q${i}`, 1] as const);
    expect(planChunks(10, many).map((c) => c.length)).toEqual([256, 256, 88]);
  });

  test("state plus one question over the 32k window is a JevRequestError (state_too_large)", () => {
    try {
      planChunks(29_000, [["q", 10]]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(JevRequestError);
      expect((e as JevRequestError).code).toBe("state_too_large");
    }
    expect(JEV_DEFAULT_LIMITS.stateLongestMax).toBe(32_000);
    expect(JEV_DEFAULT_LIMITS.stateAllMax).toBe(64_000);
  });

  test("ask splits a large question set across requests, sends each question once, merges and sums usage", async () => {
    const { calls, fetchImpl } = recording(okAnswers);
    const long = "x".repeat(9_000); // ~3,000 tokens per question
    const questions = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`q${i}`, noul(`${long} ${i}`)]),
    );
    const r = await client(fetchImpl).ask({ big: "y".repeat(3_000) }, questions);
    expect(calls.length).toBeGreaterThan(1);
    const sent = calls.flatMap((c) => Object.keys(c.body.questions));
    expect(sent.sort()).toEqual(Object.keys(questions).sort());
    for (const c of calls) {
      expect(
        estimateJevTokens(c.body.state) +
          300 +
          Object.values(c.body.questions).reduce(
            (s: number, q) => s + estimateJevTokens(q) + 12,
            0,
          ),
      ).toBeLessThanOrEqual(64_000 * 0.9);
    }
    expect(Object.keys(r.answers).length).toBe(40);
    expect(r.requests).toBe(calls.length);
    expect(r.usage.inputTokens).toBe(1000 * calls.length);
  });

  test("the limiter never runs more than `concurrency` requests at once", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl: JevFetch = async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return okAnswers({ url: "", init, body: JSON.parse(String(init.body)) });
    };
    const c = client(fetchImpl, { concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.ask(`s${i}`, { a: noul("q") })));
    expect(peak).toBe(2);
  });
});

describe("retry policy", () => {
  test("429 and 5xx are retried, then succeed", async () => {
    for (const status of [429, 500, 503, 529]) {
      const { calls, fetchImpl } = recording((call, n) =>
        n < 3 ? Response.json({ detail: "busy" }, { status }) : okAnswers(call),
      );
      const r = await client(fetchImpl).ask("s", { a: noul("q") });
      expect(calls.length).toBe(3);
      expect(r.answers.a.probability).toBe(0.75);
    }
  });

  test("retries are bounded: 3 attempts then JevUnavailableError carrying the last status", async () => {
    const { calls, fetchImpl } = recording(() =>
      Response.json({ detail: "overloaded" }, { status: 529 }),
    );
    const err = await client(fetchImpl)
      .ask("s", { a: noul("q") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailableError);
    expect(err.status).toBe(529);
    expect(err.message).toMatch(/after 3 attempts \(HTTP 529: overloaded\)/);
    expect(calls.length).toBe(3);
  });

  test("network errors and timeouts are retried and end as JevUnavailableError", async () => {
    const net = recording(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client(net.fetchImpl).ask("s", { a: noul("q") })).rejects.toThrow(/fetch failed/);
    expect(net.calls.length).toBe(3);
    const slow: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    const err = await client(slow, { timeoutMs: 20, maxRetries: 1 })
      .ask("s", { a: noul("q") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevUnavailableError);
    expect(err.message).toMatch(/timed out after 20 ms/);
  });

  test("400 (including max_tokens_exceeded), 404 and 422 are never retried: JevRequestError", async () => {
    for (const [status, body] of [
      [400, { detail: "max_tokens_exceeded" }],
      [404, { detail: "not found" }],
      [422, { detail: [{ loc: ["body", "questions"], msg: "field required", type: "missing" }] }],
    ] as const) {
      const { calls, fetchImpl } = recording(() => Response.json(body, { status }));
      const err = await client(fetchImpl)
        .ask("s", { a: noul("q") })
        .catch((e) => e);
      expect(err).toBeInstanceOf(JevRequestError);
      expect(err.status).toBe(status);
      expect(calls.length).toBe(1);
      if (status === 400) expect(err.code).toBe("max_tokens_exceeded");
    }
  });

  test("401, 402 and 403 are JevUnavailableError without retries", async () => {
    for (const status of [401, 402, 403]) {
      const { calls, fetchImpl } = recording(() => Response.json({ detail: "no" }, { status }));
      const err = await client(fetchImpl)
        .ask("s", { a: noul("q") })
        .catch((e) => e);
      expect(err).toBeInstanceOf(JevUnavailableError);
      expect(err.status).toBe(status);
      expect(calls.length).toBe(1);
      expect(err.message).not.toContain("sk-test-secret");
    }
  });

  test("retry-after is honoured up to maxRetryAfterMs", async () => {
    const { calls, fetchImpl } = recording((call, n) =>
      n === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "30" } })
        : okAnswers(call),
    );
    const t0 = performance.now();
    await client(fetchImpl, { maxRetryAfterMs: 50 }).ask("s", { a: noul("q") });
    const ms = performance.now() - t0;
    expect(calls.length).toBe(2);
    expect(ms).toBeGreaterThanOrEqual(40);
    expect(ms).toBeLessThan(1000);
  });
});

describe("abort", () => {
  test("aborting cancels the in-flight request and rejects with the caller's reason, without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: JevFetch = (_url, init) => {
      calls++;
      setTimeout(() => controller.abort(new Error("turn interrupted")), 5);
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    };
    await expect(
      client(fetchImpl).ask("s", { a: noul("q") }, { signal: controller.signal }),
    ).rejects.toThrow("turn interrupted");
    expect(calls).toBe(1);
  });

  test("aborting during a retry backoff stops at once", async () => {
    const controller = new AbortController();
    const { calls, fetchImpl } = recording(() => {
      setTimeout(() => controller.abort(new Error("stop")), 5);
      return new Response("{}", { status: 503, headers: { "retry-after": "10" } });
    });
    const t0 = performance.now();
    await expect(
      client(fetchImpl, { maxRetryAfterMs: 10_000 }).ask(
        "s",
        { a: noul("q") },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("stop");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(calls.length).toBe(1);
  });

  test("queued requests are released when the caller aborts", async () => {
    const limiter = new JevLimiter(1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    const second = limiter.run(async () => "ran", controller.signal);
    controller.abort(new Error("gone"));
    await expect(second).rejects.toThrow("gone");
    release();
    await first;
    expect(await limiter.run(async () => "free")).toBe("free");
  });
});

describe("warm-up", () => {
  test("opens connections with free GET /healthz calls, at most once per activity window", async () => {
    const urls: string[] = [];
    const fetchImpl: JevFetch = async (url, init) => {
      urls.push(`${init.method} ${url}`);
      return new Response("{}");
    };
    const c = client(fetchImpl);
    c.warmUp(3);
    c.warmUp(3);
    await new Promise((r) => setTimeout(r, 5));
    expect(urls).toEqual(Array(3).fill("GET http://jev.local/healthz"));
  });
});
