import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { posix } from "node:path";
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
  processHeapUsedBytes: number;
  processExternalBytes: number;
  processArrayBuffersBytes: number;
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
  | "turnWorkerEmergencyMemoryUsage"
  | "turnWorkerMemoryGuardIntervalMs"
  | "turnWorkerMemoryGuardSustainMs"
>;

type GuardDependencies = {
  now?: () => number;
  sample?: () => TurnWorkerMemoryPressureSnapshot;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  gc?: () => void;
};

type SnapshotDependencies = {
  readText?: (path: string) => string | null;
  hostTotalBytes?: () => number;
  hostAvailableBytes?: () => number;
  processMemoryUsage?: () => Pick<
    NodeJS.MemoryUsage,
    "rss" | "heapUsed" | "external" | "arrayBuffers"
  >;
};

export type ProcessCgroupMembership = {
  v2Path: string | null;
  v1MemoryPath: string | null;
};

export type CgroupMemoryFilePair = {
  currentPath: string;
  maxPath: string;
};

const CGROUP_V2_MOUNT = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY_MOUNT = "/sys/fs/cgroup/memory";

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

export function parseProcessCgroupMembership(value: string): ProcessCgroupMembership {
  let v2Path: string | null = null;
  let v1MemoryPath: string | null = null;
  for (const line of value.split("\n")) {
    const firstSeparator = line.indexOf(":");
    const secondSeparator = line.indexOf(":", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator < 0) continue;
    const hierarchyId = line.slice(0, firstSeparator);
    const controllers = line.slice(firstSeparator + 1, secondSeparator);
    const path = normalizeCgroupPath(line.slice(secondSeparator + 1));
    if (!path) continue;
    if (hierarchyId === "0" && controllers === "") {
      v2Path = path;
    }
    if (controllers.split(",").includes("memory")) {
      v1MemoryPath = path;
    }
  }
  return { v2Path, v1MemoryPath };
}

