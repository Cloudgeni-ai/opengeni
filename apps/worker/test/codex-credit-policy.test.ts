import { describe, expect, mock, test } from "bun:test";
import {
  normalizeCodexUsage,
  isCodexTransportError,
  CodexReloginRequired,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import {
  createCodexCreditGuard,
  CodexIncludedUsageExhaustedError,
  CodexIncludedUsageUnknownError,
} from "../src/activities/agent-turn/codex-credit-policy";
import {
  agentRunFailurePayload,
  classifyCodexCredentialFailure,
} from "../src/activities/agent-turn/errors";

const token = { accessToken: "test-token", chatgptAccountId: "test-account", isFedramp: false };
const now = Date.parse("2030-01-01T00:00:00Z");
function usage(primary = 20, secondary = 40) {
  return normalizeCodexUsage(200, {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: primary,
        reset_at: (now + 3_600_000) / 1000,
        limit_window_seconds: 18000,
      },
      secondary_window: {
        used_percent: secondary,
        reset_at: (now + 7_200_000) / 1000,
        limit_window_seconds: 604800,
      },
    },
    credits: { has_credits: true, balance: "123" },
  });
}
function headers(primary = 20, secondary = 40): CodexUsageHeaderSnapshot {
  return {
    primaryUsedPercent: primary,
    secondaryUsedPercent: secondary,
    primaryResetAt: new Date(now + 3_600_000),
    secondaryResetAt: new Date(now + 7_200_000),
    checkedAt: new Date(now),
  };
}

