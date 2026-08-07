import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { Settings } from "@opengeni/config";
import type { Observability } from "@opengeni/observability";

export type TurnWorkerMemoryScope = "host" | "cgroup";

export type TurnWorkerMemoryScopeSnapshot = {
  scope: TurnWorkerMemoryScope;
  usedBytes: number;
  limitBytes: number;
};

export type TurnWorkerMemoryPressureSnapshot = {
  processRssBytes: number;
  scopes: TurnWorkerMemoryScopeSnapshot[];
};

export type TurnWorkerMemoryPressureGuard = {
  sampleNow(): void;
  close(): void;
};

type GuardSettings = Pick<
  Settings,
  | "turnWorkerConcurrencyMode"
  | "turnWorkerTargetMemoryUsage"
  | "turnWorkerMemoryGuardIntervalMs"
  | "turnWorkerMemoryGuardSustainMs"
>;

type GuardDependencies = {
  now?: () => number;
  sample?: () => TurnWorkerMemoryPressureSnapshot;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

const CGROUP_V2_CURRENT = "/sys/fs/cgroup/memory.current";
const CGROUP_V2_MAX = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_CURRENT = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const CGROUP_V1_MAX = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

export function parseLinuxMeminfo(
  value: string,
): { totalBytes: number; availableBytes: number } | null {
  const fields = new Map<string, number>();
  for (const line of value.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1] as string, Number(match[2]) * 1024);
  }
  const totalBytes = fields.get("MemTotal");
  const availableBytes = fields.get("MemAvailable");
  if (
    totalBytes === undefined ||
    availableBytes === undefined ||
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(availableBytes) ||
    totalBytes <= 0 ||
    availableBytes < 0
  ) {
    return null;
  }
  return { totalBytes, availableBytes: Math.min(totalBytes, availableBytes) };
}

export function parseFiniteCgroupMemoryLimit(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "max") return null;
  const parsed = Number(trimmed);
  // cgroup v1 represents "unlimited" with a near-int64 sentinel. Treat only
  // realistic finite limits as authority; host headroom remains the fallback.
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed >= 2 ** 60) return null;
  return parsed;
}

export function readTurnWorkerMemoryPressureSnapshot(): TurnWorkerMemoryPressureSnapshot {
  const linux = parseLinuxMeminfo(readTextOrNull("/proc/meminfo") ?? "");
  const hostTotalBytes = linux?.totalBytes ?? totalmem();
  const hostAvailableBytes = linux?.availableBytes ?? freemem();
  const scopes: TurnWorkerMemoryScopeSnapshot[] = [
    {
      scope: "host",
      usedBytes: Math.max(0, hostTotalBytes - Math.min(hostTotalBytes, hostAvailableBytes)),
      limitBytes: hostTotalBytes,
    },
  ];

  const cgroup = readCgroupMemoryScope();
  if (cgroup) scopes.push(cgroup);

  return {
    processRssBytes: process.memoryUsage().rss,
    scopes,
  };
}

export function turnWorkerMemoryPressureGuardEnabled(
  role: "control" | "turn",
  settings: Pick<Settings, "turnWorkerConcurrencyMode">,
): boolean {
  return role === "turn" && settings.turnWorkerConcurrencyMode === "resource-based";
}

