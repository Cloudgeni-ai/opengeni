import { describe, expect, test } from "bun:test";
import { distribution, scalingReceipts } from "./bench-session-event-append";

describe("session event append benchmark receipts", () => {
  test("reports nearest-rank latency percentiles", () => {
    expect(distribution([5, 1, 4, 2, 3])).toEqual({
      samples: 5,
      min: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
    });
  });

  test("computes independent-session scaling against the matching serial scenario", () => {
    const latencyMs = { samples: 10, min: 1, p50: 1, p95: 1, p99: 1, max: 1 };
    expect(
      scalingReceipts(
        [
          {
            name: "same_workspace_raw_10_c1",
            topology: "same_workspace",
            eventClass: "raw",
            batchSize: 10,
            concurrency: 1,
            latencyMs,
            throughputPerSecond: 100,
          },
          {
            name: "same_workspace_raw_10_c8",
            topology: "same_workspace",
            eventClass: "raw",
            batchSize: 10,
            concurrency: 8,
            latencyMs,
            throughputPerSecond: 720,
          },
        ],
        8,
      ),
    ).toEqual([
      {
        topology: "same_workspace",
        eventClass: "raw",
        batchSize: 10,
        concurrency: 8,
        efficiency: 0.9,
      },
    ]);
  });
});
