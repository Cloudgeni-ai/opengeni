import { expect, test } from "bun:test";
import { AnthropicRequestError, ModelStreamIdleTimeoutError } from "@opengeni/runtime";
import {
  agentRunFailurePayload,
  agentRunRecoveryFailurePayload,
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  providerRecoveryExhaustedFailure,
  providerRecoveryResult,
  withModelRoutePresentation,
} from "../src/activities/agent-turn/errors";
import { providerRecoveryExhaustedMessage } from "../src/activities/agent-turn/provider-recovery-copy";

const route = {
  model: "claude-opus-5-5",
  modelLabel: "Claude Opus 5.5",
  providerLabel: "Amazon Bedrock",
};

function exhausted() {
  const recovery = providerRecoveryResult({
    failureCode: "provider_unavailable",
    attemptNumber: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1,
  });
  if (recovery.status !== "exhausted") throw new Error("expected exhaustion");
  return recovery;
}

test("an Anthropic-wire 503 overloaded_error is a retryable overloaded provider condition", () => {
  const error = new AnthropicRequestError(
    "Claude request failed (HTTP 503)",
    503,
    "anthropic_http_error",
    { type: "overloaded_error", message: "Overloaded" },
    new Headers(),
  );
  expect(agentRunFailurePayload(error)).toMatchObject({
    code: "provider_unavailable",
    retryable: true,
    providerCondition: "overloaded",
  });
});

test("HTTP 529 and provider overload wording classify as overloaded; other 5xx stay unavailable", () => {
  expect(
    agentRunFailurePayload(
      Object.assign(new Error("Claude stream failed (HTTP 529)"), { status: 529 }),
    ),
  ).toMatchObject({ code: "provider_unavailable", providerCondition: "overloaded" });
  expect(
    agentRunFailurePayload(
      new Error("SDK wrapper", {
        cause: Object.assign(new Error("503 The model is overloaded. Try again later."), {
          status: 503,
        }),
      }),
    ),
  ).toMatchObject({ code: "provider_unavailable", providerCondition: "overloaded" });
  expect(
    agentRunFailurePayload(Object.assign(new Error("502 Bad Gateway"), { status: 502 })),
  ).toMatchObject({ code: "provider_unavailable", providerCondition: "unavailable" });
  expect(
    agentRunFailurePayload(Object.assign(new Error("Too Many Requests"), { status: 429 })),
  ).toMatchObject({ code: "provider_rate_limited", providerCondition: "rate_limited" });
  // A refusal is never reclassified by its wording.
  expect(
    agentRunFailurePayload(Object.assign(new Error("overloaded"), { status: 400 })),
  ).not.toHaveProperty("providerCondition");
});

test("a silent provider stream is unresponsive, not overloaded", () => {
  const failure = agentRunFailurePayload(
    new ModelStreamIdleTimeoutError("anthropic", "bytes", 30_000, 0),
  );
  expect(failure).toMatchObject({
    code: "provider_unavailable",
    providerCondition: "unresponsive",
  });
});

test("model route labels attach only to model-provider recovery evidence", () => {
  const provider = withModelRoutePresentation(
    { error: "overloaded", code: "provider_unavailable", retryable: true },
    route,
  );
  expect(provider).toMatchObject(route);
  expect(agentRunRecoveryFailurePayload(new Error("x"), provider)).toMatchObject(route);
  const mcp = withModelRoutePresentation(
    { error: "MCP down", code: "mcp_transport_unavailable", retryable: true },
    route,
  );
  expect(mcp).not.toHaveProperty("modelLabel");
  expect(
    withModelRoutePresentation({ error: "x", code: "provider_unavailable" }, undefined),
  ).toEqual({ error: "x", code: "provider_unavailable" });
});

test("exhaustion names the model, the provider condition and the remedies", () => {
  const failure = providerRecoveryExhaustedFailure(
    {
      ...withModelRoutePresentation(
        {
          error: "Claude request failed (HTTP 503)",
          code: "provider_unavailable",
          retryable: true,
          providerCondition: "overloaded" as const,
        },
        route,
      ),
    },
    exhausted(),
  );
  expect(failure).toMatchObject({
    error:
      "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model.",
    code: "provider_unavailable",
    providerCondition: "overloaded",
    modelLabel: "Claude Opus 5.5",
    providerLabel: "Amazon Bedrock",
    retryable: false,
    recoveryExhausted: true,
    providerRecoveryCount: 5,
    maxProviderRecoveryCount: 5,
    lastRetryableError: "Claude request failed (HTTP 503)",
  });
  expect(failure.error).not.toMatch(/upstream dependency/);
});

test("exhaustion copy degrades gracefully without labels and for non-model dependencies", () => {
  expect(
    providerRecoveryExhaustedMessage({
      code: "provider_unavailable",
      providerRecoveryCount: 5,
    }),
  ).toBe(
    "The model is temporarily unavailable at the provider. Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model.",
  );
  expect(
    providerRecoveryExhaustedMessage({
      code: "provider_rate_limited",
      modelLabel: "GPT-5.6",
      providerLabel: "Azure OpenAI",
      providerRecoveryCount: 5,
    }),
  ).toBe(
    "GPT-5.6 is rate limited at the provider (Azure OpenAI). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model.",
  );
  expect(
    providerRecoveryExhaustedFailure(
      {
        error: "A required MCP server was temporarily unreachable.",
        code: "mcp_transport_unavailable",
      },
      exhausted(),
    ).error,
  ).toBe(
    "A required MCP server is unreachable. Opengeni retried 5 times without success. Try again in a few minutes.",
  );
});
