import { expect, test } from "bun:test";
import type { SessionEvent } from "@/types";
import { summarizeSessionFailure } from "./events";
import { failedSessionCopy } from "./failed-session-copy";

function failureEvent(payload: Record<string, unknown>): SessionEvent {
  return {
    id: "failure",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    sequence: 1,
    type: "turn.failed",
    occurredAt: "2026-10-04T14:00:00.000Z",
    payload,
  };
}

function exhaustedRateLimit(detail: string) {
  // Exact worker-emitted payload after five consecutive automatic recoveries.
  // The web consumes this event boundary without importing worker internals.
  return {
    error:
      "Automatic same-turn recovery stopped after 5 retries because the upstream dependency remained unavailable. Send a new message to retry after the dependency recovers.",
    code: "provider_rate_limited",
    retryable: false,
    detail,
    recoveryExhausted: true,
    providerRecoveryCount: 5,
    maxProviderRecoveryCount: 5,
    lastRetryableError:
      "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
  };
}

test("an exhausted worker rate-limit payload preserves every distinct diagnostic in banner details", () => {
  const detail = "429 Too Many Requests\nProvider request: fixture-request";
  const payload = exhaustedRateLimit(detail);
  const summary = summarizeSessionFailure([failureEvent(payload)], "failed");
  const recorded = [payload.error, payload.lastRetryableError, payload.detail].join("\n");

  expect(summary.failureCode).toBe("provider_rate_limited");
  expect(summary.consecutiveRecoveryCount).toBe(5);
  expect(summary.recordedDetail).toBe(recorded);
  expect(failedSessionCopy(summary, false, false, true)).toMatchObject({
    reason:
      "This model is throttled due to high demand. Select another model in the chat bar, or try again in a few minutes.",
    detail: recorded,
  });
});

test("the bounded failure diagnostics projection preserves all exhausted worker diagnostics", () => {
  const payload = exhaustedRateLimit("429 Too Many Requests\nProvider diagnostic: fixture");
  const event = failureEvent(payload);
  const summary = summarizeSessionFailure([], "failed", {
    eventId: event.id,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    turnId: event.turnId ?? null,
    payload,
  });

  expect(summary.recordedDetail).toBe(
    [payload.error, payload.lastRetryableError, payload.detail].join("\n"),
  );
});

test("recorded diagnostics preserve whitespace, remove exact duplicates and use message fallback", () => {
  const detail = "  Provider diagnostic\n  second line\t ";
  const event = failureEvent({
    message: "Recorded failure",
    lastRetryableError: detail,
    detail,
    code: " provider_rate_limited ",
  });
  const summary = summarizeSessionFailure([event], "failed");

  expect(summary.recordedDetail).toBe(`Recorded failure\n${detail}`);
  expect(summary.failureCode).toBe("provider_rate_limited");
});

test("a retained short Gemini quota diagnostic does not override the worker rate-limit classification", () => {
  const detail =
    "429 You exceeded your current quota, please check your plan and billing details. Please retry in 38.66s.";
  const payload = exhaustedRateLimit(detail);
  const summary = summarizeSessionFailure([failureEvent(payload)], "failed");

  expect(payload.code).toBe("provider_rate_limited");
  expect(summary.recordedDetail).toContain(detail);
  expect(failedSessionCopy(summary, false, false, true)).toMatchObject({
    reason:
      "This model is throttled due to high demand. Select another model in the chat bar, or try again in a few minutes.",
    detail: summary.recordedDetail,
  });
});
