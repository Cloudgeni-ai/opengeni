import { describe, expect, test } from "bun:test";

import {
  CreateSessionRequest,
  GoalAdmissionPausedReason,
  SESSION_EVENT_SEMANTIC_CLASS_TYPES,
  SESSION_USAGE_LIMIT_BASIS,
  SESSION_USAGE_LIMIT_MAX_MICROS,
  SessionEventType,
  SessionGoalPausedReason,
  SessionUsageLimit,
  SessionUsageLimitMicros,
  SessionUsageLimitReachedRefusal,
  SetSessionUsageLimitRequest,
  formatSessionUsageMicros,
  parseSessionUsageLimitReachedRefusal,
  sessionUsageLimitReachedMessage,
} from "../src/index";
import { parseAllowanceExhaustedRefusal } from "../src/allowance-refusal";

const ROOT = "11111111-2222-4333-8444-555555555555";

describe("session usage limit amounts (AC01)", () => {
  const table: Array<[unknown, boolean]> = [
    [0, true],
    [1, true],
    [10_000, true],
    [SESSION_USAGE_LIMIT_MAX_MICROS, true],
    [SESSION_USAGE_LIMIT_MAX_MICROS + 1, false],
    [-1, false],
    [0.5, false],
    [1.000001, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ["100", false],
    [null, false],
  ];
  for (const [value, ok] of table) {
    test(`${String(value)} -> ${ok ? "accepted" : "rejected"}`, () => {
      expect(SessionUsageLimitMicros.safeParse(value).success).toBe(ok);
    });
  }

  test("null (no limit) and zero (stop immediately) are distinct write values", () => {
    const base = { expectedVersion: 0, operationId: "op-1" };
    expect(
      SetSessionUsageLimitRequest.parse({ ...base, limitMicros: null }).limitMicros,
    ).toBeNull();
    expect(SetSessionUsageLimitRequest.parse({ ...base, limitMicros: 0 }).limitMicros).toBe(0);
    expect(SetSessionUsageLimitRequest.safeParse({ ...base }).success).toBe(false);
  });

  test("set request is strict and validates operation ids", () => {
    expect(
      SetSessionUsageLimitRequest.safeParse({
        limitMicros: 1,
        expectedVersion: 0,
        operationId: "op",
        rootSessionId: ROOT,
      }).success,
    ).toBe(false);
    for (const operationId of ["", "   ", "a\0b", "x".repeat(257)]) {
      expect(
        SetSessionUsageLimitRequest.safeParse({ limitMicros: 1, expectedVersion: 0, operationId })
          .success,
      ).toBe(false);
    }
    expect(
      SetSessionUsageLimitRequest.safeParse({
        limitMicros: 1,
        expectedVersion: -1,
        operationId: "a",
      }).success,
    ).toBe(false);
  });

  test("create omission means unlimited, null is explicit unlimited and zero is kept", () => {
    const base = { initialMessage: "hi" };
    expect(CreateSessionRequest.parse(base).usageLimitMicros).toBeUndefined();
    expect(CreateSessionRequest.parse({ ...base, usageLimitMicros: null }).usageLimitMicros).toBe(
      null,
    );
    expect(CreateSessionRequest.parse({ ...base, usageLimitMicros: 0 }).usageLimitMicros).toBe(0);
    expect(CreateSessionRequest.safeParse({ ...base, usageLimitMicros: 1.5 }).success).toBe(false);
    expect(CreateSessionRequest.safeParse({ ...base, usageLimitMicros: -5 }).success).toBe(false);
  });
});

describe("session usage limit projection", () => {
  const projection = {
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId: ROOT,
    inherited: false,
    status: "reached",
    limitMicros: 5_000_000,
    usedMicros: 7_250_000,
    version: 2,
    usageRevision: 9,
    history: "complete",
    coverage: "partial",
    pricedCalls: 3,
    freeCalls: 1,
    unpricedCalls: 1,
    updatedAt: "2026-10-13T08:00:00.000Z",
  } as const;

  test("overshoot above the limit is representable and not clamped", () => {
    expect(SessionUsageLimit.parse(projection).usedMicros).toBe(7_250_000);
  });

  test("preparing and unavailable carry no numeric usage", () => {
    expect(
      SessionUsageLimit.parse({ ...projection, status: "preparing", usedMicros: null }).usedMicros,
    ).toBeNull();
    expect(SessionUsageLimit.safeParse({ ...projection, basis: "credits" }).success).toBe(false);
  });
});

describe("refusal parsing and wording", () => {
  const refusal = {
    code: "session_usage_limit_reached" as const,
    basis: SESSION_USAGE_LIMIT_BASIS,
    rootSessionId: ROOT,
    limitMicros: 1_000_000,
    usedMicros: 1_200_000,
    message: "limit\u0000reached",
  };

  test("zod schema and zod-free parser agree", () => {
    expect(SessionUsageLimitReachedRefusal.safeParse({ ...refusal, message: "x" }).success).toBe(
      true,
    );
    const parsed = parseSessionUsageLimitReachedRefusal(refusal);
    expect(parsed).toEqual({ ...refusal, message: "limit reached" });
    expect(SessionUsageLimitReachedRefusal.parse(parsed)).toEqual(parsed!);
  });

  test("reads API error details and turn.completed payloads", () => {
    const { code, message, ...details } = refusal;
    expect(parseSessionUsageLimitReachedRefusal({ code, message, details })?.usedMicros).toBe(
      1_200_000,
    );
    expect(
      parseSessionUsageLimitReachedRefusal({
        output: "",
        segmentLimit: "session_usage_limit",
        sessionUsageLimit: refusal,
      })?.limitMicros,
    ).toBe(1_000_000);
  });

  test("malformed refusals are rejected rather than guessed", () => {
    for (const bad of [
      { ...refusal, basis: "credits" },
      { ...refusal, rootSessionId: "root" },
      { ...refusal, limitMicros: -1 },
      { ...refusal, usedMicros: 1.5 },
      { ...refusal, limitMicros: SESSION_USAGE_LIMIT_MAX_MICROS + 1 },
      { ...refusal, code: "allowance_exhausted" },
      null,
      "session_usage_limit_reached",
    ]) {
      expect(parseSessionUsageLimitReachedRefusal(bad)).toBeNull();
    }
  });

  test("an allowance parser never claims a session usage refusal", () => {
    expect(parseAllowanceExhaustedRefusal(refusal)).toBeNull();
  });

  test("wording has no purchase remedy, reset date or invoice claim", () => {
    const text = sessionUsageLimitReachedMessage(refusal);
    expect(text).toContain("$1.20 of $1.00");
    expect(text).not.toMatch(/credit|reset|invoice|bill|month/i);
    expect(formatSessionUsageMicros(0)).toBe("$0.00");
    expect(formatSessionUsageMicros(1)).toBe("<$0.01");
    expect(formatSessionUsageMicros(12_345_678_900)).toBe("$12,345.68");
  });
});

describe("new stop markers do not reuse credit/allowance markers", () => {
  test("goal reason and event type are new, specific values", () => {
    expect(SessionGoalPausedReason.options).toContain("session_usage_limit");
    const reason: GoalAdmissionPausedReason = "session_usage_limit";
    expect(reason).toBe("session_usage_limit");
    expect(SessionEventType.options).toContain("session.usage_limit.updated");
    expect(SESSION_EVENT_SEMANTIC_CLASS_TYPES.control).toContain("session.usage_limit.updated");
  });
});
