import { expect, test } from "bun:test";
import {
  resolveSessionFindMove,
  settledCount,
  settledFrom,
  type SessionFindMatch,
} from "./use-session-find";

const at = (sequence: number, offset = 0): SessionFindMatch => ({
  sequence,
  eventId: `event-${sequence}`,
  offset,
});

test("the oldest message reached is unsettled until the traversal moves past it", () => {
  // Newest-first pages reached message 3 and may not have all of its matches.
  const progress = { matches: [at(3, 0), at(3, 9), at(5), at(8)], exhausted: false, total: 4 };
  expect(settledFrom(progress)).toBe(2);
  expect(settledCount(progress)).toBe(2);
  expect(settledFrom({ ...progress, exhausted: true })).toBe(0);
  expect(settledCount({ matches: [at(3), at(3, 4)], exhausted: false, total: 2 })).toBe(0);
});

test("moves step through settled matches and ask for what is still unknown", () => {
  const progress = { matches: [at(3, 0), at(3, 9), at(5), at(8)], exhausted: false, total: 4 };
  expect(resolveSessionFindMove(progress, at(8), -1)).toEqual(at(5));
  expect(resolveSessionFindMove(progress, at(5), 1)).toEqual(at(8));
  // Older than message 5 is message 3, which may still gain later occurrences.
  expect(resolveSessionFindMove(progress, at(5), -1)).toBe("more");
  // Next from the newest wraps to the oldest match, asked for on its own.
  expect(resolveSessionFindMove(progress, at(8), 1)).toBe("first");
  const withFirst = { ...progress, first: at(1, 2) };
  expect(resolveSessionFindMove(withFirst, at(8), 1)).toEqual(at(1, 2));
  // Previous from the oldest wraps back to the newest settled match.
  expect(resolveSessionFindMove(withFirst, at(1, 2), -1)).toEqual(at(8));
  // Next from the oldest needs the history between it and what was reached.
  expect(resolveSessionFindMove(withFirst, at(1, 2), 1)).toBe("more");
  // A linked occurrence older than anything reached waits for older pages.
  expect(resolveSessionFindMove(progress, at(2), 1)).toBe("more");
  expect(resolveSessionFindMove({ matches: [], exhausted: false, total: 0 }, at(2), -1)).toBe(
    "more",
  );
});

test("an exhausted traversal wraps at both ends", () => {
  const progress = { matches: [at(3, 0), at(3, 9), at(5), at(8)], exhausted: true, total: 4 };
  expect(resolveSessionFindMove(progress, at(3, 0), -1)).toEqual(at(8));
  expect(resolveSessionFindMove(progress, at(8), 1)).toEqual(at(3, 0));
  expect(resolveSessionFindMove(progress, at(5), -1)).toEqual(at(3, 9));
  expect(resolveSessionFindMove(progress, at(3, 9), 1)).toEqual(at(5));
  expect(resolveSessionFindMove({ matches: [], exhausted: true, total: 0 }, at(1), 1)).toBeNull();
});
