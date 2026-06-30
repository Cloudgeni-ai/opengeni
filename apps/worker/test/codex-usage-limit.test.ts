import { describe, expect, test } from "bun:test";
import { agentRunFailurePayload, codexUsageLimitFailurePayload, humanizeResetWindow } from "../src/activities/agent-turn";

// P1-d: a ChatGPT/Codex usage cap (429 usage_limit_reached) must surface as a
// precise, NON-retryable error with the reset window — not the generic retryable
// "rate limit hit, try again in a minute" that would loop a goal against a hard cap.

describe("humanizeResetWindow", () => {
  test("formats hours+minutes / minutes / sub-minute / unknown", () => {
    expect(humanizeResetWindow(3 * 3600 + 25 * 60)).toBe("in about 3h 25m");
    expect(humanizeResetWindow(3600)).toBe("in about 1h");
    expect(humanizeResetWindow(9 * 60)).toBe("in about 9m");
    expect(humanizeResetWindow(30)).toBe("in under a minute");
    expect(humanizeResetWindow(null)).toBe("shortly");
    expect(humanizeResetWindow(0)).toBe("shortly");
  });
});

describe("codexUsageLimitFailurePayload", () => {
  test("names the reset window, carries the stable code, and is non-retryable", () => {
    const payload = codexUsageLimitFailurePayload({ resetsInSeconds: 3600 }, "429 limit hit");
    expect(payload.code).toBe("codex_usage_limit_reached");
    expect(payload.retryable).toBe(false);
    expect(payload.error).toContain("usage limit");
    expect(payload.error).toContain("in about 1h");
    expect(payload.detail).toBe("429 limit hit");
  });
});

describe("agentRunFailurePayload — codex usage limit", () => {
  test("classifies a 429 usage_limit_reached as the non-retryable codex cap (NOT the generic rate-limit)", () => {
    const err = Object.assign(new Error("429 You have hit your usage limit"), {
      status: 429,
      type: "usage_limit_reached",
      error: { type: "usage_limit_reached", resets_in_seconds: 7200 },
    });
    const payload = agentRunFailurePayload(err);
    expect(payload.code).toBe("codex_usage_limit_reached");
    expect(payload.retryable).toBe(false);
    expect(payload.error).toContain("in about 2h");
  });

  test("a plain 429 rate-limit (no usage cap) is still the generic retryable payload", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), { status: 429, code: "rate_limit_exceeded" });
    const payload = agentRunFailurePayload(err);
    expect(payload.code).toBe("provider_rate_limited");
    expect(payload.retryable).toBe(true);
  });
});
