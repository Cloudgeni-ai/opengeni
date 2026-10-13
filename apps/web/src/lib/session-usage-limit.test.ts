import { describe, expect, test } from "bun:test";
import type { SessionUsageLimit } from "@opengeni/sdk/session-usage-limits";

import {
  USAGE_LIMIT_AMOUNT_INVALID,
  USAGE_LIMIT_AMOUNT_REQUIRED,
  classifySessionUsageLimitSaveError,
  goalPausedAtUsageLimit,
  isOutcomeUnknown,
  isSessionUsageLimitRefreshEvent,
  lineageHasRunningSession,
  parseSessionUsageLimitDraft,
  sessionUsageLimitCapability,
  sessionUsageLimitDraftSummary,
  sessionUsageLimitInputValue,
  usageLimitRefusalFromState,
} from "./session-usage-limit";
import type { SessionEvent } from "@/types";

const rootSessionId = "2f1c6a52-6b1e-4f43-9d55-1c0c2f7e8a10";

function usage(overrides: Partial<SessionUsageLimit> = {}): SessionUsageLimit {
  return {
    basis: "model_api_equivalent_v1",
    rootSessionId,
    inherited: false,
    status: "within",
    limitMicros: 50_000_000,
    usedMicros: 12_340_000,
    version: 3,
    usageRevision: 7,
    history: "complete",
    coverage: "complete",
    pricedCalls: 4,
    freeCalls: 0,
    unpricedCalls: 0,
    updatedAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  } as SessionUsageLimit;
}

function event(type: string, payload: unknown, sequence = 1): SessionEvent {
  return { type, payload, sequence } as unknown as SessionEvent;
}

describe("capability", () => {
  test("an older server hides limits; enabled false only allows removing one", () => {
    expect(sessionUsageLimitCapability({})).toBe("absent");
    expect(sessionUsageLimitCapability(null)).toBe("absent");
    expect(sessionUsageLimitCapability({ sessionUsageLimits: { enabled: false } })).toBe(
      "disabled",
    );
    expect(sessionUsageLimitCapability({ sessionUsageLimits: { enabled: true } })).toBe("enabled");
  });
});

describe("dollar input", () => {
  test("reuses the console's two-decimal dollar parser and its $10M maximum", () => {
    expect(parseSessionUsageLimitDraft({ kind: "none" })).toEqual({ ok: true, limitMicros: null });
    expect(parseSessionUsageLimitDraft({ kind: "limit", text: "25" })).toEqual({
      ok: true,
      limitMicros: 25_000_000,
    });
    expect(parseSessionUsageLimitDraft({ kind: "limit", text: "$1,200.5" })).toEqual({
      ok: true,
      limitMicros: 1_200_500_000,
    });
    // Zero is a real limit: stop before any model request.
    expect(parseSessionUsageLimitDraft({ kind: "limit", text: "0" })).toEqual({
      ok: true,
      limitMicros: 0,
    });
    expect(parseSessionUsageLimitDraft({ kind: "limit", text: " " })).toEqual({
      ok: false,
      error: USAGE_LIMIT_AMOUNT_REQUIRED,
    });
    for (const text of ["1.234", "-5", "abc", "10000000.01"]) {
      expect(parseSessionUsageLimitDraft({ kind: "limit", text })).toEqual({
        ok: false,
        error: USAGE_LIMIT_AMOUNT_INVALID,
      });
    }
    expect(parseSessionUsageLimitDraft({ kind: "limit", text: "10000000" }).ok).toBe(true);
  });

  test("the + row summary and the input value", () => {
    expect(sessionUsageLimitDraftSummary({ kind: "none" })).toBe("No limit");
    expect(sessionUsageLimitDraftSummary({ kind: "limit", text: "25" })).toBe("$25.00");
    expect(sessionUsageLimitDraftSummary({ kind: "limit", text: "" })).toBe("Enter amount");
    expect(sessionUsageLimitInputValue(50_000_000)).toBe("50");
    expect(sessionUsageLimitInputValue(12_500_000)).toBe("12.50");
  });
});

