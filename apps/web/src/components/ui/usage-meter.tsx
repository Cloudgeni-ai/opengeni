import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { DisabledReason } from "@/components/ui/disabled-reason";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   UsageMeter (design brief 7.20) - remaining quota at a glance and in detail.

   Labels are full words ("Weekly", "5-hour"), never "Wk" or "5h". Color is
   quiet until it matters: a status tone only below 10% left. Reset times are
   passed in already formatted ("Mon 28 Sep, 09:00"); the relative "Checked
   just now" line comes from the shared RelativeTime helper.

   Three looks, same data:
   - "bar"   A. 4px bar, "22% left" and the reset time. In a row the bar
             drops away and it reads as text: bar in the sheet, text in the row.
   - "text"  B. "Weekly 22% left", no bar. The quietest.
   - "ring"  C. A small ring per window. Compact, harder to compare.
   Each has two densities: "full" (account sheet) and "compact" (a row).
   -------------------------------------------------------------------------- */

export type UsageMeterVariant = "bar" | "text" | "ring";
export type UsageMeterDensity = "full" | "compact";
export type UsageLevel = "healthy" | "low" | "exhausted" | "unknown";

/** Below this share left, the meter takes the danger tone. */
export const USAGE_LOW_THRESHOLD = 10;

/**
 * The level for a reading. `percent` is what the meter measures: the share
 * left (default) or the share used (machines).
 */
export function usageLevel(
  percent: number | null | undefined,
  measure: "left" | "used" = "left",
  lowAt: number = USAGE_LOW_THRESHOLD,
): UsageLevel {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return "unknown";
  const left = measure === "left" ? percent : 100 - percent;
  if (left <= 0) return "exhausted";
  if (left < lowAt) return "low";
  return "healthy";
}

