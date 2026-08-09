import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  cgroupMemoryFilePairs,
  createTurnWorkerMemoryPressureGuard,
  parseFiniteCgroupMemoryLimit,
  parseLinuxMeminfo,
  parseProcessCgroupMembership,
  readTurnWorkerMemoryPressureSnapshot,
  turnWorkerMemoryPressureGuardEnabled,
  type TurnWorkerMemoryPressureSnapshot,
} from "../src/memory-pressure-guard";
import { createWorkerServiceLifecycle } from "../src/worker-service-lifecycle";

const GiB = 1024 ** 3;

function snapshot(input: {
  hostUsedGiB: number;
  hostTotalGiB?: number;
  cgroupUsedGiB?: number;
  cgroupLimitGiB?: number;
  rssGiB?: number;
}): TurnWorkerMemoryPressureSnapshot {
  return {
    processRssBytes: (input.rssGiB ?? 1) * GiB,
    processHeapUsedBytes: 256 * 1024 ** 2,
    processExternalBytes: 64 * 1024 ** 2,
    processArrayBuffersBytes: 32 * 1024 ** 2,
    scopes: [
      {
        scope: "host",
        usedBytes: input.hostUsedGiB * GiB,
        limitBytes: (input.hostTotalGiB ?? 24) * GiB,
      },
      ...(input.cgroupUsedGiB !== undefined && input.cgroupLimitGiB !== undefined
        ? [
            {
              scope: "cgroup" as const,
              usedBytes: input.cgroupUsedGiB * GiB,
              limitBytes: input.cgroupLimitGiB * GiB,
            },
          ]
        : []),
    ],
  };
}

