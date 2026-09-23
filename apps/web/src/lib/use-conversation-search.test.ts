import { expect, test } from "bun:test";
import {
  readConversationSearchBatch,
  type ConversationSearchPage,
} from "./use-conversation-search";

function page(overrides: Partial<ConversationSearchPage> = {}): ConversationSearchPage {
  return {
    matches: [],
    nextCursor: null,
    hasMore: false,
    scannedMessages: 0,
    matchedMessageCount: 0,
    matchedOccurrenceCount: 0,
    countIsExact: true,
    ...overrides,
  };
}

test("empty advancing pages do not masquerade as no matches", async () => {
  const cursors: Array<string | undefined> = [];
  const progress: number[] = [];
  const result = await readConversationSearchBatch(
    async (cursor) => {
      cursors.push(cursor);
      return cursor
        ? page({ scannedMessages: 64 })
        : page({
            nextCursor: "continued",
            hasMore: true,
            scannedMessages: 32,
            countIsExact: false,
          });
    },
    undefined,
    new AbortController().signal,
    (count) => progress.push(count),
  );
  expect(cursors).toEqual([undefined, "continued"]);
  expect(progress).toEqual([32, 64]);
  expect(result.countIsExact).toBe(true);
});

test("a full batch stays bounded and preserves the continuation cursor", async () => {
  let requests = 0;
  const match = {
    sessionId: "s",
    sessionTitle: "title",
    eventId: "event",
    sequence: 1,
    turnId: null,
    role: "user" as const,
    messageId: null,
    messageMatchOffset: 0,
    snippet: { text: "test", matchStart: 0, matchEnd: 4 },
  };
  const result = await readConversationSearchBatch(
    async (_cursor, remaining) => {
      requests++;
      expect(remaining).toBe(50);
      return page({
        matches: Array.from({ length: 50 }, (_, index) => ({
          ...match,
          messageMatchOffset: index * 5,
        })),
        nextCursor: "later",
        hasMore: true,
        matchedOccurrenceCount: 50,
        countIsExact: false,
      });
    },
    undefined,
    new AbortController().signal,
    () => {},
  );
  expect(requests).toBe(1);
  expect(result.matches).toHaveLength(50);
  expect(result.nextCursor).toBe("later");
});

test("cancellation stops traversal and broken cursors fail visibly", async () => {
  const controller = new AbortController();
  await expect(
    readConversationSearchBatch(
      async () => {
        controller.abort();
        return page({ hasMore: true, nextCursor: "next" });
      },
      undefined,
      controller.signal,
      () => {},
    ),
  ).rejects.toThrow();
  await expect(
    readConversationSearchBatch(
      async () => page({ hasMore: true, nextCursor: "same" }),
      "same",
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("Search did not advance");
});

test("in-chat search exposes the first matches without scanning the rest of history", async () => {
  let requests = 0;
  const progress: ConversationSearchPage[] = [];
  const result = await readConversationSearchBatch(
    async () => {
      requests++;
      return page({
        matches: [
          {
            sessionId: "s",
            sessionTitle: "title",
            eventId: "event",
            sequence: 1,
            turnId: null,
            role: "user",
            messageId: null,
            messageMatchOffset: 0,
            snippet: { text: "needle", matchStart: 0, matchEnd: 6 },
          },
        ],
        nextCursor: "remaining-history",
        hasMore: true,
        matchedOccurrenceCount: 1,
        countIsExact: false,
      });
    },
    undefined,
    new AbortController().signal,
    (_count, partial) => progress.push(partial),
    true,
  );
  expect(requests).toBe(1);
  expect(progress[0]?.matches).toHaveLength(1);
  expect(result.matches).toHaveLength(1);
  expect(result.nextCursor).toBe("remaining-history");
  expect(result.countIsExact).toBe(false);
});
