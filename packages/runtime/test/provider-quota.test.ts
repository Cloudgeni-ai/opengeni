import { describe, expect, test } from "bun:test";
import {
  classifyProviderQuotaExhaustion,
  classifyProviderQuotaResponse,
  providerMessageRetryHintMs,
  withoutQuotaExhaustedRetries,
  type ProviderQuotaScope,
} from "../src/provider-quota";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";

type Case = {
  name: string;
  status: number | null;
  texts: string[];
  retryAfterMs?: number | null;
  expected: ProviderQuotaScope | null;
};

// Provider wording as returned by each API. Each row pins which side of the
// quota/rate-limit boundary it falls on.
const cases: Case[] = [
  {
    name: "OpenRouter free-models-per-day",
    status: 429,
    texts: [
      "429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    ],
    expected: "daily",
  },
  {
    name: "OpenRouter free-models-per-min",
    status: 429,
    texts: ["429 Rate limit exceeded: free-models-per-min. "],
    expected: null,
  },
  {
    name: "OpenAI insufficient_quota",
    status: 429,
    texts: [
      "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      "insufficient_quota",
      "insufficient_quota",
    ],
    expected: "quota",
  },
  {
    name: "OpenAI insufficient_quota with a short retry hint",
    status: 429,
    texts: ["429 You exceeded your current quota", "insufficient_quota"],
    retryAfterMs: 2_000,
    expected: "quota",
  },
  {
    name: "OpenAI tokens per minute",
    status: 429,
    texts: [
      "429 Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29500, Requested 1200. Please try again in 1.4s. Visit https://platform.openai.com/account/rate-limits to learn more.",
      "rate_limit_exceeded",
      "tokens",
    ],
    retryAfterMs: 1_400,
    expected: null,
  },
  {
    name: "OpenAI requests per day",
    status: 429,
    texts: [
      "429 Rate limit reached for gpt-4o in organization org-x on requests per day (RPD): Limit 200, Used 200, Requested 1. Please try again in 7m12s. Visit https://platform.openai.com/account/rate-limits to learn more.",
      "rate_limit_exceeded",
      "requests",
    ],
    expected: "daily",
  },
  {
    name: "OpenAI requests per day that the provider says clears in seconds",
    status: 429,
    texts: [
      "429 Rate limit reached for gpt-4o on requests per day (RPD): Limit 10000, Used 10000, Requested 1. Please try again in 8.64s.",
    ],
    expected: null,
  },
  {
    name: "Groq tokens per day",
    status: 429,
    texts: [
      "429 Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 100000, Used 99876, Requested 1024. Please try again in 16m32.64s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
      "rate_limit_exceeded",
      "tokens",
    ],
    expected: "daily",
  },
  {
    name: "Google Gemini per-minute quota (same sentence as a used-up quota)",
    status: 429,
    texts: [
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10\nPlease retry in 38.662417882s.",
      "RESOURCE_EXHAUSTED",
    ],
    expected: null,
  },
  {
    name: "Google Gemini quota without a short retry hint",
    status: 429,
    texts: [
      "You exceeded your current quota, please check your plan and billing details.",
      "RESOURCE_EXHAUSTED",
    ],
    expected: "quota",
  },
  {
    name: "GitHub Models / Azure AI inference per day",
    status: 429,
    texts: [
      "Rate limit of 150 per 86400s exceeded for UserByModelByDay. Please wait 42567 seconds before retrying.",
      "RateLimitReached",
    ],
    expected: "daily",
  },
  {
    name: "GitHub Models / Azure AI inference per minute",
    status: 429,
    texts: [
      "Rate limit of 15 per 60s exceeded for UserByModelByMinute. Please wait 25 seconds before retrying.",
      "RateLimitReached",
    ],
    expected: null,
  },
  {
    name: "Azure OpenAI token rate limit",
    status: 429,
    texts: [
      "429 Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
      "429",
    ],
    retryAfterMs: 6_000,
    expected: null,
  },
  {
    name: "Azure OpenAI limit that resets in a day",
    status: 429,
    texts: [
      "429 Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 86400 seconds.",
    ],
    retryAfterMs: 86_400_000,
    expected: "quota",
  },
  {
    name: "Azure quota exceeded wording",
    status: 429,
    texts: ["Quota exceeded for this deployment. Please retry after 2 hours.", "QuotaExceeded"],
    expected: "quota",
  },
  {
    name: "Anthropic tokens per minute",
    status: 429,
    texts: [
      "429 This request would exceed the rate limit for your organization of 50,000 input tokens per minute.",
      "rate_limit_error",
    ],
    retryAfterMs: 12_000,
    expected: null,
  },
  {
    name: "Anthropic credit balance (HTTP 400, already a terminal request fault)",
    status: 400,
    texts: [
      "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    ],
    expected: null,
  },
  {
    name: "OpenRouter insufficient credits",
    status: 402,
    texts: [
      "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200.",
    ],
    expected: "credits",
  },
  {
    name: "DeepSeek insufficient balance",
    status: 402,
    texts: ["402 Insufficient Balance"],
    expected: "credits",
  },
  {
    name: "xAI API credits or monthly spending limit",
    status: 429,
    texts: [
      "Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
    ],
    expected: "credits",
  },
  {
    name: "statusless streamed daily cap",
    status: null,
    texts: ["Rate limit exceeded: free-models-per-day"],
    expected: "daily",
  },
  {
    name: "statusless structured insufficient_quota",
    status: null,
    texts: ["You exceeded your current quota", "insufficient_quota"],
    expected: "quota",
  },
  {
    name: "plain 429 with a short hint",
    status: 429,
    texts: ["429 Too Many Requests"],
    retryAfterMs: 20_000,
    expected: null,
  },
  {
    name: "plain 429 without a hint",
    status: 429,
    texts: ["429 Too Many Requests"],
    expected: null,
  },
  {
    name: "plain 429 whose provider hint is an hour",
    status: 429,
    texts: ["429 Too Many Requests"],
    retryAfterMs: 3_600_000,
    expected: "quota",
  },
  {
    name: "sandbox disk quota is not provider evidence",
    status: null,
    texts: ["ENOSPC: Disk quota exceeded"],
    expected: null,
  },
  {
    name: "OpenGeni credit refusal is not provider evidence",
    status: null,
    texts: ["429 insufficient OpenGeni credits"],
    expected: null,
  },
  {
    name: "a 5xx with quota wording stays transient",
    status: 503,
    texts: ["503 quota service unavailable, quota exceeded"],
    expected: null,
  },
];

describe("classifyProviderQuotaExhaustion", () => {
  for (const row of cases) {
    test(row.name, () => {
      expect(
        classifyProviderQuotaExhaustion({
          status: row.status,
          texts: row.texts,
          retryAfterMs: row.retryAfterMs ?? null,
        }),
      ).toEqual(row.expected === null ? null : { scope: row.expected });
    });
  }

  test("reads the status from an SDK message prefix when the wrapper dropped it", () => {
    expect(
      classifyProviderQuotaExhaustion({
        status: null,
        texts: ["402 Insufficient Balance"],
        retryAfterMs: null,
      }),
    ).toEqual({ scope: "credits" });
  });
});

describe("providerMessageRetryHintMs", () => {
  test("parses provider-written retry hints", () => {
    expect(providerMessageRetryHintMs("Please retry after 6 seconds.")).toBe(6_000);
    expect(providerMessageRetryHintMs("Please try again in 16m32.64s. Need more")).toBe(992_640);
    expect(providerMessageRetryHintMs("Please retry in 38.662417882s.")).toBe(38_663);
    expect(providerMessageRetryHintMs("Please wait 42567 seconds before retrying.")).toBe(
      42_567_000,
    );
    expect(providerMessageRetryHintMs("Please retry after 7 days.")).toBe(604_800_000);
    expect(providerMessageRetryHintMs("Try again in 250ms")).toBe(250);
    expect(providerMessageRetryHintMs("Try again in a minute")).toBeNull();
    expect(providerMessageRetryHintMs("no hint here")).toBeNull();
  });
});

describe("SDK retry veto", () => {
  const perDay = {
    error: {
      message:
        "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      code: 429,
      metadata: { headers: { "X-RateLimit-Remaining": "0" }, provider_name: null },
    },
  };
  const perMinute = { error: { message: "Rate limit exceeded: free-models-per-min.", code: 429 } };

  function client(body: unknown, headers: Record<string, string> = {}) {
    const calls = { count: 0 };
    const sdk = new ReplayableJsonOpenAI({
      apiKey: "test",
      baseURL: "https://quota.test/v1",
      maxRetries: 3,
      fetch: withoutQuotaExhaustedRetries(async () => {
        calls.count += 1;
        return Response.json(body, { status: 429, headers });
      }),
    });
    return { sdk, calls };
  }

  test("an exhausted quota reaches the caller after one request with its exact body", async () => {
    const { sdk, calls } = client(perDay);
    const error = await sdk
      .post("/chat/completions", { body: { model: "m", messages: [] } })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(calls.count).toBe(1);
    expect(error).toMatchObject({
      status: 429,
      message:
        "429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    });
  });

  test("an ordinary rate limit keeps the SDK's own retries", async () => {
    const { sdk, calls } = client(perMinute, { "retry-after-ms": "0" });
    await sdk
      .post("/chat/completions", { body: { model: "m", messages: [] } })
      .catch(() => undefined);
    expect(calls.count).toBe(4);
  });

  test("a provider's own retry directive is never overridden", async () => {
    const { sdk, calls } = client(perDay, { "x-should-retry": "true", "retry-after-ms": "0" });
    await sdk
      .post("/chat/completions", { body: { model: "m", messages: [] } })
      .catch(() => undefined);
    expect(calls.count).toBe(4);
  });

  test("the vetoed response keeps the exact status, body, headers and URL", async () => {
    const original = Response.json(perDay, { status: 429, headers: { "x-request-id": "req_1" } });
    Object.defineProperty(original, "url", { value: "https://quota.test/v1/chat/completions" });
    const vetoed = await withoutQuotaExhaustedRetries(async () => original)("https://quota.test");
    expect(vetoed.status).toBe(429);
    expect(vetoed.headers.get("x-should-retry")).toBe("false");
    expect(vetoed.headers.get("x-request-id")).toBe("req_1");
    expect(vetoed.url).toBe("https://quota.test/v1/chat/completions");
    expect(await vetoed.json()).toEqual(perDay);

    const ordinary = Response.json(perMinute, { status: 429 });
    expect(await withoutQuotaExhaustedRetries(async () => ordinary)("https://quota.test")).toBe(
      ordinary,
    );
  });

  test("classifies raw responses without consuming their body", async () => {
    const response = Response.json(perDay, { status: 429 });
    expect(await classifyProviderQuotaResponse(response)).toEqual({ scope: "daily" });
    expect(await response.json()).toEqual(perDay);
    expect(await classifyProviderQuotaResponse(Response.json(perDay, { status: 500 }))).toBeNull();
    const huge = new Response(`${"x".repeat(70 * 1024)} free-models-per-day`, { status: 429 });
    expect(await classifyProviderQuotaResponse(huge)).toBeNull();
    expect((await huge.text()).length).toBeGreaterThan(70 * 1024);
  });
});
