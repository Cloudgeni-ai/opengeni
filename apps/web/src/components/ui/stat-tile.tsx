import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   StatTile (design brief 7, "Also build") - one number, one style for
   Insights, Billing and Machines.

   Label (12px muted), a tabular value (20/28 semibold), an optional delta
   against the previous period and an optional sparkline. Tiles sit flat on
   the page inside one StatGroup with hairline dividers, never a card each.
   -------------------------------------------------------------------------- */

export type StatTrend = "up" | "down" | "flat";
/** Whether the change is good news. Money and volume are usually "neutral". */
export type StatSentiment = "positive" | "negative" | "neutral";

export interface StatDelta {
  /** Display text, "+12%" or "-2". */
  value: string;
  trend: StatTrend;
  sentiment?: StatSentiment;
  /** "vs previous 7 days". */
  comparison?: string;
}

const SENTIMENT_TEXT: Record<StatSentiment, string> = {
  positive: "text-status-idle",
  negative: "text-danger",
  neutral: "text-fg-muted",
};

const TREND_ICON = {
  up: ArrowUpRightIcon,
  down: ArrowDownRightIcon,
  flat: MinusIcon,
} as const;

const TREND_WORD: Record<StatTrend, string> = {
  up: "Up",
  down: "Down",
  flat: "No change",
};

export interface StatTileProps {
  label: string;
  /** Preformatted: "1,284", "$312.40", "48.2M". Rendered with tabular numbers. */
  value?: ReactNode;
  /** A small unit after the value: "GB", "sessions". */
  unit?: ReactNode;
  delta?: StatDelta;
  /** One muted line under the value (and under the delta when both): "Of 16 GB". */
  caption?: ReactNode;
  /** Values oldest to newest; drawn as a line under the number. */
  sparkline?: number[];
  loading?: boolean;
  /** Shown instead of the value when there's no data: "No sessions yet". */
  empty?: ReactNode;
  /** Draw its own border. Off inside a StatGroup. */
  framed?: boolean;
  className?: string;
}

/** Normalizes values into SVG points in a 100 x 32 box. Exported for tests. */
export function sparklinePoints(values: number[], width = 100, height = 32, inset = 2): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = values.length > 1 ? index * step : width / 2;
      const y =
        max === min ? height / 2 : inset + (1 - (value - min) / span) * (height - inset * 2);
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  const points = sparklinePoints(values);
  if (!points) return null;
  const area = `0,32 ${points} 100,32`;
  return (
    <div className="mt-auto pt-3">
      <svg
        aria-hidden="true"
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        className="block h-8 w-full overflow-visible text-brand"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  caption,
  sparkline,
  loading = false,
  empty,
  framed = false,
  className,
}: StatTileProps) {
  const isEmpty = !loading && (value === undefined || value === null) && empty;
  const TrendIcon = delta ? TREND_ICON[delta.trend] : null;
  return (
    <div
      data-slot="stat-tile"
      aria-busy={loading || undefined}
      className={cn(
        "flex min-w-0 flex-col p-4",
        framed && "rounded-lg border border-border",
        className,
      )}
    >
      <p className="truncate text-xs leading-4.5 font-medium text-fg-muted">{label}</p>
      {loading ? (
        <>
          <span className="sr-only">Loading {label}</span>
          <span
            aria-hidden="true"
            className="mt-2 block h-5 w-24 rounded-md bg-surface-3 motion-safe:animate-pulse"
          />
          <span
            aria-hidden="true"
            className="mt-2.5 block h-2.5 w-32 rounded-full bg-surface-2 motion-safe:animate-pulse"
          />
        </>
      ) : isEmpty ? (
        <p className="mt-1 text-sm leading-7 text-fg-subtle">{empty}</p>
      ) : (
        <>
          <p className="mt-1 flex min-w-0 items-baseline gap-1">
            <span className="truncate text-xl leading-7 font-semibold tracking-[-0.25px] text-fg tabular-nums">
              {value}
            </span>
            {unit ? <span className="shrink-0 text-xs text-fg-subtle">{unit}</span> : null}
          </p>
          {delta && TrendIcon ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-4.5">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-0.5 font-medium tabular-nums",
                  SENTIMENT_TEXT[delta.sentiment ?? "neutral"],
                )}
              >
                <TrendIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">{TREND_WORD[delta.trend]} </span>
                {delta.value}
              </span>
              {delta.comparison ? (
                <span className="min-w-0 text-fg-subtle">{delta.comparison}</span>
              ) : null}
            </p>
          ) : null}
          {caption ? (
            <p className="mt-1 truncate text-xs leading-4.5 text-fg-subtle">{caption}</p>
          ) : null}
        </>
      )}
      {sparkline && sparkline.length > 1 && !loading && !isEmpty ? (
        <Sparkline values={sparkline} />
      ) : null}
    </div>
  );
}

/**
 * Tiles side by side with hairline dividers, in one bordered frame. Columns
 * follow the frame's own width: one under 320px, two under 768px, then all.
 */
export function StatGroup({
  children,
  columns = 4,
  label,
  className,
}: {
  children: ReactNode;
  /** Columns at full width. */
  columns?: 2 | 3 | 4;
  /** Accessible name for the group, for example "Last 7 days". */
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="stat-group"
      className={cn(
        "@container min-w-0 overflow-hidden rounded-lg border border-border",
        className,
      )}
    >
      <div
        className={cn(
          "grid min-w-0 [&>*]:-mt-px [&>*]:-ml-px [&>*]:border-t [&>*]:border-l [&>*]:border-border",
          "@xs:grid-cols-2",
          columns === 3 && "@3xl:grid-cols-3",
          columns === 4 && "@3xl:grid-cols-4",
        )}
      >
        {children}
      </div>
    </div>
  );
}