/** Clamps to 0-100 and rounds, so "21.6" never shows as "21.6% left". */
export function clampPercent(percent: number): number {
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/** The short value text: "22% left", "Limit reached", "Not reported yet". */
export function usageValueText(
  percent: number | null | undefined,
  measure: "left" | "used" = "left",
  lowAt: number = USAGE_LOW_THRESHOLD,
): string {
  const level = usageLevel(percent, measure, lowAt);
  if (level === "unknown") return "Not reported yet";
  if (level === "exhausted") return "Limit reached";
  return `${clampPercent(percent as number)}% ${measure}`;
}

/**
 * The reset time as it reads after "Resets": "Mon 28 Sep, 09:00" stays, but
 * "Today, 17:10" becomes "today, 17:10" mid-sentence.
 */
export function resetPhrase(resetsLabel: string): string {
  return /^(Today|Tomorrow|Tonight)\b/.test(resetsLabel)
    ? resetsLabel.charAt(0).toLowerCase() + resetsLabel.slice(1)
    : resetsLabel;
}

/** The sentence a screen reader hears for one meter. */
export function usageAccessibleText({
  label,
  percent,
  measure = "left",
  valueLabel,
  resetsLabel,
  lowAt,
}: {
  label: string;
  percent: number | null | undefined;
  measure?: "left" | "used";
  valueLabel?: string;
  resetsLabel?: string;
  lowAt?: number;
}): string {
  const value = valueLabel ?? usageValueText(percent, measure, lowAt);
  const reset = resetsLabel ? `, resets ${resetPhrase(resetsLabel)}` : "";
  return `${label}: ${value}${reset}`;
}

const LEVEL_FILL: Record<UsageLevel, string> = {
  healthy: "bg-brand",
  low: "bg-danger",
  exhausted: "bg-danger",
  unknown: "bg-transparent",
};

const LEVEL_STROKE: Record<UsageLevel, string> = {
  healthy: "text-brand",
  low: "text-danger",
  exhausted: "text-danger",
  unknown: "text-transparent",
};

const LEVEL_VALUE_TEXT: Record<UsageLevel, string> = {
  healthy: "text-fg-muted",
  low: "text-danger",
  exhausted: "text-danger",
  unknown: "text-fg-subtle",
};

export interface UsageMeterProps {
  /** "Weekly", "5-hour", "Memory". Never abbreviated. */
  label: string;
  /** 0-100, or null when the provider hasn't reported a reading. */
  percent: number | null;
  /** What `percent` measures. Quotas count what's left; machines count what's used. */
  measure?: "left" | "used";
  /** Overrides the value text, for example "5.1 of 16 GB". */
  valueLabel?: string;
  /** Formatted reset time, "Mon 28 Sep, 09:00". */
  resetsLabel?: string;
  /** A (bar, default), B (text) or C (ring). */
  variant?: UsageMeterVariant;
  /** "full" in a sheet, "compact" in a row. */
  density?: UsageMeterDensity;
  /** Share left below which the meter turns red. Default 10. */
  lowAt?: number;
  loading?: boolean;
  className?: string;
}

/** One quota window. */
export function UsageMeter({
  label,
  percent,
  measure = "left",
  valueLabel,
  resetsLabel,
  variant = "bar",
  density = "full",
  lowAt = USAGE_LOW_THRESHOLD,
  loading = false,
  className,
}: UsageMeterProps) {
  const level = usageLevel(percent, measure, lowAt);
  const value = valueLabel ?? usageValueText(percent, measure, lowAt);
  const shown = level === "unknown" ? 0 : clampPercent(percent as number);
  const fill = level === "exhausted" ? 0 : shown;
  const meterProps =
    loading || level === "unknown"
      ? { role: "group" as const, "aria-label": `${label} usage` }
      : {
          role: "meter" as const,
          "aria-label": `${label} usage`,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": shown,
          "aria-valuetext": usageAccessibleText({
            label,
            percent,
            measure,
            valueLabel,
            resetsLabel,
            lowAt,
          }),
        };
  const parts = { label, value, level, fill, resetsLabel, loading };
  const Root = density === "compact" ? "span" : "div";

  return (
    <Root
      data-slot="usage-meter"
      data-level={loading ? "loading" : level}
      data-variant={variant}
      aria-busy={loading || undefined}
      {...meterProps}
      className={cn("min-w-0", density === "compact" && "inline-flex max-w-full", className)}
    >
      {variant === "bar" ? (
        density === "full" ? (
          <BarFull {...parts} />
        ) : (
          <TextCompact {...parts} />
        )
      ) : variant === "text" ? (
        density === "full" ? (
          <TextFull {...parts} />
        ) : (
          <TextCompact {...parts} />
        )
      ) : density === "full" ? (
        <RingFull {...parts} />
      ) : (
        <RingCompact {...parts} />
      )}
    </Root>
  );
}

/**
 * The usage readout at the end of an account row: "78% left this week" and a
 * 64px bar, right-aligned so it sits against the row's chevron. Without a
 * reading it says why in words ("No usage yet"). Where the row folds its
 * facts into the meta line (narrow lists), only the words stay.
 */
export function UsageReadout({
  percent,
  window: windowLabel,
  resetsLabel,
  loading = false,
  fallback = "No usage yet",
  className,
}: {
  /** Share left, 0-100, or null when there is no reading. */
  percent: number | null;
  /** How the window reads after "left": "this week", "this period". */
  window: string;
  resetsLabel?: string;
  loading?: boolean;
  /** Words for a missing reading: "No usage yet", "Usage unavailable". */
  fallback?: string;
  className?: string;
}) {
  const level = usageLevel(percent);
  if (loading) {
    return (
      <span
        data-slot="usage-readout"
        aria-busy="true"
        className={cn("inline-flex items-center justify-end gap-3", className)}
      >
        <ValueSkeleton className="w-24" />
        <span
          aria-hidden="true"
          className="block h-1 w-16 rounded-full bg-surface-3 motion-safe:animate-pulse @max-[639px]/list:hidden"
        />
      </span>
    );
  }
  if (level === "unknown") {
    return (
      <span data-slot="usage-readout" className={cn("text-xs text-fg-subtle", className)}>
        {fallback}
      </span>
    );
  }
  const shown = clampPercent(percent as number);
  const text = level === "exhausted" ? "Limit reached" : `${shown}% left ${windowLabel}`;
  return (
    <span
      data-slot="usage-readout"
      role="meter"
      aria-label={`Usage ${windowLabel}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={shown}
      aria-valuetext={`${text}${resetsLabel ? `, resets ${resetPhrase(resetsLabel)}` : ""}`}
      title={resetsLabel ? `Resets ${resetPhrase(resetsLabel)}` : undefined}
      className={cn("inline-flex min-w-0 items-center justify-end gap-3", className)}
    >
      <span
        className={cn(
          "min-w-0 truncate text-xs whitespace-nowrap tabular-nums",
          LEVEL_VALUE_TEXT[level],
          level !== "healthy" && "font-medium",
        )}
      >
        {text}
      </span>
      <Track
        level={level}
        fill={level === "exhausted" ? 0 : shown}
        className="w-16 shrink-0 @max-[639px]/list:hidden"
      />
    </span>
  );
}

interface Parts {
  label: string;
  value: string;
  level: UsageLevel;
  fill: number;
  resetsLabel?: string;
  loading: boolean;
}

function ValueSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2.5 w-14 rounded-full bg-surface-3 motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

function ResetLine({ level, resetsLabel }: { level: UsageLevel; resetsLabel?: string }) {
  if (!resetsLabel) return null;
  return (
    <span className={cn(level === "exhausted" ? "text-fg" : "text-fg-subtle")}>
      Resets {resetPhrase(resetsLabel)}
    </span>
  );
}

function Track({
  level,
  fill,
  className,
}: {
  level: UsageLevel;
  fill: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block h-1 overflow-hidden rounded-full",
        level === "exhausted" ? "bg-danger/15" : "bg-surface-3",
        className,
      )}
    >
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", LEVEL_FILL[level])}
        style={{ width: `${fill}%` }}
      />
    </span>
  );
}

/* A: bar -------------------------------------------------------------------- */

function BarFull({ label, value, level, fill, resetsLabel, loading }: Parts) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-fg">{label}</span>
        {loading ? (
          <ValueSkeleton />
        ) : (
          <span
            className={cn(
              "shrink-0 text-sm whitespace-nowrap tabular-nums",
              LEVEL_VALUE_TEXT[level],
              level !== "healthy" && level !== "unknown" && "font-medium",
            )}
          >
            {value}
          </span>
        )}
      </div>
      {loading ? (
        <span
          aria-hidden="true"
          className="block h-1 rounded-full bg-surface-3 motion-safe:animate-pulse"
        />
      ) : (
        <Track level={level} fill={fill} />
      )}
      {resetsLabel && !loading ? (
        <p className="text-xs leading-4.5">
          <ResetLine level={level} resetsLabel={resetsLabel} />
        </p>
      ) : null}
    </div>
  );
}

/* B: text ------------------------------------------------------------------- */

function TextFull({ label, value, level, resetsLabel, loading }: Parts) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg">{label}</p>
        {resetsLabel && !loading ? (
          <p className="mt-0.5 text-xs leading-4.5">
            <ResetLine level={level} resetsLabel={resetsLabel} />
          </p>
        ) : null}
      </div>
      {loading ? (
        <ValueSkeleton className="mt-1.5" />
      ) : (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap tabular-nums",
            level === "healthy" ? "text-fg" : LEVEL_VALUE_TEXT[level],
            level !== "unknown" && "font-medium",
          )}
        >
          {level === "low" || level === "exhausted" ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />
          ) : null}
          {value}
        </span>
      )}
    </div>
  );
}

function TextCompact({ label, value, level, loading }: Parts) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs leading-4 whitespace-nowrap">
      <span className="text-fg-subtle">{label}</span>
      {loading ? (
        <ValueSkeleton className="w-10" />
      ) : (
        <span
          className={cn(
            "tabular-nums",
            LEVEL_VALUE_TEXT[level],
            level !== "healthy" && "font-medium",
          )}
        >
          {value}
        </span>
      )}
    </span>
  );
}

/* C: ring ------------------------------------------------------------------- */

function Ring({
  level,
  fill,
  size,
  loading,
  children,
}: {
  level: UsageLevel;
  fill: number;
  size: number;
  loading: boolean;
  children?: ReactNode;
}) {
  const stroke = size >= 32 ? 3 : 2.5;
  const radius = (size - stroke) / 2;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        loading && "motion-safe:animate-pulse",
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className={level === "exhausted" ? "stroke-danger/20" : "stroke-surface-3"}
        />
        {!loading && fill > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${fill} 100`}
            className={cn("stroke-current", LEVEL_STROKE[level])}
          />
        ) : null}
      </svg>
      {children ? (
        <span className="absolute inset-0 grid place-items-center">{children}</span>
      ) : null}
    </span>
  );
}

