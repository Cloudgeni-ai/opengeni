import { describe, expect, test } from "bun:test";

import {
  cadenceFromScheduleSpec,
  describeCadence,
  describeNextRuns,
  formatRunTime,
  nextRuns,
  normalizeCadenceRule,
  normalizeTime,
  parseCadence,
  stepTime,
  toScheduleSpec,
  validateCadence,
  zonedTimeToUtc,
  type CadenceRule,
} from "./cadence-picker";

/** Saturday 26 September 2026, 13:48 in Oslo (CEST, UTC+2). */
const NOW = new Date("2026-09-26T11:48:00Z");
const OSLO = { timeZone: "Europe/Oslo", now: NOW };

function runLabels(rule: CadenceRule, count = 3, options = OSLO): string[] {
  return nextRuns(rule, { ...options, count }).map((run) => formatRunTime(run, options));
}

describe("describeCadence", () => {
  test("reads each frequency as a sentence and a short row label", () => {
    const cases: Array<[CadenceRule, string, string]> = [
      [{ frequency: "hourly" }, "Runs every hour", "Every hour"],
      [
        { frequency: "daily", time: "07:15" },
        "Runs every day at 07:15 Oslo time",
        "Every day at 07:15 · Oslo",
      ],
      [
        { frequency: "weekdays", time: "08:00" },
        "Runs every weekday at 08:00 Oslo time",
        "Every weekday at 08:00 · Oslo",
      ],
      [
        { frequency: "weekly", days: ["mon"], time: "09:30" },
        "Runs every Monday at 09:30 Oslo time",
        "Every week on Mon at 09:30 · Oslo",
      ],
      [
        { frequency: "weekly", days: ["thu", "mon"], time: "09:30" },
        "Runs every Monday and Thursday at 09:30 Oslo time",
        "Every week on Mon and Thu at 09:30 · Oslo",
      ],
      [
        { frequency: "weekly", days: ["fri", "mon", "wed"], time: "09:30" },
        "Runs every Monday, Wednesday and Friday at 09:30 Oslo time",
        "Every week on Mon, Wed, Fri at 09:30 · Oslo",
      ],
      [
        { frequency: "monthly", dayOfMonth: 1, time: "09:00" },
        "Runs every month on day 1 at 09:00 Oslo time",
        "Every month on day 1 at 09:00 · Oslo",
      ],
      [
        { frequency: "interval", every: 30, unit: "minutes" },
        "Runs every 30 minutes",
        "Every 30 minutes",
      ],
      [
        { frequency: "interval", every: 2, unit: "days", time: "08:00" },
        "Runs every 2 days at 08:00 Oslo time",
        "Every 2 days at 08:00 · Oslo",
      ],
      [
        { frequency: "once", date: "2026-10-02", time: "15:00" },
        "Runs once on Fri 2 Oct at 15:00 Oslo time",
        "Once on Fri 2 Oct, 15:00 · Oslo",
      ],
    ];
    for (const [rule, sentence, short] of cases) {
      expect(describeCadence(rule, OSLO)).toEqual({ sentence, short });
    }
  });

  test("a week of Monday to Friday reads as weekdays, all seven as every day", () => {
    const workweek = describeCadence(
      { frequency: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00" },
      OSLO,
    );
    expect(workweek.sentence).toBe("Runs every weekday at 08:00 Oslo time");
    const everyDay = describeCadence(
      {
        frequency: "weekly",
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        time: "08:00",
      },
      OSLO,
    );
    expect(everyDay.sentence).toBe("Runs every day at 08:00 Oslo time");
  });

  test("uses the supplied zone label, and plain UTC", () => {
    const rule: CadenceRule = { frequency: "daily", time: "06:00" };
    expect(
      describeCadence(rule, { timeZone: "Asia/Kolkata", timeZoneLabel: "India time" }).sentence,
    ).toBe("Runs every day at 06:00 India time");
    expect(describeCadence(rule, { timeZone: "UTC" }).sentence).toBe("Runs every day at 06:00 UTC");
    expect(describeCadence(rule, { timeZone: "America/New_York" }).short).toBe(
      "Every day at 06:00 · New York",
    );
  });
});

describe("nextRuns", () => {
  test("every weekday skips the weekend", () => {
    expect(runLabels({ frequency: "weekdays", time: "08:00" })).toEqual([
      "Mon 28 Sep, 08:00",
      "Tue 29 Sep, 08:00",
      "Wed 30 Sep, 08:00",
    ]);
  });

  test("a daily time later today runs today", () => {
    expect(runLabels({ frequency: "daily", time: "14:30" }, 2)).toEqual([
      "Today, 14:30",
      "Tomorrow, 14:30",
    ]);
    expect(runLabels({ frequency: "daily", time: "13:48" }, 1)).toEqual(["Tomorrow, 13:48"]);
  });

  test("every hour runs on the hour", () => {
    expect(runLabels({ frequency: "hourly" })).toEqual([
      "Today, 14:00",
      "Today, 15:00",
      "Today, 16:00",
    ]);
  });

  test("weekly on chosen days", () => {
    expect(runLabels({ frequency: "weekly", days: ["thu", "mon"], time: "09:30" }, 4)).toEqual([
      "Mon 28 Sep, 09:30",
      "Thu 1 Oct, 09:30",
      "Mon 5 Oct, 09:30",
      "Thu 8 Oct, 09:30",
    ]);
  });

  test("monthly is a true calendar day, not 30 days", () => {
    expect(runLabels({ frequency: "monthly", dayOfMonth: 1, time: "09:00" })).toEqual([
      "Thu 1 Oct, 09:00",
      "Sun 1 Nov, 09:00",
      "Tue 1 Dec, 09:00",
    ]);
  });

  test("monthly on day 31 skips shorter months and crosses the year", () => {
    expect(runLabels({ frequency: "monthly", dayOfMonth: 31, time: "09:00" })).toEqual([
      "Sat 31 Oct, 09:00",
      "Thu 31 Dec, 09:00",
      "Sun 31 Jan 2027, 09:00",
    ]);
  });

  test("keeps the wall-clock time across the end of summer time", () => {
    const runs = nextRuns(
      { frequency: "daily", time: "08:00" },
      { timeZone: "Europe/Oslo", now: new Date("2026-10-24T12:00:00Z"), count: 2 },
    );
    // Clocks go back at 03:00 on 25 Oct, so 08:00 that morning is CET (UTC+1).
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-10-25T07:00:00.000Z",
      "2026-10-26T07:00:00.000Z",
    ]);
  });

  test("minute intervals align to the clock like the API does", () => {
    expect(runLabels({ frequency: "interval", every: 30, unit: "minutes" })).toEqual([
      "Today, 14:00",
      "Today, 14:30",
      "Today, 15:00",
    ]);
  });

  test("day intervals start at the chosen time and honour a stored anchor", () => {
    expect(runLabels({ frequency: "interval", every: 2, unit: "days", time: "08:00" })).toEqual([
      "Tomorrow, 08:00",
      "Tue 29 Sep, 08:00",
      "Thu 1 Oct, 08:00",
    ]);
    expect(
      runLabels({
        frequency: "interval",
        every: 3,
        unit: "days",
        startAt: "2026-09-20T06:00:00Z",
      }),
    ).toEqual(["Tue 29 Sep, 08:00", "Fri 2 Oct, 08:00", "Mon 5 Oct, 08:00"]);
  });

  test("one time runs once, and not at all once it has passed", () => {
    expect(runLabels({ frequency: "once", date: "2026-10-02", time: "15:00" })).toEqual([
      "Fri 2 Oct, 15:00",
    ]);
    expect(runLabels({ frequency: "once", date: "2026-09-25", time: "08:00" })).toEqual([]);
  });

  test("computes in the schedule's zone, not the viewer's", () => {
    const tokyo = { timeZone: "Asia/Tokyo", now: NOW };
    // 13:48 in Oslo is 20:48 in Tokyo, so 08:00 Tokyo is Monday morning there.
    expect(runLabels({ frequency: "weekdays", time: "08:00" }, 1, tokyo)).toEqual([
      "Mon 28 Sep, 08:00",
    ]);
    expect(
      nextRuns({ frequency: "weekdays", time: "08:00" }, { ...tokyo, count: 1 })[0]?.toISOString(),
    ).toBe("2026-09-27T23:00:00.000Z");
  });

  test("an invalid rule has no runs", () => {
    expect(nextRuns({ frequency: "weekly", days: [], time: "08:00" }, OSLO)).toEqual([]);
  });
});

