/* ----------------------------------------------------------------------------
   Cadence logic, pure (no React): describe a rule in words, compute the next
   runs in the schedule's time zone, validate it, parse typed text, and map it
   to and from the API schedule spec. The picker (`cadence-picker.tsx`) draws
   it; React Native and other non-DOM hosts import it from here. Unit tested
   in `cadence-picker.test.ts`.
   -------------------------------------------------------------------------- */
import {
  createOpenGeniText,
  type OpenGeniMessageKey,
  type OpenGeniText,
} from "../messages/runtime";

/* ============================================================================
   1. Cadence logic
   ========================================================================== */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type IntervalUnit = "minutes" | "hours" | "days";

/**
 * When something runs. Times are wall-clock "HH:MM" in the schedule's time
 * zone, which travels next to the rule (see `CadenceValue`).
 */
export type CadenceRule =
  | { frequency: "hourly" }
  | { frequency: "daily"; time: string }
  | { frequency: "weekdays"; time: string }
  | { frequency: "weekly"; days: Weekday[]; time: string }
  | { frequency: "monthly"; dayOfMonth: number; time: string }
  | {
      frequency: "interval";
      every: number;
      unit: IntervalUnit;
      /** Day intervals only: the time of day of the first run. */
      time?: string | undefined;
      /** A stored anchor from the API. New rules leave it empty. */
      startAt?: string | undefined;
    }
  /** One run on a local date ("2026-10-02") and time. */
  | { frequency: "once"; date: string; time: string }
  /** One run at an exact instant (ISO), as stored by older clients. */
  | { frequency: "once"; at: string };

export type CadenceFrequency = CadenceRule["frequency"];

export interface CadenceValue {
  rule: CadenceRule;
  /** IANA time zone, for example "Europe/Oslo". */
  timeZone: string;
}

export type ApiWeekday =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

/**
 * The API schedule spec (`ScheduledTaskScheduleSpec` in @opengeni/contracts),
 * plus `daysOfMonth` on calendar rules. True monthly schedules need that small
 * contract addition (Temporal supports `dayOfMonth` natively); until it lands,
 * the API rejects a monthly spec instead of silently drifting.
 */
export type CadenceScheduleSpec =
  | { type: "once"; runAt: string; timeZone: string }
  | { type: "interval"; everySeconds: number; startAt?: string }
  | {
      type: "calendar";
      timeZone: string;
      hour: number;
      minute: number;
      daysOfWeek?: ApiWeekday[] | undefined;
      daysOfMonth?: number[] | undefined;
    };

export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WORKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

/** The built-in English words, for callers that pass no `text`. */
const ENGLISH = createOpenGeniText();

type DayForm = "short" | "long" | "plural";

const WEEKDAY_KEYS = {
  mon: {
    short: "cadence.day.mon.short",
    long: "cadence.day.mon.long",
    plural: "cadence.day.mon.plural",
  },
  tue: {
    short: "cadence.day.tue.short",
    long: "cadence.day.tue.long",
    plural: "cadence.day.tue.plural",
  },
  wed: {
    short: "cadence.day.wed.short",
    long: "cadence.day.wed.long",
    plural: "cadence.day.wed.plural",
  },
  thu: {
    short: "cadence.day.thu.short",
    long: "cadence.day.thu.long",
    plural: "cadence.day.thu.plural",
  },
  fri: {
    short: "cadence.day.fri.short",
    long: "cadence.day.fri.long",
    plural: "cadence.day.fri.plural",
  },
  sat: {
    short: "cadence.day.sat.short",
    long: "cadence.day.sat.long",
    plural: "cadence.day.sat.plural",
  },
  sun: {
    short: "cadence.day.sun.short",
    long: "cadence.day.sun.long",
    plural: "cadence.day.sun.plural",
  },
} as const satisfies Record<Weekday, Record<DayForm, OpenGeniMessageKey>>;

/** "Mon", "Monday" or "Mondays", in the host's words. */
export function weekdayName(t: OpenGeniText, day: Weekday, form: DayForm): string {
  return t(WEEKDAY_KEYS[day][form]);
}
const API_WEEKDAYS: Record<Weekday, ApiWeekday> = {
  mon: "MONDAY",
  tue: "TUESDAY",
  wed: "WEDNESDAY",
  thu: "THURSDAY",
  fri: "FRIDAY",
  sat: "SATURDAY",
  sun: "SUNDAY",
};

