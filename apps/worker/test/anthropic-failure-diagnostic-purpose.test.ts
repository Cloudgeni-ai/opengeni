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
  classifyClaudeCredentialFailure,
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
  test("a first rejected token may renew after unrelated provider recoveries", async () => {
    const diagnostic = new AnthropicRequestError(
      "Synthetic authentication failure",
      401,
      "anthropic_http_error",
      { type: "authentication_error", message: "Fixture" },
      new Headers({ "request-id": "req_auth_fixture" }),
    );
    const { deps, settle } = failureDeps(diagnostic);
    deps.billingState.isClaudeTurn = true;
    deps.settings = { environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64") } as never;
    deps.attempt.providerRecoveryCount = 3;
    Object.assign(deps.providerTurn, {
      effectiveClaudeCredentialId: "11111111-1111-4111-8111-111111111111",
      effectiveClaudeCredentialVersion: 3,
      claudeAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeUpstreamModelId: "claude-opus-fixture",
      latestClaudeUsage: new Map([
        [
          "fixture",
          {
            scope: "workspace",
            token: "sk-ant-oat01-before",
            expectedConnectionId: "11111111-1111-4111-8111-111111111111",
            expectedCredentialVersion: 3,
            responseStatus: 401,
            upstreamModelId: "claude-opus-fixture",
            requestId: "req_auth_fixture",
          },
        ],
      ]),
    });
    Object.assign(deps.leases, {
      claude: {
        lost: false,
        held: true,
        subjectId: "user-fixture",
        holderId: "holder-fixture",
        generation: 7,
      },
    });
    const goal = spyOn(opengeniDb, "getSessionGoal").mockResolvedValue(null);
    const renew = spyOn(opengeniDb, "resolveClaudeAccountCredential").mockResolvedValue({
      secret: { token: "sk-ant-oat01-after" },
      version: 3,
    } as never);
    const recovery = spyOn(opengeniDb, "requestSessionTurnRecovery").mockResolvedValue({
      action: "recovering",
      events: [],
    } as never);
    try {
      expect(await settleTurnFailure(deps)).toMatchObject({ status: "recovering" });
      expect(renew).toHaveBeenCalledTimes(1);
      expect(recovery.mock.calls[0]![2]).toMatchObject({
        claudeAuthRecovery: {
          credentialId: "11111111-1111-4111-8111-111111111111",
          credentialVersion: 3,
        },
      });
      expect(recovery.mock.calls[0]![2]).not.toHaveProperty("providerRecoveryCount");
      expect(settle).not.toHaveBeenCalled();
    } finally {
      goal.mockRestore();
      renew.mockRestore();
      recovery.mockRestore();
    }
  });

  test("Claude rotates only typed authentication and rate limits, never permission, safety or tool failures", () => {
    const error = (status: number) =>
      new AnthropicRequestError(
        "Synthetic provider failure",
        status,
        "anthropic_http_error",
        { type: "fixture_error", message: "Fixture" },
        new Headers({ "retry-after": "120" }),
      );
    expect(classifyClaudeCredentialFailure(error(401))).toEqual({ kind: "auth", cooldownMs: null });
    expect(classifyClaudeCredentialFailure(new Error("Wrapped", { cause: error(429) }))).toEqual({
      kind: "rate_limit",
      cooldownMs: 120_000,
    });
    for (const status of [400, 403, 503, 529])
      expect(classifyClaudeCredentialFailure(error(status))).toBeNull();
    expect(
      classifyClaudeCredentialFailure(
        Object.assign(new Error("Tool rate limited"), { status: 429 }),
      ),
    ).toBeNull();
  });

  for (const responseStatus of [200, 429])
    for (const resumed of [true, false])
      test(`Claude 429 over HTTP ${responseStatus} checkpoints and ${resumed ? "rotates" : "waits"} on the same accepted turn`, async () => {
        const diagnostic = new AnthropicRequestError(
          "Synthetic provider failure",
          429,
          "anthropic_http_error",
          { type: "rate_limit_error", message: "Fixture" },
          new Headers({ "retry-after": "120", "request-id": "req_exact_fixture" }),
        );
        const { deps, settle } = failureDeps(diagnostic);
        deps.billingState.isClaudeTurn = true;
        deps.settings = {
          environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
        } as never;
        Object.assign(deps.providerTurn, {
          effectiveClaudeCredentialId: "credential-fixture",
          effectiveClaudeCredentialVersion: 3,
          claudeAuthoritySnapshot: { version: 1, scope: "workspace" },
          claudeUpstreamModelId: "claude-opus-fixture",
          latestClaudeUsage: new Map([
            [
              "fixture",
              {
                scope: "workspace",
                token: "sk-ant-oat01-fixture",
                expectedConnectionId: "credential-fixture",
                expectedCredentialVersion: 3,
                responseStatus,
                requestId: "req_exact_fixture",
                upstreamModelId: "claude-opus-fixture",
              },
            ],
            [
              "unrelated",
              {
                scope: "workspace",
                token: "sk-ant-oat01-other-request",
                expectedConnectionId: "credential-fixture",
                expectedCredentialVersion: 3,
                responseStatus: 429,
                requestId: "req_other_fixture",
                upstreamModelId: "claude-sonnet-fixture",
              },
            ],
          ]),
        });
        Object.assign(deps.leases, {
          claude: {
            lost: false,
            held: true,
            subjectId: "user-fixture",
            holderId: "holder-fixture",
            generation: 7,
          },
        });
        const history = mock(async () => undefined);
        deps.historySink.reconcileConversationTruth = history;
        const waiter = {
          id: "waiter-fixture",
          generation: 2,
          nextCheckAt: new Date(Date.now() + 120_000),
          wakeRevision: 1,
        };
        const goal = spyOn(opengeniDb, "getSessionGoal").mockResolvedValue(null);
        const record = spyOn(opengeniDb, "recordClaudeAccountUsage").mockResolvedValue({} as never);
        const arm = spyOn(opengeniDb, "armClaudeCapacityWait").mockResolvedValue({
          action: "waiting",
          waiter,
          events: [],
        } as never);
        const reconcile = spyOn(opengeniDb, "reconcileClaudeCapacityWait").mockResolvedValue({
          action: resumed ? "resumed" : "waiting",
          waiter,
          events: [],
        } as never);
        try {
          expect(await settleTurnFailure(deps)).toMatchObject({
            status: resumed ? "recovering" : "waiting_capacity",
            turnId: "turn-1",
          });
          expect(history).toHaveBeenCalledWith({ requireDurable: true });
          expect(record).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
              credentialId: "credential-fixture",
              authoritySnapshot: { version: 1, scope: "workspace" },
            }),
            expect.objectContaining({
              expectedCredentialVersion: 3,
              token: "sk-ant-oat01-fixture",
              modelCooldown: expect.objectContaining({ upstreamModelId: "claude-opus-fixture" }),
            }),
          );
          expect(arm.mock.calls[0]![1]).toMatchObject({
            turnId: "turn-1",
            expectedCredentialVersion: 3,
            leaseFence: { holderId: "holder-fixture", generation: 7 },
          });
          expect(arm.mock.calls[0]![1]).not.toHaveProperty("credentialQuarantine");
          expect(reconcile).toHaveBeenCalledTimes(1);
          expect(settle).not.toHaveBeenCalled();
          expect(deps.leases.claude.held).toBe(false);
        } finally {
          goal.mockRestore();
          record.mockRestore();
          arm.mockRestore();
          reconcile.mockRestore();
        }
      });

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
