import { createContext, useContext, useSyncExternalStore } from "react";

import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { cn } from "@/lib/utils";

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
   -------------------------------------------------------------------------- */

export type RelativeTimeFormat = "relative" | "absolute" | "date";

export type DateInput = Date | string | number;

export interface TimeFormatOptions {
  /** The clock to compare against. Defaults to the current time. */
  now?: DateInput;
  /** IANA time zone. Defaults to the viewer's. Ignored when `utc` is set. */
  timeZone?: string;
  /** Show and compute times in UTC, and say so. */
  utc?: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: Record<string, string> = {
  Mon: "Mon",
  Tue: "Tue",
  Wed: "Wed",
  Thu: "Thu",
  Fri: "Fri",
  Sat: "Sat",
  Sun: "Sun",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  weekday: string;
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = partsFormatters.get(key);
  if (!formatter) {
    // en-US parts are stable (no "Sept"); labels are composed below.
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

function wallClock(date: Date, timeZone: string | undefined): WallClock {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? parts.weekday ?? "",
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

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A readable name for a time zone: "Oslo time", "UTC". */
export function timeZoneLabel(timeZone: string | undefined): string {
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const city = zone.split("/").pop()?.replaceAll("_", " ");
  return city ? `${city} time` : zone;
}

/**
 * "Just now", "48 min ago", "2 hours ago", "Yesterday", "3 days ago",
 * "2 weeks ago", "1 month ago", "2 years ago"; future times read "In 5 min",
 * "In 3 hours", "Tomorrow", "In 5 days". Sentence case for standalone labels;
 * use `inSentence` to lowercase the leading word.
 */
export function formatRelativeTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(input);
  const now = toDate(options.now ?? Date.now());
  const elapsed = now.getTime() - date.getTime();
  const future = elapsed < 0;
  const distance = Math.abs(elapsed);
  const phrase = (text: string) => (future ? `In ${text}` : `${text} ago`);

  if (distance < MINUTE) return "Just now";
  if (distance < HOUR) return phrase(`${Math.floor(distance / MINUTE)} min`);
  if (distance < DAY) return phrase(plural(Math.floor(distance / HOUR), "hour"));

  const zone = zoneOf(options);
  const days = Math.abs(calendarDays(wallClock(date, zone), wallClock(now, zone)));
  if (days <= 1) return future ? "Tomorrow" : "Yesterday";
  if (days < 14) return phrase(`${days} days`);
  if (days < 30) return phrase(plural(Math.floor(days / 7), "week"));
  if (days < 365) return phrase(plural(Math.max(1, Math.floor(days / 30)), "month"));
  return phrase(plural(Math.floor(days / 365), "year"));
}

/**
 * The one absolute format: "Mon 28 Sep, 08:00". Same-day and adjacent days
 * read "Today, 14:00", "Tomorrow, 09:00", "Yesterday, 17:30"; other years add
 * the year: "Tue 30 Mar 2027, 09:00". UTC times end in " UTC".
 */
export function formatAbsoluteTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const today = wallClock(toDate(options.now ?? Date.now()), zone);
  const offset = calendarDays(today, wall);
  const suffix = options.utc ? " UTC" : "";
  if (offset === 0) return `Today, ${clockTime(wall)}${suffix}`;
  if (offset === 1) return `Tomorrow, ${clockTime(wall)}${suffix}`;
  if (offset === -1) return `Yesterday, ${clockTime(wall)}${suffix}`;
  const year = wall.year === today.year ? "" : ` ${wall.year}`;
  return `${wall.weekday} ${wall.day} ${MONTHS[wall.month - 1]}${year}, ${clockTime(wall)}${suffix}`;
}

const SENTENCE_WORDS = /^(Just|In|Today|Tomorrow|Yesterday)\b/;

/**
 * Lowercases the leading word of a label for use inside a sentence:
 * "Yesterday" becomes "yesterday", "Today, 14:00" becomes "today, 14:00".
 * Weekdays, months and numbers keep their case.
 */
export function inSentence(label: string): string {
  return label.replace(SENTENCE_WORDS, (word) => word.toLocaleLowerCase());
}

/** A date without the time: "14 Aug", or "31 Mar 2027" in another year. */
export function formatDate(input: DateInput, options: TimeFormatOptions = {}): string {
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const today = wallClock(toDate(options.now ?? Date.now()), zone);
  const year = wall.year === today.year ? "" : ` ${wall.year}`;
  return `${wall.day} ${MONTHS[wall.month - 1]}${year}`;
}

/** The exact time for tooltips, always with the year and zone: "Wed 23 Sep 2026, 11:12 Oslo time". */
export function formatExactTime(input: DateInput, options: TimeFormatOptions = {}): string {
  const zone = zoneOf(options);
  const wall = wallClock(toDate(input), zone);
  const label = options.utc ? "UTC" : timeZoneLabel(zone);
  return `${wall.weekday} ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}, ${clockTime(wall)} ${label}`;
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
  return clockMinute;
}

function noSubscription() {
  return () => {};
}

/**
 * Defaults for times rendered inside a container. List rows turn `focusable`
 * off: the row is the tab stop, and the time still shows its tooltip on hover.
 */
export const RelativeTimeDefaultsContext = createContext<{ focusable: boolean }>({
  focusable: true,
});

export interface RelativeTimeProps extends TimeFormatOptions {
  /** The moment to show. */
  date: DateInput;
  /** "relative" (default), "absolute" or "date". The tooltip always shows the exact time. */
  format?: RelativeTimeFormat;
  /**
   * Text before the time, for example "Updated". Part of the label, not the
   * tooltip. Implies `inSentence`.
   */
  prefix?: string;
  /** Lowercase the leading word, for times inside running text. */
  inSentence?: boolean;
  /** Show the exact time in a tooltip. Default true. */
  tooltip?: boolean;
  /**
   * A tab stop so keyboard users can open the tooltip. Defaults to true, or to
   * the container's default (false inside list rows).
   */
  focusable?: boolean;
  className?: string;
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
  // A fixed `now` needs no clock; otherwise re-render once a minute.
  useSyncExternalStore(
    now === undefined ? subscribeClock : noSubscription,
    getClockMinute,
    getClockMinute,
  );
  const moment = toDate(date);
  if (Number.isNaN(moment.getTime())) return null;

  const options: TimeFormatOptions = { now, timeZone, utc };
  const text =
    format === "absolute"
      ? formatAbsoluteTime(moment, options)
      : format === "date"
        ? formatDate(moment, options)
        : formatRelativeTime(moment, options);
  const exact = formatExactTime(moment, options);
  const midSentence = inSentenceProp ?? Boolean(prefix);
  const phrase = midSentence ? inSentence(text) : text;
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
