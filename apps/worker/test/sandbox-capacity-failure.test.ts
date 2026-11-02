import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@opengeni/runtime";
import { ComputeControlClient, ComputeControlError } from "@opengeni/runtime/sandbox";
import { APIError } from "openai";
import {
  agentRunFailurePayload,
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  PROVIDER_BACKPRESSURE_DELAY_MS,
  providerRecoveryCode,
  providerRecoveryExhaustedFailure,
  providerRecoveryResult,
  withModelRoutePresentation,
} from "../src/activities/agent-turn/errors";
import { SandboxProvisionStageError } from "../src/sandbox-resume";

// The staging failure: compute-control answered a sandbox create with
// 503 {code: "no_capacity"}. That is the sandbox fleet being full, never the
// chat model's provider.
async function noCapacityFromControlService(): Promise<ComputeControlError> {
  const client = new ComputeControlClient({
    baseUrl: "http://compute-control.test",
    apiKey: "control-key",
    maxAttempts: 1,
    fetch: (async () =>
      new Response(JSON.stringify({ code: "no_capacity", message: "no host can take it now" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  const error = await client
    .create({ request_id: "req-1" } as Parameters<ComputeControlClient["create"]>[0])
    .catch((caught: unknown) => caught);
  if (!(error instanceof ComputeControlError)) throw new Error("expected a ComputeControlError");
  return error;
}

// What the agents SDK throws when a function tool fails: the tool's own error
// on `.error`, not on `.cause`.
function thrownByTool(error: Error): ToolCallError {
  return new ToolCallError(`Failed to run function tools: ${error}`, error);
}

const route = {
  model: "claude-opus-5-5",
  modelLabel: "Claude Opus 5.5",
  providerLabel: "Claude subscription",
};

function blamesModel(text: string): boolean {
  return /\bmodel\b|\bprovider\b|claude|opus/i.test(text);
}

describe("a sandbox capacity failure is never the chat model's provider", () => {
  test("the control service's 503 no_capacity is sandbox capacity, retryable", async () => {
    const error = await noCapacityFromControlService();
    expect(error.kind).toBe("no_capacity");
    expect(error.status).toBe(503);
    const failure = agentRunFailurePayload(error);
    expect(failure).toMatchObject({
      code: "sandbox_capacity_unavailable",
      retryable: true,
      error:
        "No sandbox capacity is available right now. The same turn will retry after a short delay.",
    });
    expect(failure.detail).toContain("no host can take it now");
    expect(failure).not.toHaveProperty("providerCondition");
    expect(blamesModel(failure.error)).toBe(false);
  });

  test("the same failure surfaced through a function tool keeps its sandbox code", async () => {
    const error = thrownByTool(await noCapacityFromControlService());
    expect(error.message).toContain(
      "Failed to run function tools: ComputeControlError: compute control service POST /v1/sandboxes: no host can take it now",
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "sandbox_capacity_unavailable",
      retryable: true,
    });
  });

  test("cause wrappers (provision stage, SDK rethrows) keep the sandbox code", async () => {
    const source = await noCapacityFromControlService();
    for (const error of [
      new SandboxProvisionStageError("create", source),
      new Error("sandbox establish failed", { cause: source }),
      thrownByTool(new Error("lazy sandbox", { cause: source })),
      new AggregateError([source], "Failed to run function tools"),
    ]) {
      expect(agentRunFailurePayload(error)).toMatchObject({
        code: "sandbox_capacity_unavailable",
        retryable: true,
      });
    }
  });

  test("its recovery and exhausted copy name the sandbox, never the model", async () => {
    const error = await noCapacityFromControlService();
    const failure = withModelRoutePresentation(agentRunFailurePayload(error), route);
    expect(failure).not.toHaveProperty("modelLabel");
    expect(failure).not.toHaveProperty("providerLabel");
    expect(providerRecoveryCode(error, failure)).toBe("sandbox_capacity_unavailable");

    const recovering = providerRecoveryResult({
      failureCode: "sandbox_capacity_unavailable",
      attemptNumber: 1,
      jitterSample: 0,
    });
    expect(recovering).toEqual({
      status: "recovering",
      continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS,
    });

    const spent = providerRecoveryResult({
      failureCode: "sandbox_capacity_unavailable",
      attemptNumber: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1,
    });
    if (spent.status !== "exhausted") throw new Error("expected exhaustion");
    const terminal = providerRecoveryExhaustedFailure(failure, spent);
    expect(terminal).toMatchObject({
      code: "sandbox_capacity_unavailable",
      retryable: false,
      recoveryExhausted: true,
      error:
        "No sandbox capacity is available right now. Retried 5 times without success. Try again in a few minutes.",
    });
    expect(blamesModel(terminal.error)).toBe(false);
  });

  test("other control service failures are the sandbox service, retryable per their kind", () => {
    const unavailable = new ComputeControlError({
      kind: "unavailable",
      status: 503,
      message: "compute control service POST /v1/sandboxes: service unavailable",
    });
    const host = thrownByTool(
      new ComputeControlError({
        kind: "host",
        status: 502,
        message: "compute control service POST /v1/sandboxes/sbx/wake: host failed",
      }),
    );
    const transport = new ComputeControlError({
      kind: "transport",
      status: null,
      message: "compute control service POST /v1/sandboxes did not answer",
    });
    for (const error of [unavailable, host, transport]) {
      const failure = agentRunFailurePayload(error);
      expect(failure).toMatchObject({
        code: "sandbox_service_unavailable",
        retryable: true,
        error:
          "The sandbox service is temporarily unavailable. The same turn will retry after a short delay.",
      });
      expect(blamesModel(failure.error)).toBe(false);
    }
    const spent = providerRecoveryResult({
      failureCode: "sandbox_service_unavailable",
      attemptNumber: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1,
    });
    if (spent.status !== "exhausted") throw new Error("expected exhaustion");
    expect(providerRecoveryExhaustedFailure(agentRunFailurePayload(unavailable), spent).error).toBe(
      "The sandbox service is temporarily unavailable. Retried 5 times without success. Try again in a few minutes.",
    );
  });

  test("a control service refusal that retrying cannot fix stops without blaming the model", () => {
    const error = thrownByTool(
      new ComputeControlError({
        kind: "unauthorized",
        status: 401,
        message: "compute control service POST /v1/sandboxes: invalid api key",
      }),
    );
    const failure = agentRunFailurePayload(error);
    expect(failure).toMatchObject({
      code: "sandbox_service_unavailable",
      retryable: false,
      error: "This turn couldn't get a sandbox. Automatic retries stopped.",
    });
    expect(failure.detail).toContain("invalid api key");
  });

  test("the chat model's own 503 is still the model provider", () => {
    const error = APIError.generate(
      503,
      { error: { message: "Service Unavailable" } },
      undefined,
      new Headers(),
    );
    expect(agentRunFailurePayload(error)).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });
});
