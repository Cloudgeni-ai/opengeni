import { expect, test } from "bun:test";
import {
  emptyClaudeUsage,
  mergeClaudeUsage,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
} from "../src/claude-subscription-usage";

const now = new Date("2026-09-30T14:00:00Z");
test("captured quota headers normalize the 5-hour and weekly windows independently", () => {
  const observation = parseClaudeUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-5h-reset": "1790785200",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-7d-reset": "1791064800",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
    }),
    now,
  )!;
  expect(observation.windows).toEqual([
    {
      id: "five_hour",
      usedPercent: 100,
      resetsAt: "2026-09-30T16:20:00.000Z",
      status: "rejected",
      observedAt: now.toISOString(),
    },
    {
      id: "seven_day",
      usedPercent: 50,
      resetsAt: "2026-10-03T22:00:00.000Z",
      status: "allowed",
      observedAt: now.toISOString(),
    },
  ]);
});
test("missing, malformed and nonfinite utilization is unknown, including an empty header", () => {
  for (const value of ["", " ", "NaN", "Infinity", "-1", "garbage"])
    expect(
      parseClaudeUsageHeaders(
        new Headers({ "anthropic-ratelimit-unified-5h-utilization": value }),
        now,
      ),
    ).toBeNull();
  expect(
    parseClaudeUsageHeaders(
      new Headers({ "anthropic-ratelimit-unified-5h-surpassed-threshold": "1.0" }),
      now,
    ),
  ).toBeNull();
  expect(parseClaudeUsageHeaders(new Headers(), now)).toBeNull();
});
test("zero is a reported value, percentages above 100 remain exact and unknown windows are ignored", () => {
  expect(
    parseClaudeUsageHeaders(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0" }), now)
      ?.windows[0]?.usedPercent,
  ).toBe(0);
  expect(
    parseClaudeUsageHeaders(
      new Headers({ "anthropic-ratelimit-unified-7d-opus-utilization": "1.2" }),
      now,
    )?.windows[0]?.usedPercent,
  ).toBe(120);
  expect(
    parseClaudeUsageHeaders(
      new Headers({ "anthropic-ratelimit-unified-unknown-utilization": "1" }),
      now,
    ),
  ).toBeNull();
});
test("provider endpoint percentages use different units from headers and accept offset timestamps", () => {
  const observation = parseClaudeUsageResponse(
    {
      five_hour: null,
      seven_day: { utilization: 50, resets_at: "2026-10-04T00:00:00+02:00" },
      seven_day_opus: { utilization: 0, resets_at: null },
    },
    now,
  )!;
  expect(
    observation.windows.map((window) => [window.id, window.usedPercent, window.resetsAt]),
  ).toEqual([
    ["seven_day", 50, "2026-10-03T22:00:00.000Z"],
    ["seven_day_opus", 0, null],
  ]);
  for (const value of [null, [], {}, { five_hour: { utilization: NaN, resets_at: "invalid" } }])
    expect(parseClaudeUsageResponse(value, now)).toBeNull();
});
test("merging partial and out-of-order observations preserves each window's newest value", () => {
  const first = parseClaudeUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": ".2",
      "anthropic-ratelimit-unified-7d-utilization": ".5",
    }),
    now,
  )!;
  const later = parseClaudeUsageHeaders(
    new Headers({ "anthropic-ratelimit-unified-5h-utilization": ".3" }),
    new Date(now.getTime() + 1000),
  )!;
  const current = mergeClaudeUsage(mergeClaudeUsage(emptyClaudeUsage(1), first), later);
  expect(current.windows.map((window) => window.usedPercent)).toEqual([30, 50]);
  expect(mergeClaudeUsage(current, first)).toEqual(current);
});
