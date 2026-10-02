import { describe, expect, mock, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import * as opengeniDb from "@opengeni/db";
import { AnthropicRequestError } from "@opengeni/runtime";
import * as parentWake from "../src/activities/parent-wake";
import {
  agentRunFailurePayload,
  agentRunRecoveryFailurePayload,
  isTransientProviderError,
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  providerRetryAfterMs,
  safeErrorDiagnostic,
} from "../src/activities/agent-turn/errors";
import {
  settleTurnFailure,
  type TurnFailureDeps,
} from "../src/activities/agent-turn/failure-settlement";

function failureDeps(error: Error) {
  const settle = mock(async () => true);
  const deps = {
    error,
    input: {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "session-session-1",
    },
    settings: {},
    db: {},
    bus: {},
    observability: {
      incrementCounter: () => undefined,
      observeHistogram: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    wakeSessionWorkflow: async () => undefined,
    cancellationSignal: undefined,
    sandboxRotationController: new AbortController(),
    noteCancellationRequested: () => undefined,
    codexWorkspaceKey: "workspace-key",
    control: {
      cancellationRequestedAt: null,
      activityStatus: "unknown",
      turnMetricOutcome: null,
      activityError: null,
      acknowledgeQuiescence: false,
    },
    attempt: {
      turnId: "turn-1",
      dispatchId: "dispatch-1",
      triggerEventId: "trigger-1",
      executionGeneration: 1,
      providerRecoveryCount: 0,
      modelRequestStarted: true,
      redispatchesAtDispatch: 0,
      triggerType: "user",
    },
    billingState: { isCodexTurn: false, isXaiTurn: false },
    eventing: {
      publish: async () => [],
      turnStartedPublished: true,
      settle,
    },
    providerTurn: {},
    leases: { codex: { lost: false }, xai: { lost: false } },
    historySink: { reconcileConversationTruth: async () => undefined },
    claimedResult: (value: Record<string, unknown>) => ({
      ...value,
      turnId: "turn-1",
      attemptId: "attempt-1",
    }),
    flushRuntimeBatcher: async () => undefined,
    acknowledgeLostAttemptOwnership: () => undefined,
    acknowledgeRecoveryQuiescence: () => undefined,
  } as unknown as TurnFailureDeps;
  return { deps, settle };
}

describe("Anthropic failure diagnostic purpose", () => {
  for (const [status, type, failureCode, wrapped] of [
    [429, "rate_limit_error", "provider_rate_limited", false],
    [503, "api_error", "provider_unavailable", false],
    [429, "rate_limit_error", "provider_rate_limited", true],
    [503, "api_error", "provider_unavailable", true],
  ] as const) {
    test(`${status} ${wrapped ? "SSE" : "HTTP"} recovery omits provider text and exhausted turn.failed retains it`, async () => {
      const providerMessage = "private provider diagnostic";
      const providerDetail = `${type}: ${providerMessage}`;
      const diagnostic = new AnthropicRequestError(
        `Claude request failed (HTTP ${status})`,
        status,
        "anthropic_http_error",
        { type, message: providerMessage, request: "private echoed request" },
        new Headers({ "request-id": "req_diagnostic", "retry-after": "120" }),
      );
      const error = wrapped
        ? Object.assign(new Error(`Claude stream failed (HTTP ${status})`), {
            status,
            code: diagnostic.code,
            request_id: diagnostic.request_id,
            headers: diagnostic.headers,
            cause: diagnostic,
          })
        : diagnostic;
      const terminal = agentRunFailurePayload(error);
      const before = JSON.stringify(terminal);
      const projected = agentRunRecoveryFailurePayload(error, terminal);
      expect(projected).toMatchObject({
        code: failureCode,
        retryable: true,
        requestId: "req_diagnostic",
      });
      expect(projected).not.toHaveProperty("detail");
      expect(JSON.stringify(terminal)).toBe(before);
      expect(terminal.detail).toBe(providerDetail);
      expect(error.status).toBe(status);
      expect(error.code).toBe("anthropic_http_error");
      expect(providerRetryAfterMs(error)).toBe(120_000);
      expect(isTransientProviderError(error)).toBe(status === 503);
      expect(JSON.stringify(safeErrorDiagnostic(error))).not.toContain(providerMessage);
      expect(JSON.stringify(error)).not.toContain(providerMessage);
      expect(inspect(error)).not.toContain(providerMessage);

      const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
        action: "recovering",
        events: [],
      } as never);
      const parentDelivery = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
        undefined,
      );
      const { deps, settle } = failureDeps(error);
      try {
        expect(await settleTurnFailure(deps)).toMatchObject({
          status: "recovering",
          continueDelayMs: 120_000,
          turnId: "turn-1",
          attemptId: "attempt-1",
        });
        expect(recovery).toHaveBeenCalledWith(
          {},
          "workspace-1",
          expect.objectContaining({
            reason: failureCode,
            providerRecoveryCount: 1,
            detail: expect.objectContaining({
              code: failureCode,
              retryable: true,
              requestId: "req_diagnostic",
              continueDelayMs: 120_000,
            }),
          }),
        );
        const recoveryPayload = recovery.mock.calls[0]![2].detail;
        expect(recoveryPayload).not.toHaveProperty("detail");
        expect(JSON.stringify(recoveryPayload)).not.toContain(providerMessage);
        expect(JSON.stringify(recoveryPayload)).not.toContain(type);
        expect(settle).not.toHaveBeenCalled();

        deps.attempt.providerRecoveryCount = MAX_AUTOMATIC_PROVIDER_RECOVERIES;
        expect(await settleTurnFailure(deps)).toMatchObject({ status: "failed" });
        expect(recovery).toHaveBeenCalledTimes(1);
        expect(settle).toHaveBeenCalledWith(
          expect.objectContaining({
            events: expect.arrayContaining([
              {
                type: "turn.failed",
                payload: expect.objectContaining({
                  code: failureCode,
                  retryable: false,
                  recoveryExhausted: true,
                  providerRecoveryCount: MAX_AUTOMATIC_PROVIDER_RECOVERIES,
                  detail: providerDetail,
                  requestId: "req_diagnostic",
                }),
              },
            ]),
          }),
        );
        expect(JSON.stringify(settle.mock.calls)).not.toContain("private echoed request");
        expect(parentDelivery).toHaveBeenCalledTimes(1);
      } finally {
        recovery.mockRestore();
        parentDelivery.mockRestore();
      }
    });
  }

  test("other provider recovery diagnostics are unchanged", () => {
    const error = Object.assign(new Error("upstream failure"), { status: 503 });
    const failure = {
      ...agentRunFailurePayload(error),
      detail: "existing provider diagnostic",
    };
    expect(agentRunRecoveryFailurePayload(error, failure)).toBe(failure);
  });
});