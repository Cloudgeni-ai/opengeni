import { describe, expect, test } from "bun:test";
import { insightsUsageWindow } from "../src/domain/insights-usage";

describe("unified Insights UTC windows", () => {
  test("keeps exact minute-level boundaries and all six ranges", () => {
    const now = new Date("2026-10-03T10:42:17.123Z");
    const starts = {
      today: "2026-10-03T00:00:00.000Z",
      week: "2026-09-27T00:00:00.000Z",
      month: "2026-10-01T00:00:00.000Z",
      "30d": "2026-09-04T00:00:00.000Z",
      "90d": "2026-07-06T00:00:00.000Z",
      ytd: "2026-01-01T00:00:00.000Z",
    } as const;
    for (const range of Object.keys(starts) as Array<keyof typeof starts>) {
      const window = insightsUsageWindow(range, now);
      expect(window.since.toISOString()).toBe(starts[range]);
      expect(window.until.toISOString()).toBe(now.toISOString());
      expect(window.priorUntil.toISOString()).toBe(starts[range]);
      expect(window.until.getTime() - window.since.getTime()).toBe(
        window.priorUntil.getTime() - window.priorSince.getTime(),
      );
      expect(window.bucket).toBe(range === "today" ? "hour" : "day");
    }
    expect(now.toISOString()).toBe("2026-10-03T10:42:17.123Z");
  });

  test("does not invent usage in empty UTC midnight, month or year windows", () => {
    for (const range of ["today", "month", "ytd"] as const) {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const window = insightsUsageWindow(range, now);
      for (const field of ["since", "until", "priorSince", "priorUntil"] as const) {
        expect(window[field].toISOString()).toBe(now.toISOString());
      }
    }
  });

  test("uses UTC calendar days across leap days and DST transitions", () => {
    const leap = insightsUsageWindow("week", new Date("2024-03-01T12:00:00.000Z"));
    expect(leap.since.toISOString()).toBe("2024-02-24T00:00:00.000Z");
    expect(leap.until.getTime() - leap.since.getTime()).toBe(6.5 * 86_400_000);
    for (const now of ["2026-03-08T12:00:00.000Z", "2026-11-01T12:00:00.000Z"]) {
      const window = insightsUsageWindow("week", new Date(now));
      expect(window.until.getTime() - window.since.getTime()).toBe(6.5 * 86_400_000);
    }
  });

  test("rejects an invalid timestamp", () => {
    expect(() => insightsUsageWindow("today", new Date(Number.NaN))).toThrow(
      "Invalid Insights request time",
    );
  });
});
