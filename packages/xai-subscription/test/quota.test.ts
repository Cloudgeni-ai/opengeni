import { expect, test } from "bun:test";
import { fetchXaiSubscriptionQuota } from "../src/quota";
const token = { accessToken: "synthetic", userId: "synthetic" };
const context = { getToken: async () => token, refresh: async () => token };
async function quota(config: unknown) {
  return fetchXaiSubscriptionQuota({ context, fetch: async () => Response.json({ config }) });
}
test("unified reset omits zero usage without leaving the old quota cached", async () => {
  const config = {
    isUnifiedBillingUser: true,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" },
  };
  expect((await quota({ ...config, creditUsagePercent: 100 })).usedPercent).toBe(100);
  expect((await quota(config)).usedPercent).toBe(0);
});
test("missing, null and malformed quota are not zero", async () => {
  for (const config of [
    null,
    {},
    { creditUsagePercent: null },
    { creditUsagePercent: "bad" },
    { isUnifiedBillingUser: true },
  ]) {
    expect((await quota(config)).usedPercent).toBeNull();
  }
});
test("legacy and explicit percentages remain supported", async () => {
  expect((await quota({ monthlyLimit: { val: 100 }, used: { val: 25 } })).usedPercent).toBe(25);
  expect((await quota({ creditUsagePercent: 12.5 })).usedPercent).toBe(12.5);
});
