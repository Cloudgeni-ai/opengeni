import { createContext, useContext, useSyncExternalStore } from "react";

import { ReasonTooltip } from "./disabled-reason";
import { cn } from "../lib/cn";
import {
  createOpenGeniText,
  useOpenGeniText,
  type OpenGeniMessageKey,
  type OpenGeniText,
} from "../messages/runtime";

/* ----------------------------------------------------------------------------
   RelativeTime (design brief, "Also build").

   "3 days ago" with the exact local time in a real tooltip (hover, focus and
   tap), and one absolute format everywhere:
   - relative: "Just now", "48 min ago", "2 hours ago", "Yesterday",
     "3 days ago", "2 weeks ago", "1 month ago"; future "In 5 days".
     Mid-sentence (after a prefix, or `inSentence`) the leading word is
     lowercased: "Updated yesterday", "Expires in 5 days".
   - absolute: "Mon 28 Sep, 08:00", "Today, 14:00", "Tue 30 Mar 2027, 09:00".
   - date:     "14 Aug", "31 Mar 2027".
   - exact (tooltip): "Wed 23 Sep 2026, 11:12 Oslo time".
   Never seconds, never ISO. The explicit UTC variant is for Insights, where
   times are compared across people: "Wed 23 Sep 2026, 09:12 UTC".

   Every word and layout comes from the host's message catalog (`time.*`):
   the component reads `useOpenGeniText()`, and the pure functions take it as
   `text` in their options, English when omitted. Clock times stay 24-hour.
   -------------------------------------------------------------------------- */

export type RelativeTimeFormat = "relative" | "absolute" | "date";

export type DateInput = Date | string | number;

export interface TimeFormatOptions {
  /** The clock to compare against. Defaults to the current time. */
  now?: DateInput | undefined;
  /** IANA time zone. Defaults to the viewer's. Ignored when `utc` is set. */
  timeZone?: string | undefined;
  /** Show and compute times in UTC, and say so. */
  utc?: boolean | undefined;
  /** The host's words, from `useOpenGeniText()`. English when omitted. */
  text?: OpenGeniText | undefined;
}

const ENGLISH = createOpenGeniText();

const MONTH_KEYS = [
  "time.month.jan",
  "time.month.feb",
  "time.month.mar",
  "time.month.apr",
  "time.month.may",
  "time.month.jun",
  "time.month.jul",
  "time.month.aug",
  "time.month.sep",
  "time.month.oct",
  "time.month.nov",
  "time.month.dec",
] as const satisfies readonly OpenGeniMessageKey[];

/** Keyed by the stable en-US short weekday the parts formatter returns. */
const WEEKDAY_KEYS = {
  Mon: "time.weekday.mon",
  Tue: "time.weekday.tue",
  Wed: "time.weekday.wed",
  Thu: "time.weekday.thu",
  Fri: "time.weekday.fri",
  Sat: "time.weekday.sat",
  Sun: "time.weekday.sun",
} as const satisfies Record<string, OpenGeniMessageKey>;

type WeekdayKey = (typeof WEEKDAY_KEYS)[keyof typeof WEEKDAY_KEYS];

/** Names that open a label and keep their case inside a sentence. */
const NAME_KEYS: readonly (WeekdayKey | (typeof MONTH_KEYS)[number])[] = [
  ...MONTH_KEYS,
  ...Object.values(WEEKDAY_KEYS),
];

/** Past and future phrase keys for each relative unit. */
const RELATIVE_KEYS = {
  minute: ["time.minutesAgo", "time.inMinutes"],
  hour: ["time.hoursAgo", "time.inHours"],
  day: ["time.daysAgo", "time.inDays"],
  week: ["time.weeksAgo", "time.inWeeks"],
  month: ["time.monthsAgo", "time.inMonths"],
  year: ["time.yearsAgo", "time.inYears"],
} as const satisfies Record<string, readonly [OpenGeniMessageKey, OpenGeniMessageKey]>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  /** en-US short weekday ("Mon"), a lookup key rather than display text. */
  weekday: string;
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = partsFormatters.get(key);
  if (!formatter) {
    // en-US parts are stable; display words come from the message catalog.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    partsFormatters.set(key, formatter);
  }
  return formatter;
}

function zoneOf(options: TimeFormatOptions): string | undefined {
  return options.utc ? "UTC" : options.timeZone;
}

function textOf(options: TimeFormatOptions): OpenGeniText {
  return options.text ?? ENGLISH;
}

function wallClock(date: Date, timeZone: string | undefined): WallClock {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday ?? "",
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Whole calendar days from `from` to `to` in one time zone (negative in the past). */
function calendarDays(from: WallClock, to: WallClock): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / DAY,
  );
}

