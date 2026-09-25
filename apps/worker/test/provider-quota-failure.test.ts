import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CODEX_TRANSPORT_ERROR_HEADER } from "@opengeni/codex";
import { buildOpenAIClientFromSettings, CompactionProviderResponseError } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  agentRunFailurePayload,
  compactionFailureReasonFromError,
  providerRecoveryResult,
  shouldRecoverCompactionProviderFailure,
} from "../src/activities/agent-turn";

// Realistic provider refusals, replayed over real HTTP through the same OpenAI
// SDK client the worker builds for the built-in provider (SDK retries enabled).
type ProviderReply = { status: number; body: unknown; headers?: Record<string, string> };

const OPENROUTER_FREE_PER_DAY: ProviderReply = {
  status: 429,
  body: {
    error: {
      message:
        "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      code: 429,
      metadata: {
        headers: {
          "X-RateLimit-Limit": "50",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1758844800000",
        },
        provider_name: null,
      },
    },
    user_id: "user_fixture",
  },
};
const OPENROUTER_FREE_PER_MINUTE: ProviderReply = {
  status: 429,
  body: {
    error: {
      message: "Rate limit exceeded: free-models-per-min. ",
      code: 429,
      metadata: {
        headers: {
          "X-RateLimit-Limit": "20",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1758800000000",
        },
        provider_name: null,
      },
    },
  },
  headers: { "retry-after-ms": "1" },
};
const OPENAI_INSUFFICIENT_QUOTA: ProviderReply = {
  status: 429,
  body: {
    error: {
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      type: "insufficient_quota",
      param: null,
      code: "insufficient_quota",
    },
  },
};
const OPENAI_TOKENS_PER_MINUTE: ProviderReply = {
  status: 429,
  body: {
    error: {
      message:
        "Rate limit reached for gpt-4o in organization org-fixture on tokens per min (TPM): Limit 30000, Used 29500, Requested 1200. Please try again in 1.4s. Visit https://platform.openai.com/account/rate-limits to learn more.",
      type: "tokens",
      param: null,
      code: "rate_limit_exceeded",
    },
  },
  headers: { "retry-after-ms": "1" },
};
const AZURE_EXCEEDED_QUOTA_DAY: ProviderReply = {
  status: 429,
  body: {
    error: {
      code: "429",
      message:
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 86400 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
    },
  },
  headers: { "retry-after": "86400" },
};
const AZURE_TOKEN_RATE_LIMIT: ProviderReply = {
  status: 429,
  body: {
    error: {
      code: "429",
      message:
        "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 1 second. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.",
    },
  },
  headers: { "retry-after": "1", "retry-after-ms": "1" },
};
const OPENROUTER_OUT_OF_CREDITS: ProviderReply = {
  status: 402,
  body: {
    error: {
      message:
        "This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
      code: 402,
    },
  },
};

let server: ReturnType<typeof Bun.serve>;
let reply: ProviderReply = OPENROUTER_FREE_PER_DAY;
let serverRequests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      serverRequests += 1;
      // Drain the streamed request body so the kept-alive connection stays usable.
      await request.text();
      return Response.json(reply.body, { status: reply.status, headers: reply.headers });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

/** One chat completion through the worker's real built-in client; returns the thrown SDK error. */
async function providerFailure(
  next: ProviderReply,
  maxRetries = 5,
): Promise<{ error: unknown; requests: number }> {
  reply = next;
  serverRequests = 0;
  const client = buildOpenAIClientFromSettings(
    testSettings({
      openaiApiKey: "sk-fixture",
      openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      openaiMaxRetries: maxRetries,
    }),
  );
  try {
    await client.chat.completions.create({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
    });
  } catch (error) {
    return { error, requests: serverRequests };
  }
  throw new Error("expected the provider refusal to throw");
}

describe("provider quota exhaustion fails the turn promptly", () => {
  test("an OpenRouter free-models-per-day 429 is a non-retryable daily limit", async () => {
    const { error, requests } = await providerFailure(OPENROUTER_FREE_PER_DAY);
    // The SDK must not replay a refusal that cannot clear.
    expect(requests).toBe(1);
    const payload = agentRunFailurePayload(error);
    expect(payload).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "daily",
    });
    expect(payload.error).toBe(
      "This model's daily limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets.",
    );
    expect(payload.detail).toContain("free-models-per-day");
  });

  test("an OpenAI insufficient_quota 429 is a non-retryable used-up quota", async () => {
    const { error, requests } = await providerFailure(OPENAI_INSUFFICIENT_QUOTA);
    expect(requests).toBe(1);
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "quota",
      detail: expect.stringContaining("You exceeded your current quota"),
    });
  });

  test("an Azure 429 whose own retry hint is a whole day is quota, not pacing", async () => {
    const { error, requests } = await providerFailure(AZURE_EXCEEDED_QUOTA_DAY);
    expect(requests).toBe(1);
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "quota",
    });
  });

  test("a 402 out-of-credits refusal carries the same typed code", async () => {
    const { error, requests } = await providerFailure(OPENROUTER_OUT_OF_CREDITS);
    expect(requests).toBe(1);
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "credits",
      error:
        "The model provider account for this model is out of credits, so automatic retries stopped. Choose another model, or add credits with the provider and try again.",
    });
  });

  test("ordinary per-minute rate limits stay retryable with the existing pacing", async () => {
    for (const next of [
      OPENROUTER_FREE_PER_MINUTE,
      OPENAI_TOKENS_PER_MINUTE,
      AZURE_TOKEN_RATE_LIMIT,
    ]) {
      const { error, requests } = await providerFailure(next, 2);
      // The SDK keeps its own short retries for ordinary pacing.
      expect(requests).toBe(3);
      const payload = agentRunFailurePayload(error);
      expect(payload).toMatchObject({ code: "provider_rate_limited", retryable: true });
      expect(
        providerRecoveryResult({ failureCode: payload.code, attemptNumber: 1, retryAfterMs: null }),
      ).toEqual({ status: "recovering", continueDelayMs: 60_000 });
    }
  });

  test("subscription transports keep their credential-rotation quota semantics", () => {
    const codexQuota = Object.assign(new Error("429 You exceeded your current quota"), {
      status: 429,
      code: "insufficient_quota",
      headers: new Headers({ [CODEX_TRANSPORT_ERROR_HEADER]: "1" }),
    });
    expect(agentRunFailurePayload(codexQuota)).toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
    });
  });

  test("an exhausted quota during compaction is terminal with plain copy", async () => {
    const { error } = await providerFailure(OPENROUTER_FREE_PER_DAY);
    const compactError = new CompactionProviderResponseError(
      { httpStatus: 429, code: "429", message: (error as Error).message },
      error,
    );
    expect(shouldRecoverCompactionProviderFailure(compactError)).toBe(false);
    expect(compactionFailureReasonFromError(compactError)).toBe(
      "compaction summarization failed: This model's daily limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets. Active history was preserved.",
    );

    const { error: perMinute } = await providerFailure(OPENROUTER_FREE_PER_MINUTE, 0);
    expect(
      shouldRecoverCompactionProviderFailure(
        new CompactionProviderResponseError({ httpStatus: 429 }, perMinute),
      ),
    ).toBe(true);
  });

  test("non-provider quota text keeps its existing classification", () => {
    expect(agentRunFailurePayload(new Error("ENOSPC: Disk quota exceeded"))).toEqual({
      error: "ENOSPC: Disk quota exceeded",
    });
    expect(agentRunFailurePayload(new Error("insufficient OpenGeni credits"))).toEqual({
      error: "insufficient OpenGeni credits",
    });
  });
});