export function cgroupMemoryFilePairs(membership: ProcessCgroupMembership): CgroupMemoryFilePair[] {
  const pairs: CgroupMemoryFilePair[] = [];
  const seen = new Set<string>();
  const appendHierarchy = (
    mount: string,
    path: string | null,
    currentFilename: string,
    maxFilename: string,
  ) => {
    for (const candidate of cgroupAncestorPaths(path ?? "/")) {
      const relative = candidate === "/" ? "" : candidate.slice(1);
      const currentPath = posix.join(mount, relative, currentFilename);
      const maxPath = posix.join(mount, relative, maxFilename);
      const key = `${currentPath}\0${maxPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ currentPath, maxPath });
    }
  };

  appendHierarchy(CGROUP_V2_MOUNT, membership.v2Path, "memory.current", "memory.max");
  appendHierarchy(
    CGROUP_V1_MEMORY_MOUNT,
    membership.v1MemoryPath,
    "memory.usage_in_bytes",
    "memory.limit_in_bytes",
  );
  return pairs;
}

export function readTurnWorkerMemoryPressureSnapshot(
  dependencies: SnapshotDependencies = {},
): TurnWorkerMemoryPressureSnapshot {
  const readText = dependencies.readText ?? readTextOrNull;
  const linux = parseLinuxMeminfo(readText("/proc/meminfo") ?? "");
  const hostTotalBytes = linux?.totalBytes ?? (dependencies.hostTotalBytes ?? totalmem)();
  const hostAvailableBytes =
    linux?.availableBytes ?? (dependencies.hostAvailableBytes ?? freemem)();
  const host = {
    scope: "host" as const,
    usedBytes: Math.max(0, hostTotalBytes - Math.min(hostTotalBytes, hostAvailableBytes)),
    limitBytes: hostTotalBytes,
  };
  const cgroup = readCgroupMemoryScope(readText);
  // A finite process cgroup is the pod's actual admission boundary. Host
  // pressure includes unrelated workloads and must not make every replica
  // drain simultaneously; use it only when no finite cgroup authority exists.
  const processMemory = (dependencies.processMemoryUsage ?? process.memoryUsage)();

  return {
    processRssBytes: processMemory.rss,
    processHeapUsedBytes: processMemory.heapUsed,
    processExternalBytes: processMemory.external,
    processArrayBuffersBytes: processMemory.arrayBuffers,
    scopes: [cgroup ?? host],
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
  const collectGarbage = input.dependencies?.gc ?? (() => Bun.gc(false));
  const breachStartedAt = new Map<TurnWorkerMemoryScope, number>();
  let lastGcAt = Number.NEGATIVE_INFINITY;
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
    for (const [kind, value] of [
      ["rss", snapshot.processRssBytes],
      ["heap_used", snapshot.processHeapUsedBytes],
      ["external", snapshot.processExternalBytes],
      ["array_buffers", snapshot.processArrayBuffersBytes],
    ] as const) {
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_process_memory_bytes",
        help: "Turn-worker process memory by runtime-reported category.",
        labels: { kind },
        value: Number.isFinite(value) && value >= 0 ? value : 0,
      });
    }
    let shouldCollectGarbage = false;
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
        help: "Memory admission target enforced by the Temporal resource tuner.",
        labels: { scope: scope.scope },
        value: input.settings.turnWorkerTargetMemoryUsage,
      });
      safeSetGauge(input.observability, {
        name: "opengeni_turn_worker_memory_guard_emergency_ratio",
        help: "Emergency memory threshold enforced by the turn-worker pressure guard.",
        labels: { scope: scope.scope },
        value: input.settings.turnWorkerEmergencyMemoryUsage,
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
      shouldCollectGarbage ||= processRssRatio >= input.settings.turnWorkerTargetMemoryUsage;

      if (utilizationRatio < input.settings.turnWorkerEmergencyMemoryUsage) {
        breachStartedAt.delete(scope.scope);
        safeSetGauge(input.observability, {
          name: "opengeni_turn_worker_memory_guard_breach_seconds",
          help: "Seconds the turn-worker emergency threshold has remained continuously breached.",
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
        help: "Seconds the turn-worker emergency threshold has remained continuously breached.",
        labels: { scope: scope.scope },
        value: breachSeconds,
      });
      if (breachMs >= input.settings.turnWorkerMemoryGuardSustainMs) {
        sustainedBreaches.push({ scope: scope.scope, utilizationRatio, breachSeconds });
      }
    }

    // Large request buffers can become unreachable well before JSC's ordinary
    // heap trigger notices native/external pressure. Nudge an asynchronous GC
    // at most once per sustain window before escalating to a worker drain.
    const sustainedBreachesHadGcOpportunity =
      sustainedBreaches.length > 0 &&
      sustainedBreaches.every(({ scope }) => {
        const breachStarted = breachStartedAt.get(scope);
        return breachStarted !== undefined && lastGcAt >= breachStarted && lastGcAt < observedAt;
      });
    let collectedGarbageThisSample = false;
    if (
      shouldCollectGarbage &&
      observedAt - lastGcAt >= input.settings.turnWorkerMemoryGuardSustainMs &&
      (sustainedBreaches.length === 0 || !sustainedBreachesHadGcOpportunity)
    ) {
      lastGcAt = observedAt;
      try {
        collectGarbage();
        collectedGarbageThisSample = true;
        safeIncrementCounter(input.observability, {
          name: "opengeni_turn_worker_memory_guard_gc_total",
          help: "Proactive garbage-collection nudges under process memory pressure.",
        });
      } catch {
        safeIncrementCounter(input.observability, {
          name: "opengeni_turn_worker_memory_guard_gc_failures_total",
          help: "Proactive memory-pressure garbage-collection nudges that failed.",
        });
      }
    }

    // The nudge is asynchronous. Give it one sampling interval to make the
    // reclaimed RSS visible before deciding that process recycling is needed.
    if (
      (collectedGarbageThisSample && !sustainedBreachesHadGcOpportunity) ||
      drainRequested ||
      sustainedBreaches.length === 0
    ) {
      return;
    }

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
      reason: `memory pressure (${primaryBreach.scope}, ${boundedRatio(primaryBreach.utilizationRatio)} >= ${input.settings.turnWorkerEmergencyMemoryUsage}, ${primaryBreach.breachSeconds}s)`,
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

function readCgroupMemoryScope(
  readText: (path: string) => string | null,
): TurnWorkerMemoryScopeSnapshot | null {
  const membership = parseProcessCgroupMembership(readText("/proc/self/cgroup") ?? "");
  let mostPressured: TurnWorkerMemoryScopeSnapshot | null = null;
  for (const { currentPath, maxPath } of cgroupMemoryFilePairs(membership)) {
    const currentRaw = readText(currentPath);
    const maxRaw = readText(maxPath);
    if (currentRaw === null || maxRaw === null) continue;
    const current = Number(currentRaw.trim());
    const limit = parseFiniteCgroupMemoryLimit(maxRaw);
    if (!Number.isFinite(current) || current < 0 || limit === null) continue;
    const candidate = { scope: "cgroup" as const, usedBytes: current, limitBytes: limit };
    if (
      !mostPressured ||
      candidate.usedBytes / candidate.limitBytes >
        mostPressured.usedBytes / mostPressured.limitBytes
    ) {
      mostPressured = candidate;
    }
  }
  return mostPressured;
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

function normalizeCgroupPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\0")) return null;
  if (trimmed.split("/").includes("..")) return null;
  return posix.normalize(trimmed);
}

function cgroupAncestorPaths(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (true) {
    ancestors.push(current);
    if (current === "/") return ancestors;
    current = posix.dirname(current);
  }
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
