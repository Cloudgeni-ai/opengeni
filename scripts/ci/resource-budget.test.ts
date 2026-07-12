import { describe, expect, test } from "bun:test";

import {
  computeTestConcurrencyBudget,
  describeTestConcurrencyBudget,
  detectedMemoryLimit,
  detectedMemoryUsage,
} from "./resource-budget";

const MIB = 1024 * 1024;

describe("memory-aware test concurrency", () => {
  test("low-memory cgroups deterministically fall back to one test", () => {
    const budget = computeTestConcurrencyBudget({
      memoryLimitBytes: 768 * MIB,
      cpuSlots: 16,
      requestedMax: 8,
      memoryPerTestMib: 512,
      source: "test-low-memory",
    });
    expect(budget.concurrency).toBe(1);
    expect(budget.memorySlots).toBe(1);
    expect(describeTestConcurrencyBudget(budget)).toContain("source=test-low-memory");
  });

  test("large runners remain hard-capped and CPU-bounded", () => {
    expect(
      computeTestConcurrencyBudget({
        memoryLimitBytes: 64 * 1024 * MIB,
        cpuSlots: 32,
        requestedMax: 100,
      }).concurrency,
    ).toBe(8);
    expect(
      computeTestConcurrencyBudget({
        memoryLimitBytes: 64 * 1024 * MIB,
        cpuSlots: 2,
        requestedMax: 8,
      }).concurrency,
    ).toBe(2);
  });

  test("ambient cgroup usage reduces runnable workers", () => {
    const budget = computeTestConcurrencyBudget({
      memoryLimitBytes: 4096 * MIB,
      memoryUsageBytes: 3072 * MIB,
      cpuSlots: 16,
      requestedMax: 8,
      memoryPerTestMib: 512,
    });
    expect(budget.concurrency).toBe(1);
    expect(budget.memoryAvailableBytes).toBeLessThan(256 * MIB);
    expect(budget.memoryUsageBytes + budget.memoryReserveBytes + budget.memoryAvailableBytes).toBe(
      budget.memoryLimitBytes,
    );
  });

  test("unavailable usage accounting fails closed to one worker", () => {
    const budget = computeTestConcurrencyBudget({
      memoryLimitBytes: 64 * 1024 * MIB,
      memoryUsageBytes: 0,
      memoryUsageKnown: false,
      cpuSlots: 32,
      requestedMax: 8,
    });
    expect(budget.concurrency).toBe(1);
    expect(budget.memoryUsageBytes).toBe(budget.memoryLimitBytes);
  });

  test("detection chooses the smallest finite host/cgroup fence", () => {
    const files = new Map<string, string>([
      ["/sys/fs/cgroup/memory.max", String(2048 * MIB)],
      ["/sys/fs/cgroup/memory.high", "max"],
      ["/sys/fs/cgroup/memory/memory.limit_in_bytes", String(4096 * MIB)],
    ]);
    expect(
      detectedMemoryLimit({
        hostTotalBytes: 8192 * MIB,
        readFile: (path) => files.get(path) ?? null,
      }),
    ).toEqual({ bytes: 2048 * MIB, source: "cgroup-v2-max" });
  });

  test("current usage detection prefers cgroup v2 and reports unavailability explicitly", () => {
    expect(
      detectedMemoryUsage((path) =>
        path === "/sys/fs/cgroup/memory.current" ? String(768 * MIB) : null,
      ),
    ).toEqual({ bytes: 768 * MIB, source: "cgroup-v2-current" });
    expect(detectedMemoryUsage(() => null)).toEqual({
      bytes: 0,
      source: "usage-unavailable",
    });
  });
});
