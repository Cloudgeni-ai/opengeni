import { describe, expect, test } from "bun:test";

import {
  computeTestConcurrencyBudget,
  describeTestConcurrencyBudget,
  detectedMemoryState,
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

  test("detection pairs the smallest finite cgroup fence with its own usage", () => {
    const files = new Map<string, string>([
      ["/sys/fs/cgroup/memory.max", String(2048 * MIB)],
      ["/sys/fs/cgroup/memory.high", "max"],
      ["/sys/fs/cgroup/memory.current", String(768 * MIB)],
      ["/sys/fs/cgroup/memory/memory.limit_in_bytes", String(4096 * MIB)],
      ["/sys/fs/cgroup/memory/memory.usage_in_bytes", String(512 * MIB)],
    ]);
    expect(
      detectedMemoryState({
        hostTotalBytes: 8192 * MIB,
        hostFreeBytes: 2048 * MIB,
        readFile: (path) => files.get(path) ?? null,
      }),
    ).toEqual({
      limitBytes: 2048 * MIB,
      usageBytes: 768 * MIB,
      usageKnown: true,
      source: "cgroup-v2-limit+usage",
    });
  });

  test.each([0, 512 * 1024])(
    "a sub-MiB memory.high fence of %i bytes stays paired with cgroup usage",
    (high) => {
      const files = new Map<string, string>([
        ["/sys/fs/cgroup/memory.max", String(8192 * MIB)],
        ["/sys/fs/cgroup/memory.high", String(high)],
        ["/sys/fs/cgroup/memory.current", String(4096 * MIB)],
      ]);
      const memory = detectedMemoryState({
        hostTotalBytes: 16 * 1024 * MIB,
        hostFreeBytes: 8 * 1024 * MIB,
        readFile: (path) => files.get(path) ?? null,
      });
      expect(memory).toEqual({
        limitBytes: MIB,
        usageBytes: 4096 * MIB,
        usageKnown: true,
        source: "cgroup-v2-limit+usage",
      });
      expect(
        computeTestConcurrencyBudget({
          memoryLimitBytes: memory.limitBytes,
          memoryUsageBytes: memory.usageBytes,
          memoryUsageKnown: memory.usageKnown,
          cpuSlots: 16,
          requestedMax: 8,
        }).concurrency,
      ).toBe(1);
    },
  );

  test("an unlimited cgroup never mixes its usage with the host memory domain", () => {
    const files = new Map<string, string>([
      ["/sys/fs/cgroup/memory.max", "max"],
      ["/sys/fs/cgroup/memory.high", "max"],
      ["/sys/fs/cgroup/memory/memory.limit_in_bytes", String(2 ** 61)],
      ["/sys/fs/cgroup/memory/memory.usage_in_bytes", String(256 * MIB)],
    ]);
    expect(
      detectedMemoryState({
        hostTotalBytes: 8192 * MIB,
        hostFreeBytes: 2048 * MIB,
        readFile: (path) => files.get(path) ?? null,
      }),
    ).toEqual({
      limitBytes: 8192 * MIB,
      usageBytes: 6144 * MIB,
      usageKnown: true,
      source: "host-total+host-used",
    });
  });

  test("a tighter cgroup with unreadable matching usage fails closed", () => {
    const memory = detectedMemoryState({
      hostTotalBytes: 8192 * MIB,
      hostFreeBytes: 4096 * MIB,
      readFile: (path) => (path === "/sys/fs/cgroup/memory.max" ? String(2048 * MIB) : null),
    });
    expect(memory).toEqual({
      limitBytes: 2048 * MIB,
      usageBytes: 2048 * MIB,
      usageKnown: false,
      source: "cgroup-v2-usage-unavailable",
    });
    expect(
      computeTestConcurrencyBudget({
        memoryLimitBytes: memory.limitBytes,
        memoryUsageBytes: memory.usageBytes,
        memoryUsageKnown: memory.usageKnown,
        cpuSlots: 32,
        requestedMax: 8,
      }).concurrency,
    ).toBe(1);
  });
});
