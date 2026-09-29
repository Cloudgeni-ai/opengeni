/* ----------------------------------------------------------------------------
   CadencePicker - say when something runs, as a sentence, with a preview.

   Two halves in one file:
   1. Pure cadence logic (no React): describe a rule in words, compute the
      next runs in the schedule's time zone, validate it, parse typed text,
      and map it to and from the API schedule spec. Unit tested in
      `cadence-picker.test.ts`.
   2. The picker itself, with three variants:
      - "sentence" (default): [Every weekday] at [08:00] [Oslo time]
      - "presets": labelled preset chips and fields, with a summary line
      - "text": type "every weekday at 8" and see the rule it becomes
   -------------------------------------------------------------------------- */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CalendarClockIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  SearchIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive, Select as SelectPrimitive } from "radix-ui";

import {
  InlineDisabledReason,
  SelectMenuPanel,
  type SelectOption,
} from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";

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
      time?: string;
      /** A stored anchor from the API. New rules leave it empty. */
      startAt?: string;
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
      daysOfWeek?: ApiWeekday[];
      daysOfMonth?: number[];
    };

export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WORKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

const WEEKDAY_NAMES: Record<Weekday, { short: string; long: string; plural: string }> = {
  mon: { short: "Mon", long: "Monday", plural: "Mondays" },
  tue: { short: "Tue", long: "Tuesday", plural: "Tuesdays" },
  wed: { short: "Wed", long: "Wednesday", plural: "Wednesdays" },
  thu: { short: "Thu", long: "Thursday", plural: "Thursdays" },
  fri: { short: "Fri", long: "Friday", plural: "Fridays" },
  sat: { short: "Sat", long: "Saturday", plural: "Saturdays" },
  sun: { short: "Sun", long: "Sunday", plural: "Sundays" },
};

const API_WEEKDAYS: Record<Weekday, ApiWeekday> = {
  mon: "MONDAY",
  tue: "TUESDAY",
  wed: "WEDNESDAY",
  thu: "THURSDAY",
  fri: "FRIDAY",
  sat: "SATURDAY",
  sun: "SUNDAY",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3_600, days: 86_400 };
const UNIT_LIMITS: Record<IntervalUnit, number> = { minutes: 1_440, hours: 168, days: 365 };
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