describe("turn worker memory pressure guard", () => {
  test("only enables continuous enforcement for resource-based turn workers", () => {
    expect(
      turnWorkerMemoryPressureGuardEnabled("turn", {
        turnWorkerConcurrencyMode: "resource-based",
      }),
    ).toBe(true);
    expect(
      turnWorkerMemoryPressureGuardEnabled("turn", { turnWorkerConcurrencyMode: "fixed" }),
    ).toBe(false);
    expect(
      turnWorkerMemoryPressureGuardEnabled("control", {
        turnWorkerConcurrencyMode: "resource-based",
      }),
    ).toBe(false);
  });

  test("parses MemAvailable and finite cgroup limits without accepting unlimited sentinels", () => {
    expect(
      parseLinuxMeminfo(
        "MemTotal:       24576000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\n",
      ),
    ).toEqual({ totalBytes: 24_576_000 * 1024, availableBytes: 6_000_000 * 1024 });
    expect(parseLinuxMeminfo("MemTotal: 10 kB\n")).toBeNull();
    expect(parseFiniteCgroupMemoryLimit("4294967296\n")).toBe(4 * GiB);
    expect(parseFiniteCgroupMemoryLimit("max\n")).toBeNull();
    expect(parseFiniteCgroupMemoryLimit("9223372036854771712\n")).toBeNull();
  });

  test("resolves v2 and v1 process cgroup paths from procfs without traversal", () => {
    const membership = parseProcessCgroupMembership(
      "0::/system.slice/opengeni-worker.service\n4:cpu,memory:/docker/worker\n",
    );
    expect(membership).toEqual({
      v2Path: "/system.slice/opengeni-worker.service",
      v1MemoryPath: "/docker/worker",
    });
    expect(cgroupMemoryFilePairs(membership).slice(0, 3)).toEqual([
      {
        currentPath: "/sys/fs/cgroup/system.slice/opengeni-worker.service/memory.current",
        maxPath: "/sys/fs/cgroup/system.slice/opengeni-worker.service/memory.max",
      },
      {
        currentPath: "/sys/fs/cgroup/system.slice/memory.current",
        maxPath: "/sys/fs/cgroup/system.slice/memory.max",
      },
      {
        currentPath: "/sys/fs/cgroup/memory.current",
        maxPath: "/sys/fs/cgroup/memory.max",
      },
    ]);
    expect(parseProcessCgroupMembership("0::/../../etc\n")).toEqual({
      v2Path: null,
      v1MemoryPath: null,
    });
  });

  test("uses the most pressured finite process cgroup or ancestor", () => {
    const files = new Map<string, string>([
      ["/proc/meminfo", "MemTotal: 25165824 kB\nMemAvailable: 12582912 kB\n"],
      ["/proc/self/cgroup", "0::/system.slice/opengeni-worker.service\n"],
      ["/sys/fs/cgroup/system.slice/opengeni-worker.service/memory.current", String(3 * GiB)],
      ["/sys/fs/cgroup/system.slice/opengeni-worker.service/memory.max", String(8 * GiB)],
      ["/sys/fs/cgroup/system.slice/memory.current", String(Math.floor(3.2 * GiB))],
      ["/sys/fs/cgroup/system.slice/memory.max", String(4 * GiB)],
      ["/sys/fs/cgroup/memory.current", String(12 * GiB)],
      ["/sys/fs/cgroup/memory.max", "max"],
    ]);

    expect(
      readTurnWorkerMemoryPressureSnapshot({
        readText: (path) => files.get(path) ?? null,
        processMemoryUsage: () => ({
          rss: 2 * GiB,
          heapUsed: 512 * 1024 ** 2,
          external: 128 * 1024 ** 2,
          arrayBuffers: 64 * 1024 ** 2,
        }),
      }),
    ).toEqual({
      processRssBytes: 2 * GiB,
      processHeapUsedBytes: 512 * 1024 ** 2,
      processExternalBytes: 128 * 1024 ** 2,
      processArrayBuffersBytes: 64 * 1024 ** 2,
      scopes: [
        {
          scope: "cgroup",
          usedBytes: Math.floor(3.2 * GiB),
          limitBytes: 4 * GiB,
        },
      ],
    });
  });

  test("requires one sustained breach and requests the ordinary graceful drain exactly once", async () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let now = 0;
    let current = snapshot({ hostUsedGiB: 12, rssGiB: 4 });
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 30_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: { now: () => now, sample: () => current },
    });

    now = 1_000;
    current = snapshot({ hostUsedGiB: 22, rssGiB: 10 });
    guard.sampleNow();
    now = 30_999;
    guard.sampleNow();
    expect(drains).toBe(0);
    now = 31_000;
    guard.sampleNow();
    guard.sampleNow();
    expect(drains).toBe(1);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_worker_memory_guard_drains_total\{[^}]*scope="host"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_worker_memory_guard_process_rss_ratio\{[^}]*scope="host"[^}]*\}/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_worker_memory_guard_target_ratio\{[^}]*scope="host"[^}]*\} 0\.75\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_worker_memory_guard_emergency_ratio\{[^}]*scope="host"[^}]*\} 0\.9\b/,
    );
    guard.close();
  });

  test("nudges GC at bounded cadence and gives it one sample before emergency drain", async () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let now = 0;
    let collections = 0;
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 10_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: {
        now: () => now,
        gc: () => {
          collections += 1;
        },
        sample: () =>
          snapshot({
            hostUsedGiB: 12,
            cgroupUsedGiB: 3.7,
            cgroupLimitGiB: 4,
            rssGiB: 3.2,
          }),
      },
    });

    expect(collections).toBe(1);
    expect(drains).toBe(0);
    now = 9_999;
    guard.sampleNow();
    expect(collections).toBe(1);
    expect(drains).toBe(0);
    now = 10_000;
    guard.sampleNow();
    expect(collections).toBe(1);
    expect(drains).toBe(1);
    expect(await observability.prometheusMetrics()).toMatch(
      /opengeni_turn_worker_memory_guard_gc_total\{[^}]*\} 1\b/,
    );
    guard.close();
  });

  test("resets a transient breach and honors a tighter finite cgroup scope", async () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let now = 0;
    let current = snapshot({
      hostUsedGiB: 12,
      cgroupUsedGiB: 3.2,
      cgroupLimitGiB: 4,
      rssGiB: 3,
    });
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 10_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: { now: () => now, sample: () => current },
    });

    now = 5_000;
    current = snapshot({
      hostUsedGiB: 12,
      cgroupUsedGiB: 2,
      cgroupLimitGiB: 4,
      rssGiB: 2,
    });
    guard.sampleNow();
    now = 20_000;
    current = snapshot({
      hostUsedGiB: 12,
      cgroupUsedGiB: 3.7,
      cgroupLimitGiB: 4,
      rssGiB: 3,
    });
    guard.sampleNow();
    now = 30_000;
    guard.sampleNow();
    expect(drains).toBe(1);
    expect(await observability.prometheusMetrics()).toMatch(
      /opengeni_turn_worker_memory_guard_drains_total\{[^}]*scope="cgroup"[^}]*\} 1\b/,
    );
    guard.close();
  });

  test("does not combine alternating host and cgroup breaches into one sustained breach", () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let now = 0;
    let current = snapshot({
      hostUsedGiB: 22,
      cgroupUsedGiB: 2,
      cgroupLimitGiB: 4,
    });
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 10_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: { now: () => now, sample: () => current },
    });

    now = 6_000;
    current = snapshot({
      hostUsedGiB: 12,
      cgroupUsedGiB: 3.7,
      cgroupLimitGiB: 4,
    });
    guard.sampleNow();
    now = 11_000;
    guard.sampleNow();
    expect(drains).toBe(0);
    now = 16_000;
    guard.sampleNow();
    expect(drains).toBe(1);
    guard.close();
  });

  test("an unreadable sample resets the sustained breach window", () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let now = 0;
    let failSample = false;
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 10_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: {
        now: () => now,
        sample: () => {
          if (failSample) throw new Error("sample unavailable");
          return snapshot({ hostUsedGiB: 22 });
        },
      },
    });

    now = 9_000;
    failSample = true;
    guard.sampleNow();
    failSample = false;
    now = 10_000;
    guard.sampleNow();
    now = 19_999;
    guard.sampleNow();
    expect(drains).toBe(0);
    now = 20_000;
    guard.sampleNow();
    expect(drains).toBe(1);
    guard.close();
  });

  test("telemetry failures cannot disable the graceful drain action", () => {
    let now = 0;
    let drains = 0;
    const observability = {
      setGauge: () => {
        throw new Error("metrics unavailable");
      },
      incrementCounter: () => {
        throw new Error("metrics unavailable");
      },
      warn: () => {
        throw new Error("logging unavailable");
      },
    } as never;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 5_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: { now: () => now, sample: () => snapshot({ hostUsedGiB: 22 }) },
    });

    now = 5_000;
    guard.sampleNow();
    expect(drains).toBe(1);
    guard.close();
  });

  test("retries and records a lifecycle shutdown request that fails synchronously", async () => {
    const observability = createObservability(
      {
        observabilityMetricsEnabled: true,
        observabilityStructuredLogs: false,
        observabilityOtlpEndpoint: undefined,
        observabilityOtlpHeaders: "",
        serviceName: "opengeni-test",
        environment: "test",
      } as never,
      { component: "worker-turn" },
    );
    let shutdownAttempts = 0;
    const lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      observability,
      worker: {
        run: async () => undefined,
        shutdown: () => {
          shutdownAttempts += 1;
          if (shutdownAttempts === 1) throw new Error("shutdown failed");
        },
      },
      closeOwnedResources: async () => undefined,
    });
    let now = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
        turnWorkerEmergencyMemoryUsage: 0.9,
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 5_000,
      },
      observability,
      drain: () => {
        if (!lifecycle.drain("memory pressure guard")) {
          throw new Error("worker shutdown request failed");
        }
      },
      dependencies: { now: () => now, sample: () => snapshot({ hostUsedGiB: 22 }) },
    });

    now = 5_000;
    guard.sampleNow();
    expect(lifecycle.state()).toBe("starting");
    expect(shutdownAttempts).toBe(1);
    now = 10_000;
    guard.sampleNow();
    expect(lifecycle.state()).toBe("draining");
    expect(shutdownAttempts).toBe(2);
    expect(await observability.prometheusMetrics()).toMatch(
      /opengeni_turn_worker_memory_guard_drain_failures_total\{[^}]*scope="host"[^}]*\} 1\b/,
    );
    guard.close();
    await lifecycle.close();
  });
});
