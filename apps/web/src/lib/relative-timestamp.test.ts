import { describe, expect, test } from "bun:test";

import { relativePastTimestamp, relativeTimestamp } from "./relative-timestamp";

const now = Date.parse("2026-09-27T12:00:00.000Z");

describe("relativePastTimestamp", () => {
  test("says just now for a check that happened moments ago, even past a stale clock", () => {
    expect(relativePastTimestamp("2026-09-27T11:59:50.000Z", now)).toBe("just now");
    // The ticking `now` can lag a fresh fetch by up to 30s.
    expect(relativePastTimestamp("2026-09-27T12:00:20.000Z", now)).toBe("just now");
  });

  test("falls back to elapsed time once a minute has passed", () => {
    expect(relativePastTimestamp("2026-09-27T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativePastTimestamp("2026-09-27T09:00:00.000Z", now)).toBe("3h ago");
  });

  test("future times keep their direction", () => {
    expect(relativeTimestamp("2026-09-27T12:10:00.000Z", now)).toBe("in 10m");
  });
});
