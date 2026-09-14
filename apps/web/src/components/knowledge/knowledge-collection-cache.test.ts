import { expect, mock, test, spyOn } from "bun:test";
import { COLLECTION_CACHE_TTL_MS, KnowledgeCollectionCache } from "./knowledge-collection-cache";

const page = { entries: [], nextCursor: null };

test("successful first pages are reused until their fixed expiry", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const cache = new KnowledgeCollectionCache();
    const fetchPage = mock(async () => page);
    await cache.load("collection", fetchPage);
    now.mockReturnValue(1_000 + COLLECTION_CACHE_TTL_MS - 1);
    expect(cache.peek("collection")).toBe(page);
    await cache.load("collection", fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000 + COLLECTION_CACHE_TTL_MS);
    expect(cache.peek("collection")).toBeUndefined();
    await cache.load("collection", fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});

test("concurrent expansions share the request and a failure remains retryable", async () => {
  const cache = new KnowledgeCollectionCache();
  let reject!: (error: Error) => void;
  const fetchPage = mock(() => new Promise<typeof page>((_resolve, fail) => (reject = fail)));
  const first = cache.load("collection", fetchPage);
  const second = cache.load("collection", fetchPage);
  expect(second).toBe(first);
  const result = Promise.allSettled([first, second]);
  await Promise.resolve();
  reject(new Error("temporarily unavailable"));
  expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(cache.peek("collection")).toBeUndefined();
  expect(await cache.load("collection", async () => page)).toBe(page);
});

test("cache size is bounded and separate authorization contexts never share rows", async () => {
  const cache = new KnowledgeCollectionCache();
  for (let index = 0; index < 65; index++) {
    await cache.load(String(index), async () => page);
  }
  expect(cache.peek("0")).toBeUndefined();
  expect(cache.peek("1")).toBe(page);
  expect(cache.peek("64")).toBe(page);
  expect(new KnowledgeCollectionCache().peek("64")).toBeUndefined();
});