export function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clockTime(wall: WallClock): string {
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

function weekdayName(wall: WallClock, text: OpenGeniText): string {
  const keys: Readonly<Record<string, WeekdayKey | undefined>> = WEEKDAY_KEYS;
  const key = keys[wall.weekday];
  return key ? text(key) : wall.weekday;
}

function monthName(wall: WallClock, text: OpenGeniText): string {
  return text(MONTH_KEYS[wall.month - 1] ?? "time.month.jan");
}

/** The calendar parts the date templates interpolate. */
function dateParts(wall: WallClock, text: OpenGeniText) {
  return {
    weekday: weekdayName(wall, text),
    day: wall.day,
    month: monthName(wall, text),
    year: wall.year,
    time: clockTime(wall),
  };
}

/** UTC times say so: "Today, 14:00 UTC". */
function inZone(label: string, options: TimeFormatOptions, text: OpenGeniText): string {
  return options.utc ? text("time.inUtc", { label }) : label;
}

/** A readable name for a time zone: "Oslo time", "UTC". */
export function timeZoneLabel(timeZone: string | undefined, text: OpenGeniText = ENGLISH): string {
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === "UTC" || zone === "Etc/UTC") return text("time.utc");
  const city = zone.split("/").pop()?.replaceAll("_", " ");
  return city ? text("time.zoneTime", { city }) : zone;
}

/**
 * "Just now", "48 min ago", "2 hours ago", "Yesterday", "3 days ago",
 * "2 weeks ago", "1 month ago", "2 years ago"; future times read "In 5 min",
 * "In 3 hours", "Tomorrow", "In 5 days". Sentence case for standalone labels;
 * use `inSentence` to lowercase the leading word.
 */
export function formatRelativeTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const text = textOf(options);
  const date = toDate(input);
  const now = toDate(options.now ?? Date.now());
  const elapsed = now.getTime() - date.getTime();
  const future = elapsed < 0;
  const distance = Math.abs(elapsed);
  const phrase = (unit: keyof typeof RELATIVE_KEYS, count: number) =>
    text(RELATIVE_KEYS[unit][future ? 1 : 0], { count });

  if (distance < MINUTE) return text("time.justNow");
  if (distance < HOUR) return phrase("minute", Math.floor(distance / MINUTE));
  if (distance < DAY) return phrase("hour", Math.floor(distance / HOUR));

  const zone = zoneOf(options);
  const days = Math.abs(calendarDays(wallClock(date, zone), wallClock(now, zone)));
  if (days <= 1) return text(future ? "time.tomorrow" : "time.yesterday");
  if (days < 14) return phrase("day", days);
  if (days < 30) return phrase("week", Math.floor(days / 7));
  if (days < 365) return phrase("month", Math.max(1, Math.floor(days / 30)));
  return phrase("year", Math.floor(days / 365));
}

/**
 * The one absolute format: "Mon 28 Sep, 08:00". Same-day and adjacent days
 * read "Today, 14:00", "Tomorrow, 09:00", "Yesterday, 17:30"; other years add
 * the year: "Tue 30 Mar 2027, 09:00". UTC times end in " UTC".
 */
export function formatAbsoluteTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const text = textOf(options);
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const today = wallClock(toDate(options.now ?? Date.now()), zone);
  const offset = calendarDays(today, wall);
  const time = clockTime(wall);
  const label =
    offset === 0
      ? text("time.todayAt", { time })
      : offset === 1
        ? text("time.tomorrowAt", { time })
        : offset === -1
          ? text("time.yesterdayAt", { time })
          : wall.year === today.year
            ? text("time.dateTime", dateParts(wall, text))
            : text("time.dateTimeWithYear", dateParts(wall, text));
  return inZone(label, options, text);
}

/**
 * Lowercases the leading word of a label for use inside a sentence:
 * "Yesterday" becomes "yesterday", "Today, 14:00" becomes "today, 14:00".
 * Weekdays, months and numbers keep their case. Pass the same `text` the
 * label was formatted with, so its weekday and month names are recognized.
 */
export function inSentence(label: string, text: OpenGeniText = ENGLISH): string {
  const codePoint = label.codePointAt(0);
  if (codePoint === undefined) return label;
  const first = String.fromCodePoint(codePoint);
  const lower = lowerCase(first, text.locale);
  if (lower === first) return label;
  for (const key of NAME_KEYS) {
    if (label.startsWith(text(key))) return label;
  }
  return lower + label.slice(first.length);
}

function lowerCase(value: string, locale: string | undefined): string {
  try {
    return value.toLocaleLowerCase(locale);
  } catch {
    return value.toLowerCase();
  }
}

/** A date without the time: "14 Aug", or "31 Mar 2027" in another year. */
export function formatDate(input: DateInput, options: TimeFormatOptions = {}): string {
  const text = textOf(options);
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const today = wallClock(toDate(options.now ?? Date.now()), zone);
  const parts = dateParts(wall, text);
  return wall.year === today.year ? text("time.date", parts) : text("time.dateWithYear", parts);
}

