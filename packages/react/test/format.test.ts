import { describe, expect, test } from "bun:test";
import { formatRelativeTime, stringifyPayload, truncate, tryParseJson } from "../src/lib/format";

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-12T12:00:00Z");

  test("scales from now to days", () => {
    expect(formatRelativeTime("2026-06-12T11:59:55Z", now)).toBe("now");
    expect(formatRelativeTime("2026-06-12T11:59:20Z", now)).toBe("40s");
    expect(formatRelativeTime("2026-06-12T11:53:00Z", now)).toBe("7m");
    expect(formatRelativeTime("2026-06-12T09:00:00Z", now)).toBe("3h");
    expect(formatRelativeTime("2026-06-10T12:00:00Z", now)).toBe("2d");
  });

  test("handles invalid and future timestamps gracefully", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
    expect(formatRelativeTime("2026-06-12T12:30:00Z", now)).toBe("now");
  });
});

describe("truncate", () => {
  test("collapses whitespace and appends an ellipsis", () => {
    expect(truncate("deploy   the\nstaging cluster", 100)).toBe("deploy the staging cluster");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("stringifyPayload", () => {
  test("pretty-prints objects and embedded json strings, passes plain text through", () => {
    expect(stringifyPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(stringifyPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(stringifyPayload("plain output")).toBe("plain output");
    expect(stringifyPayload(null)).toBe("");
  });
});

describe("tryParseJson", () => {
  test("parses json and returns undefined otherwise", () => {
    expect(tryParseJson('{"x":1}')).toEqual({ x: 1 });
    expect(tryParseJson("[1,2]")).toEqual([1, 2]);
    expect(tryParseJson("nope")).toBeUndefined();
    expect(tryParseJson("{broken")).toBeUndefined();
  });
});
