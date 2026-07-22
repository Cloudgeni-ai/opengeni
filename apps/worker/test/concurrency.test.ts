import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import type { SlotPermit } from "@temporalio/worker";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  MemoryAwareTurnSlotSupplier,
  TURN_WORKER_HARD_MEMORY_BYTES_PER_TURN,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
  TURN_WORKER_NATIVE_HEADROOM_BYTES,
  createTurnWorkerTuner,
  parseCgroupCurrentValue,
  parseCgroupLimitValue,
  readCgroupMemorySnapshot,
  type CgroupMemorySnapshot,
} from "../src/concurrency";

const MIB = 1024 * 1024;

describe("worker concurrency contract", () => {
  test("pins the measured density and hard memory budget independently of control work", () => {
    expect(TURN_WORKER_MAX_CONCURRENT_TURNS).toBe(16);
    expect(TURN_WORKER_HARD_MEMORY_BYTES_PER_TURN).toBe(100 * MIB);
    expect(TURN_WORKER_NATIVE_HEADROOM_BYTES).toBe(512 * MIB);
    expect(CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES).toBe(32);
    expect(CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS).toBe(40);
  });

  test("caps permits at the lower of density and baseline memory capacity", () => {
    const memory = mutableMemory(300 * MIB, 2_050 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 16,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });

    const permits = reserveUntilBlocked(supplier);
    expect(permits).toHaveLength(12);
    expect(supplier.snapshot()).toMatchObject({
      baselineBytes: 300 * MIB,
      memoryBoundCapacity: 12,
      reservedSlots: 12,
      usedSlots: 0,
      availableSlots: 0,
    });
  });

  test("keeps pending and used permits charged through observed memory growth", () => {
    const memory = mutableMemory(300 * MIB, 2_100 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 16,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });

    const first = supplier.tryReserveSlot({} as never);
    const second = supplier.tryReserveSlot({} as never);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    supplier.markSlotUsed(used(first!));
    memory.currentBytes = 1_550 * MIB;

    // observed + two live permits + one new hard budget + headroom = 2,350 MiB
    expect(supplier.tryReserveSlot({} as never)).toBeNull();
    expect(supplier.snapshot()).toMatchObject({
      reservedSlots: 2,
      availableSlots: 0,
      memoryBoundCapacity: 2,
    });
    supplier.releaseSlot(released(second!));
    // observed + one used permit + one new hard budget + headroom = 2,250 MiB
    expect(supplier.tryReserveSlot({} as never)).toBeNull();
    memory.currentBytes = 1_400 * MIB;
    expect(supplier.tryReserveSlot({} as never)).not.toBeNull();
  });

  test("does not release a reservation when mark-used races ahead of RSS", () => {
    const memory = mutableMemory(300 * MIB, 999 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 4,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });

    const permit = supplier.tryReserveSlot({} as never)!;
    supplier.markSlotUsed(used(permit));

    // RSS has not risen yet, but current + used + new + headroom would exceed
    // the limit. Marking the first permit used must not admit the second.
    expect(memory.currentBytes).toBe(300 * MIB);
    expect(supplier.tryReserveSlot({} as never)).toBeNull();
    expect(supplier.snapshot()).toMatchObject({
      reservedSlots: 1,
      usedSlots: 1,
      availableSlots: 0,
      memoryBoundCapacity: 1,
    });
  });

  test("charges multiple permits across pending-to-used transitions until release", () => {
    const memory = mutableMemory(200 * MIB, 1_101 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 4,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });

    const first = supplier.tryReserveSlot({} as never)!;
    const second = supplier.tryReserveSlot({} as never)!;
    const third = supplier.tryReserveSlot({} as never)!;
    supplier.markSlotUsed(used(first));
    supplier.markSlotUsed(used(second));
    expect(supplier.snapshot()).toMatchObject({
      reservedSlots: 3,
      usedSlots: 2,
      availableSlots: 1,
    });

    const fourth = supplier.tryReserveSlot({} as never)!;
    supplier.markSlotUsed(used(third));
    supplier.markSlotUsed(used(fourth));
    expect(supplier.tryReserveSlot({} as never)).toBeNull();

    supplier.releaseSlot(released(second));
    expect(supplier.snapshot()).toMatchObject({
      reservedSlots: 3,
      usedSlots: 3,
      availableSlots: 1,
    });
    expect(supplier.tryReserveSlot({} as never)).not.toBeNull();
  });

  test("contracts advertised availability when retained memory grows", () => {
    const memory = mutableMemory(300 * MIB, 2_100 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 16,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });
    const permit = supplier.tryReserveSlot({} as never)!;
    supplier.markSlotUsed(used(permit));

    memory.currentBytes = 1_550 * MIB;
    expect(supplier.tryReserveSlot({} as never)).toBeNull();
    expect(supplier.snapshot()).toMatchObject({
      reservedSlots: 1,
      usedSlots: 1,
      availableSlots: 0,
      memoryBoundCapacity: 1,
    });
  });

  test("releases used capacity and exposes a complete Temporal tuner", () => {
    const memory = mutableMemory(250 * MIB, 4_000 * MIB);
    const { admission, tuner } = createTurnWorkerTuner({
      maximumTurns: 2,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });
    expect("activityTaskSlotSupplier" in tuner).toBe(true);
    if (!("activityTaskSlotSupplier" in tuner)) throw new Error("expected tuner holder");
    expect(tuner.activityTaskSlotSupplier).toBe(admission);

    const first = admission.tryReserveSlot({} as never)!;
    const second = admission.tryReserveSlot({} as never)!;
    admission.markSlotUsed(used(first));
    admission.markSlotUsed(used(second));
    expect(admission.snapshot()).toMatchObject({
      reservedSlots: 2,
      usedSlots: 2,
      availableSlots: 0,
    });
    expect(admission.tryReserveSlot({} as never)).toBeNull();

    admission.releaseSlot(released(first));
    expect(admission.snapshot()).toMatchObject({ reservedSlots: 1, usedSlots: 1 });
    expect(admission.tryReserveSlot({} as never)).not.toBeNull();
  });

  test("fails startup when the cgroup cannot safely admit one hard-budget turn", () => {
    const memory = mutableMemory(500 * MIB, 1_050 * MIB);
    expect(
      () =>
        new MemoryAwareTurnSlotSupplier({
          hardBytesPerTurn: 100 * MIB,
          nativeHeadroomBytes: 500 * MIB,
          memorySnapshot: memory.read,
        }),
    ).toThrow("cannot safely admit one turn");
  });

  test("fails the post-worker startup check when native initialization consumes the last permit", () => {
    const memory = mutableMemory(300 * MIB, 1_000 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });
    memory.currentBytes = 450 * MIB;
    expect(() => supplier.finalizeStartupBaseline()).toThrow(
      "cannot safely admit one turn after worker initialization",
    );
    memory.currentBytes = 400 * MIB;
    expect(() => supplier.finalizeStartupBaseline()).not.toThrow();
    expect(supplier.snapshot()).toMatchObject({
      baselineBytes: 400 * MIB,
      currentBytes: 400 * MIB,
      memoryBoundCapacity: 1,
    });
  });

  test("rebases capacity after worker creation retains native memory", () => {
    const memory = mutableMemory(200 * MIB, 1_500 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 16,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
    });
    expect(supplier.snapshot()).toMatchObject({ baselineBytes: 200 * MIB });

    memory.currentBytes = 400 * MIB;
    supplier.finalizeStartupBaseline();
    expect(supplier.snapshot()).toMatchObject({
      baselineBytes: 400 * MIB,
      memoryBoundCapacity: 6,
      availableSlots: 6,
    });
  });

  test("a blocked reservation exits with AbortError rather than leaking a poll", async () => {
    const memory = mutableMemory(300 * MIB, 901 * MIB);
    const supplier = new MemoryAwareTurnSlotSupplier({
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
      retryDelayMs: 5,
    });
    expect(supplier.tryReserveSlot({} as never)).not.toBeNull();
    const controller = new AbortController();
    const blocked = supplier.reserveSlot({} as never, controller.signal);
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
  });

  test("exports enough bounded gauges to reconstruct an admission decision", async () => {
    const memory = mutableMemory(250 * MIB, 4_000 * MIB);
    const observability = createObservability(testSettings(), { component: "worker-turn" });
    const supplier = new MemoryAwareTurnSlotSupplier({
      maximumTurns: 2,
      hardBytesPerTurn: 100 * MIB,
      nativeHeadroomBytes: 500 * MIB,
      memorySnapshot: memory.read,
      observability,
    });
    const permit = supplier.tryReserveSlot({} as never)!;
    supplier.markSlotUsed(used(permit));

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_slots_capacity\{[^}]*\} 2/);
    expect(metrics).toMatch(/opengeni_turn_slots_used\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turn_admission_memory_baseline_bytes\{[^}]*\} 262144000/);
    expect(metrics).toMatch(/opengeni_turn_admission_hard_bytes_per_turn\{[^}]*\} 104857600/);
    expect(metrics).toMatch(/opengeni_turn_admission_native_headroom_bytes\{[^}]*\} 524288000/);
  });

  test("reads a non-negative current cgroup or process memory snapshot", () => {
    expect(readCgroupMemorySnapshot()).toMatchObject({
      currentBytes: expect.any(Number),
      source: expect.stringMatching(/^(cgroup-v1|cgroup-v2|process)$/),
    });
    expect(readCgroupMemorySnapshot().currentBytes).toBeGreaterThanOrEqual(0);
  });

  test("rejects malformed finite cgroup values instead of failing open as unlimited", () => {
    expect(parseCgroupLimitValue("max\n")).toBeNull();
    expect(parseCgroupLimitValue(String(1n << 62n))).toBeNull();
    expect(parseCgroupLimitValue("1048576\n")).toBe(1_048_576);
    expect(() => parseCgroupLimitValue("not-a-limit")).toThrow("Malformed finite");
    expect(() => parseCgroupLimitValue("0")).toThrow("Malformed finite");
    expect(() => parseCgroupCurrentValue("-1")).toThrow("Malformed cgroup current");
    expect(() => parseCgroupCurrentValue("not-current")).toThrow("Malformed cgroup current");
  });
});

function mutableMemory(currentBytes: number, limitBytes: number | null) {
  const value: CgroupMemorySnapshot = {
    currentBytes,
    limitBytes,
    source: "cgroup-v2",
  };
  return {
    get currentBytes() {
      return value.currentBytes;
    },
    set currentBytes(next: number) {
      value.currentBytes = next;
    },
    read: () => ({ ...value }),
  };
}

function reserveUntilBlocked(supplier: MemoryAwareTurnSlotSupplier): SlotPermit[] {
  const permits: SlotPermit[] = [];
  for (;;) {
    const permit = supplier.tryReserveSlot({} as never);
    if (!permit) return permits;
    permits.push(permit);
  }
}

function used(permit: SlotPermit) {
  return {
    permit,
    slotInfo: { type: "activity", activityType: "runAgentTurn" } as const,
  };
}

function released(permit: SlotPermit) {
  return {
    permit,
    slotInfo: { type: "activity", activityType: "runAgentTurn" } as const,
  };
}
