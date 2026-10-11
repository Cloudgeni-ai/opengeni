import { describe, expect, test } from "bun:test";
import {
  decodeSubscriptionCoreXaiQuota,
  subscriptionCoreXaiAdapter,
  subscriptionCoreXaiBearer,
} from "../src/subscription-core-xai-adapter";

const end = new Date("2026-11-01T00:00:00.000Z");
const decode = (usedPercent: number | null, periodEnd: Date | null = end) =>
  decodeSubscriptionCoreXaiQuota({
    response: {
      usedPercent,
      period: periodEnd ? { type: "month", start: null, end: periodEnd } : null,
    },
    observedAt: 1_000,
    refreshGeneration: 7,
  });

describe("SuperGrok quota and bearer probes on the core adapter", () => {
  test("billing usage becomes one quota window, fenced on the bearer's generation", () => {
    expect(decode(42)).toEqual({
      windows: [{ id: "billing", usedPercent: 42, resetsAt: end.getTime(), status: "ok" }],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      revision: 0,
      observedAt: 1_000,
      observedRefreshGeneration: 7,
      source: "usage_endpoint",
    });
    expect(decode(95)?.windows[0]?.status).toBe("warning");
  });

  test("at the limit the connection is quota-exhausted until the period ends", () => {
    expect(decode(100)).toMatchObject({
      exhaustedUntil: end.getTime(),
      exhaustedKind: "quota",
      windows: [{ status: "exhausted" }],
    });
    expect(decode(100, null)).toMatchObject({ exhaustedUntil: null, exhaustedKind: "quota" });
  });

  test("unknown billing records nothing", () => {
    expect(decode(null)).toBeNull();
    expect(decode(Number.NaN)).toBeNull();
  });

  test("a billing reading below the limit may end a stored exhaustion (SuperGrok only)", () => {
    expect(subscriptionCoreXaiAdapter().usageReadEndsQuotaExhaustion).toBe(true);
  });

  test("the bearer is the access token and the connection's verified account id", () => {
    expect(
      subscriptionCoreXaiBearer({
        credential: { accessToken: "access", refreshToken: "refresh" },
        providerAccountId: "xai-user",
        providerState: {},
      }),
    ).toEqual({ accessToken: "access", userId: "xai-user" });
    expect(() =>
      subscriptionCoreXaiBearer({
        credential: { accessToken: "access", refreshToken: null },
        providerAccountId: null,
        providerState: {},
      }),
    ).toThrow("no account identity");
  });
});