function localDateOf(date: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(date, timeZone);
  return { year, month, day };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dayNumber(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

function weekdayOf(date: LocalDate): Weekday {
  const index = (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
  return WEEKDAYS[index]!;
}

function daysInMonth(year: number, month: number): number {
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
export function timeZoneLabels(timeZone: string): { label: string; shortLabel: string } {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return { label: "UTC", shortLabel: "UTC" };
  const city = (timeZone.split("/").pop() ?? timeZone).replaceAll("_", " ");
  return { label: `${city} time`, shortLabel: city };
}

/* ---------------------------------------------------------------- times */

function pad(value: number): string {
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
}

function dateLabel(date: LocalDate, today: LocalDate): string {
  const weekday = WEEKDAY_NAMES[weekdayOf(date)].short;
  const base = `${weekday} ${date.day} ${MONTHS[date.month - 1]}`;
  return date.year === today.year ? base : `${base} ${date.year}`;
}

function relativeDateLabel(date: LocalDate, today: LocalDate): string {
  const delta = dayNumber(date) - dayNumber(today);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  return dateLabel(date, today);
}

/** "Today, 14:00", "Tomorrow, 08:00", "Mon 28 Sep, 08:00" or "Mon 4 Jan 2027, 08:00". */
export function formatRunTime(date: Date, { timeZone, now }: RunFormatOptions): string {
  const parts = zonedParts(date, timeZone);
  const today = localDateOf(now, timeZone);
  return `${relativeDateLabel(parts, today)}, ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * The next runs as one line: "Mon 28 Sep, 08:00, then Tue 29 Sep and Wed 30 Sep".
 * Later runs drop what repeats: the time when it matches the first run, the
 * date when they fall on the same day as the run before.
 */
export function describeNextRuns(runs: readonly Date[], options: RunFormatOptions): string {
  const [first, ...rest] = runs;
  if (!first) return "";
  const today = localDateOf(options.now, options.timeZone);
  const firstParts = zonedParts(first, options.timeZone);
  const labels = rest.map((run, index) => {
    const parts = zonedParts(run, options.timeZone);
    const previous = zonedParts(runs[index]!, options.timeZone);
    const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
    if (dayNumber(parts) === dayNumber(previous)) return time;
    if (parts.hour === firstParts.hour && parts.minute === firstParts.minute) {
      return relativeDateLabel(parts, today);
    }
    return `${relativeDateLabel(parts, today)}, ${time}`;
  });
  const head = formatRunTime(first, options);
  if (labels.length === 0) return head;
  if (labels.length === 1) return `${head}, then ${labels[0]}`;
  return `${head}, then ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/* ---------------------------------------------------------------- describe */

export interface CadenceDescribeOptions {
  timeZone: string;
  /** "Oslo time". Derived from the zone when omitted. */
  timeZoneLabel?: string;
  /** "Oslo". Derived from the zone when omitted. */
  timeZoneShortLabel?: string;
  /** Used to decide whether a one-time date needs its year. */
  now?: Date;
}

export interface CadenceDescription {
  /** "Runs every weekday at 08:00 Oslo time" - for sentences and sheets. */
  sentence: string;
  /** "Every weekday at 08:00 · Oslo" - for list rows. Same words, zone as a suffix. */
  short: string;
}

function listDays(days: readonly Weekday[], form: "long" | "short" | "plural"): string {
  const names = sortDays(days).map((day) => WEEKDAY_NAMES[day][form]);
  if (names.length <= 1) return names.join("");
  if (form === "short" && names.length > 2) return names.join(", ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function sortDays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  const left = sortDays(a);
  const right = sortDays(b);
  return left.length === right.length && left.every((day, index) => day === right[index]);
}

function unitLabel(every: number, unit: IntervalUnit): string {
  const singular = unit.slice(0, -1);
  return every === 1 ? singular : `${every} ${unit}`;
}

/** The rule in words, as a sentence and as a short row label. */
export function describeCadence(
  rule: CadenceRule,
  options: CadenceDescribeOptions,
): CadenceDescription {
  const labels = timeZoneLabels(options.timeZone);
  const zone = options.timeZoneLabel ?? labels.label;
  const zoneShort = options.timeZoneShortLabel ?? labels.shortLabel;
  const at = (time: string) => `at ${time} ${zone}`;
  const atShort = (time: string) => `at ${time} · ${zoneShort}`;

  switch (rule.frequency) {
    case "hourly":
      return { sentence: "Runs every hour", short: "Every hour" };
    case "daily":
      return {
        sentence: `Runs every day ${at(rule.time)}`,
        short: `Every day ${atShort(rule.time)}`,
      };
    case "weekdays":
      return {
        sentence: `Runs every weekday ${at(rule.time)}`,
        short: `Every weekday ${atShort(rule.time)}`,
      };
    case "weekly": {
      if (sameDays(rule.days, WORKDAYS)) {
        return describeCadence({ frequency: "weekdays", time: rule.time }, options);
      }
      if (sameDays(rule.days, WEEKDAYS)) {
        return describeCadence({ frequency: "daily", time: rule.time }, options);
      }
      if (rule.days.length === 0) {
        return { sentence: "Runs every week on the days you pick", short: "Every week" };
      }
      return {
        sentence: `Runs every ${listDays(rule.days, "long")} ${at(rule.time)}`,
        short: `Every week on ${listDays(rule.days, "short")} ${atShort(rule.time)}`,
      };
    }
    case "monthly":
      return {
        sentence: `Runs every month on day ${rule.dayOfMonth} ${at(rule.time)}`,
        short: `Every month on day ${rule.dayOfMonth} ${atShort(rule.time)}`,
      };
    case "interval": {
      const every = unitLabel(rule.every, rule.unit);
      if (rule.unit === "days" && rule.time) {
        return {
          sentence: `Runs every ${every} ${at(rule.time)}`,
          short: `Every ${every} ${atShort(rule.time)}`,
        };
      }
      return { sentence: `Runs every ${every}`, short: `Every ${every}` };
    }
    case "once": {
      const once = onceParts(rule, options.timeZone);
      if (!once) return { sentence: "Runs once", short: "Once" };
      const today = options.now ? localDateOf(options.now, options.timeZone) : once.date;
      const day = dateLabel(once.date, today);
      return {
        sentence: `Runs once on ${day} ${at(once.time)}`,
        short: `Once on ${day}, ${once.time} · ${zoneShort}`,
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
  { timeZone, now }: RunFormatOptions,
): CadenceIssue | null {
  const timeIssue = (time: string | undefined): CadenceIssue | null =>
    time !== undefined && !parseTime(time)
      ? { field: "time", message: "Enter a time like 08:00." }
      : null;

  switch (rule.frequency) {
    case "hourly":
      return null;
    case "daily":
    case "weekdays":
      return timeIssue(rule.time);
    case "weekly":
      if (rule.days.length === 0) return { field: "days", message: "Pick at least one day." };
      return timeIssue(rule.time);
    case "monthly":
      if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
        return { field: "dayOfMonth", message: "Pick a day from 1 to 31." };
      }
      return timeIssue(rule.time);
    case "interval": {
      const limit = UNIT_LIMITS[rule.unit];
      if (!Number.isInteger(rule.every) || rule.every < 1 || rule.every > limit) {
        return { field: "every", message: `Enter a whole number from 1 to ${limit}.` };
      }
      return rule.unit === "days" ? timeIssue(rule.time) : null;
    }
    case "once": {
      if (!("at" in rule)) {
        if (!parseLocalDate(rule.date)) return { field: "date", message: "Pick a date." };
        const issue = timeIssue(rule.time);
        if (issue) return issue;
      }
      const [run] = onceRun(rule, timeZone);
      if (!run) return { field: "date", message: "Pick a date." };
      if (run.getTime() <= now.getTime()) {
        return {
          field: "date",
          message: `${formatRunTime(run, { timeZone, now })} has already passed. Pick a later time.`,
        };
      }
      return null;
    }
  }
}

/* ---------------------------------------------------------------- next runs */

export interface NextRunOptions extends RunFormatOptions {
  /** How many runs to return. Default 3. */
  count?: number;
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
    const monthPattern = MONTH_NAMES.map((name) => name.toLowerCase().slice(0, 3)).join("|");
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
      const month = MONTH_NAMES.findIndex((name) => name.toLowerCase().startsWith(found.month)) + 1;
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

/* ============================================================================
   2. The picker
   ========================================================================== */

export type CadencePickerVariant = "sentence" | "presets" | "text";

export interface CadenceTimeZoneOption {
  /** IANA id, "Europe/Oslo". */
  id: string;
  /** "Oslo time". */
  label: string;
  /** "Oslo". */
  shortLabel?: string;
  /** "UTC+2". */
  offsetLabel?: string;
}

export interface CadencePickerProps {
  value: CadenceValue;
  /** Called with every valid change. The text variant only reports rules it could read. */
  onChange: (value: CadenceValue) => void;
  /**
   * "sentence" (default): [Every weekday] at [08:00] [Oslo time].
   * "presets": labelled preset chips and fields.
   * "text": type the cadence in words.
   */
  variant?: CadencePickerVariant;
  /** Suggested zones, listed first. Search also covers every zone the browser knows. */
  timeZones?: readonly CadenceTimeZoneOption[];
  /** Limit the frequencies, for example for knowledge source sync. */
  frequencies?: readonly CadenceFrequency[];
  /** The clock for previews. Defaults to the time of the first render. */
  now?: Date;
  /** When it differs from the schedule's zone, the preview adds the viewer's local time. */
  viewerTimeZone?: string;
  /** How many upcoming runs the preview lists. Default 3. */
  previewCount?: number;
  disabled?: boolean;
  /** Shown under the picker while it is disabled: who can change it. */
  disabledReason?: ReactNode;
  /** The surrounding field label ("When"). */
  "aria-labelledby"?: string;
  className?: string;
}

const ALL_FREQUENCIES: readonly CadenceFrequency[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "interval",
  "once",
];

const FREQUENCY_OPTIONS: Record<
  CadenceFrequency,
  { label: string; trigger: string; preset: string; description: string }
> = {
  hourly: {
    label: "Every hour",
    trigger: "Every hour",
    preset: "Hourly",
    description: "On the hour, around the clock",
  },
  daily: {
    label: "Every day",
    trigger: "Every day",
    preset: "Daily",
    description: "Including weekends",
  },
  weekdays: {
    label: "Every weekday",
    trigger: "Every weekday",
    preset: "Weekdays",
    description: "Monday to Friday",
  },
  weekly: {
    label: "Every week",
    trigger: "Every week",
    preset: "Weekly",
    description: "On the days you pick",
  },
  monthly: {
    label: "Every month",
    trigger: "Every month",
    preset: "Monthly",
    description: "On one day of the month",
  },
  interval: {
    label: "Custom interval",
    trigger: "Every",
    preset: "Custom",
    description: "Every few minutes, hours or days",
  },
  once: {
    label: "One time",
    trigger: "One time",
    preset: "Once",
    description: "On a date you pick",
  },
};

const UNIT_OPTIONS: Array<{ value: IntervalUnit; label: string }> = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

function ruleTime(rule: CadenceRule): string | undefined {
  if (rule.frequency === "hourly") return undefined;
  if (rule.frequency === "once") return "at" in rule ? undefined : rule.time;
  return rule.time;
}

function usesTime(rule: CadenceRule): boolean {
  if (rule.frequency === "hourly") return false;
  if (rule.frequency === "interval") return rule.unit === "days";
  return true;
}

/** Switching frequency keeps what still applies: the time, the days. */
export function switchFrequency(
  rule: CadenceRule,
  frequency: CadenceFrequency,
  { timeZone, now }: RunFormatOptions,
): CadenceRule {
  const time = ruleTime(rule) ?? DEFAULT_CADENCE_TIME;
  switch (frequency) {
    case "hourly":
      return { frequency: "hourly" };
    case "daily":
      return { frequency: "daily", time };
    case "weekdays":
      return { frequency: "weekdays", time };
    case "weekly":
      return {
        frequency: "weekly",
        days: rule.frequency === "weekly" && rule.days.length > 0 ? rule.days : ["mon"],
        time,
      };
    case "monthly":
      return { frequency: "monthly", dayOfMonth: 1, time };
    case "interval":
      return { frequency: "interval", every: 30, unit: "minutes" };
    case "once":
      return {
        frequency: "once",
        date: formatLocalDate(addDays(localDateOf(now, timeZone), 1)),
        time,
      };
  }
}

function withTime(rule: CadenceRule, time: string): CadenceRule {
  if (rule.frequency === "hourly") return rule;
  if (rule.frequency === "once") return "at" in rule ? rule : { ...rule, time };
  return { ...rule, time };
}

/** The typed form of a rule, without "Runs" or the zone: "every weekday at 08:00". */
export function cadencePhrase(rule: CadenceRule, timeZone: string, now?: Date): string {
  const { sentence } = describeCadence(rule, { timeZone, timeZoneLabel: "", now });
  return sentence.replace(/^Runs /, "").trim();
}

/* ---------------------------------------------------------------- styles */

// Matches the Select primitive (select-menu.tsx): 36px, radius 10, 14/400 value,
// hover and open darken the border, disabled fills with surface-2.
const fieldBase =
  "inline-flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-sm text-fg transition-colors duration-[120ms] hover:border-border-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-2 disabled:text-fg-muted aria-invalid:border-danger aria-invalid:hover:border-danger data-[state=open]:border-border-strong pointer-coarse:h-11";

// Text inputs also take the brand border on focus, like TextInput (field.tsx).
const inputBase = cn(
  fieldBase,
  "cursor-text justify-center px-2 text-center tabular-nums focus-visible:border-brand pointer-coarse:text-base",
);

// Popovers match the Select panel: radius 16, one hairline, the menu shadow.
const popoverPanel =
  "z-50 overflow-hidden rounded-[16px] border border-border bg-surface text-fg shadow-og-md outline-none";

const menuContent = cn(
  popoverPanel,
  "max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)",
);

const menuItem =
  "relative flex min-h-9 cursor-pointer items-start gap-2.5 rounded-[10px] py-2 pr-9 pl-2.5 text-sm text-fg outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:text-fg-muted data-[highlighted]:bg-surface-2 data-[state=checked]:bg-brand/5 data-[highlighted]:data-[state=checked]:bg-brand/10 pointer-coarse:min-h-11";

const connector = "text-sm text-fg-muted";

/* ---------------------------------------------------------------- value select */

interface ValueOption<V extends string> {
  value: V;
  label: string;
  description?: string;
}

function ValueSelect<V extends string>({
  value,
  options,
  onValueChange,
  triggerLabel,
  label,
  disabled,
  invalid,
  describedBy,
  className,
  contentClassName,
}: {
  value: V;
  options: readonly ValueOption<V>[];
  onValueChange: (value: V) => void;
  triggerLabel?: string;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  contentClassName?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(fieldBase, "group/value-select justify-between", className)}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value>{triggerLabel ?? selected?.label}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-data-[state=open]/value-select:rotate-180"
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          align="start"
          className={cn(menuContent, contentClassName)}
        >
          <SelectPrimitive.Viewport className="max-h-[26rem] p-1.5">
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className={menuItem}>
                <span className="flex min-w-0 flex-col">
                  <SelectPrimitive.ItemText>
                    <span className="font-medium">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  {option.description ? (
                    <span className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <SelectPrimitive.ItemIndicator className="absolute top-2.5 right-2.5">
                  <CheckIcon aria-hidden="true" className="size-4 text-brand" strokeWidth={2.25} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- time field */

/** A 24-hour time input. Type "8", "830" or "8pm"; arrow keys step 15 minutes. */
export function TimeField({
  value,
  onChange,
  label = "Time",
  disabled,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);
  const normalized = normalizeTime(draft);
  const invalid = !normalized || !parseTime(value);

  const commit = () => {
    if (normalized) {
      setDraft(normalized);
      if (normalized !== value) onChange(normalized);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = stepTime(normalized ?? value, event.key === "ArrowUp" ? 15 : -15);
      setDraft(next);
      onChange(next);
    } else if (event.key === "Enter") {
      commit();
    }
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={draft}
      maxLength={8}
      placeholder="08:00"
      onChange={(event) => {
        setDraft(event.target.value);
        const next = normalizeTime(event.target.value);
        if (next && /^\d{1,2}[:.]\d{2}$/.test(event.target.value.trim())) onChange(next);
      }}
      onFocus={(event) => {
        setFocused(true);
        event.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={onKeyDown}
      className={cn(inputBase, "w-[4.75rem] placeholder:text-fg-subtle", className)}
    />
  );
}

/* ---------------------------------------------------------------- number field */

function NumberField({
  value,
  onChange,
  label,
  max,
  disabled,
  invalid,
  describedBy,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  max: number;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const text = event.target.value.replace(/[^\d]/g, "").slice(0, 4);
        setDraft(text);
        if (text) onChange(Number(text));
      }}
      onBlur={() => setDraft(String(value))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        onChange(Math.min(max, Math.max(1, value + (event.key === "ArrowUp" ? 1 : -1))));
      }}
      className={cn(inputBase, "w-16")}
    />
  );
}

/* ---------------------------------------------------------------- days */

function DayToggleGroup({
  days,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  days: readonly Weekday[];
  onChange: (days: Weekday[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Days"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-0.5 rounded-[10px] border p-[3px] transition-colors duration-[120ms] pointer-coarse:h-11",
        invalid ? "border-danger" : "border-border",
        disabled ? "bg-surface-2" : "bg-surface",
      )}
    >
      {WEEKDAYS.map((day) => {
        const on = days.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={on}
            aria-label={WEEKDAY_NAMES[day].long}
            disabled={disabled}
            onClick={() =>
              onChange(on ? days.filter((each) => each !== day) : sortDays([...days, day]))
            }
            className={cn(
              "inline-flex h-7 w-9 items-center justify-center rounded-sm text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed pointer-coarse:h-9 pointer-coarse:w-10",
              on
                ? "bg-brand/10 text-brand disabled:bg-surface-3 disabled:text-fg-muted"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg disabled:text-fg-subtle disabled:hover:bg-transparent",
            )}
          >
            {WEEKDAY_NAMES[day].short.slice(0, 2)}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- time zones */

let allZonesCache: CadenceTimeZoneOption[] | null = null;
const NO_TIME_ZONES: readonly CadenceTimeZoneOption[] = [];

function offsetLabelFor(timeZone: string, at: Date): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name || name === "GMT") return "UTC";
    return name.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

function allTimeZones(at: Date): CadenceTimeZoneOption[] {
  if (allZonesCache) return allZonesCache;
  const ids =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  allZonesCache = ids.map((id) => ({
    id,
    ...timeZoneLabels(id),
    offsetLabel: offsetLabelFor(id, at),
  }));
  return allZonesCache;
}

function zoneOption(
  timeZone: string,
  suggested: readonly CadenceTimeZoneOption[],
  at: Date,
): CadenceTimeZoneOption {
  return (
    suggested.find((zone) => zone.id === timeZone) ?? {
      id: timeZone,
      ...timeZoneLabels(timeZone),
      offsetLabel: offsetLabelFor(timeZone, at),
    }
  );
}

/**
 * The searchable list inside the time zone picker. Exported so a sheet or the
 * kit can show it inline; the picker renders it in a popover.
 */
export function TimeZoneSearch({
  value,
  onSelect,
  timeZones = NO_TIME_ZONES,
  now,
  initialQuery = "",
  autoFocus = true,
  preview = false,
  className,
}: {
  value: string;
  onSelect: (timeZone: string) => void;
  timeZones?: readonly CadenceTimeZoneOption[];
  now?: Date;
  initialQuery?: string;
  autoFocus?: boolean;
  /** A static, inert copy for previews and docs (like ComboboxPanelPreview). */
  preview?: boolean;
  className?: string;
}) {
  const [clock] = useState(() => now ?? new Date());
  const [query, setQuery] = useState(initialQuery);
  const listId = useId();
  const optionPrefix = useId();
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...timeZones];
    const seen = new Set<string>();
    const results: CadenceTimeZoneOption[] = [];
    for (const zone of [...timeZones, ...allTimeZones(clock)]) {
      if (seen.has(zone.id)) continue;
      const haystack = `${zone.label} ${zone.id} ${zone.offsetLabel ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) {
        seen.add(zone.id);
        results.push(zone);
      }
      if (results.length >= 50) break;
    }
    return results;
  }, [clock, query, timeZones]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((zone) => zone.id === value),
    ),
  );
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const searching = query.trim().length > 0;
  // The same option list as every other select and combobox (SelectMenuPanel).
  const panelOptions = useMemo<SelectOption[]>(
    () =>
      options.map((zone) => ({
        value: zone.id,
        label: zone.label,
        meta: zone.offsetLabel || undefined,
        // Search results name the region so "New Salem time" is findable and clear.
        description: searching && zone.id.includes("/") ? regionOf(zone.id) : undefined,
        group: searching ? undefined : "Suggested",
      })),
    [options, searching],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) =>
        options.length === 0
          ? 0
          : (Math.min(current, options.length - 1) + delta + options.length) % options.length,
      );
    } else if (event.key === "Enter") {
      const zone = options[activeIndex];
      if (zone) {
        event.preventDefault();
        onSelect(zone.id);
      }
    }
  };

  return (
    <SelectMenuPanel
      options={panelOptions}
      value={value}
      activeIndex={options.length > 0 ? activeIndex : -1}
      onActiveIndexChange={setActive}
      onSelect={onSelect}
      listboxId={listId}
      idPrefix={optionPrefix}
      aria-label="Time zones"
      preview={preview}
      emptyMessage={<>No time zones match &ldquo;{query.trim()}&rdquo;.</>}
      className={className}
      header={
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3.5">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
          <input
            role="combobox"
            aria-expanded={!preview}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              options[activeIndex] ? `${optionPrefix}-${activeIndex}` : undefined
            }
            aria-label="Search time zones"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus moves into the opened picker
            autoFocus={autoFocus && !preview}
            autoComplete="off"
            spellCheck={false}
            readOnly={preview}
            value={query}
            placeholder="Search city or zone"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none! placeholder:text-fg-subtle pointer-coarse:text-base"
          />
        </div>
      }
    />
  );
}

function regionOf(timeZone: string): string {
  return timeZone.split("/").slice(0, -1).join(" / ").replaceAll("_", " ");
}

/** "Oslo time" with a search popover. */
export function TimeZonePicker({
  value,
  onChange,
  timeZones = NO_TIME_ZONES,
  now,
  disabled,
  className,
  variant = "field",
}: {
  value: string;
  onChange: (timeZone: string) => void;
  timeZones?: readonly CadenceTimeZoneOption[];
  now?: Date;
  disabled?: boolean;
  className?: string;
  /** "field" is a bordered control; "ghost" sits inside another field. */
  variant?: "field" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [clock] = useState(() => now ?? new Date());
  const current = zoneOption(value, timeZones, clock);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        disabled={disabled}
        aria-label={`Time zone: ${current.label}`}
        className={cn(
          fieldBase,
          "group/zone justify-between",
          variant === "ghost" &&
            "h-7 gap-1.5 border-transparent bg-transparent px-2 text-fg-muted hover:border-transparent hover:bg-surface-2 hover:text-fg disabled:bg-transparent data-[state=open]:border-transparent data-[state=open]:bg-surface-2 data-[state=open]:text-fg pointer-coarse:h-9",
          className,
        )}
      >
        {variant === "ghost" ? <GlobeIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
        {variant === "ghost" && current.shortLabel ? (
          // Inside a narrow field the city alone is enough ("Oslo").
          <>
            <span className="min-w-0 truncate @max-[26rem]/cadence-text:hidden">
              {current.label}
            </span>
            <span className="hidden min-w-0 truncate @max-[26rem]/cadence-text:inline">
              {current.shortLabel}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate">{current.label}</span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-data-[state=open]/zone:rotate-180"
        />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={variant === "ghost" ? "end" : "start"}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            popoverPanel,
            "flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-24px))] flex-col",
          )}
        >
          <TimeZoneSearch
            value={value}
            timeZones={timeZones}
            now={clock}
            onSelect={(zone) => {
              onChange(zone);
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- date field */

function CalendarGrid({
  value,
  min,
  onSelect,
}: {
  value: LocalDate | null;
  min: LocalDate;
  onSelect: (date: LocalDate) => void;
}) {
  const [focus, setFocus] = useState<LocalDate>(value ?? min);
  const [view, setView] = useState({ year: focus.year, month: focus.month });
  const gridRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(true);

  useEffect(() => {
    if (!shouldFocus.current) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${formatLocalDate(focus)}"]`)
      ?.focus();
  }, [focus, view]);

  const first: LocalDate = { year: view.year, month: view.month, day: 1 };
  const leading = WEEKDAYS.indexOf(weekdayOf(first));
  const total = daysInMonth(view.year, view.month);
  const cells: Array<LocalDate | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: total }, (_, index) => ({ ...first, day: index + 1 })),
  ];
  const minDay = dayNumber(min);

  const move = (date: LocalDate) => {
    const target = dayNumber(date) < minDay ? min : date;
    shouldFocus.current = true;
    setFocus(target);
    setView({ year: target.year, month: target.month });
  };

  const shiftMonth = (delta: number) => {
    const index = view.month - 1 + delta;
    const year = view.year + Math.floor(index / 12);
    const month = (((index % 12) + 12) % 12) + 1;
    shouldFocus.current = false;
    setView({ year, month });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      move(addDays(focus, step));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const delta = event.key === "PageUp" ? -1 : 1;
      const index = focus.month - 1 + delta;
      const year = focus.year + Math.floor(index / 12);
      const month = (((index % 12) + 12) % 12) + 1;
      move({ year, month, day: Math.min(focus.day, daysInMonth(year, month)) });
    }
  };

  const canGoBack = view.year > min.year || (view.year === min.year && view.month > min.month);

  return (
    <div className="w-[17.5rem] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p aria-live="polite" className="text-sm font-semibold text-fg">
          {MONTH_NAMES[view.month - 1]} {view.year}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            disabled={!canGoBack}
            onClick={() => shiftMonth(-1)}
            className="grid size-8 place-items-center rounded-[10px] text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent pointer-coarse:size-11"
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shiftMonth(1)}
            className="grid size-8 place-items-center rounded-[10px] text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-11"
          >
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={`${MONTH_NAMES[view.month - 1]} ${view.year}`}
        onKeyDown={onKeyDown}
      >
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map((day) => (
            <span
              key={day}
              role="columnheader"
              aria-label={WEEKDAY_NAMES[day].long}
              className="grid h-8 place-items-center text-xs font-medium text-fg-subtle"
            >
              {WEEKDAY_NAMES[day].short.slice(0, 2)}
            </span>
          ))}
        </div>
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, row) => (
          <div
            key={`week-${view.year}-${view.month}-${row}`}
            role="row"
            className="grid grid-cols-7"
          >
            {cells.slice(row * 7, row * 7 + 7).map((date, column) => {
              // Leading blanks only occur in the first row, before day 1.
              if (!date) return <span key={`blank-${WEEKDAYS[column]}`} role="gridcell" />;
              const iso = formatLocalDate(date);
              const selected = value !== null && dayNumber(value) === dayNumber(date);
              const isToday = dayNumber(date) === minDay;
              const past = dayNumber(date) < minDay;
              const focused = dayNumber(date) === dayNumber(focus);
              return (
                <span key={iso} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={focused ? 0 : -1}
                    disabled={past}
                    aria-label={`${WEEKDAY_NAMES[weekdayOf(date)].long} ${date.day} ${MONTH_NAMES[date.month - 1]} ${date.year}${isToday ? ", today" : ""}`}
                    onClick={() => onSelect(date)}
                    className={cn(
                      "relative mx-auto grid size-9 place-items-center rounded-[10px] text-sm tabular-nums transition-colors duration-[120ms]",
                      selected
                        ? "border border-primary-border bg-primary font-medium text-primary-foreground"
                        : past
                          ? "cursor-not-allowed text-fg-subtle"
                          : "text-fg hover:bg-surface-2",
                    )}
                  >
                    {date.day}
                    {isToday && !selected ? (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 size-1 rounded-full bg-brand"
                      />
                    ) : null}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DateField({
  value,
  onChange,
  timeZone,
  now,
  disabled,
  invalid,
  describedBy,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  timeZone: string;
  now: Date;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const date = parseLocalDate(value);
  const today = localDateOf(now, timeZone);
  const label = date ? dateLabel(date, today) : "Pick a date";
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        disabled={disabled}
        aria-label={`Date: ${label}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(fieldBase, "justify-between", className)}
      >
        <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        <span className="min-w-0 truncate">{label}</span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={popoverPanel}
        >
          <CalendarGrid
            value={date}
            min={today}
            onSelect={(picked) => {
              onChange(formatLocalDate(picked));
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- preview */

/**
 * The live summary under a cadence: the rule as a sentence, the next runs,
 * or what to fix. Exported for read-only places such as a schedule sheet.
 */
export function CadencePreview({
  value,
  now,
  timeZones = NO_TIME_ZONES,
  viewerTimeZone,
  count = 3,
  issue,
  id,
  className,
}: {
  value: CadenceValue;
  now: Date;
  timeZones?: readonly CadenceTimeZoneOption[];
  viewerTimeZone?: string;
  count?: number;
  /** Overrides the rule's own validation, for example a parse error. */
  issue?: string | null;
  id?: string;
  className?: string;
}) {
  const zone = zoneOption(value.timeZone, timeZones, now);
  const options = { timeZone: value.timeZone, now };
  const problem = issue ?? validateCadence(value.rule, options)?.message ?? null;
  const description = describeCadence(value.rule, {
    timeZone: value.timeZone,
    timeZoneLabel: zone.label,
    timeZoneShortLabel: zone.shortLabel,
    now,
  });
  const runs = problem ? [] : nextRuns(value.rule, { ...options, count });
  const viewerZone =
    viewerTimeZone && viewerTimeZone !== value.timeZone && usesTime(value.rule)
      ? viewerTimeZone
      : null;
  const viewerLine =
    viewerZone && runs[0]
      ? (() => {
          const local = zonedParts(runs[0], viewerZone);
          const viewerLabel = zoneOption(viewerZone, timeZones, now).label;
          return `That's ${pad(local.hour)}:${pad(local.minute)} ${viewerLabel} for you.`;
        })()
      : null;

  // A problem reads like every other field error (field.tsx): a red line, no box.
  if (problem) {
    return (
      <p
        id={id}
        role="status"
        aria-live="polite"
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-danger",
          className,
        )}
      >
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{problem}</span>
      </p>
    );
  }

  return (
    <div
      id={id}
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-[10px] bg-surface-2 px-3 py-2.5",
        className,
      )}
    >
      <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{description.sentence}.</p>
        <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
          {runs.length > 0 ? (
            <>
              <span className="text-fg-subtle">Next: </span>
              {describeNextRuns(runs, options)}
            </>
          ) : (
            "No upcoming runs."
          )}
        </p>
        {viewerLine ? (
          <p className="mt-0.5 text-xs leading-4.5 text-fg-subtle">{viewerLine}</p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the picker */

interface PartProps {
  value: CadenceValue;
  update: (rule: CadenceRule) => void;
  updateZone: (timeZone: string) => void;
  issue: CadenceIssue | null;
  issueId: string;
  now: Date;
  disabled?: boolean;
  timeZones: readonly CadenceTimeZoneOption[];
  frequencies: readonly CadenceFrequency[];
}

function FrequencySelect({ value, update, now, disabled, frequencies }: PartProps) {
  const rule = value.rule;
  return (
    <ValueSelect<CadenceFrequency>
      label="How often"
      value={rule.frequency}
      triggerLabel={FREQUENCY_OPTIONS[rule.frequency].trigger}
      disabled={disabled}
      options={frequencies.map((frequency) => ({
        value: frequency,
        label: FREQUENCY_OPTIONS[frequency].label,
        description: FREQUENCY_OPTIONS[frequency].description,
      }))}
      onValueChange={(frequency) =>
        update(switchFrequency(rule, frequency, { timeZone: value.timeZone, now }))
      }
      contentClassName="w-64"
    />
  );
}

const DAY_OF_MONTH_OPTIONS: ValueOption<string>[] = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/** Inline, each phrase ("on day [1]") wraps as one unit so a word never dangles. */
function Phrase({ inline, children }: { inline: boolean; children: ReactNode }) {
  return inline ? (
    <span className="inline-flex min-w-0 items-center gap-2">{children}</span>
  ) : (
    <>{children}</>
  );
}

function RuleDetails({
  value,
  update,
  issue,
  issueId,
  now,
  disabled,
  layout,
}: PartProps & { layout: "inline" | "stacked" }) {
  const rule = normalizeCadenceRule(value.rule, value.timeZone);
  const invalid = (field: CadenceField) => issue?.field === field;
  const described = (field: CadenceField) => (issue?.field === field ? issueId : undefined);
  const word = (text: string) =>
    layout === "inline" ? <span className={connector}>{text}</span> : null;
  const inline = layout === "inline";

  switch (rule.frequency) {
    case "weekly":
      return (
        <Phrase inline={inline}>
          {word("on")}
          <DayToggleGroup
            days={rule.days}
            disabled={disabled}
            invalid={invalid("days")}
            describedBy={described("days")}
            onChange={(days) => update({ ...rule, days })}
          />
        </Phrase>
      );
    case "monthly":
      return (
        <Phrase inline={inline}>
          {word("on day")}
          <ValueSelect
            label="Day of the month"
            value={String(rule.dayOfMonth)}
            options={DAY_OF_MONTH_OPTIONS}
            disabled={disabled}
            invalid={invalid("dayOfMonth")}
            describedBy={described("dayOfMonth")}
            onValueChange={(day) => update({ ...rule, dayOfMonth: Number(day) })}
            className="w-[4.5rem]"
            contentClassName="w-24"
          />
        </Phrase>
      );
    case "interval":
      return (
        <Phrase inline={inline}>
          <NumberField
            label="Every how many"
            value={rule.every}
            max={UNIT_LIMITS[rule.unit]}
            disabled={disabled}
            invalid={invalid("every")}
            describedBy={described("every")}
            onChange={(every) => update({ ...rule, every })}
          />
          <ValueSelect<IntervalUnit>
            label="Unit"
            value={rule.unit}
            options={UNIT_OPTIONS.map((option) => ({
              ...option,
              label: rule.every === 1 ? option.label.slice(0, -1) : option.label,
            }))}
            disabled={disabled}
            onValueChange={(unit) =>
              update(
                unit === "days"
                  ? {
                      frequency: "interval",
                      every: Math.min(rule.every, UNIT_LIMITS.days),
                      unit,
                      time: rule.time ?? DEFAULT_CADENCE_TIME,
                    }
                  : { frequency: "interval", every: Math.min(rule.every, UNIT_LIMITS[unit]), unit },
              )
            }
            className="w-[6.5rem]"
          />
        </Phrase>
      );
    case "once":
      if ("at" in rule) return null;
      return (
        <Phrase inline={inline}>
          {word("on")}
          <DateField
            value={rule.date}
            timeZone={value.timeZone}
            now={now}
            disabled={disabled}
            invalid={invalid("date")}
            describedBy={described("date")}
            onChange={(date) => update({ ...rule, date })}
          />
        </Phrase>
      );
    default:
      return null;
  }
}

function monthDayHint(rule: CadenceRule): string | null {
  if (rule.frequency !== "monthly" || rule.dayOfMonth <= 28) return null;
  return rule.dayOfMonth === 29
    ? "Skips February in most years."
    : `Skips months with fewer than ${rule.dayOfMonth} days.`;
}

function SentenceVariant(props: PartProps) {
  const { value, update, updateZone, now, disabled, timeZones } = props;
  const rule = value.rule;
  const time = ruleTime(normalizeCadenceRule(rule, value.timeZone));
  const showTime = usesTime(rule) && time !== undefined;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <FrequencySelect {...props} />
      {rule.frequency === "hourly" ? <span className={connector}>on the hour</span> : null}
      <RuleDetails {...props} layout="inline" />
      {showTime ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className={connector}>at</span>
          <TimeField
            value={time}
            disabled={disabled}
            onChange={(next) => update(withTime(normalizeCadenceRule(rule, value.timeZone), next))}
          />
          <TimeZonePicker
            value={value.timeZone}
            onChange={updateZone}
            timeZones={timeZones}
            now={now}
            disabled={disabled}
          />
        </span>
      ) : null}
    </div>
  );
}

function PresetChips({
  value,
  frequencies,
  onChange,
  disabled,
  labelledBy,
}: {
  value: CadenceFrequency;
  frequencies: readonly CadenceFrequency[];
  onChange: (frequency: CadenceFrequency) => void;
  disabled?: boolean;
  labelledBy: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + frequencies.length) % frequencies.length;
    onChange(frequencies[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex min-w-0 flex-wrap gap-1.5">
      {frequencies.map((frequency, index) => {
        const checked = frequency === value;
        return (
          <button
            key={frequency}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(frequency)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium transition-colors duration-[120ms] disabled:cursor-not-allowed pointer-coarse:h-11",
              // Selected matches the outlined segmented control: brand tint, soft brand edge.
              checked
                ? "border-brand/45 bg-brand/10 text-brand disabled:border-border disabled:bg-surface-3 disabled:text-fg-muted"
                : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-border",
            )}
          >
            {FREQUENCY_OPTIONS[frequency].preset}
          </button>
        );
      })}
    </div>
  );
}

function PresetField({
  label,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  htmlFor?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          id={labelId}
          className="text-xs leading-4.5 font-medium text-fg-muted"
        >
          {label}
        </label>
      ) : (
        <span id={labelId} className="text-xs leading-4.5 font-medium text-fg-muted">
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function PresetsVariant(props: PartProps) {
  const { value, update, updateZone, now, disabled, timeZones, frequencies } = props;
  const rule = normalizeCadenceRule(value.rule, value.timeZone);
  const time = ruleTime(rule);
  const repeatsId = useId();
  const timeId = useId();
  const detailLabel: Partial<Record<CadenceFrequency, string>> = {
    weekly: "Days",
    monthly: "Day of the month",
    interval: "Every",
    once: "Date",
  };
  const detail = detailLabel[rule.frequency];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <span id={repeatsId} className="text-xs leading-4.5 font-medium text-fg-muted">
          Repeats
        </span>
        <PresetChips
          value={rule.frequency}
          frequencies={frequencies}
          labelledBy={repeatsId}
          disabled={disabled}
          onChange={(frequency) =>
            update(switchFrequency(rule, frequency, { timeZone: value.timeZone, now }))
          }
        />
      </div>
      {detail ? (
        <PresetField label={detail}>
          <RuleDetails {...props} layout="stacked" />
        </PresetField>
      ) : null}
      {usesTime(rule) && time !== undefined ? (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-4">
          <PresetField label="Time" htmlFor={timeId}>
            <TimeField
              id={timeId}
              value={time}
              disabled={disabled}
              onChange={(next) => update(withTime(rule, next))}
            />
          </PresetField>
          <PresetField label="Time zone">
            <TimeZonePicker
              value={value.timeZone}
              onChange={updateZone}
              timeZones={timeZones}
              now={now}
              disabled={disabled}
              className="w-full max-w-60"
            />
          </PresetField>
        </div>
      ) : null}
    </div>
  );
}

const TEXT_EXAMPLES = [
  "weekdays at 8",
  "mon and thu at 9:30",
  "1st of the month at 9",
  "every 30 min",
];

function TextVariant({
  value,
  update,
  updateZone,
  now,
  disabled,
  timeZones,
  inputIssueId,
  onIssue,
}: PartProps & { inputIssueId: string; onIssue: (message: string | null) => void }) {
  const [text, setText] = useState(() => cadencePhrase(value.rule, value.timeZone, now));
  const inputId = useId();
  const read = (next: string) => {
    setText(next);
    const result = parseCadence(next, { timeZone: value.timeZone, now });
    if (result.ok) {
      onIssue(null);
      update(result.rule);
    } else {
      onIssue(result.message);
    }
  };
  return (
    <div className="@container/cadence-text flex min-w-0 flex-col gap-2.5">
      <div
        className={cn(
          "flex h-9 min-w-0 items-center gap-1 rounded-[10px] border border-border pr-1 pl-3 transition-colors duration-[120ms] pointer-coarse:h-11",
          disabled
            ? "bg-surface-2 text-fg-muted"
            : "bg-surface hover:border-border-strong focus-within:border-brand focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand/55 focus-within:hover:border-brand",
        )}
      >
        <CalendarClockIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="When it runs, in words"
          aria-describedby={inputIssueId}
          disabled={disabled}
          value={text}
          placeholder='For example "every weekday at 8"'
          onChange={(event) => read(event.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm text-fg outline-none! placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:text-fg-muted pointer-coarse:text-base"
        />
        <TimeZonePicker
          value={value.timeZone}
          onChange={updateZone}
          timeZones={timeZones}
          now={now}
          disabled={disabled}
          variant="ghost"
          className="max-w-44 shrink-0"
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-xs text-fg-subtle">Try</span>
        {TEXT_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            disabled={disabled}
            onClick={() => read(example)}
            className="inline-flex h-7 items-center rounded-full border border-border bg-surface px-2.5 text-xs text-fg-muted transition-colors duration-[120ms] hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle disabled:hover:border-border pointer-coarse:h-9"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Say when something runs. Emits a `CadenceValue` (rule + time zone); map it
 * to the API with `toScheduleSpec` and describe it with `describeCadence`.
 */
export function CadencePicker({
  value,
  onChange,
  variant = "sentence",
  timeZones = NO_TIME_ZONES,
  frequencies = ALL_FREQUENCIES,
  now: nowProp,
  viewerTimeZone,
  previewCount = 3,
  disabled,
  disabledReason,
  "aria-labelledby": labelledBy,
  className,
}: CadencePickerProps) {
  const [firstRender] = useState(() => new Date());
  const now = nowProp ?? firstRender;
  const issueId = useId();
  const reasonId = useId();
  const [parseIssue, setParseIssue] = useState<string | null>(null);
  const issue = validateCadence(value.rule, { timeZone: value.timeZone, now });
  const hint = monthDayHint(value.rule);

  const parts: PartProps = {
    value,
    update: (rule) => onChange({ ...value, rule }),
    updateZone: (timeZone) => onChange({ ...value, timeZone }),
    issue,
    issueId,
    now,
    disabled,
    timeZones,
    frequencies,
  };

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      data-variant={variant}
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {variant === "presets" ? (
        <PresetsVariant {...parts} />
      ) : variant === "text" ? (
        <TextVariant {...parts} inputIssueId={issueId} onIssue={setParseIssue} />
      ) : (
        <SentenceVariant {...parts} />
      )}
      {hint && !issue ? <p className="-mt-1 text-xs leading-4.5 text-fg-muted">{hint}</p> : null}
      <CadencePreview
        id={issueId}
        value={value}
        now={now}
        timeZones={timeZones}
        viewerTimeZone={viewerTimeZone}
        count={previewCount}
        issue={variant === "text" ? parseIssue : null}
        // An error line sits 6px under the controls, like a field error.
        className={(variant === "text" && parseIssue) || issue ? "-mt-1.5" : undefined}
      />
      {disabled && disabledReason ? (
        <InlineDisabledReason id={reasonId}>{disabledReason}</InlineDisabledReason>
      ) : null}
    </div>
  );
}
