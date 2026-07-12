import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";

const MIB = 1024 * 1024;
const DEFAULT_MEMORY_PER_TEST_MIB = 512;
const MIN_MEMORY_PER_TEST_MIB = 256;
const DEFAULT_MAX_CONCURRENCY = 4;
const ABSOLUTE_MAX_CONCURRENCY = 8;

export type TestConcurrencyBudget = {
  concurrency: number;
  cpuSlots: number;
  memorySlots: number;
  memoryLimitBytes: number;
  memoryUsageBytes: number;
  memoryAvailableBytes: number;
  memoryReserveBytes: number;
  memoryPerTestBytes: number;
  source: string;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function finiteByteLimit(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "max") return null;
  const parsed = Number(trimmed);
  // Linux v1 commonly reports a huge page-aligned sentinel for "unlimited".
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= 2 ** 60) return null;
  return parsed;
}

function finiteByteUsage(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export type DetectedMemoryState = {
  limitBytes: number;
  usageBytes: number;
  usageKnown: boolean;
  source: string;
};

export function detectedMemoryState(
  options: {
    hostTotalBytes?: number;
    hostFreeBytes?: number;
    readFile?: (path: string) => string | null;
  } = {},
): DetectedMemoryState {
  const hostTotalBytes = options.hostTotalBytes ?? totalmem();
  const hostFreeBytes = options.hostFreeBytes ?? freemem();
  const readFile =
    options.readFile ??
    ((path: string): string | null => {
      if (!existsSync(path)) return null;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const v2Limits = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.high"]
    .map((path) => readFile(path))
    .flatMap((raw) => (raw === null ? [] : [finiteByteLimit(raw)]))
    .filter((value): value is number => value !== null);
  const v1Raw = readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const v1Limit = v1Raw === null ? null : finiteByteLimit(v1Raw);
  const cgroups = [
    ...(v2Limits.length > 0
      ? [
          {
            limitBytes: Math.min(...v2Limits),
            usagePath: "/sys/fs/cgroup/memory.current",
            source: "cgroup-v2",
          },
        ]
      : []),
    ...(v1Limit === null
      ? []
      : [
          {
            limitBytes: v1Limit,
            usagePath: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
            source: "cgroup-v1",
          },
        ]),
  ]
    // A cgroup fence above physical host memory is not the effective domain.
    .filter((candidate) => candidate.limitBytes < hostTotalBytes)
    .sort((a, b) => a.limitBytes - b.limitBytes);
  const cgroup = cgroups[0];
  if (cgroup) {
    const usageRaw = readFile(cgroup.usagePath);
    const usageBytes = usageRaw === null ? null : finiteByteUsage(usageRaw);
    return {
      limitBytes: Math.max(MIB, cgroup.limitBytes),
      usageBytes: usageBytes ?? cgroup.limitBytes,
      usageKnown: usageBytes !== null,
      source: `${cgroup.source}-${usageBytes === null ? "usage-unavailable" : "limit+usage"}`,
    };
  }
  const hostUsageKnown =
    Number.isSafeInteger(hostFreeBytes) && hostFreeBytes >= 0 && hostFreeBytes <= hostTotalBytes;
  return {
    limitBytes: Math.max(MIB, hostTotalBytes),
    usageBytes: hostUsageKnown ? hostTotalBytes - hostFreeBytes : hostTotalBytes,
    usageKnown: hostUsageKnown,
    source: hostUsageKnown ? "host-total+host-used" : "host-usage-unavailable",
  };
}

export function computeTestConcurrencyBudget(options: {
  memoryLimitBytes: number;
  memoryUsageBytes?: number;
  memoryUsageKnown?: boolean;
  cpuSlots: number;
  requestedMax?: number;
  memoryPerTestMib?: number;
  source?: string;
}): TestConcurrencyBudget {
  const cpuSlots = Math.max(1, Math.floor(options.cpuSlots));
  const requestedMax = Math.min(
    ABSOLUTE_MAX_CONCURRENCY,
    Math.max(1, Math.floor(options.requestedMax ?? DEFAULT_MAX_CONCURRENCY)),
  );
  const memoryPerTestMib = Math.max(
    MIN_MEMORY_PER_TEST_MIB,
    Math.floor(options.memoryPerTestMib ?? DEFAULT_MEMORY_PER_TEST_MIB),
  );
  const memoryPerTestBytes = memoryPerTestMib * MIB;
  const memoryLimitBytes = Math.max(MIB, Math.floor(options.memoryLimitBytes));
  // Unknown ambient usage is not zero usage. Budget as fully occupied so a
  // runner with unreadable cgroup accounting degrades to one worker rather than
  // amplifying an already opaque memory-pressure condition.
  const memoryUsageBytes =
    options.memoryUsageKnown === false
      ? memoryLimitBytes
      : Math.max(0, Math.floor(options.memoryUsageBytes ?? 0));
  // Keep both a proportional reserve and enough room for Bun/the runner/service
  // control processes. On genuinely small cgroups the reserve scales down rather
  // than making every budget impossible.
  const memoryReserveBytes = Math.min(
    1024 * MIB,
    Math.max(256 * MIB, Math.floor(memoryLimitBytes * 0.2)),
    Math.floor(memoryLimitBytes * 0.5),
  );
  const memoryAvailableBytes = Math.max(
    0,
    memoryLimitBytes - Math.min(memoryLimitBytes, memoryUsageBytes) - memoryReserveBytes,
  );
  const memorySlots = Math.max(1, Math.floor(memoryAvailableBytes / memoryPerTestBytes));
  return {
    concurrency: Math.max(1, Math.min(requestedMax, cpuSlots, memorySlots)),
    cpuSlots,
    memorySlots,
    memoryLimitBytes,
    memoryUsageBytes,
    memoryAvailableBytes,
    memoryReserveBytes,
    memoryPerTestBytes,
    source: options.source ?? "explicit",
  };
}

export function testConcurrencyBudget(
  environment: NodeJS.ProcessEnv = process.env,
): TestConcurrencyBudget {
  const memory = detectedMemoryState();
  return computeTestConcurrencyBudget({
    memoryLimitBytes: memory.limitBytes,
    memoryUsageBytes: memory.usageBytes,
    memoryUsageKnown: memory.usageKnown,
    cpuSlots: availableParallelism(),
    requestedMax: positiveInteger(
      environment.OPENGENI_TEST_MAX_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
      "OPENGENI_TEST_MAX_CONCURRENCY",
    ),
    memoryPerTestMib: positiveInteger(
      environment.OPENGENI_TEST_MEMORY_PER_WORKER_MB,
      DEFAULT_MEMORY_PER_TEST_MIB,
      "OPENGENI_TEST_MEMORY_PER_WORKER_MB",
    ),
    source: memory.source,
  });
}

export function describeTestConcurrencyBudget(budget: TestConcurrencyBudget): string {
  const mib = (bytes: number): string => `${Math.round(bytes / MIB)}MiB`;
  return [
    `concurrency=${budget.concurrency}`,
    `cpuSlots=${budget.cpuSlots}`,
    `memorySlots=${budget.memorySlots}`,
    `memoryLimit=${mib(budget.memoryLimitBytes)}`,
    `memoryUsage=${mib(budget.memoryUsageBytes)}`,
    `available=${mib(budget.memoryAvailableBytes)}`,
    `reserve=${mib(budget.memoryReserveBytes)}`,
    `perTest=${mib(budget.memoryPerTestBytes)}`,
    `source=${budget.source}`,
  ].join(" ");
}
