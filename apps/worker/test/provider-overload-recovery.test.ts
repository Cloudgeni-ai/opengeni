import { expect, test } from "bun:test";
import { AnthropicRequestError } from "@opengeni/runtime";
import {
  agentRunFailurePayload,
  assertProviderOverloadRecoveryActive,
  postClaimDatabaseRecoveryFailure,
  providerRecoveryCode,
  providerRecoveryCountAfterModelRequestPhase,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";
import { readProviderRecoveryStartedAt } from "../src/activities/agent-turn/provider-recovery-policy";

const startedAt = Date.parse("2026-01-01T00:00:00Z");

test("confirmed provider overload can recover beyond the ordinary five retries", () => {
  const input = {
    failureCode: "provider_overloaded",
    attemptNumber: 6,
    recoveryStartedAt: startedAt,
    now: startedAt + 5 * 60_000,
    jitterSample: 1,
  };
  expect(providerRecoveryResult(input)).toMatchObject({
    status: "recovering",
    continueDelayMs: 65_000,
    maxProviderRecoveryCount: 15,
  });
});

test("overload recovery stops at fifteen retries even before the deadline", () => {
  const input = {
    failureCode: "provider_overloaded",
    attemptNumber: 16,
    recoveryStartedAt: startedAt,
    now: startedAt + 10 * 60_000,
  };
  expect(providerRecoveryResult(input)).toMatchObject({
    status: "exhausted",
    providerRecoveryCount: 15,
    maxProviderRecoveryCount: 15,
  });
});

test("overload recovery cannot schedule at or beyond its fifteen-minute deadline", () => {
  for (const now of [startedAt + 15 * 60_000, startedAt + 14 * 60_000]) {
    const input = {
      failureCode: "provider_overloaded",
      attemptNumber: 6,
      recoveryStartedAt: startedAt,
      now,
    };
    expect(providerRecoveryResult(input)).toMatchObject({
      status: "exhausted",
      providerRecoveryCount: 5,
      maxProviderRecoveryCount: 15,
      providerRecoveryExhaustedReason: "deadline",
    });
  }
});

test("Retry-After is a lower bound, never a way to extend the overload deadline", () => {
  const input = {
    failureCode: "provider_overloaded",
    attemptNumber: 2,
    recoveryStartedAt: startedAt,
    now: startedAt + 60_000,
    retryAfterMs: 15 * 60_000,
  };
  expect(providerRecoveryResult(input)).toMatchObject({
    status: "exhausted",
    maxProviderRecoveryCount: 15,
    providerRecoveryExhaustedReason: "deadline",
  });
});

function claudeError(
  status: number | undefined,
  type: unknown = "overloaded_error",
  message = "Busy",
) {
  return new AnthropicRequestError(
    "Claude request failed",
    status,
    "anthropic_http_error",
    {
      type,
      message,
      request: "ignored body field",
    },
    new Headers({ "request-id": "synthetic-request" }),
  );
}

test("only structured retryable Claude overload grants the larger recovery window", () => {
  for (const error of [
    claudeError(529, undefined),
    claudeError(503),
    new Error("SDK wrapper", { cause: claudeError(529) }),
    new Error("SDK wrapper", { cause: new Error("SDK wrapper", { cause: claudeError(529) }) }),
  ]) {
    const failure = agentRunFailurePayload(error);
    expect(failure).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(providerRecoveryCode(error, failure)).toBe("provider_overloaded");
  }
});

test("presentation labels, auth, quota, unknown types and other providers cannot grant extra retries", () => {
  const errors = [
    claudeError(503, "api_error", "Provider is overloaded"),
    claudeError(503, "unknown_error", "overloaded_error"),
    claudeError(undefined),
    ...[400, 401, 402, 403, 404, 413, 422, 429].map((status) => claudeError(status)),
    Object.assign(new Error("overloaded"), { status: 529 }),
    Object.assign(new Error("overloaded"), { status: 503 }),
    Object.assign(new Error("outer refusal"), { status: 403, cause: claudeError(529) }),
    Object.assign(new Error("transport timeout"), { name: "TimeoutError" }),
    new Error("capacity might recover"),
  ];
  for (const error of errors) {
    const failure = agentRunFailurePayload(error);
    expect(providerRecoveryCode(error, failure)).toBe(failure.code);
    expect(providerRecoveryResult({ failureCode: failure.code, attemptNumber: 6 }).status).toBe(
      "exhausted",
    );
  }
  expect(
    providerRecoveryCode(claudeError(529), { code: "provider_unavailable", retryable: false }),
  ).toBe("provider_unavailable");
});

test("the structured type is bounded and not retained in generic error serialization", () => {
  const error = claudeError(529);
  expect(error.errorType).toBe("overloaded_error");
  expect(JSON.stringify(error)).not.toContain("overloaded_error");
  expect(JSON.stringify(error)).not.toContain("ignored body field");
  expect(Buffer.byteLength(claudeError(529, "💥".repeat(200)).errorType!)).toBeLessThanOrEqual(256);
});

test("replacement attempts reuse one durable clock and a finite consecutive streak", () => {
  const metadata = { providerRecoveryStartedAt: new Date(startedAt).toISOString() };
  let now = startedAt;
  for (let attemptNumber = 1; attemptNumber <= 15; attemptNumber += 1) {
    const result = providerRecoveryResult({
      failureCode: "provider_overloaded",
      attemptNumber,
      recoveryStartedAt: readProviderRecoveryStartedAt(metadata),
      now,
      jitterSample: 1,
    });
    expect(result.status).toBe("recovering");
    if (result.status !== "recovering") throw new Error("Expected retry inside the window");
    now += result.continueDelayMs;
    expect(readProviderRecoveryStartedAt(metadata)).toBe(startedAt);
  }
  expect(
    providerRecoveryResult({
      failureCode: "provider_overloaded",
      attemptNumber: 16,
      recoveryStartedAt: startedAt,
      now,
    }),
  ).toMatchObject({ status: "exhausted", providerRecoveryExhaustedReason: "retry_limit" });
  for (const phase of ["started", "first_byte", "failed"]) {
    expect(providerRecoveryCountAfterModelRequestPhase(15, phase)).toBe(15);
  }
  expect(providerRecoveryCountAfterModelRequestPhase(15, "completed")).toBe(0);
  // Genuine progress starts a new episode; a stale local clock cannot carry over.
  expect(
    providerRecoveryResult({ failureCode: "provider_overloaded", attemptNumber: 1, now }),
  ).toMatchObject({ status: "recovering" });
});

test("missing, invalid or future durable clocks fail closed instead of restarting the window", () => {
  for (const recoveryStartedAt of [undefined, NaN, Infinity, startedAt + 1]) {
    expect(
      providerRecoveryResult({
        failureCode: "provider_overloaded",
        attemptNumber: 2,
        recoveryStartedAt,
        now: startedAt,
      }),
    ).toMatchObject({ status: "exhausted", providerRecoveryExhaustedReason: "invalid_clock" });
  }
  expect(
    readProviderRecoveryStartedAt({ providerRecoveryStartedAt: "not a date" }),
  ).toBeUndefined();
});

test("a late retry is stopped before dispatch and is not counted as an executed retry", () => {
  let dispatched = false;
  let error: unknown;
  try {
    assertProviderOverloadRecoveryActive({
      failureCode: "provider_overloaded",
      providerRecoveryCount: 3,
      recoveryStartedAt: startedAt,
      now: startedAt + 15 * 60_000,
    });
    dispatched = true;
  } catch (caught) {
    error = caught;
  }
  expect(dispatched).toBe(false);
  const failure = agentRunFailurePayload(new Error("dispatch wrapper", { cause: error }));
  expect(failure).toMatchObject({
    code: "provider_unavailable",
    retryable: false,
    recoveryExhausted: true,
    providerRecoveryCount: 2,
    maxProviderRecoveryCount: 15,
    providerRecoveryExhaustedReason: "deadline",
  });
  // An active, progressed turn is not capped by the age of its previous failure.
  expect(() =>
    assertProviderOverloadRecoveryActive({
      failureCode: "provider_overloaded",
      providerRecoveryCount: 0,
      recoveryStartedAt: startedAt,
      now: startedAt + 24 * 60 * 60_000,
    }),
  ).not.toThrow();
  expect(() =>
    assertProviderOverloadRecoveryActive({
      failureCode: "provider_unavailable",
      providerRecoveryCount: 1,
      recoveryStartedAt: startedAt,
      now: startedAt + 24 * 60 * 60_000,
    }),
  ).not.toThrow();
});

test("checkpoint database outages preserve only the selected overload budget and delay", () => {
  const input = {
    error: Object.assign(new Error("database connection reset"), { code: "ECONNRESET" }),
    turnId: "turn",
    triggerEventId: "trigger",
    executionGeneration: 3,
  };
  expect(
    postClaimDatabaseRecoveryFailure({
      ...input,
      providerRecovery: {
        failureCode: "provider_overloaded",
        providerRecoveryCount: 6,
        continueDelayMs: 85_000,
      },
    }),
  ).toMatchObject({
    details: [
      {
        turnId: "turn",
        executionGeneration: 3,
        providerFailureCode: "provider_overloaded",
        providerRecoveryCount: 6,
        providerRecoveryContinueDelayMs: 85_000,
      },
    ],
  });
  for (const providerRecovery of [
    { failureCode: "provider_unavailable", providerRecoveryCount: 6 },
    { failureCode: "mcp_transport_timeout", providerRecoveryCount: 6 },
    { failureCode: "provider_overloaded", providerRecoveryCount: 16, continueDelayMs: 60_000 },
    { failureCode: "provider_overloaded", providerRecoveryCount: 6 },
    { failureCode: "provider_overloaded", providerRecoveryCount: 6, continueDelayMs: 900_000 },
    { failureCode: "provider_unavailable", providerRecoveryCount: 1, continueDelayMs: 60_000 },
  ]) {
    expect(postClaimDatabaseRecoveryFailure({ ...input, providerRecovery })).toBeNull();
  }
});
