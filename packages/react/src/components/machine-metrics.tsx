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
  const fillClass =
    tone === "hot" ? "bg-og-status-failed" : tone === "warn" ? "bg-og-status-waiting" : "bg-og-status-running";
  return (
    <div className="flex min-w-0 flex-col gap-1" data-metric={label.toLowerCase()}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">{label}</span>
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

  const memPct = metrics.memTotalBytes > 0 ? (metrics.memUsedBytes / metrics.memTotalBytes) * 100 : 0;
  const diskPct = metrics.diskTotalBytes > 0 ? (metrics.diskUsedBytes / metrics.diskTotalBytes) * 100 : 0;
  const hasGpu = metrics.gpuUtilPct !== null;
  const gpuMemLabel = metrics.gpuMemBytes !== null ? formatBytes(metrics.gpuMemBytes) : null;

  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-2.5",
        density === "full" ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
        className,
      )}
      data-machine-metrics
    >
      <Meter
        label="CPU"
        value={`${metrics.cpuPct.toFixed(0)}%`}
        fillPct={metrics.cpuPct}
        tone={toneFor(metrics.cpuPct)}
      />
      <Meter
        label="Load"
        value={`${metrics.load1.toFixed(2)} · ${metrics.load5.toFixed(2)} · ${metrics.load15.toFixed(2)}`}
        // Normalise load1 against a nominal 8-core ceiling for the bar (display only).
        fillPct={(metrics.load1 / 8) * 100}
        tone={toneFor((metrics.load1 / 8) * 100)}
      />
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
      {hasGpu ? (
        <Meter
          label="GPU"
          value={gpuMemLabel ? `${metrics.gpuUtilPct!.toFixed(0)}% · ${gpuMemLabel}` : `${metrics.gpuUtilPct!.toFixed(0)}%`}
          fillPct={metrics.gpuUtilPct!}
          tone={toneFor(metrics.gpuUtilPct!)}
        />
      ) : null}
      {metrics.runQueue > 0 ? (
        <div className="flex items-baseline gap-1.5 text-[11px] text-og-fg-subtle" data-metric="runqueue">
          <span className="font-medium uppercase tracking-wide">Run queue</span>
          <span className="font-og-mono tabular-nums text-og-fg-muted">{metrics.runQueue}</span>
        </div>
      ) : null}
    </div>
  );
}
