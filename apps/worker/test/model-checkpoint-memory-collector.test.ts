import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import {
  MODEL_CHECKPOINT_GC_COOLDOWN_MS,
  MODEL_CHECKPOINT_GC_PRESSURE_BYTES,
  createModelCheckpointMemoryCollector,
  modelCheckpointPressureBytes,
} from "../src/model-checkpoint-memory-collector";

function observabilityRecorder() {
  const counters: string[] = [];
  const histograms: string[] = [];
  return {
    counters,
    histograms,
    observability: {
      incrementCounter: ({ name }: { name: string }) => counters.push(name),
      observeHistogram: ({ name }: { name: string }) => histograms.push(name),
    } as Observability,
  };
}

function controlledTimer() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setTimeout: ((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} };
    }) as unknown as typeof setTimeout,
  };
}

describe("model checkpoint memory collector", () => {
  test("counts heap and external allocations as independent pressure", () => {
    expect(
      modelCheckpointPressureBytes({
        heapUsed: MODEL_CHECKPOINT_GC_PRESSURE_BYTES / 2,
        external: MODEL_CHECKPOINT_GC_PRESSURE_BYTES / 2,
      }),
    ).toBe(MODEL_CHECKPOINT_GC_PRESSURE_BYTES);
  });

  test("does nothing below process heap and external pressure", () => {
    const timer = controlledTimer();
    const metrics = observabilityRecorder();
    let collections = 0;
    const collector = createModelCheckpointMemoryCollector({
      setTimeout: timer.setTimeout,
      memoryUsage: () => ({
        heapUsed: MODEL_CHECKPOINT_GC_PRESSURE_BYTES - 1,
        external: 0,
      }),
      gc: () => {
        collections += 1;
      },
    });

    collector.schedule(metrics.observability);
    timer.callbacks.shift()?.();

    expect(collections).toBe(0);
    expect(metrics.counters).toEqual([]);
  });

  test("coalesces checkpoints and forces one collection at the pressure boundary", () => {
    const timer = controlledTimer();
    const metrics = observabilityRecorder();
    let collections = 0;
    const collector = createModelCheckpointMemoryCollector({
      setTimeout: timer.setTimeout,
      memoryUsage: () => ({
        heapUsed: MODEL_CHECKPOINT_GC_PRESSURE_BYTES / 2,
        external: MODEL_CHECKPOINT_GC_PRESSURE_BYTES / 2,
      }),
      gc: () => {
        collections += 1;
      },
    });

    collector.schedule(metrics.observability);
    collector.schedule(metrics.observability);
    expect(timer.callbacks).toHaveLength(1);
    timer.callbacks.shift()?.();

    expect(collections).toBe(1);
    expect(metrics.counters).toEqual(["opengeni_turn_worker_model_checkpoint_gc_total"]);
    expect(metrics.histograms).toEqual([
      "opengeni_turn_worker_model_checkpoint_gc_duration_seconds",
    ]);
  });

  test("rate limits repeated collections while pressure remains high", () => {
    const timer = controlledTimer();
    const metrics = observabilityRecorder();
    let now = 1_000;
    let collections = 0;
    const collector = createModelCheckpointMemoryCollector({
      now: () => now,
      setTimeout: timer.setTimeout,
      memoryUsage: () => ({
        heapUsed: MODEL_CHECKPOINT_GC_PRESSURE_BYTES,
        external: 0,
      }),
      gc: () => {
        collections += 1;
      },
    });

    collector.schedule(metrics.observability);
    timer.callbacks.shift()?.();
    now += MODEL_CHECKPOINT_GC_COOLDOWN_MS - 1;
    collector.schedule(metrics.observability);
    timer.callbacks.shift()?.();
    expect(collections).toBe(1);

    now += 1;
    collector.schedule(metrics.observability);
    timer.callbacks.shift()?.();
    expect(collections).toBe(2);
  });

  test("collection and sampling failures never escape the checkpoint callback", () => {
    const samplingTimer = controlledTimer();
    const samplingMetrics = observabilityRecorder();
    createModelCheckpointMemoryCollector({
      setTimeout: samplingTimer.setTimeout,
      memoryUsage: () => {
        throw new Error("sample failed");
      },
    }).schedule(samplingMetrics.observability);
    expect(() => samplingTimer.callbacks.shift()?.()).not.toThrow();
    expect(samplingMetrics.counters).toEqual([
      "opengeni_turn_worker_model_checkpoint_gc_failures_total",
    ]);

    const gcTimer = controlledTimer();
    const gcMetrics = observabilityRecorder();
    createModelCheckpointMemoryCollector({
      setTimeout: gcTimer.setTimeout,
      memoryUsage: () => ({
        heapUsed: MODEL_CHECKPOINT_GC_PRESSURE_BYTES,
        external: 0,
      }),
      gc: () => {
        throw new Error("gc failed");
      },
    }).schedule(gcMetrics.observability);
    expect(() => gcTimer.callbacks.shift()?.()).not.toThrow();
    expect(gcMetrics.counters).toEqual(["opengeni_turn_worker_model_checkpoint_gc_failures_total"]);
  });

  test("timer failures never escape the durable response path", () => {
    const metrics = observabilityRecorder();
    const collector = createModelCheckpointMemoryCollector({
      setTimeout: (() => {
        throw new Error("timer failed");
      }) as unknown as typeof setTimeout,
    });

    expect(() => collector.schedule(metrics.observability)).not.toThrow();
    expect(() => collector.schedule(metrics.observability)).not.toThrow();
  });
});