const MONTH_KEYS = [
  { short: "cadence.month.jan.short", long: "cadence.month.jan.long" },
  { short: "cadence.month.feb.short", long: "cadence.month.feb.long" },
  { short: "cadence.month.mar.short", long: "cadence.month.mar.long" },
  { short: "cadence.month.apr.short", long: "cadence.month.apr.long" },
  { short: "cadence.month.may.short", long: "cadence.month.may.long" },
  { short: "cadence.month.jun.short", long: "cadence.month.jun.long" },
  { short: "cadence.month.jul.short", long: "cadence.month.jul.long" },
  { short: "cadence.month.aug.short", long: "cadence.month.aug.long" },
  { short: "cadence.month.sep.short", long: "cadence.month.sep.long" },
  { short: "cadence.month.oct.short", long: "cadence.month.oct.long" },
  { short: "cadence.month.nov.short", long: "cadence.month.nov.long" },
  { short: "cadence.month.dec.short", long: "cadence.month.dec.long" },
] as const satisfies ReadonlyArray<Record<"short" | "long", OpenGeniMessageKey>>;

/** "Sep" or "September" for month 9, in the host's words. */
export function monthName(t: OpenGeniText, month: number, form: "short" | "long"): string {
  return t(MONTH_KEYS[month - 1]![form]);
}

/** English month names, which typed cadences use. */
const TYPED_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3_600, days: 86_400 };
export const UNIT_LIMITS: Record<IntervalUnit, number> = { minutes: 1_440, hours: 168, days: 365 };
const DAY_MS = 86_400_000;
export const DEFAULT_CADENCE_TIME = "09:00";

/* ---------------------------------------------------------------- time zones */

