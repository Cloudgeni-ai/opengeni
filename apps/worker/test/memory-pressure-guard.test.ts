import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  createTurnWorkerMemoryPressureGuard,
  parseFiniteCgroupMemoryLimit,
  parseLinuxMeminfo,
  turnWorkerMemoryPressureGuardEnabled,
  type TurnWorkerMemoryPressureSnapshot,
} from "../src/memory-pressure-guard";

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
    current = snapshot({ hostUsedGiB: 19, rssGiB: 10 });
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
      cgroupUsedGiB: 3.5,
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
      hostUsedGiB: 20,
      cgroupUsedGiB: 2,
      cgroupLimitGiB: 4,
    });
    let drains = 0;
    const guard = createTurnWorkerMemoryPressureGuard({
      settings: {
        turnWorkerConcurrencyMode: "resource-based",
        turnWorkerTargetMemoryUsage: 0.75,
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
      cgroupUsedGiB: 3.5,
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
          return snapshot({ hostUsedGiB: 20 });
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
        turnWorkerMemoryGuardIntervalMs: 60_000,
        turnWorkerMemoryGuardSustainMs: 5_000,
      },
      observability,
      drain: () => {
        drains += 1;
      },
      dependencies: { now: () => now, sample: () => snapshot({ hostUsedGiB: 20 }) },
    });

    now = 5_000;
    guard.sampleNow();
    expect(drains).toBe(1);
    guard.close();
  });
});
