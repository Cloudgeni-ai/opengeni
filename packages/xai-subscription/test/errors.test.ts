import { describe, expect, test } from "bun:test";

import { isXaiSubscriptionRateLimitDiagnostic } from "../src/errors";

describe("isXaiSubscriptionRateLimitDiagnostic", () => {
  test("matches HTTP 429 and known overload codes without reading the message", () => {
    expect(isXaiSubscriptionRateLimitDiagnostic({ status: 429, message: "nope" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "rate_limit_exceeded" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "too_many_requests" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "overloaded_error" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "server_overloaded" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "capacity_exceeded" })).toBe(true);
    expect(isXaiSubscriptionRateLimitDiagnostic({ code: "resource_exhausted" })).toBe(true);
  });

  test("matches only the observed Grok capacity sentence as a message fallback", () => {
    expect(
      isXaiSubscriptionRateLimitDiagnostic({
        code: "response_error",
        status: 502,
        message:
          "The model is currently at capacity due to high demand. Please try again in a few minutes.",
      }),
    ).toBe(true);
  });

  test("does not treat isolated capacity-ish wording as a waiter", () => {
    expect(
      isXaiSubscriptionRateLimitDiagnostic({
        message: "The model is currently at capacity. Please try again later.",
      }),
    ).toBe(false);
    expect(isXaiSubscriptionRateLimitDiagnostic({ message: "high demand right now" })).toBe(false);
    expect(
      isXaiSubscriptionRateLimitDiagnostic({
        message: "Our servers are currently overloaded. Please try again later.",
      }),
    ).toBe(false);
    expect(isXaiSubscriptionRateLimitDiagnostic({ message: "too many requests" })).toBe(false);
    expect(isXaiSubscriptionRateLimitDiagnostic({ message: "rate limit exceeded" })).toBe(false);
    expect(
      isXaiSubscriptionRateLimitDiagnostic({
        code: "invalid_request",
        message: "prompt rejected due to high demand policy",
      }),
    ).toBe(false);
  });
});