export interface LocalDate {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date and time of an instant in a time zone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a wall-clock date and time happens in a time zone. */
export function zonedTimeToUtc(
  date: LocalDate,
  time: { hour: number; minute: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const first = offsetMs(new Date(guess), timeZone);
  let instant = guess - first;
  const second = offsetMs(new Date(instant), timeZone);
  if (second !== first) instant = guess - second;
  return new Date(instant);
}

export function localDateOf(date: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(date, timeZone);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function dayNumber(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

export function weekdayOf(date: LocalDate): Weekday {
  const index = (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
  return WEEKDAYS[index]!;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatLocalDate(date: LocalDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function parseLocalDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12) return null;
  if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  return date;
}

/** Human labels for an IANA zone: "Oslo time" and "Oslo". */
export function timeZoneLabels(
  timeZone: string,
  text: OpenGeniText = ENGLISH,
): { label: string; shortLabel: string } {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return { label: "UTC", shortLabel: "UTC" };
  const city = (timeZone.split("/").pop() ?? timeZone).replaceAll("_", " ");
  return { label: text("cadence.zoneTime", { city }), shortLabel: city };
}

/* ---------------------------------------------------------------- times */

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Strict "HH:MM" (24 hour). */
export function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Lenient time entry, normalised to "HH:MM": "8" -> "08:00", "830" -> "08:30",
 * "8.30" -> "08:30", "8pm" -> "20:00". Returns null for times that don't exist.
 */
export function normalizeTime(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;
  const meridiem = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)$/.exec(text);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem[3] === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return `${pad(hour)}:${pad(minute)}`;
  }
  let hour: number;
  let minute: number;
  const separated = /^(\d{1,2})[:.h](\d{1,2})$/.exec(text);
  if (separated) {
    hour = Number(separated[1]);
    minute = Number(separated[2]!.length === 1 ? `${separated[2]}0` : separated[2]);
  } else if (/^\d{1,2}$/.test(text)) {
    hour = Number(text);
    minute = 0;
  } else if (/^\d{3,4}$/.test(text)) {
    hour = Number(text.slice(0, -2));
    minute = Number(text.slice(-2));
  } else {
    return null;
  }
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** Steps a "HH:MM" time by minutes, wrapping around midnight. */
export function stepTime(value: string, minutes: number): string {
  const time = parseTime(value) ?? parseTime(DEFAULT_CADENCE_TIME)!;
  const total = (((time.hour * 60 + time.minute + minutes) % 1_440) + 1_440) % 1_440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/* ---------------------------------------------------------------- formatting */

export interface RunFormatOptions {
  timeZone: string;
  now: Date;
  /** The host's words, from `useOpenGeniText()`. English when omitted. */
  text?: OpenGeniText | undefined;
}

export function dateLabel(t: OpenGeniText, date: LocalDate, today: LocalDate): string {
  const words = {
    weekday: weekdayName(t, weekdayOf(date), "short"),
    day: date.day,
    month: monthName(t, date.month, "short"),
  };
  return date.year === today.year
    ? t("cadence.date", words)
    : t("cadence.dateWithYear", { ...words, year: date.year });
}

function relativeDateLabel(t: OpenGeniText, date: LocalDate, today: LocalDate): string {
  const delta = dayNumber(date) - dayNumber(today);
  if (delta === 0) return t("cadence.today");
  if (delta === 1) return t("cadence.tomorrow");
  return dateLabel(t, date, today);
}

/** "a, b and c" in the host's words. */
function joinList(t: OpenGeniText, items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return t("cadence.and", { head: items.slice(0, -1).join(", "), last: items.at(-1) });
}

/** "Today, 14:00", "Tomorrow, 08:00", "Mon 28 Sep, 08:00" or "Mon 4 Jan 2027, 08:00". */
export function formatRunTime(
  date: Date,
  { timeZone, now, text = ENGLISH }: RunFormatOptions,
): string {
  const parts = zonedParts(date, timeZone);
  const today = localDateOf(now, timeZone);
  return text("cadence.runTime", {
    date: relativeDateLabel(text, parts, today),
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
  });
}

/**
 * The next runs as one line: "Mon 28 Sep, 08:00, then Tue 29 Sep and Wed 30 Sep".
 * Later runs drop what repeats: the time when it matches the first run, the
 * date when they fall on the same day as the run before.
 */
export function describeNextRuns(runs: readonly Date[], options: RunFormatOptions): string {
  const [first, ...rest] = runs;
  if (!first) return "";
  const t = options.text ?? ENGLISH;
  const today = localDateOf(options.now, options.timeZone);
  const firstParts = zonedParts(first, options.timeZone);
  const labels = rest.map((run, index) => {
    const parts = zonedParts(run, options.timeZone);
    const previous = zonedParts(runs[index]!, options.timeZone);
    const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
    if (dayNumber(parts) === dayNumber(previous)) return time;
    if (parts.hour === firstParts.hour && parts.minute === firstParts.minute) {
      return relativeDateLabel(t, parts, today);
    }
    return t("cadence.runTime", { date: relativeDateLabel(t, parts, today), time });
  });
  const head = formatRunTime(first, options);
  if (labels.length === 0) return head;
  return t("cadence.then", { first: head, rest: joinList(t, labels) });
}

/* ---------------------------------------------------------------- describe */

export interface CadenceDescribeOptions {
  timeZone: string;
  /** "Oslo time". Derived from the zone when omitted. */
  timeZoneLabel?: string | undefined;
  /** "Oslo". Derived from the zone when omitted. */
  timeZoneShortLabel?: string | undefined;
  /** Used to decide whether a one-time date needs its year. */
  now?: Date | undefined;
  /** The host's words, from `useOpenGeniText()`. English when omitted. */
  text?: OpenGeniText | undefined;
}

export interface CadenceDescription {
  /** "Runs every weekday at 08:00 Oslo time" - for sentences and sheets. */
  sentence: string;
  /** "Every weekday at 08:00 · Oslo" - for list rows. Same words, zone as a suffix. */
  short: string;
}

function listDays(t: OpenGeniText, days: readonly Weekday[], form: DayForm): string {
  const names = sortDays(days).map((day) => weekdayName(t, day, form));
  if (form === "short" && names.length > 2) return names.join(", ");
  return joinList(t, names);
}

export function sortDays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  const left = sortDays(a);
  const right = sortDays(b);
  return left.length === right.length && left.every((day, index) => day === right[index]);
}

/** "minute" or "30 minutes": what follows "every". */
function unitLabel(t: OpenGeniText, every: number, unit: IntervalUnit): string {
  switch (unit) {
    case "minutes":
      return t("cadence.every.minutes", { count: every });
    case "hours":
      return t("cadence.every.hours", { count: every });
    case "days":
      return t("cadence.every.days", { count: every });
  }
}

/** The rule in words, as a sentence and as a short row label. */
export function describeCadence(
  rule: CadenceRule,
  options: CadenceDescribeOptions,
): CadenceDescription {
  const t = options.text ?? ENGLISH;
  const labels = timeZoneLabels(options.timeZone, t);
  const zone = options.timeZoneLabel ?? labels.label;
  const zoneShort = options.timeZoneShortLabel ?? labels.shortLabel;
  const at = (time: string) => t("cadence.at", { time, zone }).trim();
  const atShort = (time: string) => t("cadence.atShort", { time, zone: zoneShort });

  switch (rule.frequency) {
    case "hourly":
      return {
        sentence: t("cadence.describe.hourly"),
        short: t("cadence.describe.hourlyShort"),
      };
    case "daily":
      return {
        sentence: t("cadence.describe.daily", { at: at(rule.time) }),
        short: t("cadence.describe.dailyShort", { at: atShort(rule.time) }),
      };
    case "weekdays":
      return {
        sentence: t("cadence.describe.weekdays", { at: at(rule.time) }),
        short: t("cadence.describe.weekdaysShort", { at: atShort(rule.time) }),
      };
    case "weekly": {
      if (sameDays(rule.days, WORKDAYS)) {
        return describeCadence({ frequency: "weekdays", time: rule.time }, options);
      }
      if (sameDays(rule.days, WEEKDAYS)) {
        return describeCadence({ frequency: "daily", time: rule.time }, options);
      }
      if (rule.days.length === 0) {
        return {
          sentence: t("cadence.describe.weeklyNoDays"),
          short: t("cadence.describe.weeklyNoDaysShort"),
        };
      }
      return {
        sentence: t("cadence.describe.weekly", {
          days: listDays(t, rule.days, "long"),
          at: at(rule.time),
        }),
        short: t("cadence.describe.weeklyShort", {
          days: listDays(t, rule.days, "short"),
          at: atShort(rule.time),
        }),
      };
    }
    case "monthly":
      return {
        sentence: t("cadence.describe.monthly", { day: rule.dayOfMonth, at: at(rule.time) }),
        short: t("cadence.describe.monthlyShort", { day: rule.dayOfMonth, at: atShort(rule.time) }),
      };
    case "interval": {
      const every = unitLabel(t, rule.every, rule.unit);
      if (rule.unit === "days" && rule.time) {
        return {
          sentence: t("cadence.describe.intervalAt", { every, at: at(rule.time) }),
          short: t("cadence.describe.intervalAtShort", { every, at: atShort(rule.time) }),
        };
      }
      return {
        sentence: t("cadence.describe.interval", { every }),
        short: t("cadence.describe.intervalShort", { every }),
      };
    }
    case "once": {
      const once = onceParts(rule, options.timeZone);
      if (!once) {
        return { sentence: t("cadence.describe.once"), short: t("cadence.describe.onceShort") };
      }
      const today = options.now ? localDateOf(options.now, options.timeZone) : once.date;
      const date = dateLabel(t, once.date, today);
      return {
        sentence: t("cadence.describe.onceOn", { date, at: at(once.time) }),
        short: t("cadence.describe.onceOnShort", { date, time: once.time, zone: zoneShort }),
      };
    }
  }
}

function onceParts(
  rule: Extract<CadenceRule, { frequency: "once" }>,
  timeZone: string,
): { date: LocalDate; time: string } | null {
  if ("at" in rule) {
    const instant = new Date(rule.at);
    if (Number.isNaN(instant.getTime())) return null;
    const parts = zonedParts(instant, timeZone);
    return { date: parts, time: `${pad(parts.hour)}:${pad(parts.minute)}` };
  }
  const date = parseLocalDate(rule.date);
  return date ? { date, time: rule.time } : null;
}

/** A one-time rule as a local date and time, converting stored instants. */
export function normalizeCadenceRule(rule: CadenceRule, timeZone: string): CadenceRule {
  if (rule.frequency !== "once" || !("at" in rule)) return rule;
  const once = onceParts(rule, timeZone);
  if (!once) return rule;
  return { frequency: "once", date: formatLocalDate(once.date), time: once.time };
}

/* ---------------------------------------------------------------- validate */

export type CadenceField = "time" | "days" | "dayOfMonth" | "every" | "date";

export interface CadenceIssue {
  field: CadenceField;
  message: string;
}

/** What's wrong with a rule, in words, or null when it can run. */
export function validateCadence(
  rule: CadenceRule,
  { timeZone, now, text = ENGLISH }: RunFormatOptions,
): CadenceIssue | null {
  const timeIssue = (time: string | undefined): CadenceIssue | null =>
    time !== undefined && !parseTime(time)
      ? { field: "time", message: text("cadence.issue.time") }
      : null;

  switch (rule.frequency) {
    case "hourly":
      return null;
    case "daily":
    case "weekdays":
      return timeIssue(rule.time);
    case "weekly":
      if (rule.days.length === 0) return { field: "days", message: text("cadence.issue.days") };
      return timeIssue(rule.time);
    case "monthly":
      if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
        return { field: "dayOfMonth", message: text("cadence.issue.dayOfMonth") };
      }
      return timeIssue(rule.time);
    case "interval": {
      const limit = UNIT_LIMITS[rule.unit];
      if (!Number.isInteger(rule.every) || rule.every < 1 || rule.every > limit) {
        return { field: "every", message: text("cadence.issue.every", { limit }) };
      }
      return rule.unit === "days" ? timeIssue(rule.time) : null;
    }
    case "once": {
      if (!("at" in rule)) {
        if (!parseLocalDate(rule.date))
          return { field: "date", message: text("cadence.issue.date") };
        const issue = timeIssue(rule.time);
        if (issue) return issue;
      }
      const [run] = onceRun(rule, timeZone);
      if (!run) return { field: "date", message: text("cadence.issue.date") };
      if (run.getTime() <= now.getTime()) {
        return {
          field: "date",
          message: text("cadence.issue.passed", {
            time: formatRunTime(run, { timeZone, now, text }),
          }),
        };
      }
      return null;
    }
  }
}

/* ---------------------------------------------------------------- next runs */

export interface NextRunOptions extends RunFormatOptions {
  /** How many runs to return. Default 3. */
  count?: number | undefined;
}

function onceRun(rule: Extract<CadenceRule, { frequency: "once" }>, timeZone: string): Date[] {
  if ("at" in rule) {
    const instant = new Date(rule.at);
    return Number.isNaN(instant.getTime()) ? [] : [instant];
  }
  const date = parseLocalDate(rule.date);
  const time = parseTime(rule.time);
  return date && time ? [zonedTimeToUtc(date, time, timeZone)] : [];
}

function intervalAnchor(
  rule: Extract<CadenceRule, { frequency: "interval" }>,
  { timeZone, now }: RunFormatOptions,
): number {
  if (rule.startAt) {
    const start = new Date(rule.startAt).getTime();
    if (!Number.isNaN(start)) return start;
  }
  const time = rule.unit === "days" && rule.time ? parseTime(rule.time) : null;
  if (!time) return 0; // Temporal aligns plain intervals to the Unix epoch.
  const today = localDateOf(now, timeZone);
  const todayRun = zonedTimeToUtc(today, time, timeZone);
  return todayRun.getTime() > now.getTime()
    ? todayRun.getTime()
    : zonedTimeToUtc(addDays(today, 1), time, timeZone).getTime();
}

/** The next runs strictly after `now`, in order. Empty when the rule is invalid. */
export function nextRuns(rule: CadenceRule, options: NextRunOptions): Date[] {
  const { timeZone, now } = options;
  const count = options.count ?? 3;
  if (validateCadence(rule, options)) return [];
  const runs: Date[] = [];
  const nowMs = now.getTime();

  const calendarRuns = (time: string, matches: (date: LocalDate) => boolean) => {
    const clock = parseTime(time)!;
    const today = localDateOf(now, timeZone);
    for (let offset = 0; offset < 400 && runs.length < count; offset += 1) {
      const date = addDays(today, offset);
      if (!matches(date)) continue;
      const run = zonedTimeToUtc(date, clock, timeZone);
      if (run.getTime() > nowMs) runs.push(run);
    }
  };

  switch (rule.frequency) {
    case "hourly":
      return nextRuns({ frequency: "interval", every: 1, unit: "hours" }, options);
    case "daily":
      calendarRuns(rule.time, () => true);
      return runs;
    case "weekdays":
      calendarRuns(rule.time, (date) => WORKDAYS.includes(weekdayOf(date)));
      return runs;
    case "weekly":
      calendarRuns(rule.time, (date) => rule.days.includes(weekdayOf(date)));
      return runs;
    case "monthly": {
      const clock = parseTime(rule.time)!;
      const today = localDateOf(now, timeZone);
      for (let step = 0; step < 48 && runs.length < count; step += 1) {
        const monthIndex = today.month - 1 + step;
        const year = today.year + Math.floor(monthIndex / 12);
        const month = (monthIndex % 12) + 1;
        if (rule.dayOfMonth > daysInMonth(year, month)) continue;
        const run = zonedTimeToUtc({ year, month, day: rule.dayOfMonth }, clock, timeZone);
        if (run.getTime() > nowMs) runs.push(run);
      }
      return runs;
    }
    case "interval": {
      const period = rule.every * UNIT_SECONDS[rule.unit] * 1000;
      const anchor = intervalAnchor(rule, options);
      let next =
        anchor > nowMs ? anchor : anchor + (Math.floor((nowMs - anchor) / period) + 1) * period;
      while (runs.length < count) {
        runs.push(new Date(next));
        next += period;
      }
      return runs;
    }
    case "once":
      return onceRun(rule, timeZone).filter((run) => run.getTime() > nowMs);
  }
}

/* ---------------------------------------------------------------- API spec */

/** The API schedule spec for a rule. Call only for valid rules. */
export function toScheduleSpec(
  rule: CadenceRule,
  { timeZone, now }: RunFormatOptions,
): CadenceScheduleSpec {
  const calendar = (time: string, extra: { daysOfWeek?: ApiWeekday[]; daysOfMonth?: number[] }) => {
    const clock = parseTime(time) ?? parseTime(DEFAULT_CADENCE_TIME)!;
    return {
      type: "calendar" as const,
      timeZone,
      hour: clock.hour,
      minute: clock.minute,
      ...extra,
    };
  };
  switch (rule.frequency) {
    case "hourly":
      return { type: "interval", everySeconds: 3_600 };
    case "daily":
      return calendar(rule.time, {});
    case "weekdays":
      return calendar(rule.time, { daysOfWeek: WORKDAYS.map((day) => API_WEEKDAYS[day]) });
    case "weekly":
      return calendar(rule.time, {
        daysOfWeek: sortDays(rule.days).map((day) => API_WEEKDAYS[day]),
      });
    case "monthly":
      return calendar(rule.time, { daysOfMonth: [rule.dayOfMonth] });
    case "interval": {
      const everySeconds = rule.every * UNIT_SECONDS[rule.unit];
      if (rule.startAt) return { type: "interval", everySeconds, startAt: rule.startAt };
      if (rule.unit === "days" && rule.time) {
        const anchor = intervalAnchor(rule, { timeZone, now });
        return { type: "interval", everySeconds, startAt: new Date(anchor).toISOString() };
      }
      return { type: "interval", everySeconds };
    }
    case "once": {
      const [run] = onceRun(rule, timeZone);
      return { type: "once", runAt: (run ?? now).toISOString(), timeZone };
    }
  }
}

/**
 * A stored API spec as a rule the picker can edit. Fixes the classic
 * "43200 minutes" edit: whole hours and days come back as hours and days.
 */
export function cadenceFromScheduleSpec(
  spec: CadenceScheduleSpec,
  fallbackTimeZone: string,
): CadenceValue {
  switch (spec.type) {
    case "once": {
      const instant = new Date(spec.runAt);
      const parts = zonedParts(instant, spec.timeZone);
      return {
        timeZone: spec.timeZone,
        rule: {
          frequency: "once",
          date: formatLocalDate(parts),
          time: `${pad(parts.hour)}:${pad(parts.minute)}`,
        },
      };
    }
    case "interval": {
      const seconds = spec.everySeconds;
      if (seconds === 3_600 && !spec.startAt) {
        return { timeZone: fallbackTimeZone, rule: { frequency: "hourly" } };
      }
      if (seconds % 86_400 === 0) {
        const time = spec.startAt ? zonedParts(new Date(spec.startAt), fallbackTimeZone) : null;
        return {
          timeZone: fallbackTimeZone,
          rule: {
            frequency: "interval",
            every: seconds / 86_400,
            unit: "days",
            ...(time ? { time: `${pad(time.hour)}:${pad(time.minute)}` } : {}),
            ...(spec.startAt ? { startAt: spec.startAt } : {}),
          },
        };
      }
      const unit: IntervalUnit = seconds % 3_600 === 0 ? "hours" : "minutes";
      return {
        timeZone: fallbackTimeZone,
        rule: {
          frequency: "interval",
          every: Math.max(1, Math.round(seconds / UNIT_SECONDS[unit])),
          unit,
          ...(spec.startAt ? { startAt: spec.startAt } : {}),
        },
      };
    }
    case "calendar": {
      const time = `${pad(spec.hour)}:${pad(spec.minute)}`;
      const monthDay = spec.daysOfMonth?.[0];
      if (monthDay !== undefined) {
        return {
          timeZone: spec.timeZone,
          rule: { frequency: "monthly", dayOfMonth: monthDay, time },
        };
      }
      const days = (spec.daysOfWeek ?? []).flatMap((apiDay) =>
        WEEKDAYS.filter((day) => API_WEEKDAYS[day] === apiDay),
      );
      if (days.length === 0 || sameDays(days, WEEKDAYS)) {
        return { timeZone: spec.timeZone, rule: { frequency: "daily", time } };
      }
      if (sameDays(days, WORKDAYS)) {
        return { timeZone: spec.timeZone, rule: { frequency: "weekdays", time } };
      }
      return { timeZone: spec.timeZone, rule: { frequency: "weekly", days: sortDays(days), time } };
    }
  }
}

/* ---------------------------------------------------------------- parse text */

export type CadenceParseResult = { ok: true; rule: CadenceRule } | { ok: false; message: string };

const DAY_TOKENS: Array<[RegExp, Weekday]> = [
  [/\bmon(?:day)?s?\b/g, "mon"],
  [/\btue(?:s|sday)?s?\b/g, "tue"],
  [/\bwed(?:nesday)?s?\b/g, "wed"],
  [/\bthu(?:r|rs|rsday)?s?\b/g, "thu"],
  [/\bfri(?:day)?s?\b/g, "fri"],
  [/\bsat(?:urday)?s?\b/g, "sat"],
  [/\bsun(?:day)?s?\b/g, "sun"],
];

const PARSE_HINT = 'Try "every weekday at 8" or "1st of every month at 9".';

/**
 * Reads a typed cadence: "every weekday at 8", "mondays and thursdays at 9:30",
 * "1st of every month at 9", "every 30 minutes", "tomorrow at 15:00".
 * Missing times default to 09:00.
 */
export function parseCadence(
  input: string,
  { timeZone, now }: RunFormatOptions,
): CadenceParseResult {
  let text = ` ${input.toLowerCase().replace(/[,;]/g, " ").replace(/\s+/g, " ").trim()} `;
  text = text.replace(/^ (?:runs?|repeat|repeats) /, " ");
  if (!text.trim()) {
    return { ok: false, message: 'Describe when it should run, like "every weekday at 8".' };
  }

  /* Time of day, removed from the text so its digits aren't read twice. */
  let time: string | null = null;
  let badTime = false;
  const takeTime = (pattern: RegExp, read: (match: RegExpExecArray) => string | null) => {
    if (time || badTime) return;
    const match = pattern.exec(text);
    if (!match) return;
    const value = read(match);
    if (value) time = value;
    else badTime = true;
    text = text.replace(match[0], " ");
  };
  takeTime(/\b(?:at )?(noon|midday)\b/, () => "12:00");
  takeTime(/\b(?:at )?midnight\b/, () => "00:00");
  takeTime(/\b(?:at )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm)\b/, (m) =>
    normalizeTime(`${m[1]}${m[2] ? `:${m[2]}` : ""}${m[3]}`),
  );
  takeTime(/\bat (\d{1,2})(?:[:.h](\d{2}))?\b/, (m) =>
    normalizeTime(`${m[1]}${m[2] ? `:${m[2]}` : ""}`),
  );
  takeTime(/\b(\d{1,2})[:.](\d{2})\b/, (m) => normalizeTime(`${m[1]}:${m[2]}`));
  if (badTime) return { ok: false, message: "That time doesn't exist. Use a time like 08:00." };
  const clock: string = time ?? DEFAULT_CADENCE_TIME;

  /* Intervals. */
  const halfHour = /\bevery half(?: an)? hour\b/.exec(text);
  if (halfHour) return { ok: true, rule: { frequency: "interval", every: 30, unit: "minutes" } };
  if (/\bevery other day\b/.test(text)) {
    return { ok: true, rule: { frequency: "interval", every: 2, unit: "days", time: clock } };
  }
  const interval = /\bevery (\d+) ?(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/.exec(text);
  if (interval) {
    const every = Number(interval[1]);
    const token = interval[2]!;
    const unit: IntervalUnit = token.startsWith("m")
      ? "minutes"
      : token.startsWith("h")
        ? "hours"
        : "days";
    if (unit === "hours" && every === 1) return { ok: true, rule: { frequency: "hourly" } };
    if (unit === "days" && every === 1)
      return { ok: true, rule: { frequency: "daily", time: clock } };
    const rule: CadenceRule =
      unit === "days"
        ? { frequency: "interval", every, unit, time: clock }
        : { frequency: "interval", every, unit };
    const issue = validateCadence(rule, { timeZone, now });
    return issue ? { ok: false, message: issue.message } : { ok: true, rule };
  }
  if (/\b(?:every|each) minute\b/.test(text)) {
    return { ok: true, rule: { frequency: "interval", every: 1, unit: "minutes" } };
  }
  if (/\b(?:hourly|(?:every|each) hour)\b/.test(text))
    return { ok: true, rule: { frequency: "hourly" } };

  /* Monthly. */
  if (/\b(?:monthly|(?:every|each|a|per) month|of (?:every|each|the) month)\b/.test(text)) {
    if (/\blast day\b/.test(text)) {
      return {
        ok: false,
        message: "The last day of the month isn't supported yet. Pick a day from 1 to 31.",
      };
    }
    const dayMatch = /\b(?:day )?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      text.replace(/\b(?:monthly|every|each|month|of|the|on)\b/g, " "),
    );
    const dayOfMonth = dayMatch ? Number(dayMatch[1]) : 1;
    const rule: CadenceRule = { frequency: "monthly", dayOfMonth, time: clock };
    const issue = validateCadence(rule, { timeZone, now });
    return issue ? { ok: false, message: issue.message } : { ok: true, rule };
  }

  /* Weekdays and weekends. */
  if (
    /\b(?:weekdays?|workdays?|business days?|working days?)\b/.test(text) ||
    /\bmon(?:day)? ?(?:-|to|through|until) ?fri(?:day)?\b/.test(text)
  ) {
    return { ok: true, rule: { frequency: "weekdays", time: clock } };
  }
  if (/\bweekends?\b/.test(text)) {
    return { ok: true, rule: { frequency: "weekly", days: ["sat", "sun"], time: clock } };
  }

  /* One time: today, tomorrow, a date, or "next friday". */
  const today = localDateOf(now, timeZone);
  let onceDate: LocalDate | null = null;
  if (/\btoday\b|\btonight\b/.test(text)) onceDate = today;
  else if (/\btomorrow\b/.test(text)) onceDate = addDays(today, 1);
  else {
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
    if (iso) onceDate = parseLocalDate(iso[1]!);
    const monthPattern = TYPED_MONTHS.map((name) => name.slice(0, 3)).join("|");
    const dayMonth = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${monthPattern})[a-z]*\\b`,
    ).exec(text);
    const monthDay = new RegExp(`\\b(${monthPattern})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(
      text,
    );
    const found = dayMonth
      ? { day: Number(dayMonth[1]), month: dayMonth[2]! }
      : monthDay
        ? { day: Number(monthDay[2]), month: monthDay[1]! }
        : null;
    if (!onceDate && found) {
      const month = TYPED_MONTHS.findIndex((name) => name.startsWith(found.month)) + 1;
      let year = today.year;
      if (month < today.month || (month === today.month && found.day < today.day)) year += 1;
      onceDate = found.day <= daysInMonth(year, month) ? { year, month, day: found.day } : null;
      if (!onceDate) return { ok: false, message: "That date doesn't exist. Pick another day." };
    }
    const nextDay = /\b(next|this) (mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/.exec(text);
    if (!onceDate && nextDay && !/\b(?:every|each)\b/.test(text)) {
      const target = WEEKDAYS.indexOf(nextDay[2] as Weekday);
      const current = WEEKDAYS.indexOf(weekdayOf(today));
      const delta = (target - current + 7) % 7;
      onceDate = addDays(today, delta === 0 && nextDay[1] === "next" ? 7 : delta);
    }
  }
  if (onceDate) {
    const rule: CadenceRule = { frequency: "once", date: formatLocalDate(onceDate), time: clock };
    const issue = validateCadence(rule, { timeZone, now });
    return issue ? { ok: false, message: issue.message } : { ok: true, rule };
  }

  /* Named days: "mondays and thursdays". */
  const days = new Set<Weekday>();
  for (const [pattern, day] of DAY_TOKENS) {
    if (new RegExp(pattern.source).test(text)) days.add(day);
  }
  if (days.size > 0) {
    const sorted = sortDays([...days]);
    if (sameDays(sorted, WORKDAYS))
      return { ok: true, rule: { frequency: "weekdays", time: clock } };
    if (sameDays(sorted, WEEKDAYS)) return { ok: true, rule: { frequency: "daily", time: clock } };
    return { ok: true, rule: { frequency: "weekly", days: sorted, time: clock } };
  }

  if (
    /\b(?:daily|(?:every|each) (?:day|morning|evening|night))\b/.test(text) ||
    (time && /\bevery\b/.test(text))
  ) {
    return { ok: true, rule: { frequency: "daily", time: clock } };
  }
  if (/\b(?:weekly|(?:every|each) week)\b/.test(text)) {
    return { ok: true, rule: { frequency: "weekly", days: ["mon"], time: clock } };
  }
  return { ok: false, message: `Couldn't read that. ${PARSE_HINT}` };
}
