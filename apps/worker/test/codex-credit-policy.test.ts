import { describe, expect, mock, test } from "bun:test";
import { isCodexTransportError, type CodexUsageHeaderSnapshot } from "@opengeni/codex";
import {
  createCodexCreditGuard,
  CodexIncludedUsageExhaustedError,
} from "../src/activities/agent-turn/codex-credit-policy";
import { classifyCodexCredentialFailure } from "../src/activities/agent-turn/errors";

const now = Date.parse("2030-01-01T00:00:00Z");
function headers(primary = 20, secondary = 40, at = now): CodexUsageHeaderSnapshot {
  return {
    primaryUsedPercent: primary,
    secondaryUsedPercent: secondary,
    primaryResetAt: new Date(now + 3_600_000),
    secondaryResetAt: new Date(now + 7_200_000),
    checkedAt: new Date(at),
  };
}

describe("Codex extra credit protection", () => {
  test("unknown usage admits a dispatch without any read or credit query", async () => {
    const canSpendCredits = mock(async () => false);
    const guard = createCodexCreditGuard({ canSpendCredits, now: () => now });
    await guard.assertKnownUsageAllowsDispatch();
    guard.observe(headers(99.9, 99.9));
    await guard.assertKnownUsageAllowsDispatch();
    guard.observe({ ...headers(), primaryUsedPercent: Number.NaN, checkedAt: new Date(now + 1) });
    await guard.assertKnownUsageAllowsDispatch();
    expect(canSpendCredits).not.toHaveBeenCalled();
  });

  test("a response reporting either window exhausted refuses the next dispatch", async () => {
    for (const window of ["primary", "secondary"]) {
      const guard = createCodexCreditGuard({ canSpendCredits: async () => false, now: () => now });
      await guard.assertKnownUsageAllowsDispatch();
      guard.observe(headers(window === "primary" ? 100 : 20, window === "secondary" ? 100 : 40));
      await expect(guard.assertKnownUsageAllowsDispatch()).rejects.toBeInstanceOf(
        CodexIncludedUsageExhaustedError,
      );
    }
  });

  test("the refusal is a quota decision carrying the latest reset, not a transport error", async () => {
    const guard = createCodexCreditGuard({ now: () => now });
    guard.observe(headers(100, 100));
    try {
      await guard.assertKnownUsageAllowsDispatch();
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

  test("an exhausted window whose reset has passed is no longer known to be exhausted", async () => {
    let clock = now;
    const guard = createCodexCreditGuard({ now: () => clock });
    guard.observe(headers(100, 40));
    await expect(guard.assertKnownUsageAllowsDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
    clock = now + 3_600_001;
    await guard.assertKnownUsageAllowsDispatch();
  });

  test("out-of-order observations cannot replace exhausted usage with an older success", async () => {
    const guard = createCodexCreditGuard({ now: () => now });
    guard.observe(headers(100));
    guard.observe(headers(20, 40, now - 1000));
    await expect(guard.assertKnownUsageAllowsDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
    guard.observe(headers(20, 40, now + 1000));
    await guard.assertKnownUsageAllowsDispatch();
  });

  test("known exhaustion spends credits only with live consent at each dispatch", async () => {
    let allowed = true;
    const canSpendCredits = mock(async () => allowed);
    const guard = createCodexCreditGuard({ canSpendCredits, now: () => now });
    guard.observe(headers(100));
    await guard.assertKnownUsageAllowsDispatch();
    allowed = false;
    await expect(guard.assertKnownUsageAllowsDispatch()).rejects.toBeInstanceOf(
      CodexIncludedUsageExhaustedError,
    );
    expect(canSpendCredits).toHaveBeenCalledTimes(2);
  });

  test("an explicit opt-in to extra credits admits exhausted usage without a policy query", async () => {
    const canSpendCredits = mock(async () => false);
    const guard = createCodexCreditGuard({
      allowExtraCredits: true,
      canSpendCredits,
      now: () => now,
    });
    guard.observe(headers(100, 100));
    await guard.assertKnownUsageAllowsDispatch();
    expect(canSpendCredits).not.toHaveBeenCalled();
  });
});
