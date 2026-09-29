import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RelativeTime,
  formatAbsoluteTime,
  formatDate,
  formatExactTime,
  formatRelativeTime,
  inSentence,
  timeZoneLabel,
} from "./relative-time";

/** Saturday 26 September 2026, 13:48 in Oslo (CEST, UTC+2). */
const NOW = new Date("2026-09-26T11:48:00Z");
const OSLO = { now: NOW, timeZone: "Europe/Oslo" } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function before(ms: number) {
  return new Date(NOW.getTime() - ms);
}

describe("formatRelativeTime", () => {
  test("uses the short past phrases the copy rules ask for", () => {
    expect(formatRelativeTime(before(20_000), OSLO)).toBe("Just now");
    expect(formatRelativeTime(before(59_999), OSLO)).toBe("Just now");
    expect(formatRelativeTime(before(MINUTE), OSLO)).toBe("1 min ago");
    expect(formatRelativeTime(before(48 * MINUTE), OSLO)).toBe("48 min ago");
    expect(formatRelativeTime(before(HOUR), OSLO)).toBe("1 hour ago");
    expect(formatRelativeTime(before(2 * HOUR + 10 * MINUTE), OSLO)).toBe("2 hours ago");
  });

  test("counts calendar days in the viewer's zone after the first day", () => {
    // Fri 25 Sep, 08:00 Oslo is more than 24 hours ago and on the previous day.
    expect(formatRelativeTime("2026-09-25T06:00:00Z", OSLO)).toBe("Yesterday");
    expect(formatRelativeTime("2026-09-23T09:12:00Z", OSLO)).toBe("3 days ago");
    expect(formatRelativeTime("2026-09-18T08:15:00Z", OSLO)).toBe("8 days ago");
    expect(formatRelativeTime("2026-09-12T11:05:00Z", OSLO)).toBe("2 weeks ago");
    expect(formatRelativeTime("2026-09-02T12:40:00Z", OSLO)).toBe("3 weeks ago");
    expect(formatRelativeTime("2026-08-26T07:45:00Z", OSLO)).toBe("1 month ago");
    expect(formatRelativeTime(before(400 * DAY), OSLO)).toBe("1 year ago");
  });

  test("reads future times forward", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 14 * MINUTE), OSLO)).toBe("In 14 min");
    expect(formatRelativeTime(new Date(NOW.getTime() + 3 * HOUR), OSLO)).toBe("In 3 hours");
    // Sun 27 Sep, 23:00 Oslo: more than a day away, on the next calendar day.
    expect(formatRelativeTime("2026-09-27T21:00:00Z", OSLO)).toBe("Tomorrow");
    expect(formatRelativeTime(new Date(NOW.getTime() + 5 * DAY), OSLO)).toBe("In 5 days");
  });

  test("the calendar day follows the time zone, not UTC", () => {
    // 23:30 UTC on 24 Sep is already 25 Sep in Tokyo but still 24 Sep in New York.
    const late = "2026-09-24T23:30:00Z";
    const now = new Date("2026-09-26T10:00:00Z");
    expect(formatRelativeTime(late, { now, timeZone: "Asia/Tokyo" })).toBe("Yesterday");
    expect(formatRelativeTime(late, { now, timeZone: "America/New_York" })).toBe("2 days ago");
  });
});

describe("formatAbsoluteTime", () => {
  test("one format: weekday, day, month and 24-hour time, never 'Sept' or seconds", () => {
    expect(formatAbsoluteTime("2026-09-28T06:00:00Z", OSLO)).toBe("Mon 28 Sep, 08:00");
    expect(formatAbsoluteTime("2026-10-01T07:00:00Z", OSLO)).toBe("Thu 1 Oct, 09:00");
  });

  test("names today, tomorrow and yesterday", () => {
    expect(formatAbsoluteTime("2026-09-26T12:00:00Z", OSLO)).toBe("Today, 14:00");
    expect(formatAbsoluteTime("2026-09-27T07:30:00Z", OSLO)).toBe("Tomorrow, 09:30");
    expect(formatAbsoluteTime("2026-09-25T15:30:00Z", OSLO)).toBe("Yesterday, 17:30");
  });

  test("adds the year only outside the current one", () => {
    expect(formatAbsoluteTime("2027-03-30T07:00:00Z", OSLO)).toBe("Tue 30 Mar 2027, 09:00");
  });

  test("the UTC variant computes and says UTC", () => {
    expect(formatAbsoluteTime("2026-09-23T09:12:00Z", { now: NOW, utc: true })).toBe(
      "Wed 23 Sep, 09:12 UTC",
    );
  });
});

describe("formatDate and formatExactTime", () => {
  test("dates drop the time and the current year", () => {
    expect(formatDate("2026-08-14T10:02:00Z", OSLO)).toBe("14 Aug");
    expect(formatDate("2027-03-31T10:00:00Z", OSLO)).toBe("31 Mar 2027");
  });

  test("the exact time always has the year and names the zone in words", () => {
    expect(formatExactTime("2026-09-23T09:12:00Z", OSLO)).toBe("Wed 23 Sep 2026, 11:12 Oslo time");
    expect(formatExactTime("2026-09-23T09:12:00Z", { utc: true })).toBe(
      "Wed 23 Sep 2026, 09:12 UTC",
    );
    expect(timeZoneLabel("America/Los_Angeles")).toBe("Los Angeles time");
    expect(timeZoneLabel("Etc/UTC")).toBe("UTC");
  });
});

describe("inSentence", () => {
  test("lowercases only the leading relative word", () => {
    expect(inSentence("Yesterday")).toBe("yesterday");
    expect(inSentence("Just now")).toBe("just now");
    expect(inSentence("In 5 days")).toBe("in 5 days");
    expect(inSentence("Today, 14:00")).toBe("today, 14:00");
    expect(inSentence("Mon 28 Sep, 08:00")).toBe("Mon 28 Sep, 08:00");
    expect(inSentence("3 days ago")).toBe("3 days ago");
  });
});

describe("RelativeTime", () => {
  test("renders a machine-readable time and a prefixed, sentence-cased label", () => {
    const html = renderToStaticMarkup(
      <RelativeTime date="2026-09-25T06:00:00Z" prefix="Updated" {...OSLO} />,
    );
    expect(html).toContain('dateTime="2026-09-25T06:00:00.000Z"');
    expect(html).toContain("Updated yesterday");
    expect(html).toContain('tabindex="0"');
  });

  test("renders nothing for an invalid date", () => {
    expect(renderToStaticMarkup(<RelativeTime date="not a date" {...OSLO} />)).toBe("");
  });

  test("without a tab stop, screen readers still get the exact time", () => {
    const html = renderToStaticMarkup(
      <RelativeTime date="2026-09-23T09:12:00Z" focusable={false} {...OSLO} />,
    );
    expect(html).not.toContain("tabindex");
    expect(html).toContain("Wed 23 Sep 2026, 11:12 Oslo time");
  });
});
