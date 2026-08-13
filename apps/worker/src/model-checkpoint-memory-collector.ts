import type { Observability } from "@opengeni/observability";

export const MODEL_CHECKPOINT_GC_PRESSURE_BYTES = 512 * 1024 * 1024;
export const MODEL_CHECKPOINT_GC_COOLDOWN_MS = 30_000;

type ProcessMemory = Pick<NodeJS.MemoryUsage, "heapUsed" | "external">;

type ModelCheckpointMemoryCollectorDependencies = {
  now?: () => number;
  memoryUsage?: () => ProcessMemory;
  gc?: () => void;
  setTimeout?: typeof setTimeout;
};

export type ModelCheckpointMemoryCollector = {
  schedule(observability: Observability): void;
};

export function modelCheckpointPressureBytes(memory: ProcessMemory): number {
  // `external` includes ArrayBuffer storage in Bun/Node's memoryUsage contract.
  // Heap and external allocations are independent, so max(heap, external)
  // undercounts the actual reclaimable pressure whenever both are large.
  return memory.heapUsed + memory.external;
}

/**
 * Reclaim request serialization and stream buffers only after one model
 * response has crossed the durable conversation checkpoint. The callback runs
 * on a later task so the completed response's stack can unwind first. Active
 * turns and their exact model context remain strongly reachable and are never
 * shortened, restarted, or rewritten by this process-local collection.
 */
export function createModelCheckpointMemoryCollector(
  dependencies: ModelCheckpointMemoryCollectorDependencies = {},
): ModelCheckpointMemoryCollector {
  const now = dependencies.now ?? Date.now;
  const memoryUsage = dependencies.memoryUsage ?? process.memoryUsage;
  const collectGarbage = dependencies.gc ?? (() => Bun.gc(true));
  const scheduleTask = dependencies.setTimeout ?? setTimeout;
  let scheduled = false;
  let lastCollectionAt = Number.NEGATIVE_INFINITY;

  return {
    schedule(observability) {
      if (scheduled) return;
      scheduled = true;
      try {
        const timer = scheduleTask(() => {
          scheduled = false;
          let memory: ProcessMemory;
          try {
            memory = memoryUsage();
          } catch {
            safeIncrementCounter(observability, {
              name: "opengeni_turn_worker_model_checkpoint_gc_failures_total",
              help: "Model-checkpoint garbage collections that could not sample or collect memory.",
            });
            return;
          }

          const pressureBytes = modelCheckpointPressureBytes(memory);
          const observedAt = now();
          if (
            !Number.isFinite(pressureBytes) ||
            pressureBytes < MODEL_CHECKPOINT_GC_PRESSURE_BYTES ||
            observedAt - lastCollectionAt < MODEL_CHECKPOINT_GC_COOLDOWN_MS
          ) {
            return;
          }

          lastCollectionAt = observedAt;
          const startedAt = performance.now();
          try {
            collectGarbage();
            safeIncrementCounter(observability, {
              name: "opengeni_turn_worker_model_checkpoint_gc_total",
              help: "Forced garbage collections after durable model-response checkpoints.",
            });
            safeObserveHistogram(observability, {
              name: "opengeni_turn_worker_model_checkpoint_gc_duration_seconds",
              help: "Forced garbage-collection duration after durable model-response checkpoints.",
              value: Math.max(0, performance.now() - startedAt) / 1_000,
            });
          } catch {
            safeIncrementCounter(observability, {
              name: "opengeni_turn_worker_model_checkpoint_gc_failures_total",
              help: "Model-checkpoint garbage collections that could not sample or collect memory.",
            });
          }
        }, 0);
        try {
          timer.unref?.();
        } catch {
          // A timer implementation without a usable unref is still safe.
        }
      } catch {
        scheduled = false;
      }
    },
  };
}

function safeIncrementCounter(
  observability: Observability,
  input: Parameters<Observability["incrementCounter"]>[0],
): void {
  try {
    observability.incrementCounter(input);
  } catch {
    // Telemetry cannot disable collection at a durable model checkpoint.
  }
}

function safeObserveHistogram(
  observability: Observability,
  input: Parameters<Observability["observeHistogram"]>[0],
): void {
  try {
    observability.observeHistogram(input);
  } catch {
    // Telemetry cannot disable collection at a durable model checkpoint.
  }
}