describe("save errors", () => {
  const apiError = (status: number, code: string, details?: Record<string, unknown>) =>
    Object.assign(new Error(`Opengeni API ${status}: refused`), {
      status,
      code: status === 409 ? "conflict" : "forbidden",
      details: { code, ...details },
    });

  test("each details.code reads as what happened and what to do", () => {
    expect(
      classifySessionUsageLimitSaveError(apiError(409, "session_usage_limit_conflict")).kind,
    ).toBe("conflict");
    expect(
      classifySessionUsageLimitSaveError(apiError(409, "session_usage_limit_preparing")),
    ).toMatchObject({ kind: "preparing", message: expect.stringContaining("amount is kept") });
    expect(
      classifySessionUsageLimitSaveError(
        apiError(409, "session_usage_limit_not_root", { rootSessionId }),
      ),
    ).toMatchObject({ kind: "not_root", rootSessionId });
    expect(
      classifySessionUsageLimitSaveError(apiError(403, "session_usage_limit_forbidden")).kind,
    ).toBe("forbidden");
    expect(
      classifySessionUsageLimitSaveError(apiError(422, "session_usage_limit_disabled")).kind,
    ).toBe("disabled");
    expect(
      classifySessionUsageLimitSaveError(apiError(503, "session_usage_limit_unavailable")).kind,
    ).toBe("unavailable");
    const other = classifySessionUsageLimitSaveError(new TypeError("Failed to fetch"));
    expect(other.kind).toBe("other");
    expect(other.message).not.toMatch(/Opengeni API|session_usage/);
  });

  test("a lost response is unknown, not a failure: saving again is safe", () => {
    const lost = Object.assign(new Error("Failed to fetch"), { outcomeUnknown: true });
    expect(isOutcomeUnknown(lost)).toBe(true);
    expect(isOutcomeUnknown(new Error("x"))).toBe(false);
    expect(classifySessionUsageLimitSaveError(lost)).toEqual({
      kind: "unknown",
      message: "Couldn't confirm the save. Save again to check; it won't be applied twice.",
    });
  });
});

describe("refresh signals", () => {
  test("own usage and limit events refresh; other stops don't", () => {
    expect(isSessionUsageLimitRefreshEvent(event("session.usage_limit.updated", {}))).toBe(true);
    expect(isSessionUsageLimitRefreshEvent(event("agent.model.usage", {}))).toBe(true);
    expect(
      isSessionUsageLimitRefreshEvent(
        event("turn.completed", { output: "", segmentLimit: "session_usage_limit" }),
      ),
    ).toBe(true);
    expect(
      isSessionUsageLimitRefreshEvent(
        event("turn.completed", { output: "", segmentLimit: "budget_exhausted" }),
      ),
    ).toBe(false);
    expect(isSessionUsageLimitRefreshEvent(event("agent.message", {}))).toBe(false);
    // A child settled: its usage is not on this stream, so read the total.
    expect(
      isSessionUsageLimitRefreshEvent(
        event("system.update.delivered", {
          members: [{ id: "u1", kind: "child_terminal_result", classification: "success" }],
        }),
      ),
    ).toBe(true);
    expect(
      isSessionUsageLimitRefreshEvent(
        event("system.update.delivered", {
          members: [{ id: "u2", kind: "agent_message", classification: "info" }],
        }),
      ),
    ).toBe(false);
  });

  test("a running agent anywhere in the tree keeps polling on", () => {
    const node = (status: string, children: unknown[] = []) => ({
      session: { status },
      children,
    });
    expect(lineageHasRunningSession([])).toBe(false);
    expect(lineageHasRunningSession([node("idle", [node("idle")])])).toBe(false);
    expect(lineageHasRunningSession([node("idle", [node("idle", [node("running")])])])).toBe(true);
  });

  test("only the newest goal event decides a pause at the limit", () => {
    expect(goalPausedAtUsageLimit([event("goal.paused", { reason: "session_usage_limit" })])).toBe(
      true,
    );
    expect(
      goalPausedAtUsageLimit([
        event("goal.paused", { reason: "session_usage_limit" }, 1),
        event("goal.resumed", {}, 2),
      ]),
    ).toBe(false);
    expect(goalPausedAtUsageLimit([event("goal.paused", { reason: "user_pause" })])).toBe(false);
  });
});

describe("refused Send", () => {
  test("shows reached until the reread answers, from the typed refusal or the known limit", () => {
    expect(usageLimitRefusalFromState({ pending: false, error: null, usage: usage() })).toBeNull();
    expect(
      usageLimitRefusalFromState({
        pending: true,
        error: { rootSessionId, limitMicros: 50_000_000, usedMicros: 51_000_000 },
        usage: usage(),
      }),
    ).toEqual({ rootSessionId, limitMicros: 50_000_000, usedMicros: 51_000_000 });
    expect(usageLimitRefusalFromState({ pending: true, error: null, usage: usage() })).toEqual({
      rootSessionId,
      limitMicros: 50_000_000,
      usedMicros: 50_000_000,
    });
    expect(
      usageLimitRefusalFromState({
        pending: true,
        error: null,
        usage: usage({ limitMicros: null }),
      }),
    ).toBeNull();
  });
});
