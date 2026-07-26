// ----------------------------------------------------------------------------
// MetricHistoryChart — the per-metric history visual on the machine detail view.
//
// A dependency-free SVG line/area chart tuned for the calm dark aesthetic:
// a soft gradient fill, a smoothed stroke that draws itself in, whisper-quiet
// gridlines, dashed threshold guides, and a hover crosshair with a mono readout.
// It degrades honestly — a handful of points render as markers, zero points show
// a quiet "no samples" note rather than an empty axis.
//
// Pure presentational: it takes plotted {t, v} points + a little config and owns
// no data-fetching. `color` is any CSS color (pass a token var for theme-safety).
// ----------------------------------------------------------------------------
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export type SeriesPoint = { t: number; v: number | null };

export type MetricHistoryChartProps = {
  points: SeriesPoint[];
  /** Fixed ceiling (100 for %) or "auto" to fit the data with headroom. */
  yMax?: number | "auto";
  yMin?: number;
  /** Format a value for the axis + readout (default: rounded + unit). */
  format?: (v: number) => string;
  unit?: string;
  /** Stroke/fill hue — any CSS color; pass a token var to stay theme-safe. */
  color?: string;
  thresholds?: { warn?: number | undefined; crit?: number | undefined } | undefined;
  height?: number;
  /** Human range label for the empty state ("in the last hour"). */
  rangeLabel?: string | undefined;
  className?: string | undefined;
};

const PAD = { top: 10, right: 12, bottom: 18, left: 40 };

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Catmull-Rom → cubic-bezier path so the line is smooth without overshooting. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]!.x},${pts[0]!.y}`;
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

function fmtClock(t: number): string {
  const d = new Date(t);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function MetricHistoryChart({
  points,
  yMax = "auto",
  yMin = 0,
  format,
  unit = "",
  color = "var(--og-color-accent)",
  thresholds,
  height = 132,
  rangeLabel = "in this range",
  className,
}: MetricHistoryChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const valued = points.filter(
    (p): p is { t: number; v: number } => p.v != null && Number.isFinite(p.v),
  );
  const fmt = format ?? ((v: number) => `${Math.round(v)}${unit}`);

  const H = height;
  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, H - PAD.top - PAD.bottom);

  const dataMax = valued.length ? Math.max(...valued.map((p) => p.v)) : 1;
  const top = yMax === "auto" ? niceCeil(Math.max(dataMax * 1.15, thresholds?.warn ?? 0, 1)) : yMax;
  const span = Math.max(1e-6, top - yMin);

  const tMin = valued.length ? valued[0]!.t : 0;
  const tMax = valued.length ? valued[valued.length - 1]!.t : 1;
  const tSpan = Math.max(1, tMax - tMin);

  const xOf = (t: number) => PAD.left + ((t - tMin) / tSpan) * plotW;
  const yOf = (v: number) =>
    PAD.top + (1 - (Math.min(top, Math.max(yMin, v)) - yMin) / span) * plotH;

  const pxPts = valued.map((p) => ({ x: xOf(p.t), y: yOf(p.v), t: p.t, v: p.v }));
  const sparse = pxPts.length > 0 && pxPts.length <= 4;

  const line = smoothPath(pxPts);
  const area =
    pxPts.length > 1
      ? `${line} L${pxPts[pxPts.length - 1]!.x},${PAD.top + plotH} L${pxPts[0]!.x},${PAD.top + plotH} Z`
      : "";

  // y gridlines at 0 / mid / top
  const yTicks = [yMin, yMin + span / 2, top];
  const gid = `og-mh-${Math.round(top)}-${Math.round(color.length)}`;

  const hoverPt = hover != null ? pxPts[hover] : null;

  return (
    <div
      ref={ref}
      className={cn("relative w-full select-none", className)}
      style={{ height: H }}
      data-metric-chart
    >
      {valued.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-og-xs text-og-fg-subtle">No samples {rangeLabel}</span>
        </div>
      ) : (
        <svg
          width={w}
          height={H}
          className="overflow-visible"
          role="img"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const mx = e.clientX - rect.left;
            let best = 0;
            let bestD = Infinity;
            for (let i = 0; i < pxPts.length; i++) {
              const d = Math.abs(pxPts[i]!.x - mx);
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
            setHover(best);
          }}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* gridlines + y labels */}
          {yTicks.map((v, i) => {
            const y = yOf(v);
            return (
              <g key={`yt-${v}`}>
                <line
                  x1={PAD.left}
                  x2={w - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--og-color-border)"
                  strokeOpacity={i === 0 ? 0.9 : 0.4}
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="font-og-mono"
                  fontSize={10}
                  fill="var(--og-color-fg-subtle)"
                >
                  {fmt(v)}
                </text>
              </g>
            );
          })}

          {/* threshold guides */}
          {(["warn", "crit"] as const).map((k) => {
            const tv = thresholds?.[k];
            if (tv == null || tv > top) return null;
            const y = yOf(tv);
            const stroke =
              k === "crit" ? "var(--og-color-status-failed)" : "var(--og-color-status-waiting)";
            return (
              <line
                key={k}
                x1={PAD.left}
                x2={w - PAD.right}
                y1={y}
                y2={y}
                stroke={stroke}
                strokeOpacity={0.5}
                strokeWidth={1}
                strokeDasharray="3 4"
              />
            );
          })}

          {/* x time ticks (first + last) */}
          {valued.length > 1 &&
            [tMin, tMax].map((t, i) => (
              <text
                key={i === 0 ? "x-start" : "x-end"}
                x={i === 0 ? PAD.left : w - PAD.right}
                y={H - 4}
                textAnchor={i === 0 ? "start" : "end"}
                className="font-og-mono"
                fontSize={10}
                fill="var(--og-color-fg-subtle)"
              >
                {fmtClock(t)}
              </text>
            ))}

          {/* area + line */}
          {area && <path d={area} fill={`url(#${gid})`} />}
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            className="og-mh-draw"
          />

          {/* sparse markers */}
          {sparse &&
            pxPts.map((p) => <circle key={`m-${p.t}`} cx={p.x} cy={p.y} r={2.5} fill={color} />)}

          {/* hover crosshair */}
          {hoverPt && (
            <g pointerEvents="none">
              <line
                x1={hoverPt.x}
                x2={hoverPt.x}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--og-color-border-strong)"
                strokeWidth={1}
              />
              <circle
                cx={hoverPt.x}
                cy={hoverPt.y}
                r={3.5}
                fill={color}
                stroke="var(--og-color-bg)"
                strokeWidth={1.5}
              />
            </g>
          )}
        </svg>
      )}

      {/* floating readout */}
      {hoverPt && (
        <div
          className="pointer-events-none absolute z-10 flex flex-col rounded-og-sm border border-og-border-strong bg-og-surface-3/95 px-2 py-1 shadow-og-md backdrop-blur-sm"
          style={{
            left: Math.min(Math.max(hoverPt.x - 30, 0), w - 78),
            top: Math.max(hoverPt.y - 42, 0),
          }}
        >
          <span className="font-og-mono text-og-sm font-medium tabular-nums text-og-fg">
            {fmt(hoverPt.v)}
          </span>
          <span className="font-og-mono text-[10px] tabular-nums text-og-fg-subtle">
            {fmtClock(hoverPt.t)}
          </span>
        </div>
      )}
    </div>
  );
}
