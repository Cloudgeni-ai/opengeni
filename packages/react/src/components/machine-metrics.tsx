import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import type { MetricSample } from "../types/machines";

export type MachineMetricsProps = {
  /** The latest metric sample, or null when the machine hasn't reported yet. */
  metrics: MetricSample | null;
  /** Compact (dashboard row) vs full (the dock detail). */
  density?: "compact" | "full" | undefined;
  className?: string | undefined;
};

/** Clamp a 0..100-ish percent into the bar range. */
function pct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** A label/value pair with a token-tinted utilisation bar. */
function Meter({
  label,
  value,
  fillPct,
  tone,
}: {
  label: string;
  value: string;
  fillPct: number;
  tone: "ok" | "warn" | "hot";
}) {
  // Traffic-light ramp, aligned with the fused health verdict: calm resources
  // read green (idle), pressure ambers (running), near-the-wall reds (failed).
  const fillClass =
    tone === "hot"
      ? "bg-og-status-failed"
      : tone === "warn"
        ? "bg-og-status-running"
        : "bg-og-status-idle";
  return (
    <div className="flex min-w-0 flex-col gap-1" data-metric={label.toLowerCase()}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
          {label}
        </span>
        <span className="font-og-mono text-[11px] tabular-nums text-og-fg-muted">{value}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-og-surface-2">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", fillClass)}
          style={{ width: `${pct(fillPct)}%` }}
        />
      </div>
    </div>
  );
}

/** Map a percent to a calm/warn/hot tone (no color invented — token classes). */
function toneFor(p: number): "ok" | "warn" | "hot" {
  if (p >= 90) return "hot";
  if (p >= 70) return "warn";
  return "ok";
}

/**
 * Load average as three labeled mini-stats (1m / 5m / 15m) — an honest triple of
 * numbers, NOT a fake gauge. Load is not a 0..100 ratio and we don't know the
 * core count, so a raw load of 2 or 8 is not inherently "bad" — we render it
 * NEUTRAL rather than falsely alarming. The real saturation signal is the run
 * queue, which rides alongside as a quiet chip when there's pending work.
 */
function StatTriple({
  load1,
  load5,
  load15,
  runQueue,
}: {
  load1: number;
  load5: number;
  load15: number;
  runQueue: number;
}) {
  const stats: Array<{ label: string; value: number }> = [
    { label: "1m", value: load1 },
    { label: "5m", value: load5 },
    { label: "15m", value: load15 },
  ];
  return (
    <div className="flex items-center justify-between gap-3" data-metric="load">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
          Load
        </span>
        <div className="flex items-baseline gap-3">
          {stats.map((s) => (
            <div key={s.label} className="flex items-baseline gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                {s.label}
              </span>
              <span className="font-og-mono text-[12px] tabular-nums text-og-fg">
                {s.value.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
      {runQueue > 0 ? (
        <div
          className="flex shrink-0 items-baseline gap-1.5 rounded-og-sm bg-og-surface-2 px-2 py-1 text-[11px] text-og-fg-subtle"
          data-metric="runqueue"
        >
          <span className="font-medium uppercase tracking-wide">Queue</span>
          <span className="font-og-mono tabular-nums text-og-fg-muted">{runQueue}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Per-machine resource meters: CPU%, load average, memory, disk, and GPU when
 * present. Renders the M2 `machine_metrics_latest` sample. When `metrics` is
 * null the panel shows a quiet "no samples yet" placeholder (offline / just
 * enrolled). GPU rows only render when `gpuUtilPct` is non-null.
 */
export function MachineMetrics({ metrics, density = "compact", className }: MachineMetricsProps) {
  if (!metrics) {
    return (
      <div className={cn("text-[11px] text-og-fg-subtle", className)} data-metrics-empty>
        No metrics yet
      </div>
    );
  }

  const memPct =
    metrics.memTotalBytes > 0 ? (metrics.memUsedBytes / metrics.memTotalBytes) * 100 : 0;
  const diskPct =
    metrics.diskTotalBytes > 0 ? (metrics.diskUsedBytes / metrics.diskTotalBytes) * 100 : 0;
  const hasGpu = metrics.gpuUtilPct !== null;
  const gpuMemLabel = metrics.gpuMemBytes !== null ? formatBytes(metrics.gpuMemBytes) : null;
  // Memory & disk are honest used/total ratios → full-width meters; stack them in
  // the dock detail, two-up in the dashboard row.
  const ratioGridClass = density === "full" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2";

  return (
    <div className={cn("flex flex-col gap-3", className)} data-machine-metrics>
      {/* Resources — used/total ratios with real 0..100% bars. */}
      <div className={cn("grid gap-x-4 gap-y-2.5", ratioGridClass)}>
        <Meter
          label="Memory"
          value={`${formatBytes(metrics.memUsedBytes)} / ${formatBytes(metrics.memTotalBytes)}`}
          fillPct={memPct}
          tone={toneFor(memPct)}
        />
        <Meter
          label="Disk"
          value={`${formatBytes(metrics.diskUsedBytes)} / ${formatBytes(metrics.diskTotalBytes)}`}
          fillPct={diskPct}
          tone={toneFor(diskPct)}
        />
      </div>

      {/* Utilization — CPU% (and GPU% when present) as honest percent gauges. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Meter
          label="CPU"
          value={`${metrics.cpuPct.toFixed(0)}%`}
          fillPct={metrics.cpuPct}
          tone={toneFor(metrics.cpuPct)}
        />
        {hasGpu ? (
          <Meter
            label="GPU"
            value={
              gpuMemLabel
                ? `${metrics.gpuUtilPct!.toFixed(0)}% · ${gpuMemLabel}`
                : `${metrics.gpuUtilPct!.toFixed(0)}%`
            }
            fillPct={metrics.gpuUtilPct!}
            tone={toneFor(metrics.gpuUtilPct!)}
          />
        ) : null}
      </div>

      {/* Activity — load average as labeled mini-stats (no fake bar) + run queue. */}
      <StatTriple
        load1={metrics.load1}
        load5={metrics.load5}
        load15={metrics.load15}
        runQueue={metrics.runQueue}
      />
    </div>
  );
}
