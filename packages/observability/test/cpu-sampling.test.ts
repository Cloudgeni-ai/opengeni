import { describe, expect, test } from "bun:test";
import {
  analyzeCpuSamples,
  captureCpuSamplingProfile,
  type CpuSampleTrace,
} from "../src/cpu-sampling";

function trace(seconds: number, ...names: string[]): CpuSampleTrace {
  return {
    timestamp: seconds,
    frames: names.map((name) => ({ name, sourceURL: "/app/dist/index.js", line: 1, column: 7 })),
  };
}

describe("analyzeCpuSamples", () => {
  test("separates busy stretches and attributes the long one to its stack", () => {
    const traces: CpuSampleTrace[] = [];
    // 250 ms continuous block inside buildCatalog, then idle, then short work.
    for (let index = 0; index < 250; index += 1) {
      traces.push(trace(10 + index / 1_000, "stringify", "buildCatalog", "startTurn"));
    }
    for (let index = 0; index < 5; index += 1) {
      traces.push(trace(11 + index / 1_000, "parse", "onMessage"));
    }
    const summary = analyzeCpuSamples(traces, { windowMs: 2_000, sampleIntervalMs: 1 });
    expect(summary.samples).toBe(255);
    expect(summary.blocks).toHaveLength(1);
    expect(summary.blocks[0]).toMatchObject({ startOffsetMs: 0, durationMs: 250, samples: 250 });
    expect(summary.blocks[0]!.topStacks[0]!.label).toBe(
      "stringify index.js:1:7 < buildCatalog index.js:1:7 < startTurn index.js:1:7",
    );
    expect(summary.topSelf[0]).toEqual({ label: "stringify index.js:1:7", samples: 250 });
    expect(summary.topInclusive.map((entry) => entry.label)).toContain("startTurn index.js:1:7");
    expect(summary.busyMs).toBe(255);
  });
});

describe("captureCpuSamplingProfile", () => {
  test("finds a synchronous stall that runs during the window", async () => {
    function stallTheEventLoop(ms: number): number {
      const until = Date.now() + ms;
      let value = 0;
      while (Date.now() < until) value += Math.sqrt(value + 1);
      return value;
    }
    setTimeout(() => stallTheEventLoop(250), 50);
    const summary = await captureCpuSamplingProfile(600);
    expect(summary.blocks.length).toBeGreaterThanOrEqual(1);
    expect(summary.blocks[0]!.durationMs).toBeGreaterThanOrEqual(200);
    expect(summary.blocks[0]!.topStacks[0]!.label).toContain("stallTheEventLoop");
  });
});