describe("Codex extra credit protection", () => {
  test("a rejected usage bearer is refreshed once before allowance is checked", async () => {
    const refreshed = { ...token, accessToken: "refreshed-test-token" };
    const refreshToken = mock(async () => refreshed);
    const fetchUsage = mock(async (auth: { accessToken: string }) =>
      auth.accessToken === token.accessToken
        ? { status: 401, payload: null }
        : {
            status: 200,
            payload: {
              rate_limit: {
                primary_window: { used_percent: 10, limit_window_seconds: 604800 },
              },
            },
          },
    );
    const guard = createCodexCreditGuard({
      allowExtraCredits: false,
      fetchUsage,
      refreshToken,
      now: () => now,
    });
    guard.setToken(token);
    await guard.assertCanDispatch();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchUsage.mock.calls.map(([auth]) => auth.accessToken)).toEqual([
      token.accessToken,
      refreshed.accessToken,
    ]);
    await guard.assertCanDispatch();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchUsage.mock.calls[2]![0].accessToken).toBe(refreshed.accessToken);
  });

  test("repeated usage rejection stops, while permanent refresh failure keeps its auth classification", async () => {
    const fetchUsage = mock(async () => ({ status: 401, payload: null }));
    const refreshToken = mock(async () => token);
    const guard = createCodexCreditGuard({ allowExtraCredits: false, fetchUsage, refreshToken });
    guard.setToken(token);
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(CodexIncludedUsageUnknownError);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    const expired = new CodexReloginRequired("Reconnect this account");
    const rejected = createCodexCreditGuard({
      allowExtraCredits: false,
      fetchUsage,
      refreshToken: async () => {
        throw expired;
      },
    });
    rejected.setToken(token);
    await expect(rejected.assertCanDispatch()).rejects.toBe(expired);
    expect(classifyCodexCredentialFailure(expired)).toMatchObject({ kind: "auth" });
  });

  test("successful requests reaching either limit block the next dispatch despite available credits", async () => {
    for (const window of ["primary", "secondary"]) {
      const readUsage = mock(async () => usage());
      const guard = createCodexCreditGuard({ allowExtraCredits: false, readUsage, now: () => now });
      guard.setToken(token);
      await guard.assertCanDispatch();
      guard.observe(headers(window === "primary" ? 100 : 20, window === "secondary" ? 100 : 40));
      await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
        CodexIncludedUsageExhaustedError,
      );
      expect(readUsage).toHaveBeenCalledTimes(1);
    }
  });

  test("initial usage at its limit blocks even when the provider accepts credit spending", async () => {
    const guard = createCodexCreditGuard({
      allowExtraCredits: false,
      readUsage: async () => usage(100, 100),
      now: () => now,
    });
    guard.setToken(token);
    try {
      await guard.assertCanDispatch();
      throw new Error("dispatched");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexIncludedUsageExhaustedError);
      expect((error as CodexIncludedUsageExhaustedError).resetsInSeconds).toBe(7200);
      expect(isCodexTransportError(error)).toBe(false);
      expect(
        classifyCodexCredentialFailure(new Error("SDK wrapper", { cause: error })),
      ).toMatchObject({ kind: "quota", cooldownSeconds: 7200, origin: "included_usage_policy" });
    }
  });

  test("stale success and passed reset require a fresh read; unknown usage never means permission to spend", async () => {
    let clock = now;
    const readUsage = mock(async () => usage());
    const guard = createCodexCreditGuard({ allowExtraCredits: false, readUsage, now: () => clock });
    guard.setToken(token);
    await guard.assertCanDispatch();
    clock += 31_000;
    readUsage.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(CodexIncludedUsageUnknownError);
    expect(classifyCodexCredentialFailure(new CodexIncludedUsageUnknownError())).toBeNull();
    expect(agentRunFailurePayload(new CodexIncludedUsageUnknownError())).toMatchObject({
      code: "codex_included_usage_unknown",
      retryable: false,
    });
    guard.observe({
      ...headers(100),
      primaryResetAt: new Date(clock - 1),
      checkedAt: new Date(clock),
    });
    await guard.assertCanDispatch();
    expect(readUsage).toHaveBeenCalledTimes(3);
  });

  test("an explicit limit without windows blocks; malformed or partial usage fails closed", async () => {
    for (const body of [{}, { credits: { has_credits: true, balance: 200 } }]) {
      const guard = createCodexCreditGuard({
        allowExtraCredits: false,
        readUsage: async () => normalizeCodexUsage(200, body),
        now: () => now,
      });
      guard.setToken(token);
      await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
        CodexIncludedUsageUnknownError,
      );
    }
    const guard = createCodexCreditGuard({
      allowExtraCredits: false,
      readUsage: async () => normalizeCodexUsage(200, { rate_limit: { allowed: false } }),
      now: () => now,
    });
    guard.setToken(token);
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
  });

  test("explicit opt-in permits continued work; a reset credit is never redeemed", async () => {
    const readUsage = mock(async () => usage(100, 100));
    const guard = createCodexCreditGuard({ allowExtraCredits: true, readUsage, now: () => now });
    guard.observe(headers(100, 100));
    await guard.assertCanDispatch();
    expect(readUsage).not.toHaveBeenCalled();
  });

  test("weekly-only accounts are admitted using their actual allowance", async () => {
    const readUsage = mock(async () =>
      normalizeCodexUsage(200, {
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 604800,
            reset_at: (now + 7200000) / 1000,
          },
        },
      }),
    );
    const onUsage = mock(() => undefined);
    const guard = createCodexCreditGuard({
      allowExtraCredits: false,
      readUsage,
      onUsage,
      now: () => now,
    });
    guard.setToken(token);
    await guard.assertCanDispatch();
    expect(onUsage).not.toHaveBeenCalled();
    readUsage.mockImplementationOnce(async () =>
      normalizeCodexUsage(200, {
        rate_limit: {
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 604800,
            reset_at: (now + 7200000) / 1000,
          },
        },
      }),
    );
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
  });

  test("a response without usage headers cannot reuse the preceding successful check", async () => {
    const readUsage = mock(async () => usage(99));
    const guard = createCodexCreditGuard({ allowExtraCredits: false, readUsage, now: () => now });
    guard.setToken(token);
    await guard.assertCanDispatch();
    readUsage.mockImplementationOnce(async () => usage(100));
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  test("out-of-order observations cannot replace exhausted usage with an older success", async () => {
    const guard = createCodexCreditGuard({ allowExtraCredits: false, now: () => now });
    guard.observe(headers(100));
    guard.observe({ ...headers(), checkedAt: new Date(now - 1000) });
    await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
  });

  test("feature exhaustion cannot silently spend credits while base allowance remains", async () => {
    for (const seconds of [18000, 604800, 86400]) {
      const data = usage();
      data.additionalLimits = normalizeCodexUsage(200, {
        additional_limits: [
          {
            limit_name: "feature",
            metered_feature: "codex_feature",
            primary_window: {
              used_percent: 100,
              limit_window_seconds: seconds,
              reset_at: (now + 3600000) / 1000,
            },
          },
        ],
      }).additionalLimits;
      const guard = createCodexCreditGuard({
        allowExtraCredits: false,
        readUsage: async () => data,
        now: () => now,
      });
      guard.setToken(token);
      await expect(guard.assertCanDispatch()).rejects.toBeInstanceOf(
        CodexIncludedUsageExhaustedError,
      );
    }
  });
});
