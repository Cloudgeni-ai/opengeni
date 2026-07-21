// ----------------------------------------------------------------------------
// MetricSparkline — an axis-less micro-trend for stat tiles and (later) cards.
// Same smoothing as the full chart, no chrome: a hairline + a faint fill and a
// dot on the latest point. Fixed viewBox so it scales crisply at any width.
// ----------------------------------------------------------------------------
import type { SeriesPoint } from "./metric-history-chart";

export type MetricSparklineProps = {
  points: SeriesPoint[];
  color?: string;
  yMax?: number | "auto";
  height?: number;
  className?: string | undefined;
};

const VW = 120;

export function MetricSparkline({
  points,
  color = "var(--og-color-accent)",
  yMax = "auto",
  height = 28,
  className,
}: MetricSparklineProps) {
  const valued = points.filter(
    (p): p is { t: number; v: number } => p.v != null && Number.isFinite(p.v),
  );
  if (valued.length < 2) {
    return <div className={className} style={{ height }} aria-hidden />;
  }
  const vh = height;
  const top = yMax === "auto" ? Math.max(1, ...valued.map((p) => p.v)) * 1.1 : yMax;
  const tMin = valued[0]!.t;
  const tSpan = Math.max(1, valued[valued.length - 1]!.t - tMin);
  const xy = valued.map((p) => ({
    x: ((p.t - tMin) / tSpan) * VW,
    y: vh - (Math.min(top, Math.max(0, p.v)) / Math.max(1e-6, top)) * (vh - 2) - 1,
  }));
  let d = `M${xy[0]!.x},${xy[0]!.y}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i]!;
    const p1 = xy[i]!;
    const p2 = xy[i + 1]!;
    const p3 = xy[i + 2] ?? p2;
    d += `C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  const last = xy[xy.length - 1]!;
  const gid = `spark-${Math.round(top)}-${color.length}`;
  return (
    <svg
      viewBox={`0 0 ${VW} ${vh}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: "100%" }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${last.x},${vh} L${xy[0]!.x},${vh} Z`} fill={`url(#${gid})`} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last.x} cy={last.y} r={1.6} fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
