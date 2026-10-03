import { expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { AnthropicMessagesModel } from "../../../packages/runtime/src/anthropic-messages";
import { AnthropicRequestError } from "../../../packages/runtime/src/anthropic-request-error";
import { classifyProviderQuotaError } from "../../../packages/runtime/src/provider-quota";
import { ResponsesStreamingTerminalError } from "../../../packages/runtime/src/responses-terminal-error";
import { agentRunFailurePayload, providerRetryAfterMs } from "../src/activities/agent-turn/errors";
import { failedSessionCopy } from "../../web/src/lib/failed-session-copy";
import { summarizeSessionFailure } from "../../web/src/lib/events";

const provider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  builtin: false,
  baseUrl: "https://api.example.test/v1",
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
  } catch (failure) {
    caught = failure;
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
  for (const type of ["future_error", "toString", "__proto__", "constructor"]) {
    const error = await claudeFailure({
      type,
      message: "overloaded / rate limit",
      request: "synthetic echoed request",
    });
    expect((error as { status?: number }).status).toBeUndefined();
    expect((error as Error).cause).toBeInstanceOf(AnthropicRequestError);
    expect(((error as Error).cause as AnthropicRequestError).status).toBeUndefined();
    const failure = agentRunFailurePayload(error);
    expect(failure.retryable).not.toBe(true);
    expect(failure.detail).toBe(`${type}: overloaded / rate limit`);
    expect(JSON.stringify(error)).not.toContain("overloaded / rate limit");
    expect(JSON.stringify(error)).not.toContain("synthetic echoed request");
    expect(JSON.stringify(failure)).not.toContain("synthetic echoed request");
  }
});

test("Claude payment-detail errors remain terminal without claiming exhausted credits", async () => {
  for (const status of [402, undefined]) {
    const error = await claudeFailure(
      { type: "billing_error", message: "Payment card requires updating" },
      status,
    );
    expect((error as { status?: number }).status).toBe(402);
    expect(classifyProviderQuotaError(error)).toBeNull();
    const payload = agentRunFailurePayload(error);
    expect(payload).toMatchObject({ code: "provider_billing_error", retryable: false });
    expect(payload.quotaScope).toBeUndefined();
    const copy = failedSessionCopy({
      reason: payload.error,
      recordedDetail: payload.error,
      failureCode: payload.code,
      failedAt: null,
      consecutiveRecoveryCount: null,
    });
    expect(copy.reason).toContain("payment details");
    expect(copy.reason).not.toMatch(/out of credits|quota.*used up/i);
  }
});

test("native Claude credential refusal stays actionable through the worker and banner", async () => {
  const error = await claudeFailure({ type: "authentication_error", message: "private" }, 401);
  const payload = agentRunFailurePayload(error);
  const copy = failedSessionCopy(
    {
      reason: payload.error,
      recordedDetail: payload.error,
      failureCode: payload.code,
      failedAt: null,
      consecutiveRecoveryCount: null,
    },
    false,
    false,
    true,
  );
  expect(copy).toMatchObject({
    reason:
      "The model provider rejected the credentials for this model. Choose another model below.",
    retryUnhelpful: true,
    unavailableModel: false,
  });
  expect(copy.detail).toBe(
    "Claude credentials expired or were revoked. Replace the key or setup token in Models.",
  );
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

test("typed native Claude authentication proof survives the real failure projection", async () => {
  for (const status of [401, undefined]) {
    const error = await claudeFailure(
      { type: "authentication_error", message: "synthetic diagnostic" },
      status,
    );
    const payload = agentRunFailurePayload(error);
    expect(payload).toMatchObject({ code: "anthropic_authentication_error", retryable: false });
    const failure = summarizeSessionFailure(
      [
        {
          id: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          sequence: 1,
          type: "turn.failed",
          payload,
          occurredAt: "2031-04-05T06:07:08.000Z",
        },
      ],
      "failed",
    );
    expect(failure.failureCode).toBe("anthropic_authentication_error");
    expect(failure.recordedDetail).toBe(`${payload.error}\n${payload.detail}`);
    const copy = failedSessionCopy(failure, false, false, true);
    expect(copy).toMatchObject({
      reason:
        "The model provider rejected the credentials for this model. Choose another model below.",
      retryUnhelpful: true,
      unavailableModel: false,
      detail: failure.recordedDetail,
    });
    expect(JSON.stringify(error)).not.toContain("synthetic diagnostic");
  }
});

test("authentication presentation requires typed native proof and matching status", () => {
  const native = (status: number) =>
    new AnthropicRequestError(
      "synthetic request refusal",
      status,
      "anthropic_http_error",
      { type: "authentication_error", message: "synthetic diagnostic" },
      new Headers(),
    );
  for (const error of [
    Object.assign(new Error("synthetic request refusal"), {
      name: "AnthropicRequestError",
      status: 401,
      code: "anthropic_http_error",
    }),
    native(403),
    Object.assign(new Error("synthetic request refusal"), { status: 403, cause: native(401) }),
  ]) {
    expect(agentRunFailurePayload(error).code).not.toBe("anthropic_authentication_error");
  }
  for (const failureCode of ["anthropic_http_error", "anthropic_stream_error"]) {
    expect(
      failedSessionCopy({
        reason: "authentication_error: synthetic diagnostic",
        recordedDetail: "authentication_error: synthetic diagnostic",
        failureCode,
        failedAt: null,
        consecutiveRecoveryCount: null,
      }).retryUnhelpful,
    ).not.toBe(true);
  }
});
