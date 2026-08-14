import { describe, expect, test } from "bun:test";

import { enumerateUtcDays, enumerateUtcHours } from "../src/insights";

describe("enumerateUtcDays", () => {
  test("buckets in UTC day keys exclusive of until", () => {
    const since = new Date("2026-07-01T12:00:00.000Z");
    const until = new Date("2026-07-03T00:00:00.000Z");
    expect(enumerateUtcDays(since, until)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  test("returns empty when until is not after since day start", () => {
    const since = new Date("2026-07-01T00:00:00.000Z");
    expect(enumerateUtcDays(since, since)).toEqual([]);
  });
});

describe("enumerateUtcHours", () => {
  test("buckets elapsed UTC hours exclusive of until", () => {
    const since = new Date("2026-07-01T00:00:00.000Z");
    const until = new Date("2026-07-01T03:45:00.000Z");
    expect(enumerateUtcHours(since, until)).toEqual([
      "2026-07-01T00:00",
      "2026-07-01T01:00",
      "2026-07-01T02:00",
      "2026-07-01T03:00",
    ]);
  });

  test("starts from the containing UTC hour", () => {
    const since = new Date("2026-07-01T01:30:00.000Z");
    const until = new Date("2026-07-01T02:00:00.000Z");
    expect(enumerateUtcHours(since, until)).toEqual(["2026-07-01T01:00"]);
  });
});
