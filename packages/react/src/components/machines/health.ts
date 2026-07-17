// ----------------------------------------------------------------------------
// Machine health — the single derived signal.
//
// The dashboard already shows connection state (a pill) and per-resource meters
// (independently tinted). What it lacks is ONE verdict that fuses the three
// things that actually make a machine "in trouble":
//
//   1. reachability   — is the control plane still hearing from it?
//   2. resource load  — is a resource (mem/disk/cpu) near the wall?
//   3. freshness      — is the latest sample recent, or has telemetry gone quiet?
//
// This module is a PURE function from a machine's state + latest sample + clock
// to a `HealthVerdict`. No React, no tokens — the UI maps `level` to a color.
// Keeping it pure means it is trivially testable and reused by cards, the detail
// hero, and any future fleet-summary count.
// ----------------------------------------------------------------------------
import type { MachineState, MetricSample } from "../../types/machines";

export type HealthLevel = "healthy" | "degraded" | "critical" | "offline" | "unknown";

export type HealthVerdict = {
  level: HealthLevel;
  /** Title-case label for the pill ("Healthy", "Under load", "Critical", …). */
  label: string;
  /** One short human clause naming the dominant cause ("Memory 94%", "No display"…). */
  reason: string;
  /** The latest sample is older than we'd expect from a live agent (~5s cadence). */
  stale: boolean;
};

// Resource pressure thresholds. `warn` mirrors the existing meter ramp (>=70
// tints), `crit` is the "near the wall" line. Disk is stricter than CPU/mem
// because a full disk is a hard failure, whereas transient CPU/mem spikes are
// normal on a working machine.
const PRESSURE = {
  cpu: { warn: 90, crit: 98 },
  mem: { warn: 85, crit: 95 },
  disk: { warn: 90, crit: 96 },
} as const;

// A live agent samples ~every 5s and the series downsamples to ~1/min. We treat
// a latest sample older than 45s as "telemetry has gone quiet" — enough slack to
// not flap on a single missed beat, tight enough to notice a wedged sampler.
const STALE_AFTER_MS = 45_000;

function pct(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return (used / total) * 100;
}

/** Fold a machine's reachability + latest sample + wall-clock into one verdict. */
export function deriveHealth(
  state: MachineState,
  metrics: MetricSample | null,
  now: number = Date.now(),
): HealthVerdict {
  // Reachability dominates: an offline machine has no meaningful resource story.
  if (state === "offline") {
    return { level: "offline", label: "Offline", reason: "Not reachable", stale: true };
  }
  if (state === "enrolling") {
    return { level: "unknown", label: "Enrolling", reason: "Completing enrollment", stale: false };
  }

  const stale = metrics ? now - new Date(metrics.sampledAt).getTime() > STALE_AFTER_MS : true;

  // Reconnecting, or online-but-quiet: reachable yet we can't trust the numbers.
  if (state === "reconnecting") {
    return { level: "degraded", label: "Reconnecting", reason: "Re-establishing link", stale };
  }
  if (!metrics) {
    return { level: "unknown", label: "Online", reason: "Awaiting first sample", stale };
  }
  if (stale) {
    return { level: "degraded", label: "Telemetry stale", reason: "No recent sample", stale: true };
  }

  // Reachable + fresh: the verdict is now the worst resource pressure. Evaluate
  // each resource, keep the most severe, and name it in the reason.
  const memPct = pct(metrics.memUsedBytes, metrics.memTotalBytes);
  const diskPct = pct(metrics.diskUsedBytes, metrics.diskTotalBytes);
  const cpu = metrics.cpuPct;

  const pressures: Array<{ level: HealthLevel; reason: string; sev: number }> = [
    resolve("Disk", diskPct, PRESSURE.disk),
    resolve("Memory", memPct, PRESSURE.mem),
    resolve("CPU", cpu, PRESSURE.cpu),
  ];
  const worst = pressures.reduce((a, b) => (b.sev > a.sev ? b : a));

  if (worst.sev === 2) return { level: "critical", label: "Critical", reason: worst.reason, stale };
  if (worst.sev === 1)
    return { level: "degraded", label: "Under load", reason: worst.reason, stale };
  return { level: "healthy", label: "Healthy", reason: "All systems nominal", stale };
}

function resolve(
  name: string,
  value: number,
  t: { warn: number; crit: number },
): { level: HealthLevel; reason: string; sev: number } {
  const rounded = Math.round(value);
  if (value >= t.crit) return { level: "critical", reason: `${name} ${rounded}%`, sev: 2 };
  if (value >= t.warn) return { level: "degraded", reason: `${name} ${rounded}%`, sev: 1 };
  return { level: "healthy", reason: `${name} ${rounded}%`, sev: 0 };
}

// --- UI mapping helpers (color/token names live here so every surface agrees) --

/**
 * The token color ramp for a health level. Green/amber/red/grey is the
 * universally-legible traffic model; we reserve it for the HEALTH verdict
 * specifically (per-resource meters keep their own ramp in `machine-metrics`).
 */
export const HEALTH_TOKEN: Record<HealthLevel, { text: string; dot: string; soft: string }> = {
  healthy: {
    text: "text-og-status-idle",
    dot: "bg-og-status-idle",
    soft: "bg-og-status-idle/10 border-og-status-idle/25",
  },
  degraded: {
    text: "text-og-status-running",
    dot: "bg-og-status-running",
    soft: "bg-og-status-running/10 border-og-status-running/25",
  },
  critical: {
    text: "text-og-status-failed",
    dot: "bg-og-status-failed",
    soft: "bg-og-status-failed/10 border-og-status-failed/30",
  },
  offline: {
    text: "text-og-fg-subtle",
    dot: "bg-og-fg-subtle",
    soft: "bg-og-surface-2 border-og-border",
  },
  unknown: {
    text: "text-og-fg-muted",
    dot: "bg-og-fg-muted",
    soft: "bg-og-surface-2 border-og-border",
  },
};

/** Live/transient levels breathe; settled levels hold still. */
export function healthPulses(level: HealthLevel): boolean {
  return level === "degraded" || level === "critical";
}
