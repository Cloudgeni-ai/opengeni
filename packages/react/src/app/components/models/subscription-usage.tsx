// The one way a subscription account's usage is shown: every window its
// provider reported, each with a short label, a small bar, the share left and
// when it resets. The account menu, the model settings rows and the account
// pages all render it from `subscriptionWindows` (lib/subscription-accounts),
// so Claude, ChatGPT and SuperGrok read the same way.
import { formatAbsoluteTime, formatShortTime, useMinuteNow } from "../../../ui/relative-time";
import {
  UsageTrack,
  UsageReadout,
  usageLevel,
  usageValueText,
  type UsageWindowReading,
} from "../../../ui/usage-meter";
import { cn } from "../../lib/utils";
import type { SubscriptionWindow } from "../../lib/subscription-accounts";

/** What a window's value says: "64% left", "Limit reached", "Reset passed". */
export function subscriptionWindowValue(window: SubscriptionWindow): string {
  // Refused extra usage (spent or switched off) is unavailable, not a plan limit.
  if (window.limitReached) return window.extra ? "Unavailable" : "Limit reached";
  if (window.resetPassed) return "Reset passed";
  return usageValueText(window.leftPercent);
}

/** The sentence a screen reader hears for one window. */
export function subscriptionWindowSentence(window: SubscriptionWindow, now: number): string {
  const reset =
    window.resetsAt === null
      ? ""
      : `, ${window.limitReached ? "until" : "resets"} ${formatAbsoluteTime(window.resetsAt, { now })}`;
  return `${window.label}: ${subscriptionWindowValue(window)}${reset}`;
}

function windowLevel(window: SubscriptionWindow) {
  return window.limitReached ? "exhausted" : usageLevel(window.leftPercent);
}

/**
 * Every reported window of one account. `inline` flows the windows on one
 * line and wraps rather than truncating (menus); `stack` puts one window per
 * line (list rows, right-aligned with `align="end"`).
 */
export function SubscriptionUsageWindows({
  windows,
  layout = "inline",
  align = "start",
  empty = "No usage reading yet",
  now: fixedNow,
  className,
}: {
  windows: readonly SubscriptionWindow[];
  layout?: "inline" | "stack" | undefined;
  align?: "start" | "end" | undefined;
  /** Words when nothing was reported; null shows nothing. */
  empty?: string | null | undefined;
  /** The clock reset times are read against; defaults to the shared minute clock. */
  now?: number | undefined;
  className?: string | undefined;
}) {
  const minuteNow = useMinuteNow();
  const now = fixedNow ?? minuteNow;
  if (windows.length === 0) {
    return empty ? (
      <span
        data-slot="subscription-usage"
        className={cn("text-2xs leading-4 text-fg-subtle", className)}
      >
        {empty}
      </span>
    ) : null;
  }
  return (
    <span
      data-slot="subscription-usage"
      className={cn(
        "flex min-w-0 text-2xs leading-4",
        layout === "inline" ? "flex-wrap gap-x-3 gap-y-0.5" : "flex-col gap-0.5",
        align === "end" ? "items-end justify-end" : "items-start",
        className,
      )}
    >
      {windows.map((window) => {
        const level = windowLevel(window);
        const known = window.leftPercent !== null && !window.resetPassed;
        // A reached limit with no reported share is not given an invented one.
        const measured = known || (window.limitReached && window.leftPercent !== null);
        return (
          <span
            key={window.id}
            data-slot="subscription-usage-window"
            data-level={level}
            {...(measured
              ? {
                  role: "meter",
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-valuenow": Math.round(window.limitReached ? 0 : window.leftPercent!),
                }
              : { role: "group" })}
            aria-label={subscriptionWindowSentence(window, now)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums"
          >
            <span className="text-fg-muted">{window.label}</span>
            {known || window.limitReached ? (
              <UsageTrack
                level={level}
                fill={window.limitReached ? 0 : Math.round(window.leftPercent!)}
                className="w-8 shrink-0"
              />
            ) : null}
            <span
              className={cn(
                level === "exhausted" || level === "low" ? "font-medium text-danger" : "text-fg",
                !known && !window.limitReached && "text-fg-subtle",
              )}
            >
              {subscriptionWindowValue(window)}
            </span>
            {window.resetsAt !== null ? (
              <span className="text-fg-subtle">
                {window.limitReached ? "until " : ""}
                {formatShortTime(window.resetsAt, { now })}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** The windows as the account page's meters (UsageMeterGroup), with full reset times. */
export function subscriptionUsageReadings(
  windows: readonly SubscriptionWindow[],
  now: number,
): UsageWindowReading[] {
  return windows.map((window) => ({
    label: window.label,
    percent: window.leftPercent,
    ...(window.limitReached ? { limitReached: true } : {}),
    ...(window.resetPassed || (window.extra && window.limitReached)
      ? { valueLabel: subscriptionWindowValue(window) }
      : {}),
    ...(window.resetsAt !== null
      ? { resetsLabel: formatAbsoluteTime(window.resetsAt, { now }), resetsAt: window.resetsAt }
      : {}),
  }));
}

/**
 * The usage cell at the end of an account row in settings: every reported
 * window, one per line, right-aligned. Words when there is no reading.
 */
export function SubscriptionUsageCell({
  windows,
  loading = false,
  fallback = "No usage yet",
  now,
}: {
  windows: readonly SubscriptionWindow[];
  loading?: boolean | undefined;
  /** Words for a missing reading: "No usage yet", "Usage unavailable". */
  fallback?: string | undefined;
  now?: number | undefined;
}) {
  if (loading) return <UsageReadout percent={null} window="" loading />;
  return (
    <SubscriptionUsageWindows
      windows={windows}
      layout="stack"
      align="end"
      empty={fallback}
      now={now}
      className="text-xs leading-4.5"
    />
  );
}
