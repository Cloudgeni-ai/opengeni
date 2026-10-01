import { describe, expect, test } from "bun:test";
import { ResponsesStreamingTerminalError } from "@opengeni/runtime";
import {
  agentRunFailurePayload,
  classifyCodexCredentialFailure,
  classifyContextWindowOverflowError,
  classifyXaiCredentialFailure,
  isTransientProviderError,
  providerRecoveryExhaustedFailure,
  providerRecoveryResult,
  providerRetryAfterMs,
  safeErrorDiagnostic,
} from "../src/activities/agent-turn/errors";

describe("Responses terminal failure settlement", () => {
  test("recognized safety diagnostic vetoes server recovery and context compaction", () => {
    for (const eventType of ["response.failed", "response.error"] as const) {
      const detail =
        "This request was blocked by our safety systems. Your input exceeds the context window.";
      const error = new ResponsesStreamingTerminalError(eventType, {
        code: "server_error",
        message: detail,
      });
      expect(agentRunFailurePayload(error)).toMatchObject({
        code: "provider_safety_refusal",
        retryable: false,
        detail,
      });
      expect(isTransientProviderError(error)).toBe(false);
      expect(classifyContextWindowOverflowError(error)).toBeNull();
      expect(classifyCodexCredentialFailure(error)).toBeNull();
      expect(classifyXaiCredentialFailure(error)).toBeNull();
      expect(JSON.stringify(safeErrorDiagnostic(error))).not.toContain(detail);
    }
  });

  test("bounded diagnostic-only context overflow remains recognizable through cause wrappers", () => {
    const detail = "  Your input exceeds the context window of this model.\n";
    const error = new ResponsesStreamingTerminalError("response.error", {
      code: "invalid_prompt",
      message: detail,
    });
    for (const source of [error, new Error("outer wrapper", { cause: error })]) {
      expect(classifyContextWindowOverflowError(source)).toMatchObject({ detail });
    }
    expect(
      classifyContextWindowOverflowError({
        detail: "Your input exceeds the context window of this model.",
        message: "unrelated application error",
      }),
    ).toBeNull();
  });

  for (const eventType of ["response.failed", "response.error"] as const) {
    for (const [code, failureCode, retryable] of [
      ["server_error", "provider_unavailable", true],
      ["overloaded_error", "provider_unavailable", true],
      ["rate_limit_exceeded", "provider_rate_limited", true],
      ["invalid_request", "provider_request_rejected", false],
      ["content_policy_violation", "provider_safety_refusal", false],
      ["ResponsibleAIPolicyViolation", "provider_safety_refusal", false],
      ["unrecognized", "provider_request_rejected", false],
    ] as const) {
      test(`${eventType} ${code} retains exact detail and truthful retryability`, () => {
        const detail = "  exact private diagnostic\nservice unavailable, rate limit, overloaded  ";
        const error = new ResponsesStreamingTerminalError(eventType, { code, message: detail });
        const payload = agentRunFailurePayload(error);
        expect(payload).toMatchObject({ code: failureCode, retryable, detail });
        expect(payload.error).not.toContain(detail);
        expect(JSON.stringify(safeErrorDiagnostic(error))).not.toContain(detail);
        expect(isTransientProviderError(error)).toBe(failureCode === "provider_unavailable");
        expect(classifyCodexCredentialFailure(error)).toBeNull();
        expect(classifyXaiCredentialFailure(error)).toBeNull();
      });
    }
  }

  test("server terminals keep all five connectivity delays then exhaust without losing detail", () => {
    const failure = agentRunFailurePayload(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "server_error",
        message: "  exact outage\n",
      }),
    );
    for (const [index, continueDelayMs] of [2_000, 5_000, 15_000, 30_000, 60_000].entries()) {
      expect(
        providerRecoveryResult({
          failureCode: failure.code,
          attemptNumber: index + 1,
        }),
      ).toEqual({ status: "recovering", continueDelayMs });
    }
    const recovery = providerRecoveryResult({ failureCode: failure.code, attemptNumber: 6 });
    expect(recovery.status).toBe("exhausted");
    if (recovery.status !== "exhausted") throw new Error("expected exhaustion");
    expect(providerRecoveryExhaustedFailure(failure, recovery)).toMatchObject({
      code: "provider_unavailable",
      detail: "  exact outage\n",
      retryable: false,
      recoveryExhausted: true,
      providerRecoveryCount: 5,
      maxProviderRecoveryCount: 5,
    });
  });

  test("rate terminals retain existing provider backpressure pacing", () => {
    const failure = agentRunFailurePayload(
      new ResponsesStreamingTerminalError("response.error", {
        code: "rate_limit_exceeded",
        message: "private rate diagnostic",
      }),
    );
    expect(providerRecoveryResult({ failureCode: failure.code, attemptNumber: 1 })).toEqual({
      status: "recovering",
      continueDelayMs: 60_000,
    });
    expect(
      providerRecoveryResult({
        failureCode: failure.code,
        attemptNumber: 5,
        retryAfterMs: 1_000,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 120_000 });
  });

  test("streamed retry hints keep their existing lower bound and quota cutoff", () => {
    for (const error of [
      new ResponsesStreamingTerminalError("response.failed", {
        code: "rate_limit_exceeded",
        retry_after_seconds: 180,
      }),
      new ResponsesStreamingTerminalError(
        "response.error",
        {
          code: "rate_limit_exceeded",
        },
        new Headers({ "retry-after": "180" }),
      ),
    ]) {
      const failure = agentRunFailurePayload(error);
      expect(providerRetryAfterMs(error)).toBe(180_000);
      expect(
        providerRecoveryResult({
          failureCode: failure.code,
          attemptNumber: 1,
          retryAfterMs: providerRetryAfterMs(error),
        }),
      ).toEqual({ status: "recovering", continueDelayMs: 180_000 });
    }
    expect(
      agentRunFailurePayload(
        new ResponsesStreamingTerminalError("response.failed", {
          code: "rate_limit_exceeded",
          retry_after_seconds: 86_400,
        }),
      ),
    ).toMatchObject({ code: "provider_quota_exhausted", retryable: false });
  });

  test("streamed insufficient quota is terminal rather than ordinary rate limiting", () => {
    const failure = agentRunFailurePayload(
      new ResponsesStreamingTerminalError("response.failed", {
        code: "insufficient_quota",
        message: "exact exhausted quota",
      }),
    );
    expect(failure).toMatchObject({
      code: "provider_quota_exhausted",
      retryable: false,
      quotaScope: "quota",
      detail: "exact exhausted quota",
    });
  });

  test("a terminal invalid request cannot be reclassified by rate/quota wording", () => {
    expect(
      agentRunFailurePayload(
        new ResponsesStreamingTerminalError("response.failed", {
          code: "invalid_request_error",
          message: "rate limit exceeded your current quota",
        }),
      ),
    ).toMatchObject({ code: "provider_request_rejected", retryable: false });
  });
});