function RingFull({ label, value, level, fill, resetsLabel, loading }: Parts) {
  const center =
    level === "unknown" || loading ? null : (
      <span
        className={cn(
          "text-2xs font-semibold tabular-nums",
          level === "healthy" ? "text-fg" : "text-danger",
        )}
      >
        {level === "exhausted" ? "0%" : `${fill}%`}
      </span>
    );
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Ring level={level} fill={fill} size={44} loading={loading}>
        {center}
      </Ring>
      <div className="min-w-0 text-xs leading-4.5">
        <p className="truncate text-sm leading-5 font-medium text-fg">{label}</p>
        {loading ? (
          <ValueSkeleton className="mt-1" />
        ) : (
          <>
            <p className={cn(LEVEL_VALUE_TEXT[level], level !== "healthy" && "font-medium")}>
              {value}
            </p>
            {resetsLabel ? (
              <p>
                <ResetLine level={level} resetsLabel={resetsLabel} />
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function RingCompact({ label, value, level, fill, loading }: Parts) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs leading-4 whitespace-nowrap">
      <Ring level={level} fill={fill} size={14} loading={loading} />
      <span className="text-fg-subtle">{label}</span>
      {loading ? (
        <ValueSkeleton className="w-10" />
      ) : (
        <span
          className={cn(
            "tabular-nums",
            LEVEL_VALUE_TEXT[level],
            level !== "healthy" && "font-medium",
          )}
        >
          {value}
        </span>
      )}
    </span>
  );
}

/* Group --------------------------------------------------------------------- */

export interface UsageWindowReading {
  label: string;
  percent: number | null;
  resetsLabel?: string;
}

export interface UsageMeterGroupProps {
  windows: UsageWindowReading[];
  variant?: UsageMeterVariant;
  density?: UsageMeterDensity;
  /** "Checked just now". Pass a RelativeTime for the exact time on hover. */
  checked?: ReactNode;
  /** Shows a refresh button next to `checked`. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Disables the refresh button and explains why, for example a reconnect. */
  refreshDisabledReason?: ReactNode;
  /** Replaces the footer line when the last check failed. */
  error?: ReactNode;
  loading?: boolean;
  className?: string;
}

/**
 * Every window of one account: stacked in a sheet, inline in a row. The
 * footer carries when it was checked and a refresh button.
 */
export function UsageMeterGroup({
  windows,
  variant = "bar",
  density = "full",
  checked,
  onRefresh,
  refreshing = false,
  refreshDisabledReason,
  error,
  loading = false,
  className,
}: UsageMeterGroupProps) {
  if (density === "compact") {
    return (
      <span
        data-slot="usage-meter-group"
        className={cn(
          "inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1",
          className,
        )}
      >
        {windows.map((reading) => (
          <UsageMeter
            key={reading.label}
            label={reading.label}
            percent={reading.percent}
            resetsLabel={reading.resetsLabel}
            variant={variant}
            density="compact"
            loading={loading}
          />
        ))}
      </span>
    );
  }

  return (
    <div
      data-slot="usage-meter-group"
      className={cn("@container flex min-w-0 flex-col gap-4", className)}
    >
      <div
        className={cn(
          "grid min-w-0",
          variant === "ring" ? "gap-4 @sm:grid-cols-2" : variant === "text" ? "gap-3" : "gap-4",
        )}
      >
        {windows.map((reading) => (
          <UsageMeter
            key={reading.label}
            label={reading.label}
            percent={reading.percent}
            resetsLabel={reading.resetsLabel}
            variant={variant}
            density="full"
            loading={loading}
          />
        ))}
      </div>
      {error || checked || onRefresh ? (
        <div className="flex min-h-8 min-w-0 items-center justify-between gap-3">
          <p
            aria-live="polite"
            className={cn(
              "flex min-w-0 items-start gap-1.5 text-xs leading-4.5",
              error && !refreshing ? "text-fg-muted" : "text-fg-subtle",
            )}
          >
            {error && !refreshing ? (
              <CircleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-danger"
              />
            ) : null}
            <span className="min-w-0">{refreshing ? "Checking usage…" : (error ?? checked)}</span>
          </p>
          {onRefresh ? (
            <DisabledReason
              reason={refreshDisabledReason}
              disabled={Boolean(refreshDisabledReason)}
            >
              {/* aria-disabled, not disabled, while checking: a disabled button drops keyboard focus. */}
              <button
                type="button"
                onClick={refreshing ? undefined : onRefresh}
                aria-disabled={refreshing || undefined}
                aria-label="Check usage now"
                className="-mr-2 inline-grid size-8 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-subtle pointer-coarse:-mr-3.5 pointer-coarse:size-11"
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={cn("size-4", refreshing && "motion-safe:animate-spin")}
                />
              </button>
            </DisabledReason>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