/**
 * The shortest unambiguous label for an upcoming time, for a dense row: the
 * clock alone later today ("14:20"), the weekday within the coming week
 * ("Thu 09:00"), otherwise the date ("16 Oct", "3 Jan 2027"). Use
 * `formatAbsoluteTime` wherever there is room for the full label.
 */
export function formatShortTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const text = textOf(options);
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const today = wallClock(toDate(options.now ?? Date.now()), zone);
  const offset = calendarDays(today, wall);
  if (offset === 0) return inZone(clockTime(wall), options, text);
  if (offset > 0 && offset < 7) {
    return inZone(text("time.weekdayTime", dateParts(wall, text)), options, text);
  }
  return formatDate(input, options);
}

/** The exact time for tooltips, always with the year and zone: "Wed 23 Sep 2026, 11:12 Oslo time". */
export function formatExactTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const text = textOf(options);
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const label = options.utc ? text("time.utc") : timeZoneLabel(zone, text);
  return text("time.exact", { ...dateParts(wall, text), zone: label });
}

/* ----------------------------------------------------------------------------
   A shared minute clock, so live labels ("just now" -> "1 min ago") update
   together with one timer, and only while something is mounted.
   -------------------------------------------------------------------------- */

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockMinute = Math.floor(Date.now() / MINUTE);

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      const minute = Math.floor(Date.now() / MINUTE);
      if (minute === clockMinute) return;
      clockMinute = minute;
      for (const each of clockListeners) each();
    }, 15_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockMinute() {
  return Math.floor(Date.now() / MINUTE);
}

function noSubscription() {
  return () => {};
}

/** Shared clock for quota expiry and the accompanying time labels. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribeClock, getClockMinute, getClockMinute) * MINUTE;
}

/**
 * Defaults for times rendered inside a container. List rows turn `focusable`
 * off: the row is the tab stop, and the time still shows its tooltip on hover.
 */
export const RelativeTimeDefaultsContext = createContext<{ focusable: boolean }>({
  focusable: true,
});

export interface RelativeTimeProps extends Omit<TimeFormatOptions, "text"> {
  /** The moment to show. */
  date: DateInput;
  /** "relative" (default), "absolute" or "date". The tooltip always shows the exact time. */
  format?: RelativeTimeFormat | undefined;
  /**
   * Text before the time, for example "Updated". Part of the label, not the
   * tooltip. Implies `inSentence`.
   */
  prefix?: string | undefined;
  /** Lowercase the leading word, for times inside running text. */
  inSentence?: boolean | undefined;
  /** Show the exact time in a tooltip. Default true. */
  tooltip?: boolean | undefined;
  /**
   * A tab stop so keyboard users can open the tooltip. Defaults to true, or to
   * the container's default (false inside list rows).
   */
  focusable?: boolean | undefined;
  className?: string | undefined;
}

export function RelativeTime({
  date,
  format = "relative",
  prefix,
  inSentence: inSentenceProp,
  tooltip = true,
  focusable: focusableProp,
  now,
  timeZone,
  utc,
  className,
}: RelativeTimeProps) {
  const defaults = useContext(RelativeTimeDefaultsContext);
  const words = useOpenGeniText();
  // A fixed `now` needs no clock; otherwise re-render once a minute.
  useSyncExternalStore(
    now === undefined ? subscribeClock : noSubscription,
    getClockMinute,
    getClockMinute,
  );
  const moment = toDate(date);
  if (Number.isNaN(moment.getTime())) return null;

  const options: TimeFormatOptions = { now, timeZone, utc, text: words };
  const text =
    format === "absolute"
      ? formatAbsoluteTime(moment, options)
      : format === "date"
        ? formatDate(moment, options)
        : formatRelativeTime(moment, options);
  const exact = formatExactTime(moment, options);
  const midSentence = inSentenceProp ?? Boolean(prefix);
  const phrase = midSentence ? inSentence(text, words) : text;
  const label = prefix ? `${prefix} ${phrase}` : phrase;
  const focusable = tooltip && (focusableProp ?? defaults.focusable);

  const element = (
    <time
      data-slot="relative-time"
      dateTime={moment.toISOString()}
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        "whitespace-nowrap tabular-nums",
        tooltip &&
          "cursor-default underline decoration-transparent decoration-dotted underline-offset-2",
        tooltip && "transition-[text-decoration-color] duration-[120ms] hover:decoration-current",
        // Tab stops get the app's global focus outline.
        focusable && "rounded-[4px] focus-visible:decoration-current",
        className,
      )}
    >
      {label}
      {/* The exact time for screen readers when the tooltip is out of reach. */}
      {tooltip && !focusable ? <span className="sr-only">, {exact}</span> : null}
    </time>
  );

  // A click opens the tooltip only when the time is its own tab stop; inside a
  // list row a click belongs to the row.
  return tooltip ? (
    <ReasonTooltip reason={exact} openOnClick={focusable}>
      {element}
    </ReasonTooltip>
  ) : (
    element
  );
}
