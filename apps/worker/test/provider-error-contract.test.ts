import { expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../../../packages/runtime/src/anthropic-messages";
import { classifyProviderQuotaError } from "../../../packages/runtime/src/provider-quota";
import { ResponsesStreamingTerminalError } from "../../../packages/runtime/src/responses-terminal-error";
import { agentRunFailurePayload, providerRetryAfterMs } from "../src/activities/agent-turn/errors";

const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "fixture",
};
const request: ModelRequest = {
  input: "Hello",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

for (const [code, scope] of [
  ["credit_balance_exhausted", "credits"],
  ["organization_spend_limit_exceeded", "monthly"],
  ["project_spend_limit_exceeded", "monthly"],
  ["organization_usage_limit_exceeded", "monthly"],
] as const) {
  test(`documented quota code ${code} works without explanatory wording`, () => {
    expect(
      classifyProviderQuotaError(
        Object.assign(new Error("429"), {
          status: 429,
          error: { code, message: "Request refused" },
        }),
      ),
    ).toEqual({ scope });
  });
}

for (const [code, category] of [
  ["slow_down", "rate_limit"],
  ["server_is_overloaded", "unavailable"],
] as const) {
  test(`documented Responses terminal ${code} retains its recovery class`, () => {
    expect(
      new ResponsesStreamingTerminalError("response.failed", { code, message: "refused" }).category,
    ).toBe(category);
  });
}

async function claudeFailure(error: unknown, status?: number) {
  let requests = 0;
  const model = new AnthropicMessagesModel(provider, "fixture", (async () => {
    requests += 1;
    return status === undefined
      ? new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : new Response(JSON.stringify({ type: "error", error }), { status });
  }) as typeof fetch);
  let caught: unknown;
  try {
    if (status === undefined)
      for await (const _ of model.getStreamedResponse(request)) {
        /* drain */
      }
    else await model.getResponse(request);
  } catch (error) {
    caught = error;
  }
  expect(requests).toBe(1);
  expect(caught).toBeDefined();
  return caught;
}

test("Claude tier spend cap is terminal even with rate-limit type and no retry hint", async () => {
  for (const status of [429, undefined]) {
    const error = await claudeFailure(
      {
        type: "rate_limit_error",
        message: "private provider text",
        details: { error_code: "enforced_spend_limit_reached" },
      },
      status,
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      quotaScope: "monthly",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("private provider text");
  }
});

test("Claude configured organization and workspace spend caps preserve the documented HTTP 400 proof", async () => {
  for (const prefix of [
    "You have reached your specified API usage limits",
    "You have reached your specified workspace API usage limits",
  ]) {
    const error = await claudeFailure(
      { type: "invalid_request_error", message: `${prefix}. private provider text` },
      400,
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      quotaScope: "monthly",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("private provider text");
  }
});

test("ordinary Claude throttling and overload retain bounded recovery", async () => {
  for (const [type, status, code] of [
    ["rate_limit_error", 429, "provider_rate_limited"],
    ["overloaded_error", 529, "provider_unavailable"],
  ] as const) {
    const error = await claudeFailure({ type, message: "private" });
    expect((error as { status?: number }).status).toBe(status);
    expect(agentRunFailurePayload(error)).toMatchObject({ code, retryable: true });
  }
});

test("Claude spend-limit text elsewhere in an invalid request is not quota authority", async () => {
  const error = await claudeFailure(
    {
      type: "invalid_request_error",
      message: "Your prompt mentions: You have reached your specified API usage limits",
    },
    400,
  );
  expect(agentRunFailurePayload(error).code).not.toBe("provider_quota_exhausted");
  expect(agentRunFailurePayload(error).retryable).not.toBe(true);
});

test("Responses safety and unknown codes never acquire transient recovery from wording", () => {
  for (const [code, category] of [
    ["misalignment_policy_violation", "safety"],
    ["new_future_error", "unknown"],
  ] as const) {
    expect(
      new ResponsesStreamingTerminalError("response.failed", {
        code,
        message: "overloaded rate limit",
      }).category,
    ).toBe(category);
  }
});

test("unknown Claude stream error does not invent a retryable HTTP server failure", async () => {
  const error = await claudeFailure({ type: "future_error", message: "overloaded / rate limit" });
  expect((error as { status?: number }).status).toBeUndefined();
  expect(agentRunFailurePayload(error).retryable).not.toBe(true);
});

test("documented Claude billing stream failure remains a payment refusal", async () => {
  const error = await claudeFailure({ type: "billing_error", message: "private" });
  expect((error as { status?: number }).status).toBe(402);
  expect(agentRunFailurePayload(error)).toMatchObject({
    code: "provider_quota_exhausted",
    quotaScope: "credits",
    retryable: false,
  });
});

test("real request refusal wins over rate-limit wording", () => {
  expect(
    agentRunFailurePayload(
      Object.assign(new Error("400 invalid rate limit setting"), {
        status: 400,
        code: "invalid_request_error",
      }),
    ).retryable,
  ).not.toBe(true);
});

test("Azure millisecond retry hints survive HTTP and semantic stream failure boundaries", () => {
  const headers = new Headers({
    "retry-after-ms": "180000",
    "retry-after": "30",
    "set-cookie": "fixture",
  });
  for (const error of [
    Object.assign(new Error("429"), { status: 429, headers }),
    new ResponsesStreamingTerminalError(
      "response.failed",
      { code: "rate_limit_exceeded" },
      headers,
    ),
  ]) {
    expect(providerRetryAfterMs(error)).toBe(180_000);
  }
  const semantic = new ResponsesStreamingTerminalError(
    "response.failed",
    { code: "rate_limit_exceeded" },
    headers,
  );
  expect(semantic.retryAfterSeconds).toBe(180);
  expect([...semantic.headers.keys()].sort()).toEqual(["retry-after", "retry-after-ms"]);
  for (const hint of ["", "0", "-1", "Infinity", "NaN"]) {
    expect(providerRetryAfterMs({ headers: { "retry-after-ms": hint, "retry-after": "30" } })).toBe(
      30_000,
    );
  }
});

test("OpenAI HTTP misalignment refusal stops automatic recovery without blaming credentials", () => {
  expect(
    agentRunFailurePayload(
      Object.assign(new Error("403"), { status: 403, code: "misalignment_policy_violation" }),
    ),
  ).toMatchObject({ code: "provider_safety_refusal", retryable: false });
});
