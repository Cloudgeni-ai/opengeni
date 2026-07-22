// ----------------------------------------------------------------------------
// MachineDetail — the marquee per-machine telemetry view.
//
// Opens from a machine card. Answers, at a glance and then in depth: is this
// machine healthy right now (one fused verdict), what are its live numbers, and
// how have they moved over the chosen window. Built entirely on the existing
// `og-*` token system — no new visual language, just the missing depth.
// ----------------------------------------------------------------------------
import {
  ArrowLeftIcon,
  CpuIcon,
  LaptopIcon,
  Loader2Icon,
  RadioIcon,
  ServerIcon,
  UnplugIcon,
} from "lucide-react";
import type { Ref } from "react";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../lib/format";
import type { MachineView, MetricSample } from "../../types/machines";
import { deriveHealth, HEALTH_TOKEN, healthPulses } from "./health";
import { MetricHistoryChart } from "./metric-history-chart";
import { MetricSparkline } from "./metric-sparkline";
import { METRICS, METRIC_WINDOWS, pointsFor, WINDOW_LABEL, type MetricWindow } from "./series";

export type MachineDetailProps = {
  machine: MachineView;
  /** Downsampled history for the active window (from `fetchSeries`). */
  series: MetricSample[];
  window: MetricWindow;
  onWindowChange: (w: MetricWindow) => void;
  loadingSeries?: boolean | undefined;
  onBack?: (() => void) | undefined;
  /** Request permanent revocation of this connected-machine enrollment. */
  onRevoke?: (() => void) | undefined;
  revokeButtonRef?: Ref<HTMLButtonElement> | undefined;
  revoking?: boolean | undefined;
  now?: number | undefined;
  className?: string | undefined;
};

function KindIcon({ kind, session }: { kind: string; session: boolean }) {
  if (session) return <ServerIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  if (kind === "modal") return <CpuIcon className="size-4 text-og-fg-subtle" aria-hidden />;
  return <LaptopIcon className="size-4 text-og-fg-subtle" aria-hidden />;
}

