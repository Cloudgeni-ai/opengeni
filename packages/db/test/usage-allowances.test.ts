import { describe, expect, test } from "bun:test";
import {
  allowanceUsage,
  setWorkspaceAllowance,
  validateMemberAllowanceRule,
  validateWorkspaceAllowanceConfig,
} from "../src/usage-allowances";
import { withCreditDebitAttribution } from "../src/credit-debit-attribution";
import type { Database } from "../src/database";

describe("usage allowance projections and validation", () => {
  test("authenticated agent context cannot mutate with human-looking actor labels", async () => {
    await expect(
      withCreditDebitAttribution(
        { kind: "turn", turnId: crypto.randomUUID(), initiatingHumanSubjectId: "user:admin" },
        () =>
          setWorkspaceAllowance({} as Database, {
            accountId: crypto.randomUUID(),
            workspaceId: crypto.randomUUID(),
            actorSubjectId: "user:admin",
            actorType: "human_session",
            includedCredits: 100,
            period: "none",
            expectedVersion: 0,
          }),
      ),
    ).rejects.toThrow("Agent attempts cannot change usage allowances");
  });

  test("micros are integral, rules allow oversubscription, zero is exhausted", () => {
    expect(() =>
      validateWorkspaceAllowanceConfig({ includedCredits: 1.5, period: "monthly" }),
    ).toThrow("safe integer");
    expect(() =>
      validateWorkspaceAllowanceConfig({ includedCredits: 100, period: "monthly", anchorDay: 32 }),
    ).toThrow("anchorDay");
    expect(() => validateMemberAllowanceRule({ share: 2.5 })).not.toThrow();
    expect(() => validateMemberAllowanceRule({ share: Number.NaN })).toThrow("finite");
    expect(allowanceUsage(0, 0, null).status).toBe("exhausted");
  });
  test("meter exposes fractions, warning, overshoot and unlimited state", () => {
    expect(allowanceUsage(100, 80, "2026-10-01")).toMatchObject({
      remaining: 20,
      fraction: 0.8,
      status: "warning",
    });
    expect(allowanceUsage(100, 120, null)).toMatchObject({
      remaining: 0,
      fraction: 1.2,
      status: "exhausted",
    });
    expect(allowanceUsage(null, 120, null)).toMatchObject({
      remaining: null,
      fraction: null,
      status: "ok",
    });
  });
});
