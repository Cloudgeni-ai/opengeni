import { describe, expect, test } from "bun:test";
import { CODEX_TRANSPORT_ERROR_HEADER, CodexReloginRequired } from "@opengeni/codex";
import {
  agentRunFailurePayload,
  classifyCodexCredentialFailure,
  CODEX_ALLOWANCE_FALLBACK_MS,
  codexCredentialCooldownUntil,
  codexUsageLimitFailurePayload,
  humanizeResetWindow,
} from "../src/activities/agent-turn";

function codexTransportError<T extends Error>(error: T, retryAfter?: string): T {
  return Object.assign(error, {
    headers: new Headers({
      [CODEX_TRANSPORT_ERROR_HEADER]: "1",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    }),
  });
}

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

describe("credential allocator definitive credential failure classification", () => {
  test("classifies second 401, 403, generic 429, and quota shapes", () => {
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(Object.assign(new Error("unauthorized"), { status: 401 })),
      ),
    ).toEqual({ kind: "auth", cooldownSeconds: null });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(Object.assign(new Error("forbidden"), { status: 403 })),
      ),
    ).toEqual({ kind: "forbidden", cooldownSeconds: null });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(
          Object.assign(new Error("too many requests"), {
            status: 429,
            retry_after_seconds: 17,
          }),
        ),
      ),
    ).toEqual({ kind: "rate_limit", cooldownSeconds: 17 });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(
          Object.assign(new Error("insufficient quota"), { code: "insufficient_quota" }),
        ),
      ),
    ).toEqual({ kind: "quota", cooldownSeconds: null });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(
          Object.assign(new Error("insufficient quota"), {
            status: 429,
            code: "insufficient_quota",
            retry_after_seconds: 19,
          }),
        ),
      ),
    ).toEqual({ kind: "quota", cooldownSeconds: 19 });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(
          Object.assign(new Error("weekly quota exceeded"), {
            status: 429,
            error: { code: "quota_exceeded" },
          }),
        ),
      ),
    ).toEqual({ kind: "quota", cooldownSeconds: null });
    expect(classifyCodexCredentialFailure(new CodexReloginRequired("refresh rejected"))).toEqual({
      kind: "auth",
      cooldownSeconds: null,
    });
    expect(
      classifyCodexCredentialFailure(
        Object.assign(new Error("Connection error."), {
          cause: new CodexReloginRequired("refresh rejected"),
        }),
      ),
    ).toEqual({ kind: "auth", cooldownSeconds: null });
    expect(
      classifyCodexCredentialFailure(
        codexTransportError(Object.assign(new Error("header throttled"), { status: 429 }), "23"),
      ),
    ).toEqual({ kind: "rate_limit", cooldownSeconds: 23 });
  });

  test("ambiguous network, 5xx, invalid content, and partial-stream errors never rotate", () => {
    const ambiguous = [
      Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("provider failed"), { status: 503 }),
      Object.assign(new Error("model produced invalid content"), { status: 400 }),
      new Error("unstructured text mentioned a rate limit without a status or code"),
      Object.assign(new Error("stream terminated before response.completed"), {
        code: "partial_stream",
      }),
      Object.assign(new Error("sandbox forbidden"), { status: 403 }),
      Object.assign(new Error("MCP throttled"), { status: 429, code: "rate_limit_exceeded" }),
    ];
    for (const error of ambiguous) {
      expect(classifyCodexCredentialFailure(error)).toBeNull();
    }
  });

  test("cooldowns use provider retry-after, latest binding reset, and a five-hour fallback", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    expect(
      codexCredentialCooldownUntil(
        { kind: "rate_limit", cooldownSeconds: 31 },
        null,
        now,
      )?.getTime(),
    ).toBe(now.getTime() + 31_000);
    const fiveHourReset = new Date(now.getTime() + 4 * 60 * 60_000);
    const weeklyReset = new Date(now.getTime() + 6 * 24 * 60 * 60_000);
    expect(
      codexCredentialCooldownUntil(
        { kind: "quota", cooldownSeconds: null },
        {
          primaryUsedPercent: 100,
          primaryResetAt: fiveHourReset,
          secondaryUsedPercent: 100,
          secondaryResetAt: weeklyReset,
        },
        now,
      )?.getTime(),
    ).toBe(weeklyReset.getTime());
    expect(
      codexCredentialCooldownUntil(
        { kind: "quota", cooldownSeconds: 31 },
        {
          primaryUsedPercent: 100,
          primaryResetAt: fiveHourReset,
          secondaryUsedPercent: 100,
          secondaryResetAt: weeklyReset,
        },
        now,
      )?.getTime(),
    ).toBe(weeklyReset.getTime());
    expect(
      codexCredentialCooldownUntil({ kind: "quota", cooldownSeconds: null }, null, now)?.getTime(),
    ).toBe(now.getTime() + CODEX_ALLOWANCE_FALLBACK_MS);
    expect(
      codexCredentialCooldownUntil({ kind: "auth", cooldownSeconds: null }, null, now),
    ).toBeNull();
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

  test("P3 all-accounts variant names the earliest reset across subscriptions", () => {
    const payload = codexUsageLimitFailurePayload({ resetsInSeconds: 2 * 3600 }, "all capped", {
      allAccounts: true,
    });
    expect(payload.code).toBe("codex_usage_limit_reached");
    expect(payload.retryable).toBe(false);
    expect(payload.error).toContain("All connected");
    expect(payload.error).toContain("in about 2h");
    expect(payload.detail).toBe("all capped");
  });

  test("the single-account message is unchanged when allAccounts is not set", () => {
    const payload = codexUsageLimitFailurePayload({ resetsInSeconds: 3600 }, "x");
    expect(payload.error).toContain("Your ChatGPT/Codex subscription usage limit has been reached");
    expect(payload.error).not.toContain("All connected");
  });
});

describe("agentRunFailurePayload — codex usage limit", () => {
  test("classifies a 429 usage_limit_reached as the non-retryable codex cap (NOT the generic rate-limit)", () => {
    const err = codexTransportError(
      Object.assign(new Error("429 You have hit your usage limit"), {
        status: 429,
        type: "usage_limit_reached",
        error: { type: "usage_limit_reached", resets_in_seconds: 7200 },
      }),
    );
    const payload = agentRunFailurePayload(err);
    expect(payload.code).toBe("codex_usage_limit_reached");
    expect(payload.retryable).toBe(false);
    expect(payload.error).toContain("in about 2h");
  });

  test("a plain 429 rate-limit (no usage cap) is still the generic retryable payload", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    const payload = agentRunFailurePayload(err);
    expect(payload.code).toBe("provider_rate_limited");
    expect(payload.retryable).toBe(true);
  });
});
