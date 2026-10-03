import { expect, test } from "bun:test";
import {
  createInsightsCredentialPartition,
  createInsightsResponseCache,
  insightsWithFriendlyTimeout,
} from "../src/routes/insights-response-cache";

test("response cache is bounded, fixed-TTL, isolated and fence-invalidated", () => {
  let now = 0;
  const cache = createInsightsResponseCache(() => now);
  cache.put("scope-query-actor-key", "visibility1", {
    generatedAt: "original",
    dataThrough: "source",
    amount: 7,
  });
  const hit = cache.get<any>("scope-query-actor-key", "visibility1")!;
  hit.amount = 99;
  expect(cache.get<any>("scope-query-actor-key", "visibility1")!.amount).toBe(7);
  expect(cache.get("different-principal", "visibility1")).toBeNull();
  now = 59_999;
  expect(cache.get("scope-query-actor-key", "visibility1")).toMatchObject({
    generatedAt: "original",
    dataThrough: "source",
  });
  now = 60_000;
  expect(cache.get("scope-query-actor-key", "visibility1")).toBeNull();
  cache.put("key", "v1", { amount: 7 });
  expect(cache.get("key", "v2")).toBeNull();
  for (let n = 0; n < 500; n++) cache.put(String(n), "v", { n });
  expect(cache.size).toBe(128);
  cache.put("oversize", "v", "x".repeat(1024 * 1024));
  expect(cache.get("oversize", "v")).toBeNull();
});

test("credential partitions retain only a keyed digest, never raw bearer/cookie values", () => {
  const partition = createInsightsCredentialPartition();
  const key = partition("Bearer synthetic-secret", "synthetic-cookie");
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toContain("secret");
  expect(partition("Bearer synthetic-secret", "synthetic-cookie")).toBe(key);
  expect(partition("Bearer other-key", "synthetic-cookie")).not.toBe(key);
  expect(
    createInsightsCredentialPartition()("Bearer synthetic-secret", "synthetic-cookie"),
  ).not.toBe(key);
});

test("statement cancellation maps to a bounded friendly error without SQL or secrets", async () => {
  await expect(
    insightsWithFriendlyTimeout(async () => {
      throw { cause: { code: "57014", message: "private SQL parameters" } };
    }),
  ).rejects.toMatchObject({ status: 408, message: "Range too large, try 7 days." });
  await expect(
    insightsWithFriendlyTimeout(async () => {
      throw new Error("unrelated failure");
    }),
  ).rejects.toThrow("unrelated failure");
  expect(await insightsWithFriendlyTimeout(async () => 7)).toBe(7);
});
