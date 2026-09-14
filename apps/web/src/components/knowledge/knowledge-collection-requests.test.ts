import { expect, mock, test } from "bun:test";
import { KnowledgeCollectionRequests } from "./knowledge-collection-requests";

const page = { entries: [], nextCursor: null };

test("settled first pages are never reused", async () => {
  const requests = new KnowledgeCollectionRequests();
  const fetchPage = mock(async () => page);
  await requests.load("collection", fetchPage);
  await requests.load("collection", fetchPage);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

test("concurrent expansions share the request and a failure remains retryable", async () => {
  const requests = new KnowledgeCollectionRequests();
  let reject!: (error: Error) => void;
  const fetchPage = mock(() => new Promise<typeof page>((_resolve, fail) => (reject = fail)));
  const first = requests.load("collection", fetchPage);
  const second = requests.load("collection", fetchPage);
  expect(second).toBe(first);
  const result = Promise.allSettled([first, second]);
  await Promise.resolve();
  reject(new Error("temporarily unavailable"));
  expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(await requests.load("collection", async () => page)).toBe(page);
});

test("different request keys and authorization contexts never share pending reads", async () => {
  let resolve!: (result: typeof page) => void;
  const held = new Promise<typeof page>((done) => (resolve = done));
  const fetchPage = mock(() => held);
  const requests = new KnowledgeCollectionRequests();
  const first = requests.load("collection", fetchPage);
  const otherKey = requests.load("other", fetchPage);
  const otherContext = new KnowledgeCollectionRequests().load("collection", fetchPage);
  expect(otherKey).not.toBe(first);
  expect(otherContext).not.toBe(first);
  await Promise.resolve();
  expect(fetchPage).toHaveBeenCalledTimes(3);
  resolve(page);
  await Promise.all([first, otherKey, otherContext]);
});