describe("describeNextRuns", () => {
  test("drops the repeated time and joins with then", () => {
    const runs = nextRuns({ frequency: "weekdays", time: "08:00" }, OSLO);
    expect(describeNextRuns(runs, OSLO)).toBe("Mon 28 Sep, 08:00, then Tue 29 Sep and Wed 30 Sep");
  });

  test("runs on the same day show only their time", () => {
    const runs = nextRuns({ frequency: "hourly" }, OSLO);
    expect(describeNextRuns(runs, OSLO)).toBe("Today, 14:00, then 15:00 and 16:00");
  });

  test("a single run is just its time", () => {
    const runs = nextRuns({ frequency: "once", date: "2026-10-02", time: "15:00" }, OSLO);
    expect(describeNextRuns(runs, OSLO)).toBe("Fri 2 Oct, 15:00");
  });
});

describe("validateCadence", () => {
  test("says what to fix", () => {
    expect(validateCadence({ frequency: "weekly", days: [], time: "08:00" }, OSLO)).toEqual({
      field: "days",
      message: "Pick at least one day.",
    });
    expect(validateCadence({ frequency: "daily", time: "25:00" }, OSLO)?.message).toBe(
      "Enter a time like 08:00.",
    );
    expect(
      validateCadence({ frequency: "monthly", dayOfMonth: 32, time: "09:00" }, OSLO)?.field,
    ).toBe("dayOfMonth");
    expect(
      validateCadence({ frequency: "interval", every: 0, unit: "minutes" }, OSLO)?.message,
    ).toBe("Enter a whole number from 1 to 1440.");
  });

  test("a one-time run in the past names the time that passed", () => {
    expect(
      validateCadence({ frequency: "once", date: "2026-09-25", time: "08:00" }, OSLO)?.message,
    ).toBe("Fri 25 Sep, 08:00 has already passed. Pick a later time.");
    expect(
      validateCadence({ frequency: "once", date: "2026-09-26", time: "09:00" }, OSLO)?.message,
    ).toBe("Today, 09:00 has already passed. Pick a later time.");
  });
});

