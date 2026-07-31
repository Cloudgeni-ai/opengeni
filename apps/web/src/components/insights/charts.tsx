import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

type Series = {
  id: string;
  label: string;
  values: number[];
  className: string;
};

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

export function AreaChart(props: {
  labels: readonly string[];
  series: Series[];
  height?: number;
  className?: string;
  valuePrefix?: string;
  valueSuffix?: string;
}) {
  const reduceMotion = useReducedMotion();
  const gradId = useId();
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 220;
  const width = 720;
  const padX = 8;
  const padTop = 18;
  const padBottom = 8;
  const all = props.series.flatMap((s) => s.values);
  const max = Math.max(...all, 1) * 1.08;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  const geometry = useMemo(() => {
    return props.series.map((series) => {
      const points = series.values.map((value, i) => {
        const x =
          padX +
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
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (props.labels.length - 1));
    setActive(Math.max(0, Math.min(props.labels.length - 1, index)));
  };

  const activeX =
    active == null
      ? null
      : padX + (active / Math.max(props.labels.length - 1, 1)) * innerW;

  return (
    <div className={cn("relative w-full", props.className)} onPointerLeave={() => setActive(null)}>
      <AnimatePresence>
        {active != null ? (
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border/80 bg-surface-3/95 px-2.5 py-2 shadow-[var(--og-shadow-md)] backdrop-blur-md"
            style={{
              left: `clamp(0px, calc(${(active / Math.max(props.labels.length - 1, 1)) * 100}% - 56px), calc(100% - 120px))`,
            }}
          >
            <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
              {props.labels[active]}
            </p>
            <div className="mt-1 grid gap-0.5">
              {props.series.map((series) => (
                <div key={series.id} className="flex items-center justify-between gap-4 text-2xs">
                  <span className={cn("inline-flex items-center gap-1.5", series.className)}>
                    <span className="size-1.5 rounded-full bg-current" />
                    <span className="text-fg-muted">{series.label}</span>
                  </span>
                  <span className="font-mono text-fg">
                    {props.valuePrefix}
                    {series.values[active]!.toFixed(series.values[active]! >= 10 ? 0 : 1)}
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
        aria-label="Interactive usage trend"
        onPointerMove={onMove}
      >
        <defs>
          {geometry.map(({ series }, index) => (
            <linearGradient key={series.id} id={`${gradId}-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
              <stop offset="55%" stopColor="currentColor" stopOpacity={0.08} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          ))}
          <filter id={`${gradId}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {[0.25, 0.5, 0.75].map((t) => {
          const y = padTop + innerH * (1 - t);
          return (
            <line
              key={t}
              x1={padX}
              x2={width - padX}
              y1={y}
              y2={y}
              className="stroke-border/50"
              strokeWidth={1}
              strokeDasharray="3 5"
            />
          );
        })}

        {geometry.map(({ series, line, area, points }, index) => (
          <g key={series.id} className={series.className}>
            <motion.path
              d={area}
              fill={`url(#${gradId}-${index})`}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.12 + index * 0.08, ease: [0.22, 1, 0.36, 1] }}
            />
            <motion.path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={`url(#${gradId}-glow)`}
              initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1.15, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}
            />
            {points.map((point, i) => (
              <motion.circle
                key={`${series.id}-${i}`}
                cx={point.x}
                cy={point.y}
                r={active === i ? 4.5 : 0}
                className="fill-bg stroke-current"
                strokeWidth={2}
                initial={false}
                animate={{ r: active === i ? 4.5 : 0, opacity: active === i ? 1 : 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 28 }}
              />
            ))}
          </g>
        ))}

        {activeX != null ? (
          <motion.line
            x1={activeX}
            x2={activeX}
            y1={padTop}
            y2={padTop + innerH}
            className="stroke-fg/35"
            strokeWidth={1}
            initial={false}
            animate={{ x1: activeX, x2: activeX }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
          />
        ) : null}
      </svg>

      <div className="mt-1.5 flex justify-between px-0.5">
        {props.labels.map((label, index) => (
          <button
            key={label}
            type="button"
            onMouseEnter={() => setActive(index)}
            className={cn(
              "text-2xs transition-colors",
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
                "group relative grid w-full gap-1.5 overflow-hidden rounded-xl px-3 py-2.5 text-left transition-colors",
                "hover:bg-surface-2/70",
                props.onSelect && "cursor-pointer",
              )}
            >
              <div className="relative z-[1] flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-muted">
                  {props.valuePrefix}
                  {row.value.toFixed(row.value >= 10 ? 1 : 2)}
                  {row.hint ? <span className="ml-1.5 text-fg-subtle">{row.hint}</span> : null}
                </span>
              </div>
              <div className="relative z-[1] h-[3px] overflow-hidden rounded-full bg-fg/[0.06]">
                <motion.div
                  className={cn("h-full rounded-full bg-brand", row.toneClass)}
                  initial={reduceMotion ? false : { width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{
                    duration: 0.9,
                    delay: 0.06 + index * 0.045,
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
  const used = props.segments.reduce((sum, s) => sum + s.value, 0);
  const pct = Math.min(100, (used / props.total) * 100);

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
        {props.segments.map((segment, index) => (
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
      </div>
    </div>
  );
}