export function MachineDetail({
  machine,
  series,
  window,
  onWindowChange,
  loadingSeries,
  onBack,
  onRevoke,
  revokeButtonRef,
  revoking,
  now = Date.now(),
  className,
}: MachineDetailProps) {
  const health = deriveHealth(machine.state, machine.metrics, now);
  const tone = HEALTH_TOKEN[health.level];
  const latest = machine.metrics;
  const sampledAgo = latest ? formatRelativeTime(latest.sampledAt, new Date(now)) : null;

  // Only render metrics that have a value (GPU is dropped on headless boxes).
  const visible = METRICS.filter((m) => !(m.key === "gpu" && latest?.gpuUtilPct == null));
  // The tile grid tracks the metric count exactly so it never leaves a dead cell.
  const tileCols =
    visible.length >= 5
      ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
      : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className={cn("og-root mx-auto flex w-full max-w-5xl flex-col gap-5", className)}>
      {/* ── top bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex size-7 shrink-0 items-center justify-center rounded-og-sm border border-og-border bg-og-surface-1 text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg"
              aria-label="Back to machines"
            >
              <ArrowLeftIcon className="size-3.5" aria-hidden />
            </button>
          )}
          <KindIcon kind={machine.kind} session={machine.isSessionGroup} />
          <h1 className="truncate text-og-md font-semibold text-og-fg">{machine.name}</h1>
          <span className="hidden shrink-0 rounded-og-sm border border-og-border bg-og-surface-1 px-1.5 py-0.5 font-og-mono text-og-xs text-og-fg-subtle sm:inline">
            {machine.os} · {machine.arch}
          </span>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
          {onRevoke ? (
            <button
              type="button"
              ref={revokeButtonRef}
              data-revoke-machine
              disabled={revoking}
              onClick={onRevoke}
              className="inline-flex min-h-7 items-center gap-1.5 rounded-og-sm border border-og-status-failed/30 px-2 py-1 text-og-xs font-medium text-og-status-failed transition-colors hover:bg-og-status-failed/10 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-10"
            >
              {revoking ? (
                <Loader2Icon className="size-3 animate-og-spin" aria-hidden />
              ) : (
                <UnplugIcon className="size-3" aria-hidden />
              )}
              {revoking ? "Unenrolling…" : "Unenroll"}
            </button>
          ) : null}
          {/* range selector */}
          <div className="flex items-center gap-0.5 rounded-og-md border border-og-border bg-og-surface-1 p-0.5">
            {METRIC_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => onWindowChange(w)}
                data-active={w === window}
                className={cn(
                  "rounded-og-sm px-2 py-1 font-og-mono text-og-xs transition-colors",
                  w === window
                    ? "bg-og-surface-3 text-og-fg shadow-og-sm"
                    : "text-og-fg-subtle hover:text-og-fg-muted",
                )}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── health hero ─────────────────────────────────────────────────── */}
      <div
        className={cn(
          "relative flex flex-col gap-4 overflow-hidden rounded-og-lg border p-5 shadow-og-sm",
          tone.soft,
        )}
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", tone.dot)} />
        <div className="flex flex-wrap items-center justify-between gap-3 pl-1">
          <div className="flex items-center gap-3">
            <span className="relative flex size-3">
              {healthPulses(health.level) && (
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-og-pulse rounded-full opacity-60",
                    tone.dot,
                  )}
                />
              )}
              <span className={cn("relative inline-flex size-3 rounded-full", tone.dot)} />
            </span>
            <div className="flex flex-col">
              <span className={cn("text-og-md font-semibold", tone.text)}>{health.label}</span>
              <span className="text-og-sm text-og-fg-muted">{health.reason}</span>
            </div>
          </div>
          <div className="flex items-start gap-5 pr-1">
            {sampledAgo && (
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                  Sampled
                </span>
                <span className="flex items-center gap-1 font-og-mono text-og-sm tabular-nums text-og-fg">
                  <RadioIcon
                    className={cn("size-3", health.stale ? "text-og-fg-subtle" : tone.text)}
                    aria-hidden
                  />
                  {sampledAgo === "now" ? "live" : `${sampledAgo} ago`}
                </span>
              </div>
            )}
            {machine.lastSeenAt && (
              <div className="hidden flex-col items-end gap-0.5 sm:flex">
                <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                  Last seen
                </span>
                <span className="font-og-mono text-og-sm tabular-nums text-og-fg-muted">
                  {formatRelativeTime(machine.lastSeenAt, new Date(now))}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* current-stat tiles */}
        {latest && (
          <div
            className={cn(
              "grid gap-px overflow-hidden rounded-og-md border border-og-border bg-og-border",
              tileCols,
            )}
          >
            {visible.map((m) => {
              const pts = pointsFor(m, series);
              return (
                <div key={m.key} className="flex flex-col gap-1.5 bg-og-surface-1 p-3">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-og-fg-subtle">
                    {m.title}
                  </span>
                  <span className="font-og-mono text-og-md font-medium tabular-nums text-og-fg">
                    {m.current(latest)}
                  </span>
                  <MetricSparkline points={pts} color={m.color} yMax={m.yMax} height={22} />
                  {m.sub && (
                    <span className="truncate font-og-mono text-[10px] text-og-fg-subtle">
                      {m.sub(latest)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── history charts ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visible.map((m) => {
          const pts = pointsFor(m, series);
          return (
            <div
              key={m.key}
              className="flex flex-col gap-3 rounded-og-lg border border-og-border bg-og-surface-1 p-4 shadow-og-sm"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-og-sm font-medium text-og-fg">{m.title}</span>
                {latest && (
                  <span className="font-og-mono text-og-sm tabular-nums text-og-fg-muted">
                    {m.current(latest)}
                  </span>
                )}
              </div>
              <MetricHistoryChart
                points={pts}
                yMax={m.yMax}
                unit={m.unit}
                color={m.color}
                thresholds={m.thresholds}
                rangeLabel={WINDOW_LABEL[window]}
                height={128}
                className={cn(loadingSeries && "opacity-50 transition-opacity")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
