import { createContext, useContext, useSyncExternalStore } from "react";

import { ReasonTooltip } from "./disabled-reason";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import {
  type RelativeTimeFormat,
  type DateInput,
  type TimeFormatOptions,
  MINUTE,
  toDate,
  formatRelativeTime,
  formatAbsoluteTime,
  inSentence,
  formatDate,
  formatExactTime,
} from "./time-format";

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

export {
  type RelativeTimeFormat,
  type DateInput,
  type TimeFormatOptions,
  toDate,
  timeZoneLabel,
  formatRelativeTime,
  formatAbsoluteTime,
  inSentence,
  formatDate,
  formatShortTime,
  formatExactTime,
} from "./time-format";

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