describe("API schedule spec", () => {
  test("maps each rule to the spec the API stores", () => {
    expect(toScheduleSpec({ frequency: "hourly" }, OSLO)).toEqual({
      type: "interval",
      everySeconds: 3600,
    });
    expect(toScheduleSpec({ frequency: "weekdays", time: "08:00" }, OSLO)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 8,
      minute: 0,
      daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    });
    expect(toScheduleSpec({ frequency: "daily", time: "07:45" }, OSLO)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 7,
      minute: 45,
    });
    expect(toScheduleSpec({ frequency: "monthly", dayOfMonth: 1, time: "09:00" }, OSLO)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 0,
      daysOfMonth: [1],
    });
    expect(
      toScheduleSpec({ frequency: "interval", every: 2, unit: "days", time: "08:00" }, OSLO),
    ).toEqual({
      type: "interval",
      everySeconds: 172_800,
      startAt: "2026-09-27T06:00:00.000Z",
    });
    expect(toScheduleSpec({ frequency: "once", date: "2026-10-02", time: "15:00" }, OSLO)).toEqual({
      type: "once",
      runAt: "2026-10-02T13:00:00.000Z",
      timeZone: "Europe/Oslo",
    });
  });

  test("round-trips through the spec", () => {
    const rules: CadenceRule[] = [
      { frequency: "hourly" },
      { frequency: "daily", time: "07:45" },
      { frequency: "weekdays", time: "08:00" },
      { frequency: "weekly", days: ["mon", "thu"], time: "09:30" },
      { frequency: "monthly", dayOfMonth: 15, time: "10:00" },
      { frequency: "interval", every: 30, unit: "minutes" },
      { frequency: "interval", every: 6, unit: "hours" },
      { frequency: "once", date: "2026-10-02", time: "15:00" },
    ];
    for (const rule of rules) {
      const back = cadenceFromScheduleSpec(toScheduleSpec(rule, OSLO), "Europe/Oslo");
      expect(back).toEqual({ timeZone: "Europe/Oslo", rule });
    }
  });

  test("a 30-day interval edits as days, never as 43200 minutes", () => {
    expect(
      cadenceFromScheduleSpec({ type: "interval", everySeconds: 2_592_000 }, "Europe/Oslo").rule,
    ).toEqual({
      frequency: "interval",
      every: 30,
      unit: "days",
    });
  });
});

