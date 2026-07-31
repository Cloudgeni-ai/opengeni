import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useId,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

type Series = {
  id: string;
  label: string;
  values: number[];
  className: string;
};

export type DonutSlice = {
  id: string;
  label: string;
  value: number;
  /** Tailwind text-* class used for fill-current */
  toneClass: string;
};

const DONUT_TONES = [
  "text-brand",
  "text-status-running",
  "text-status-waiting",
  "text-fg-muted",
  "text-status-failed",
  "text-status-idle",
  "text-fg",
] as const;

export function donutTone(index: number): string {
  return DONUT_TONES[index % DONUT_TONES.length]!;
}

function smoothLine(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`;
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

function formatChartNumber(value: number, digits?: number): string {
  if (digits != null) return value.toFixed(digits);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(1);
}

export function AreaChart(props: {
  labels: readonly string[];
  series: Series[];
  height?: number;
  className?: string;
  valuePrefix?: string;
  valueSuffix?: string;
  /** Fixed decimal places for tooltip / axis */
  valueDigits?: number;
  /** Soft y-axis floor for percentage charts */
  yMax?: number;
}) {
  const reduceMotion = useReducedMotion();
  const gradId = useId();
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 220;
  const width = 720;
  const padL = 36;
  const padR = 12;
  const padTop = 16;
  const padBottom = 6;
  const all = props.series.flatMap((s) => s.values);
  const dataMax = Math.max(...all, 0);
  const max = props.yMax ?? Math.max(dataMax * 1.12, 1);
  const innerW = width - padL - padR;
  const innerH = height - padTop - padBottom;

  const geometry = useMemo(() => {
    return props.series.map((series) => {
      const points = series.values.map((value, i) => {
        const x =
          padL +
          (series.values.length <= 1 ? innerW / 2 : (i / (series.values.length - 1)) * innerW);
        const y = padTop + innerH - (value / max) * innerH;
        return { x, y, value };
      });
      const line = smoothLine(points);
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const area = `${line} L${last.x},${padTop + innerH} L${first.x},${padTop + innerH} Z`;
      return { series, points, line, area };
    });
  }, [props.series, innerH, innerW, max, padTop]);

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = (localX - padL) / innerW;
    const index = Math.round(ratio * (props.labels.length - 1));
    setActive(Math.max(0, Math.min(props.labels.length - 1, index)));
  };

  const activeX =
    active == null
      ? null
      : padL + (active / Math.max(props.labels.length - 1, 1)) * innerW;

  const ticks = [0, 0.5, 1];

  return (
    <div className={cn("relative w-full", props.className)} onPointerLeave={() => setActive(null)}>
      <AnimatePresence>
        {active != null ? (
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute top-0 z-10 min-w-[7.5rem] rounded-lg border border-border bg-surface-3/95 px-2.5 py-2 shadow-sm backdrop-blur-md"
            style={{
              left: `clamp(0px, calc(${(active / Math.max(props.labels.length - 1, 1)) * 100}% - 40px), calc(100% - 130px))`,
            }}
          >
            <p className="text-2xs font-medium text-fg-subtle">{props.labels[active]}</p>
            <div className="mt-1.5 grid gap-1">
              {props.series.map((series) => (
                <div key={series.id} className="flex items-center justify-between gap-4 text-2xs">
                  <span className={cn("inline-flex items-center gap-1.5", series.className)}>
                    <span className="size-1.5 rounded-full bg-current" />
                    <span className="text-fg-muted">{series.label}</span>
                  </span>
                  <span className="font-mono tabular-nums text-fg">
                    {props.valuePrefix}
                    {formatChartNumber(series.values[active]!, props.valueDigits)}
                    {props.valueSuffix}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full cursor-crosshair overflow-visible"
        role="img"
        aria-label="Trend chart"
        onPointerMove={onMove}
      >
        <defs>
          {geometry.map(({ series }, index) => (
            <linearGradient key={series.id} id={`${gradId}-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
              <stop offset="70%" stopColor="currentColor" stopOpacity={0.05} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>

        {/* baseline */}
        <line
          x1={padL}
          x2={width - padR}
          y1={padTop + innerH}
          y2={padTop + innerH}
          className="stroke-border"
          strokeWidth={1}
        />

        {ticks.map((t) => {
          const y = padTop + innerH * (1 - t);
          const label = max * t;
          return (
            <g key={t}>
              {t > 0 ? (
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={y}
                  y2={y}
                  className="stroke-border/40"
                  strokeWidth={1}
                  strokeDasharray="2 6"
                />
              ) : null}
              <text
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-fg-subtle"
                style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
              >
                {props.valuePrefix}
                {formatChartNumber(label, props.valueDigits ?? (max >= 50 ? 0 : 0))}
                {props.valueSuffix}
              </text>
            </g>
          );
        })}

        {activeX != null ? (
          <motion.rect
            x={activeX - innerW / props.labels.length / 2}
            y={padTop}
            width={Math.max(innerW / props.labels.length, 12)}
            height={innerH}
            className="fill-fg/[0.04]"
            initial={false}
            animate={{ x: activeX - innerW / props.labels.length / 2 }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
          />
        ) : null}

        {geometry.map(({ series, line, area, points }, index) => (
          <g key={series.id} className={series.className}>
            <motion.path
              d={area}
              fill={`url(#${gradId}-${index})`}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.08 + index * 0.06, ease: [0.22, 1, 0.36, 1] }}
            />
            <motion.path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
            />
            {points.map((point, i) => (
              <circle
                key={`${series.id}-x${point.x}`}
                cx={point.x}
                cy={point.y}
                r={active === i ? 4.5 : 2.25}
                className={cn(
                  "stroke-bg transition-[r]",
                  active === i || active == null ? "opacity-100" : "opacity-40",
                )}
                fill="currentColor"
                strokeWidth={active === i ? 2 : 1.5}
              />
            ))}
          </g>
        ))}

        {activeX != null ? (
          <line
            x1={activeX}
            x2={activeX}
            y1={padTop}
            y2={padTop + innerH}
            className="stroke-fg/25"
            strokeWidth={1}
          />
        ) : null}
      </svg>

      <div className="mt-1 flex justify-between pl-9 pr-1">
        {props.labels.map((label, index) => (
          <button
            key={label}
            type="button"
            onMouseEnter={() => setActive(index)}
            className={cn(
              "min-w-0 truncate text-2xs transition-colors",
              active === index ? "font-medium text-fg" : "text-fg-subtle",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function polar(cx: number, cy: number, r: number, angle: number) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const large = endAngle - startAngle > 180 ? 1 : 0;
  const o1 = polar(cx, cy, rOuter, startAngle);
  const o2 = polar(cx, cy, rOuter, endAngle);
  const i1 = polar(cx, cy, rInner, endAngle);
  const i2 = polar(cx, cy, rInner, startAngle);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${i2.x} ${i2.y}`,
    "Z",
  ].join(" ");
}

export function DonutChart(props: {
  slices: DonutSlice[];
  className?: string;
  /** Center primary line */
  centerValue?: ReactNode;
  centerLabel?: string;
  formatValue?: (value: number) => string;
  onSelect?: (id: string) => void;
  size?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [hover, setHover] = useState<string | null>(null);
  const size = props.size ?? 176;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.27;
  const total = props.slices.reduce((n, s) => n + s.value, 0);
  const format = props.formatValue ?? ((v: number) => formatChartNumber(v));

  const arcs = useMemo(() => {
    if (total <= 0) return [];
    let angle = 0;
    return props.slices
      .filter((s) => s.value > 0)
      .map((slice) => {
        const sweep = (slice.value / total) * 360;
        // Leave a tiny gap between slices for clarity
        const gap = props.slices.length > 1 ? 1.2 : 0;
        const start = angle + gap / 2;
        const end = angle + sweep - gap / 2;
        angle += sweep;
        const mid = (start + end) / 2;
        return {
          slice,
          path: arcPath(cx, cy, rOuter, rInner, start, Math.max(start + 0.01, end)),
          mid,
          pct: Math.round((slice.value / total) * 100),
        };
      });
  }, [props.slices, total, cx, cy, rOuter, rInner]);

  const active = arcs.find((a) => a.slice.id === hover) ?? null;

  return (
    <div className={cn("flex flex-col items-stretch gap-4 sm:flex-row sm:items-center", props.className)}>
      <div className="relative mx-auto shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full overflow-visible" role="img">
          {total <= 0 ? (
            <circle
              cx={cx}
              cy={cy}
              r={(rOuter + rInner) / 2}
              fill="none"
              className="stroke-border"
              strokeWidth={rOuter - rInner}
            />
          ) : (
            arcs.map((arc, index) => {
              const isActive = hover == null || hover === arc.slice.id;
              return (
                <motion.path
                  key={arc.slice.id}
                  d={arc.path}
                  className={cn(arc.slice.toneClass, "cursor-pointer fill-current")}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
                  animate={{
                    opacity: isActive ? 1 : 0.35,
                    scale: hover === arc.slice.id ? 1.03 : 1,
                  }}
                  transition={{
                    duration: 0.45,
                    delay: index * 0.04,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  style={{ transformOrigin: `${cx}px ${cy}px` }}
                  onMouseEnter={() => setHover(arc.slice.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => props.onSelect?.(arc.slice.id)}
                />
              );
            })
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-lg font-semibold tracking-[-0.03em] tabular-nums text-fg">
            {active ? format(active.slice.value) : (props.centerValue ?? format(total))}
          </p>
          <p className="mt-0.5 line-clamp-2 text-2xs text-fg-subtle">
            {active ? `${active.pct}% · ${active.slice.label}` : (props.centerLabel ?? "Total")}
          </p>
        </div>
      </div>

      <ul className="min-w-0 flex-1 grid gap-1">
        {arcs.map((arc) => (
          <li key={arc.slice.id}>
            <button
              type="button"
              onMouseEnter={() => setHover(arc.slice.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => props.onSelect?.(arc.slice.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                hover === arc.slice.id ? "bg-surface-2/80" : "hover:bg-surface-2/50",
              )}
            >
              <span className={cn("size-2 shrink-0 rounded-full bg-current", arc.slice.toneClass)} />
              <span className="min-w-0 flex-1 truncate text-xs text-fg">{arc.slice.label}</span>
              <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-muted">
                {format(arc.slice.value)}
              </span>
              <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-subtle">
                {arc.pct}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HorizontalBars(props: {
  rows: Array<{ id: string; label: string; value: number; hint?: string; toneClass?: string }>;
  max?: number;
  valuePrefix?: string;
  className?: string;
  onSelect?: (id: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const max = props.max ?? Math.max(...props.rows.map((r) => r.value), 1);

  return (
    <ul className={cn("grid gap-1", props.className)}>
      {props.rows.map((row, index) => {
        const pct = Math.max(3, (row.value / max) * 100);
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => props.onSelect?.(row.id)}
              className={cn(
                "group relative grid w-full gap-1.5 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors",
                "hover:bg-surface-2/70",
                props.onSelect && "cursor-pointer",
              )}
            >
              <div className="relative z-[1] flex items-baseline justify-between gap-3">
                <span className="truncate text-xs font-medium text-fg">{row.label}</span>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-muted">
                  {props.valuePrefix}
                  {row.value.toFixed(row.value >= 10 ? 1 : 2)}
                  {row.hint ? <span className="ml-1.5 text-fg-subtle">{row.hint}</span> : null}
                </span>
              </div>
              <div className="relative z-[1] h-1.5 overflow-hidden rounded-full bg-fg/[0.06]">
                <motion.div
                  className={cn("h-full rounded-full bg-brand", row.toneClass)}
                  initial={reduceMotion ? false : { width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{
                    duration: 0.75,
                    delay: 0.04 + index * 0.04,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function UsageMeter(props: {
  label: string;
  detail: string;
  segments: Array<{ id: string; value: number; className: string; label?: string }>;
  total: number;
}) {
  const reduceMotion = useReducedMotion();
  const total = Math.max(0, props.total);
  const segments = props.segments.map((segment) => ({
    ...segment,
    value: Math.max(0, Math.min(segment.value, total)),
  }));
  const used = Math.min(
    total,
    segments.reduce((sum, segment) => sum + segment.value, 0),
  );
  const remainder = Math.max(0, total - used);
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <div className="grid gap-2.5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium tracking-[-0.01em] text-fg">{props.label}</p>
          <p className="mt-0.5 font-mono text-2xs tabular-nums text-fg-subtle">{props.detail}</p>
        </div>
        <p className="font-mono text-sm tabular-nums text-fg">{pct.toFixed(0)}%</p>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-fg/[0.06]">
        {segments.map((segment, index) => (
          <motion.div
            key={segment.id}
            className={cn("h-full", segment.className)}
            initial={reduceMotion ? false : { flexGrow: 0 }}
            animate={{ flexGrow: segment.value }}
            transition={{
              duration: 0.9,
              delay: 0.08 + index * 0.05,
              ease: [0.22, 1, 0.36, 1],
            }}
            style={{ flexBasis: 0 }}
            title={segment.label}
          />
        ))}
        {remainder > 0 ? (
          <div className="h-full" style={{ flexBasis: 0, flexGrow: remainder }} aria-hidden />
        ) : null}
      </div>
    </div>
  );
}
