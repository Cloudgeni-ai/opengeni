import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@opengeni/runtime";
import { APIError } from "openai";
import {
  agentRunFailurePayload,
  classifyProviderQuotaExhaustionError,
} from "../src/activities/agent-turn";
import { GatewayImageApiError } from "../src/activities/gateway-image-generation";

// What the agents SDK throws when a function tool without an error function
// fails: the tool's own error wrapped in a ToolCallError.
function thrownByTool(error: Error): ToolCallError {
  return new ToolCallError(`Failed to run function tools: ${error}`, error);
}

const OUT_OF_CREDIT =
  "Insufficient funds. Please add credits to your account to continue using AI services. Visit https://billing.example.com/top-up to top up your credits.";

describe("a tool's own provider failure is not the chat model's", () => {
  test("an image provider out of credit never reads as the chat model out of credits", () => {
    const error = thrownByTool(
      new GatewayImageApiError(
        402,
        `AI Gateway image generation failed (402): ${OUT_OF_CREDIT}`,
        OUT_OF_CREDIT,
      ),
    );
    expect(classifyProviderQuotaExhaustionError(error)).toBeNull();
    const failure = agentRunFailurePayload(error);
    expect(failure).toEqual({
      error: "A tool's provider refused its request, so this turn stopped.",
      code: "tool_provider_refused",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("billing.example.com");
  });

  test("a tool provider rate limit neither retries the turn nor blames the chat model", () => {
    const error = thrownByTool(
      new GatewayImageApiError(429, "AI Gateway image generation failed (429): Too many requests"),
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "tool_provider_refused",
      retryable: false,
    });
  });

  test("the chat model's own 402 still fails the turn as provider quota", () => {
    const error = APIError.generate(
      402,
      { error: { message: OUT_OF_CREDIT, type: "insufficient_funds" } },
      undefined,
      new Headers(),
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "credits",
    });
  });

  test("the chat model's own short rate limit still retries the turn", () => {
    const error = APIError.generate(
      429,
      { error: { message: "Rate limit reached for requests" } },
      undefined,
      new Headers({ "retry-after": "2" }),
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
    });
  });
});