describe("parseCadence", () => {
  const parse = (text: string) => parseCadence(text, OSLO);

  test("reads everyday phrasing", () => {
    const cases: Array<[string, CadenceRule]> = [
      ["every weekday at 8", { frequency: "weekdays", time: "08:00" }],
      ["Weekdays at 8am", { frequency: "weekdays", time: "08:00" }],
      ["mon-fri 7:30", { frequency: "weekdays", time: "07:30" }],
      [
        "mondays and thursdays at 9:30",
        { frequency: "weekly", days: ["mon", "thu"], time: "09:30" },
      ],
      ["every friday at 5pm", { frequency: "weekly", days: ["fri"], time: "17:00" }],
      ["weekends at noon", { frequency: "weekly", days: ["sat", "sun"], time: "12:00" }],
      ["every day at 7:15", { frequency: "daily", time: "07:15" }],
      ["daily", { frequency: "daily", time: "09:00" }],
      ["1st of every month at 9", { frequency: "monthly", dayOfMonth: 1, time: "09:00" }],
      ["monthly on day 15 at 10:00", { frequency: "monthly", dayOfMonth: 15, time: "10:00" }],
      ["every hour", { frequency: "hourly" }],
      ["every 30 minutes", { frequency: "interval", every: 30, unit: "minutes" }],
      ["every 6h", { frequency: "interval", every: 6, unit: "hours" }],
      ["every 2 days at 8", { frequency: "interval", every: 2, unit: "days", time: "08:00" }],
      ["tomorrow at 15:00", { frequency: "once", date: "2026-09-27", time: "15:00" }],
      ["fri 2 oct at 3pm", { frequency: "once", date: "2026-10-02", time: "15:00" }],
      ["next monday at 10", { frequency: "once", date: "2026-09-28", time: "10:00" }],
      ["mon and thu at 9:30", { frequency: "weekly", days: ["mon", "thu"], time: "09:30" }],
      ["1st of the month at 9", { frequency: "monthly", dayOfMonth: 1, time: "09:00" }],
      ["every 30 min", { frequency: "interval", every: 30, unit: "minutes" }],
      ["weekdays at 8", { frequency: "weekdays", time: "08:00" }],
    ];
    for (const [text, rule] of cases) {
      expect({ text, result: parse(text) }).toEqual({ text, result: { ok: true, rule } });
    }
  });

  test("explains what it can't read", () => {
    expect(parse("whenever")).toEqual({
      ok: false,
      message: 'Couldn\'t read that. Try "every weekday at 8" or "1st of every month at 9".',
    });
    expect(parse("every day at 25:00")).toEqual({
      ok: false,
      message: "That time doesn't exist. Use a time like 08:00.",
    });
    expect(parse("today at 9")).toEqual({
      ok: false,
      message: "Today, 09:00 has already passed. Pick a later time.",
    });
    expect(parse("")).toMatchObject({ ok: false });
  });
});

describe("time entry", () => {
  test("normalises what people type", () => {
    expect(normalizeTime("8")).toBe("08:00");
    expect(normalizeTime("830")).toBe("08:30");
    expect(normalizeTime("8.3")).toBe("08:30");
    expect(normalizeTime("17:05")).toBe("17:05");
    expect(normalizeTime("12am")).toBe("00:00");
    expect(normalizeTime("7 pm")).toBe("19:00");
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("soon")).toBeNull();
  });

  test("steps wrap around midnight", () => {
    expect(stepTime("23:45", 15)).toBe("00:00");
    expect(stepTime("00:00", -15)).toBe("23:45");
  });
});

describe("zones", () => {
  test("converts a wall-clock time to the right instant", () => {
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 9, day: 28 },
        { hour: 8, minute: 0 },
        "Europe/Oslo",
      ).toISOString(),
    ).toBe("2026-09-28T06:00:00.000Z");
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 12, day: 1 },
        { hour: 8, minute: 0 },
        "Europe/Oslo",
      ).toISOString(),
    ).toBe("2026-12-01T07:00:00.000Z");
  });

  test("normalises a stored one-time instant into its local date and time", () => {
    expect(
      normalizeCadenceRule({ frequency: "once", at: "2026-10-02T13:00:00Z" }, "Europe/Oslo"),
    ).toEqual({
      frequency: "once",
      date: "2026-10-02",
      time: "15:00",
    });
  });
});
