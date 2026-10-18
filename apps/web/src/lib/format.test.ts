import { describe, expect, test } from "bun:test";

import { formatMoneyMicros, formatWaitingSince } from "./format";
import { formatBudget } from "./usage-allowances";

describe("dollar amounts", () => {
  test("show a plain $ even in locales that would write US$", () => {
    const Original = Intl.NumberFormat;
    function britishFormat(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
      return new Original("en-GB", options);
    }
    Intl.NumberFormat = britishFormat as unknown as typeof Intl.NumberFormat;
    try {
      expect(formatMoneyMicros(10_000_000, "usd")).toBe("$10.00");
      expect(formatBudget(500_000_000)).toBe("$500");
    } finally {
      Intl.NumberFormat = Original;
    }
  });
});

const NOW = new Date("2026-08-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatWaitingSince", () => {
  test("reads as a duration at every scale and never collapses to a date", () => {
    expect(formatWaitingSince(ago(0), NOW)).toBe("<1m");
    expect(formatWaitingSince(ago(59_000), NOW)).toBe("<1m");
    expect(formatWaitingSince(ago(5 * 60_000), NOW)).toBe("5m");
    expect(formatWaitingSince(ago(10 * 3_600_000 + 30 * 60_000), NOW)).toBe("10h");
    expect(formatWaitingSince(ago(47 * 3_600_000), NOW)).toBe("47h");
    expect(formatWaitingSince(ago(9 * 86_400_000), NOW)).toBe("9d");
    expect(formatWaitingSince(ago(30 * 86_400_000), NOW)).toBe("30d");
  });

  test("is empty for an unparseable timestamp and clamps future times", () => {
    expect(formatWaitingSince("not-a-date", NOW)).toBe("");
    expect(formatWaitingSince(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("<1m");
  });
});
