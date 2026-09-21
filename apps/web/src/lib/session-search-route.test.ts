import { describe, expect, test } from "bun:test";
import { parseSessionSearchRoute } from "./session-search-route";

describe("session search route", () => {
  test("preserves literal text and exact safe target", () => {
    expect(
      parseSessionSearchRoute({ find: " PR_100% ", matchSequence: "42", matchOffset: "0" }),
    ).toEqual({ find: " PR_100% ", matchSequence: 42, matchOffset: 0 });
  });

  test("rejects absent, empty, and oversized queries", () => {
    for (const find of [undefined, null, true, "", "  ", "x".repeat(201)]) {
      expect(parseSessionSearchRoute({ find, matchSequence: 42 })).toEqual({});
    }
  });

  test("drops malformed targets without losing a valid query", () => {
    for (const matchSequence of [
      0,
      -1,
      1.5,
      true,
      "",
      "1e2",
      "42junk",
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(parseSessionSearchRoute({ find: "test", matchSequence, matchOffset: 2 })).toEqual({
        find: "test",
      });
    }
    expect(parseSessionSearchRoute({ find: "test", matchSequence: 1, matchOffset: -1 })).toEqual({
      find: "test",
      matchSequence: 1,
    });
  });
});
