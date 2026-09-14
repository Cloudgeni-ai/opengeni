import { expect, test } from "bun:test";
import { createDiscoveryCache } from "../src/discovery-cache";

test("discovery cache deduplicates reads and isolates clients and query/workspace keys", async () => {
  const cache = createDiscoveryCache<number>();
  const client = {};
  let calls = 0;
  const fetch = async () => ++calls;
  expect(
    await Promise.all([
      cache.read(client, "workspace:query", fetch),
      cache.read(client, "workspace:query", fetch),
    ]),
  ).toEqual([1, 1]);
  expect(cache.peek(client, "workspace:query")).toBe(1);
  expect(await cache.read({}, "workspace:query", fetch)).toBe(2);
  expect(await cache.read(client, "another:query", fetch)).toBe(3);
});

test("discovery cache expires, bounds entries, and does not cache failures", async () => {
  const cache = createDiscoveryCache<number>(20, 2);
  const client = {};
  await cache.read(client, "a", async () => 1);
  await cache.read(client, "b", async () => 2);
  await cache.read(client, "c", async () => 3);
  expect(cache.peek(client, "a")).toBeUndefined();
  await Bun.sleep(30);
  expect(cache.peek(client, "b")).toBeUndefined();
  expect(await cache.read(client, "b", async () => 4)).toBe(4);
  await expect(
    cache.read(client, "failed", async () => {
      throw Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(await cache.read(client, "failed", async () => 5)).toBe(5);
});
