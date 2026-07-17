// Unit tests for the fused machine-health verdict (deriveHealth). Pure function,
// so these pin the reachability > pressure > freshness precedence directly.
import { describe, expect, test } from "bun:test";
import { deriveHealth } from "../src/components/machines/health";
import type { MetricSample } from "../src/types/machines";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const GB = 1024 ** 3;

function sample(over: Partial<MetricSample> = {}, ageMs = 2000): MetricSample {
  return {
    cpuPct: 20,
    load1: 1,
    load5: 1,
    load15: 1,
    memUsedBytes: 8 * GB,
    memTotalBytes: 32 * GB,
    diskUsedBytes: 100 * GB,
    diskTotalBytes: 512 * GB,
    gpuUtilPct: null,
    gpuMemBytes: null,
    runQueue: 0,
    sampledAt: new Date(NOW - ageMs).toISOString(),
    ...over,
  };
}

describe("deriveHealth", () => {
  test("offline dominates regardless of metrics", () => {
    const v = deriveHealth("offline", sample(), NOW);
    expect(v.level).toBe("offline");
  });

  test("fresh + calm resources → healthy", () => {
    const v = deriveHealth("online", sample(), NOW);
    expect(v.level).toBe("healthy");
  });

  test("memory near the wall → critical, and names the cause", () => {
    const v = deriveHealth(
      "online",
      sample({ memUsedBytes: 31 * GB, memTotalBytes: 32 * GB }),
      NOW,
    );
    expect(v.level).toBe("critical");
    expect(v.reason.toLowerCase()).toContain("memory");
  });

  test("elevated (but not critical) memory → degraded", () => {
    const v = deriveHealth(
      "online",
      sample({ memUsedBytes: 29 * GB, memTotalBytes: 32 * GB }),
      NOW,
    );
    expect(v.level).toBe("degraded");
  });

  test("a stale sample degrades even when the last numbers were calm", () => {
    const v = deriveHealth("online", sample({}, 60_000), NOW);
    expect(v.level).toBe("degraded");
    expect(v.stale).toBe(true);
  });

  test("reconnecting is degraded, not offline", () => {
    const v = deriveHealth("reconnecting", sample(), NOW);
    expect(v.level).toBe("degraded");
  });

  test("no metrics yet → unknown, not a false healthy", () => {
    const v = deriveHealth("online", null, NOW);
    expect(v.level).toBe("unknown");
  });

  test("the worst resource wins (critical disk beats calm cpu/mem)", () => {
    const v = deriveHealth(
      "online",
      sample({ diskUsedBytes: 505 * GB, diskTotalBytes: 512 * GB }),
      NOW,
    );
    expect(v.level).toBe("critical");
    expect(v.reason.toLowerCase()).toContain("disk");
  });
});
