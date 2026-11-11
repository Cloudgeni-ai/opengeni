// Shared series helpers: project a MetricSample[] into per-metric {t, v} points,
// and the metric catalog the detail view + tiles iterate over.
import type { MetricSample } from "../../types/machines";
import type { SeriesPoint } from "./metric-history-chart";
import { type OpenGeniText } from "../../messages/runtime";

export type MetricWindow = "15m" | "1h" | "6h" | "24h";
export const METRIC_WINDOWS: MetricWindow[] = ["15m", "1h", "6h", "24h"];

export const WINDOW_LABEL = (msg: OpenGeniText): Record<MetricWindow, string> => ({
  "15m": msg("machines.series.inTheLast15Min"),
  "1h": msg("machines.series.inTheLastHour"),
  "6h": msg("machines.series.inTheLast6Hours"),
  "24h": msg("machines.series.inTheLast24Hours"),
});

function ptsFrom(samples: MetricSample[], pick: (s: MetricSample) => number | null): SeriesPoint[] {
  return samples.map((s) => ({ t: new Date(s.sampledAt).getTime(), v: pick(s) }));
}

const memPct = (s: MetricSample) =>
  s.memTotalBytes > 0 ? (s.memUsedBytes / s.memTotalBytes) * 100 : null;
const diskPct = (s: MetricSample) =>
  s.diskTotalBytes > 0 ? (s.diskUsedBytes / s.diskTotalBytes) * 100 : null;

export type MetricKey = "cpu" | "mem" | "disk" | "load" | "gpu";

export type MetricDef = {
  key: MetricKey;
  title: string;
  unit: string;
  yMax: number | "auto";
  color: string;
  thresholds?: { warn?: number; crit?: number };
  pick: (s: MetricSample) => number | null;
  /** Big current-value string for tiles/badges. */
  current: (s: MetricSample) => string;
  /** Optional sub-line under the current value. */
  sub?: (s: MetricSample) => string | null;
};

const fmtBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  for (const unit of u) {
    if (v < 1024 || unit === "TB") return `${v.toFixed(v < 10 ? 1 : 0)} ${unit}`;
    v /= 1024;
  }
  return `${b} B`;
};

// The catalog. GPU is included but the detail view only renders it when the
// latest sample actually reports a GPU (gpuUtilPct != null).
export const METRICS = (msg: OpenGeniText): MetricDef[] => [
  {
    key: "cpu",
    title: "CPU",
    unit: "%",
    yMax: 100,
    color: "var(--og-color-accent)",
    thresholds: { warn: 90, crit: 98 },
    pick: (s) => s.cpuPct,
    current: (s) => `${Math.round(s.cpuPct)}%`,
    sub: (s) => msg("machines.series.runqueueInRunQueue", { runQueue: s.runQueue }),
  },
  {
    key: "mem",
    title: msg("machines.series.memory"),
    unit: "%",
    yMax: 100,
    color: "var(--og-color-status-idle)",
    thresholds: { warn: 85, crit: 95 },
    pick: memPct,
    current: (s) => `${Math.round(memPct(s) ?? 0)}%`,
    sub: (s) => `${fmtBytes(s.memUsedBytes)} / ${fmtBytes(s.memTotalBytes)}`,
  },
  {
    key: "disk",
    title: msg("machines.series.disk"),
    unit: "%",
    yMax: 100,
    color: "var(--og-color-status-waiting)",
    thresholds: { warn: 90, crit: 96 },
    pick: diskPct,
    current: (s) => `${Math.round(diskPct(s) ?? 0)}%`,
    sub: (s) => `${fmtBytes(s.diskUsedBytes)} / ${fmtBytes(s.diskTotalBytes)}`,
  },
  {
    key: "load",
    title: msg("machines.series.loadAverage"),
    unit: "",
    yMax: "auto",
    color: "var(--og-color-accent-strong)",
    pick: (s) => s.load1,
    current: (s) => s.load1.toFixed(2),
    sub: (s) => `5m ${s.load5.toFixed(2)} · 15m ${s.load15.toFixed(2)}`,
  },
  {
    key: "gpu",
    title: "GPU",
    unit: "%",
    yMax: 100,
    color: "var(--og-color-status-running)",
    thresholds: { warn: 90, crit: 98 },
    pick: (s) => s.gpuUtilPct,
    current: (s) => (s.gpuUtilPct == null ? "—" : `${Math.round(s.gpuUtilPct)}%`),
    sub: (s) => (s.gpuMemBytes == null ? null : `${fmtBytes(s.gpuMemBytes)} used`),
  },
];

export function pointsFor(def: MetricDef, samples: MetricSample[]): SeriesPoint[] {
  return ptsFrom(samples, def.pick);
}
