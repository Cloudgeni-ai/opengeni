import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@opengeni/runtime";
import {
  ComputeControlClient,
  ComputeControlError,
  loadE2BServiceBusyError,
} from "@opengeni/runtime/sandbox";
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
import { SandboxProviderError } from "@openai/agents-core/sandbox";
import { RoutingMutationOutcomeUnknownError } from "../../../packages/runtime/src/sandbox/routing/routing-session";

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

  test("cause wrappers (SDK rethrows, parallel tools) keep the sandbox code", async () => {
    const source = await noCapacityFromControlService();
    for (const error of [
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
        // compute-control's own 401 text.
        message: "compute control service POST /v1/sandboxes: a valid X-API-Key is needed",
      }),
    );
    const failure = agentRunFailurePayload(error);
    expect(failure).toMatchObject({
      code: "sandbox_service_refused",
      retryable: false,
      error:
        "The sandbox service refused to provide a sandbox for this turn. This turn stopped without retrying.",
    });
    expect(failure.detail).toContain("a valid X-API-Key is needed");
    expect(blamesModel(failure.error)).toBe(false);
  });

  test("an uncertain sandbox mutation beside or around it keeps the turn terminal", async () => {
    const capacity = await noCapacityFromControlService();
    const busy = new ComputeControlError({
      kind: "busy",
      status: 409,
      message: "compute control service POST /v1/sandboxes/sbx/wake: busy",
    });
    const cases = [
      // The routing layer could not prove whether its launch happened.
      thrownByTool(
        new RoutingMutationOutcomeUnknownError("execCommand", "launch did not return", {
          cause: busy,
        }),
      ),
      thrownByTool(
        new RoutingMutationOutcomeUnknownError("execCommand", "launch did not return", {
          cause: capacity,
        }),
      ),
      // A parallel tool's uncertain outcome beside a capacity refusal.
      new AggregateError(
        [capacity, new RoutingMutationOutcomeUnknownError("execCommand", "release unresolved")],
        "Failed to run function tools",
      ),
    ];
    for (const error of cases) {
      const failure = agentRunFailurePayload(error);
      expect(failure.code).toMatch(/^sandbox_(capacity|service)_unavailable$/);
      expect(failure.retryable).toBe(false);
      expect(failure.error).toEndWith(
        "This turn stopped without retrying because an earlier sandbox action may already have taken effect.",
      );
      expect(failure.detail).toMatch(/launch did not return|release unresolved/);
      expect(blamesModel(failure.error)).toBe(false);
    }
  });

  test("E2B's typed no-capacity error is sandbox capacity, through the SDK wrapper", async () => {
    // The E2B SDK loads only with an E2B sandbox; its provider registers the class.
    const ServiceBusyError = await loadE2BServiceBusyError();
    if (!ServiceBusyError) throw new Error("expected the E2B SDK");
    // The agents SDK E2B client wraps every provider failure this way.
    const busy = new (ServiceBusyError as unknown as new (message: string) => Error)(
      "no capacity to place a sandbox right now",
    );
    const wrapped = Object.assign(
      new SandboxProviderError("e2b failed to create sandbox", {
        provider: "e2b",
        operation: "create sandbox",
        status: 503,
        retryable: true,
      }),
      { cause: busy },
    );
    for (const error of [wrapped, thrownByTool(wrapped)]) {
      expect(agentRunFailurePayload(error)).toMatchObject({
        code: "sandbox_capacity_unavailable",
        retryable: true,
        error:
          "No sandbox capacity is available right now. The same turn will retry after a short delay.",
      });
    }
  });

  test("any sandbox provider SDK's HTTP failure is the sandbox service, not the model", () => {
    for (const status of [429, 500, 503]) {
      const cause = Object.assign(new Error(`daytona ${status}`), { status });
      const error = Object.assign(
        new SandboxProviderError("daytona failed to start sandbox", {
          provider: "daytona",
          operation: "start sandbox",
          status,
        }),
        { cause },
      );
      const failure = agentRunFailurePayload(error);
      expect(failure.code).toBe("sandbox_service_unavailable");
      // Retry authority is the provider classifier's, unchanged.
      expect(failure.retryable).toBe(true);
      expect(failure).not.toHaveProperty("providerCondition");
      expect(blamesModel(failure.error)).toBe(false);
    }
    // An uncertain mutation around it still forbids the replay.
    const daytona = Object.assign(
      new SandboxProviderError("daytona failed to exec", { provider: "daytona", status: 503 }),
      { cause: Object.assign(new Error("daytona 503"), { status: 503 }) },
    );
    const uncertain = new RoutingMutationOutcomeUnknownError(
      "execCommand",
      "launch did not return",
      {
        cause: daytona,
      },
    );
    expect(agentRunFailurePayload(uncertain)).toMatchObject({
      code: "sandbox_service_unavailable",
      retryable: false,
    });
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