export function createTurnWorkerMemoryPressureGuard(input: {
  settings: GuardSettings;
  observability: Observability;
  drain: () => void;
  dependencies?: GuardDependencies;
}): TurnWorkerMemoryPressureGuard {
  const now = input.dependencies?.now ?? Date.now;
  const sample = input.dependencies?.sample ?? readTurnWorkerMemoryPressureSnapshot;
  const schedule = input.dependencies?.setInterval ?? setInterval;
  const cancel = input.dependencies?.clearInterval ?? clearInterval;
  const breachStartedAt = new Map<TurnWorkerMemoryScope, number>();
  let drainRequested = false;
  let closed = false;

  const sampleNow = () => {
    if (closed) return;
    const observedAt = now();
    let snapshot: TurnWorkerMemoryPressureSnapshot;
    try {
      snapshot = sample();
    } catch {
      breachStartedAt.clear();
      safeIncrementCounter(input.observability, {
        name: "opengeni_turn_worker_memory_guard_sample_failures_total",
        help: "Turn-worker memory pressure guard samples that could not be read.",
      });
      return;
    }

    const validScopes = snapshot.scopes.filter(
      ({ usedBytes, limitBytes }) =>
        Number.isFinite(usedBytes) &&
        Number.isFinite(limitBytes) &&
        usedBytes >= 0 &&
        limitBytes > 0,
    );
    if (validScopes.length === 0) {
      breachStartedAt.clear();
      safeIncrementCounter(input.observability, {
        name: "opengeni_turn_worker_memory_guard_sample_failures_total",
        help: "Turn-worker memory pressure guard samples that could not be read.",
      });
      return;
    }

    const sustainedBreaches: Array<{
      scope: TurnWorkerMemoryScope;
      utilizationRatio: number;
      breachSeconds: number;
    }> = [];
    for (const scope of validScopes) {
      const utilizationRatio = scope.usedBytes / scope.limitBytes;
      const processRssRatio = snapshot.processRssBytes / scope.limitBytes;
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_utilization_ratio",
        help: "Observed memory utilization ratio used by the turn-worker pressure guard.",
        labels: { scope: scope.scope },
        value: utilizationRatio,
      });
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_target_ratio",
        help: "Configured memory utilization target enforced by the turn-worker pressure guard.",
        labels: { scope: scope.scope },
        value: input.settings.turnWorkerTargetMemoryUsage,
      });
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_available_bytes",
        help: "Memory headroom remaining in the turn-worker pressure guard scope.",
        labels: { scope: scope.scope },
        value: Math.max(0, scope.limitBytes - scope.usedBytes),
      });
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_process_rss_ratio",
        help: "Turn-worker RSS as a ratio of the observed host or finite cgroup memory scope.",
        labels: { scope: scope.scope },
        value: processRssRatio,
      });

      if (utilizationRatio < input.settings.turnWorkerTargetMemoryUsage) {
        breachStartedAt.delete(scope.scope);
        safeSetGauge(input.observability, {
          name: "opengeni_turn_worker_memory_guard_breach_seconds",
          help: "Seconds the turn-worker memory target has remained continuously breached.",
          labels: { scope: scope.scope },
          value: 0,
        });
        continue;
      }

      const startedAt = breachStartedAt.get(scope.scope) ?? observedAt;
      breachStartedAt.set(scope.scope, startedAt);
      const breachMs = Math.max(0, observedAt - startedAt);
      const breachSeconds = breachMs / 1_000;
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_breach_seconds",
        help: "Seconds the turn-worker memory target has remained continuously breached.",
        labels: { scope: scope.scope },
        value: breachSeconds,
      });
      if (breachMs >= input.settings.turnWorkerMemoryGuardSustainMs) {
        sustainedBreaches.push({ scope: scope.scope, utilizationRatio, breachSeconds });
      }
    }

    if (drainRequested || sustainedBreaches.length === 0) return;

    const primaryBreach = sustainedBreaches.sort(
      (left, right) => right.utilizationRatio - left.utilizationRatio,
    )[0];
    if (!primaryBreach) return;

    drainRequested = true;
    safeIncrementCounter(input.observability, {
      name: "opengeni_turn_worker_memory_guard_drains_total",
      help: "Graceful turn-worker drains requested after sustained memory pressure.",
      labels: { scope: primaryBreach.scope },
    });
    safeWarn(input.observability, "turn worker memory guard requested graceful drain", {
      errorClass: "WorkerLifecycleOperation",
      errorCode: "worker_draining",
      origin: "worker-lifecycle",
      reason: `memory pressure (${primaryBreach.scope}, ${boundedRatio(primaryBreach.utilizationRatio)} >= ${input.settings.turnWorkerTargetMemoryUsage}, ${primaryBreach.breachSeconds}s)`,
    });
    try {
      input.drain();
    } catch {
      drainRequested = false;
      safeIncrementCounter(input.observability, {
        name: "opengeni_turn_worker_memory_guard_drain_failures_total",
        help: "Turn-worker memory pressure guard drain requests that failed synchronously.",
        labels: { scope: primaryBreach.scope },
      });
      safeWarn(input.observability, "turn worker memory guard drain request failed", {
        errorClass: "WorkerLifecycleOperationError",
        errorCode: "worker_shutdown_request_failed",
        origin: "worker-lifecycle",
      });
    }
  };

  const timer = schedule(sampleNow, input.settings.turnWorkerMemoryGuardIntervalMs);
  timer.unref?.();
  sampleNow();

  return {
    sampleNow,
    close: () => {
      if (closed) return;
      closed = true;
      cancel(timer);
    },
  };
}

function readCgroupMemoryScope(): TurnWorkerMemoryScopeSnapshot | null {
  for (const [currentPath, maxPath] of [
    [CGROUP_V2_CURRENT, CGROUP_V2_MAX],
    [CGROUP_V1_CURRENT, CGROUP_V1_MAX],
  ] as const) {
    const currentRaw = readTextOrNull(currentPath);
    const maxRaw = readTextOrNull(maxPath);
    if (currentRaw === null || maxRaw === null) continue;
    const current = Number(currentRaw.trim());
    const limit = parseFiniteCgroupMemoryLimit(maxRaw);
    if (!Number.isFinite(current) || current < 0 || limit === null) continue;
    return { scope: "cgroup", usedBytes: current, limitBytes: limit };
  }
  return null;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function boundedRatio(value: number): number {
  return Math.round(Math.max(0, Math.min(value, 10)) * 1_000_000) / 1_000_000;
}

function safeSetGauge(
  observability: Observability,
  input: Parameters<Observability["setGauge"]>[0],
): void {
  try {
    observability.setGauge(input);
  } catch {
    // Telemetry cannot disable the memory-safety action.
  }
}

function safeIncrementCounter(
  observability: Observability,
  input: Parameters<Observability["incrementCounter"]>[0],
): void {
  try {
    observability.incrementCounter(input);
  } catch {
    // Telemetry cannot disable the memory-safety action.
  }
}

function safeWarn(
  observability: Observability,
  message: string,
  attributes: Parameters<Observability["warn"]>[1],
): void {
  try {
    observability.warn(message, attributes);
  } catch {
    // Telemetry cannot disable the memory-safety action.
  }
}
