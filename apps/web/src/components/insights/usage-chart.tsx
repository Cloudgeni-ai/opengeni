import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "@/lib/utils";

export type ChartSeries = {
  id: string;
  label: string;
  /** Tailwind text-* (fill: currentColor) and bg-* tone classes. */
  text: string;
  bg: string;
};

export type ChartBucket = {
  key: string;
  label: string;
  /** Long label for the tooltip. */
  title: string;
  /** Value per series id; missing means zero. */
  values: Record<string, number>;
};

function useWidth(initial = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A "nice" axis maximum and step for about four gridlines. Exported for tests. */
export function niceScale(max: number): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const nice =
    residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  const step = nice * magnitude;
  return { max: Math.ceil(max / step) * step, step };
}

/**
 * Stacked bars over time, one bar per bucket. Thin bars with a 2px surface gap
 * between segments, a 4px rounded top, recessive gridlines, a crosshair band
 * and a tooltip per bucket. Arrow keys move through buckets.
 */
export function StackedBarChart(props: {
  buckets: readonly ChartBucket[];
  series: readonly ChartSeries[];
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
  /** Accessible name: "Spend per day". */
  label: string;
  height?: number;
  /** Hide the legend for one series (the title names it). */
  showLegend?: boolean;
  className?: string;
}) {
  const [frameRef, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 220;
  const padLeft = 52;
  const padRight = 8;
  const padTop = 10;
  const padBottom = 24;
  const innerW = Math.max(40, width - padLeft - padRight);
  const innerH = height - padTop - padBottom;
  const totals = props.buckets.map((bucket) =>
    props.series.reduce((sum, series) => sum + Math.max(0, bucket.values[series.id] ?? 0), 0),
  );
  const scale = niceScale(Math.max(0, ...totals));
  const band = innerW / Math.max(1, props.buckets.length);
  const barWidth = Math.max(2, Math.min(28, band * 0.62));
  const ticks: number[] = [];
  for (let value = 0; value <= scale.max + scale.step / 2; value += scale.step) ticks.push(value);
  const y = (value: number) => padTop + innerH - (value / scale.max) * innerH;
  const labelStride = Math.max(
    1,
    Math.ceil(props.buckets.length / Math.max(2, Math.floor(innerW / 64))),
  );
  const empty = totals.every((total) => total === 0);

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width - padLeft;
    const index = Math.floor(localX / band);
    setActive(index >= 0 && index < props.buckets.length ? index : null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const current = active ?? 0;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - 1;
    if (event.key === "ArrowRight") next = current + 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = props.buckets.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(props.buckets.length - 1, next)));
  };

  const describe = (index: number) => {
    const bucket = props.buckets[index];
    if (!bucket) return "";
    const parts = props.series
      .filter((series) => (bucket.values[series.id] ?? 0) > 0)
      .map((series) => `${series.label} ${props.formatValue(bucket.values[series.id] ?? 0)}`);
    return `${bucket.title}: ${props.formatValue(totals[index] ?? 0)}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`;
  };

  const activeBucket = active === null ? null : props.buckets[active];
  const tooltipLeftPct =
    active === null ? 0 : ((padLeft + band * (active + 0.5)) / Math.max(1, width)) * 100;

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", props.className)}>
      {(props.showLegend ?? props.series.length > 1) ? (
        <ul aria-label="Legend" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
          {props.series.map((series) => (
            <li
              key={series.id}
              className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted"
            >
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-[3px]", series.bg)} />
              <span className="truncate">{series.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={frameRef} className="relative w-full" onPointerLeave={() => setActive(null)}>
        {activeBucket ? (
          <div
            data-chart-tooltip
            className="pointer-events-none absolute top-0 z-10 w-max max-w-56 min-w-40 -translate-x-1/2 rounded-lg border border-border bg-surface-3/95 px-2.5 py-2 shadow-sm backdrop-blur-md"
            style={{ left: `clamp(112px, ${tooltipLeftPct}%, calc(100% - 112px))` }}
          >
            <p className="text-2xs font-medium text-fg-subtle">{activeBucket.title}</p>
            <p className="mt-0.5 text-xs font-semibold text-fg tabular-nums">
              {props.formatValue(totals[active!] ?? 0)}
            </p>
            {props.series.length > 1 ? (
              <div className="mt-1.5 grid gap-1">
                {[...props.series]
                  .reverse()
                  .filter((series) => (activeBucket.values[series.id] ?? 0) > 0)
                  .map((series) => (
                    <div
                      key={series.id}
                      className="flex items-center justify-between gap-4 text-2xs"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-muted">
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 shrink-0 rounded-full", series.bg)}
                        />
                        <span className="truncate">{series.label}</span>
                      </span>
                      <span className="text-fg tabular-nums">
                        {props.formatValue(activeBucket.values[series.id] ?? 0)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-auto w-full touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-fg/30"
          role="img"
          aria-label={`${props.label}. ${empty ? "No usage." : "Use the arrow keys to read each bar."}`}
          tabIndex={empty ? -1 : 0}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? props.buckets.length - 1)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? "stroke-border" : "stroke-border/50"}
                strokeWidth={1}
                strokeDasharray={tick === 0 ? undefined : "2 4"}
              />
              <text
                x={padLeft - 8}
                y={y(tick) + 3}
                textAnchor="end"
                className="fill-fg-subtle"
                style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
              >
                {props.formatAxis(tick)}
              </text>
            </g>
          ))}
          {active !== null ? (
            <rect
              x={padLeft + band * active}
              y={padTop}
              width={band}
              height={innerH}
              className="fill-fg/[0.05]"
              rx={4}
            />
          ) : null}
          {props.buckets.map((bucket, index) => {
            const x = padLeft + band * index + (band - barWidth) / 2;
            let base = 0;
            const visible = props.series.filter((series) => (bucket.values[series.id] ?? 0) > 0);
            return (
              <g key={bucket.key} opacity={active === null || active === index ? 1 : 0.55}>
                {visible.map((series, segment) => {
                  const value = bucket.values[series.id] ?? 0;
                  const top = y(base + value);
                  const bottom = y(base);
                  base += value;
                  const gap = segment > 0 ? 1 : 0;
                  const h = Math.max(0, bottom - top - gap);
                  if (h <= 0) return null;
                  const isTop = segment === visible.length - 1;
                  const r = isTop ? Math.min(4, barWidth / 2, h) : 0;
                  return (
                    <path
                      key={series.id}
                      className={series.text}
                      fill="currentColor"
                      d={roundedTopRect(x, top, barWidth, h, r)}
                    />
                  );
                })}
              </g>
            );
          })}
          {props.buckets.map((bucket, index) =>
            index % labelStride === 0 || index === props.buckets.length - 1 ? (
              index !== props.buckets.length - 1 &&
              props.buckets.length - 1 - index < labelStride / 2 ? null : (
                <text
                  key={`label-${bucket.key}`}
                  x={padLeft + band * (index + 0.5)}
                  y={height - 6}
                  textAnchor="middle"
                  className={active === index ? "fill-fg" : "fill-fg-subtle"}
                  style={{ fontSize: 10 }}
                >
                  {bucket.label}
                </text>
              )
            ) : null,
          )}
        </svg>
        <span className="sr-only" aria-live="polite">
          {active !== null ? describe(active) : ""}
        </span>
      </div>
    </div>
  );
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
