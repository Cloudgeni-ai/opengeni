import { describe, expect, test } from "bun:test";
import { planSubscriptionCoreRefusal } from "../src";

const adapter = {
  health: {
    forbiddenQuarantineMs: 600_000,
    entitlementCooldownMs: 3_600_000,
    rateLimitFallbackMs: 60_000,
    exhaustedFallbackMs: 7_200_000,
  },
};
const now = 1_000_000;
const base = { now, refreshGeneration: 4, renewable: false, refreshed: false };

function until(plan: ReturnType<typeof planSubscriptionCoreRefusal>) {
  if (plan.kind !== "settle" || plan.health.kind !== "quota") throw new Error("not a quota plan");
  return [plan.health.observation.exhaustedUntil, plan.health.observation.exhaustedKind];
}

describe("planSubscriptionCoreRefusal", () => {
  test("rate limits rest until the retry time, else the adapter's fallback", () => {
    expect(
      until(
        planSubscriptionCoreRefusal(adapter, { kind: "rate_limited", retryAfterMs: 5_000 }, base),
      ),
    ).toEqual([now + 5_000, "rate_limit"]);
    for (const retryAfterMs of [null, 0, -1])
      expect(
        until(planSubscriptionCoreRefusal(adapter, { kind: "rate_limited", retryAfterMs }, base)),
      ).toEqual([now + 60_000, "rate_limit"]);
  });

  test("an exhaustion rests until its reset; an unknown or past reset uses the fallback window", () => {
    expect(
      until(planSubscriptionCoreRefusal(adapter, { kind: "exhausted", resetAt: now + 9 }, base)),
    ).toEqual([now + 9, "quota"]);
    for (const resetAt of [null, now, now - 1]) {
      const plan = planSubscriptionCoreRefusal(adapter, { kind: "exhausted", resetAt }, base);
      expect(until(plan)).toEqual([null, null]);
      if (plan.kind === "settle" && plan.health.kind === "quota")
        expect(plan.health.observation.windows).toEqual([
          {
            id: "exhausted_without_reset",
            usedPercent: 100,
            resetsAt: now + 7_200_000,
            status: "exhausted",
          },
        ]);
    }
  });

  test("a refusal's receipt carries its kind and the refused credential's generation", () => {
    const plan = planSubscriptionCoreRefusal(adapter, { kind: "forbidden" }, base);
    expect(plan).toEqual({
      kind: "settle",
      requestOutcome: "refused",
      receipt: { kind: "forbidden", evidence: { refreshGeneration: 4 } },
      health: { kind: "quarantine", reason: "forbidden" },
    });
    const quota = planSubscriptionCoreRefusal(adapter, { kind: "exhausted", resetAt: null }, base);
    expect(quota.kind === "settle" && quota.health.kind === "quota").toBe(true);
    if (quota.kind === "settle" && quota.health.kind === "quota")
      expect(quota.health.observation).toMatchObject({
        observedAt: now,
        observedRefreshGeneration: 4,
        source: "refusal",
        exhaustedUntil: null,
      });
  });

  test("a missing entitlement cools the model down on the connection", () => {
    expect(
      planSubscriptionCoreRefusal(adapter, { kind: "entitlement_missing", modelId: "m" }, base),
    ).toMatchObject({
      kind: "settle",
      health: { kind: "model_cooldown", modelId: "m", until: now + 3_600_000 },
    });
  });

  test("a renewable credential is refreshed once before a sign-in refusal is settled", () => {
    for (const kind of ["unauthorized", "forbidden"] as const) {
      expect(planSubscriptionCoreRefusal(adapter, { kind }, { ...base, renewable: true })).toEqual({
        kind: "retry_after_refresh",
        requestOutcome: "refused",
      });
      expect(
        planSubscriptionCoreRefusal(
          adapter,
          { kind },
          { ...base, renewable: true, refreshed: true },
        ),
      ).toMatchObject({
        kind: "settle",
        health: { kind: "quarantine", reason: kind === "unauthorized" ? "sign_in" : "forbidden" },
      });
    }
    // A static key is never refreshed: it needs a new key.
    expect(planSubscriptionCoreRefusal(adapter, { kind: "unauthorized" }, base)).toMatchObject({
      kind: "settle",
      health: { kind: "quarantine", reason: "sign_in" },
    });
  });

  test("a refusal naming one model cools that model only", () => {
    const cooled = (outcome: Parameters<typeof planSubscriptionCoreRefusal>[1]) => {
      const plan = planSubscriptionCoreRefusal(adapter, outcome, base);
      if (plan.kind !== "settle" || plan.health.kind !== "model_cooldown")
        throw new Error("not a model cooldown");
      return [plan.health.modelId, plan.health.until];
    };
    expect(cooled({ kind: "rate_limited", retryAfterMs: 5_000, modelId: "m" })).toEqual([
      "m",
      now + 5_000,
    ]);
    expect(cooled({ kind: "rate_limited", retryAfterMs: null, modelId: "m" })).toEqual([
      "m",
      now + 60_000,
    ]);
    expect(cooled({ kind: "rate_limited", retryAfterMs: 0, modelId: "m" })).toEqual([
      "m",
      now + 60_000,
    ]);
    expect(cooled({ kind: "exhausted", resetAt: now + 9, modelId: "m" })).toEqual(["m", now + 9]);
    expect(cooled({ kind: "exhausted", resetAt: null, modelId: "m" })).toEqual([
      "m",
      now + 7_200_000,
    ]);
  });

  test("overloaded, failed and unclassified replies never fail over", () => {
    expect(planSubscriptionCoreRefusal(adapter, { kind: "overloaded" }, base)).toEqual({
      kind: "no_failover",
      requestOutcome: "refused",
    });
    for (const kind of ["transient", "fatal"] as const)
      expect(planSubscriptionCoreRefusal(adapter, { kind }, base)).toEqual({
        kind: "no_failover",
        requestOutcome: "response_received",
      });
    expect(planSubscriptionCoreRefusal(adapter, null, base)).toEqual({
      kind: "no_failover",
      requestOutcome: "unknown",
    });
  });
});
