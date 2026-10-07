import { expect, test } from "bun:test";
import { collectIdPages, planIdBatches, summarizeIdBatches } from "../src/pagination";
test("collection freezes exact distinct IDs before a chunk plan can exist", async () => {
  const calls: (string | undefined)[] = [];
  const ids = await collectIdPages(async (token) => {
    calls.push(token);
    return token ? { ids: ["two", "three"] } : { ids: ["one", "two"], nextPageToken: "next" };
  });
  expect(calls).toEqual([undefined, "next"]);
  expect(ids).toEqual(["one", "two", "three"]);
  expect(Object.isFrozen(ids)).toBe(true);
});
test("repeated tokens, empty continuation pages, caps and cancellation never return partial intent", async () => {
  await expect(
    collectIdPages(async () => ({ ids: ["one"], nextPageToken: "loop" })),
  ).rejects.toThrow("did not progress");
  await expect(collectIdPages(async () => ({ ids: [], nextPageToken: "next" }))).rejects.toThrow(
    "did not progress",
  );
  await expect(
    collectIdPages(async () => ({ ids: ["one", "two"] }), { maxItems: 1 }),
  ).rejects.toThrow("item limit");
  await expect(
    collectIdPages(async () => ({ ids: ["one"], nextPageToken: "next" }), { maxPages: 1 }),
  ).rejects.toThrow("page limit");
  const controller = new AbortController();
  let calls = 0;
  controller.abort();
  await expect(
    collectIdPages(
      async () => {
        calls++;
        return { ids: [] };
      },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  const during = new AbortController();
  await expect(
    collectIdPages(
      async () => {
        during.abort();
        return { ids: ["one"] };
      },
      { signal: during.signal },
    ),
  ).rejects.toThrow();
});
test("10001 IDs are bounded distinct immutable batches; receipt truth never implies per-item success", () => {
  const input = Array.from({ length: 10001 }, (_, index) => `synthetic-${index}`);
  const plan = planIdBatches([...input, input[0]!]);
  expect(plan.count).toBe(10001);
  expect(plan.batches).toHaveLength(11);
  expect(plan.batches.every((batch) => batch.ids.length <= 1000)).toBe(true);
  expect(new Set(plan.batches.flatMap((batch) => batch.ids)).size).toBe(10001);
  expect(Object.isFrozen(plan.batches[0]!.ids)).toBe(true);
  const receipts = ["acknowledged", "failed_before_effect", "unknown", "waiting"].map(
    (outcome, index) => ({
      operationId: plan.batches[index]!.operationId,
      outcome: outcome as "acknowledged" | "failed_before_effect" | "unknown" | "waiting",
    }),
  );
  expect(summarizeIdBatches(plan, receipts)).toEqual({
    selected: 10001,
    acknowledged: 1000,
    failed_before_effect: 1000,
    unknown: 1000,
    waiting: 1000,
    unstarted: 6001,
    individualStateVerified: false,
  });
  expect(() => summarizeIdBatches(plan, [receipts[0]!, receipts[0]!])).toThrow();
});
