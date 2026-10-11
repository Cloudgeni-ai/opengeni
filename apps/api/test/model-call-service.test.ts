import { describe, expect, test } from "bun:test";
import { CodexReloginRequired, type CodexUsagePayload } from "@opengeni/codex";
import { ModelCallError } from "@opengeni/core";
import { SingleModelCallUnsupportedError } from "@opengeni/runtime";
import { codexIncludedUsageAvailable, publicModelCallError } from "../src/model-calls/service";

const NOW = Date.parse("2026-10-10T12:00:00Z");

function window(percent: number, resetAt: string | null = "2026-10-10T15:00:00Z") {
  return {
    used: percent,
    limit: 100,
    remaining: 100 - percent,
    percent,
    resetAt,
    resetAfterSeconds: null,
    limitWindowSeconds: 18000,
  };
}

function usage(overrides: Partial<CodexUsagePayload> = {}): CodexUsagePayload {
  return {
    status: "ok",
    planType: "pro",
    fiveHour: window(20),
    weekly: window(40),
    limitReached: false,
    fetchedAt: "2026-10-10T12:00:00Z",
    rateLimitResetCredits: null,
    ...overrides,
  };
}

describe("codexIncludedUsageAvailable", () => {
  test("admits an account with included usage left", () => {
    expect(codexIncludedUsageAvailable(usage(), NOW)).toBe(true);
  });

  test.each([
    ["limit reached", usage({ limitReached: true })],
    ["limit status", usage({ status: "limit_reached" })],
    ["exhausted window", usage({ fiveHour: window(100) })],
    ["unknown usage", usage({ status: "error" })],
    ["no data", usage({ status: "no-data" })],
    ["no windows", usage({ fiveHour: null, weekly: null })],
    ["exhausted without reset", usage({ weekly: window(100, null) })],
  ])("never spends extra credits: %s", (_label, payload) => {
    expect(codexIncludedUsageAvailable(payload, NOW)).toBe(false);
  });

  test("an exhausted window whose reset has passed is available again", () => {
    expect(
      codexIncludedUsageAvailable(usage({ fiveHour: window(100, "2026-10-10T11:00:00Z") }), NOW),
    ).toBe(true);
  });
});

describe("publicModelCallError", () => {
  test("keeps public errors and client aborts", () => {
    const refusal = new ModelCallError({ status: 402, type: "insufficient_quota", message: "x" });
    expect(publicModelCallError(refusal)).toBe(refusal);
    const abort = new DOMException("Aborted", "AbortError");
    expect(publicModelCallError(abort)).toBe(abort);
  });

  test("an unsupported parameter names it", () => {
    const mapped = publicModelCallError(new SingleModelCallUnsupportedError("stop", "no stop"));
    expect(mapped).toMatchObject({ status: 400, param: "stop", code: "unsupported_parameter" });
  });

  test("provider statuses map to public statuses", () => {
    expect(publicModelCallError(Object.assign(new Error("slow"), { status: 429 }))).toMatchObject({
      status: 429,
      type: "rate_limit_error",
    });
    expect(
      publicModelCallError(Object.assign(new Error("bad schema"), { status: 400 })),
    ).toMatchObject({ status: 400, message: "bad schema" });
    const credential = publicModelCallError(
      Object.assign(new Error("invalid api key sk-secret"), { status: 401 }),
    ) as ModelCallError;
    expect(credential.status).toBe(502);
    expect(credential.message).not.toContain("sk-secret");
  });

  test("a disconnected subscription asks for reconnection", () => {
    expect(publicModelCallError(new CodexReloginRequired("expired"))).toMatchObject({
      status: 503,
      code: "subscription_reconnect_required",
    });
  });

  test("unknown failures stay generic", () => {
    const mapped = publicModelCallError(new Error("socket hang up at 10.0.0.1")) as ModelCallError;
    expect(mapped.status).toBe(502);
    expect(mapped.message).toBe("The model request failed.");
  });
});
