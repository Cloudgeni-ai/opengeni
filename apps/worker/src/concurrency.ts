import { readFileSync } from "node:fs";
import type { Observability } from "@opengeni/observability";
import type {
  ActivitySlotInfo,
  CustomSlotSupplier,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReleaseContext,
  SlotReserveContext,
  WorkerTuner,
} from "@temporalio/worker";

const MIB = 1024 * 1024;

/**
 * Process-local Temporal execution ceilings.
 *
 * Turn workers host only runAgentTurn. Sixteen remains the measured production
 * density until the OPE-52 sweep proves a different optimum. It is a hard
 * ceiling, not an amount the worker promises to admit: the slot supplier below
 * may expose fewer permits when the pod's memory limit cannot safely support
 * all sixteen turns.
 */
export const TURN_WORKER_MAX_CONCURRENT_TURNS = 16;
export const TURN_WORKER_HARD_MEMORY_BYTES_PER_TURN = 100 * MIB;
export const TURN_WORKER_NATIVE_HEADROOM_BYTES = 512 * MIB;

export const CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES = 32;
export const CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS = 40;

const CGROUP_MEMORY_FILES = [
  {
    limit: "/sys/fs/cgroup/memory.max",
    current: "/sys/fs/cgroup/memory.current",
  },
  {
    limit: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    current: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  },
] as const;

// cgroup v1 uses enormous sentinels for "unlimited". Values this large are
// host capacity rather than a meaningful container admission boundary.
const UNLIMITED_CGROUP_BYTES = 1n << 60n;

export type CgroupMemorySnapshot = {
  currentBytes: number;
  limitBytes: number | null;
  source: "cgroup-v1" | "cgroup-v2" | "process";
};

export type TurnAdmissionSnapshot = {
  baselineBytes: number;
  currentBytes: number;
  limitBytes: number | null;
  hardBytesPerTurn: number;
  nativeHeadroomBytes: number;
  maximumTurns: number;
  memoryBoundCapacity: number;
  reservedSlots: number;
  usedSlots: number;
  availableSlots: number;
};

export type TurnAdmissionOptions = {
  maximumTurns?: number;
  hardBytesPerTurn?: number;
  nativeHeadroomBytes?: number;
  memorySnapshot?: () => CgroupMemorySnapshot;
  retryDelayMs?: number;
  observability?: Observability;
};

type TurnSlotPermit = SlotPermit & {
  readonly owner: symbol;
  used: boolean;
};

/**
 * Temporal custom activity-slot supplier for turn workers.
 *
 * A permit is required before Temporal polls a task. Reservation is allowed
 * only when both independent safety checks pass:
 *
 *   baseline + reserved-after × hard-turn-budget + native headroom <= limit
 *   current  + pending-after  × hard-turn-budget + native headroom <= limit
 *
 * The first check enforces the release contract even when current RSS happens
 * to be low. The second accounts for native/retained memory observed after
 * startup and for poll permits that have not begun allocating turn state yet.
 * Kubernetes OOM is never an admission mechanism.
 */
export class MemoryAwareTurnSlotSupplier implements CustomSlotSupplier<ActivitySlotInfo> {
  readonly type = "custom" as const;

  private readonly owner = Symbol("opengeni-turn-admission");
  private readonly permits = new Set<TurnSlotPermit>();
  private readonly baselineBytes: number;
  private readonly maximumTurns: number;
  private readonly hardBytesPerTurn: number;
  private readonly nativeHeadroomBytes: number;
  private readonly memorySnapshot: () => CgroupMemorySnapshot;
  private readonly retryDelayMs: number;
  private readonly observability: Observability | undefined;

  constructor(options: TurnAdmissionOptions = {}) {
    this.maximumTurns = positiveInteger(
      "maximumTurns",
      options.maximumTurns ?? TURN_WORKER_MAX_CONCURRENT_TURNS,
    );
    this.hardBytesPerTurn = positiveInteger(
      "hardBytesPerTurn",
      options.hardBytesPerTurn ?? TURN_WORKER_HARD_MEMORY_BYTES_PER_TURN,
    );
    this.nativeHeadroomBytes = nonnegativeInteger(
      "nativeHeadroomBytes",
      options.nativeHeadroomBytes ?? TURN_WORKER_NATIVE_HEADROOM_BYTES,
    );
    this.retryDelayMs = positiveInteger("retryDelayMs", options.retryDelayMs ?? 100);
    this.memorySnapshot = options.memorySnapshot ?? readCgroupMemorySnapshot;
    this.observability = options.observability;
    const initial = this.memorySnapshot();
    this.baselineBytes = initial.currentBytes;
    if (initial.limitBytes !== null && this.memoryBoundCapacity(initial.limitBytes) < 1) {
      throw new Error(
        "Turn worker memory limit cannot safely admit one turn: " +
          `baseline=${this.baselineBytes} hardTurn=${this.hardBytesPerTurn} ` +
          `nativeHeadroom=${this.nativeHeadroomBytes} limit=${initial.limitBytes}`,
      );
    }
    this.refreshMetrics(initial);
  }

  async reserveSlot(_ctx: SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit> {
    for (;;) {
      if (abortSignal.aborted) throw abortError();
      const permit = this.reserveIfSafe();
      if (permit) return permit;
      await abortableDelay(this.retryDelayMs, abortSignal);
    }
  }

  tryReserveSlot(_ctx: SlotReserveContext): SlotPermit | null {
    return this.reserveIfSafe();
  }

  markSlotUsed(ctx: SlotMarkUsedContext<ActivitySlotInfo>): void {
    const permit = this.ownedPermit(ctx.permit);
    permit.used = true;
    this.refreshMetrics();
  }

  releaseSlot(ctx: SlotReleaseContext<ActivitySlotInfo>): void {
    const permit = this.ownedPermit(ctx.permit);
    this.permits.delete(permit);
    this.refreshMetrics();
  }

  snapshot(memory = this.memorySnapshot()): TurnAdmissionSnapshot {
    const usedSlots = this.usedSlots();
    const reservedSlots = this.permits.size;
    const availableSlots = this.availableSlots(memory);
    // Never report less capacity than work already admitted. The dynamic
    // denominator is exactly reserved + what a new poll could reserve now.
    const memoryBoundCapacity = reservedSlots + availableSlots;
    return {
      baselineBytes: this.baselineBytes,
      currentBytes: memory.currentBytes,
      limitBytes: memory.limitBytes,
      hardBytesPerTurn: this.hardBytesPerTurn,
      nativeHeadroomBytes: this.nativeHeadroomBytes,
      maximumTurns: this.maximumTurns,
      memoryBoundCapacity,
      reservedSlots,
      usedSlots,
      availableSlots,
    };
  }

  /**
   * Recheck the one-turn startup invariant after Temporal/native construction.
   * Worker.create can retain memory after the constructor's baseline sample;
   * a pod that can no longer reserve one permit must fail before readiness.
   */
  assertCanAdmitOne(): void {
    const memory = this.memorySnapshot();
    if (this.permits.size !== 0) {
      throw new Error("Turn worker startup admission check ran after slot reservation");
    }
    if (this.availableSlots(memory) < 1) {
      throw new Error(
        "Turn worker memory limit cannot safely admit one turn after worker initialization: " +
          `baseline=${this.baselineBytes} current=${memory.currentBytes} ` +
          `hardTurn=${this.hardBytesPerTurn} nativeHeadroom=${this.nativeHeadroomBytes} ` +
          `limit=${String(memory.limitBytes)}`,
      );
    }
    this.refreshMetrics(memory);
  }

  private reserveIfSafe(): TurnSlotPermit | null {
    const memory = this.memorySnapshot();
    if (this.permits.size >= this.maximumTurns || !this.memoryAllowsAnother(memory)) {
      this.refreshMetrics(memory);
      return null;
    }
    const permit: TurnSlotPermit = { owner: this.owner, used: false };
    this.permits.add(permit);
    this.refreshMetrics(memory);
    return permit;
  }

  private memoryAllowsAnother(memory: CgroupMemorySnapshot): boolean {
    return this.availableSlots(memory) > 0;
  }

  private availableSlots(memory: CgroupMemorySnapshot): number {
    const densityRemaining = this.maximumTurns - this.permits.size;
    if (memory.limitBytes === null) return Math.max(0, densityRemaining);

    const baselineRemaining = this.memoryBoundCapacity(memory.limitBytes) - this.permits.size;
    const observedRemaining =
      Math.floor(
        (memory.limitBytes - memory.currentBytes - this.nativeHeadroomBytes) /
          this.hardBytesPerTurn,
      ) - this.pendingSlots();
    return Math.max(0, Math.min(densityRemaining, baselineRemaining, observedRemaining));
  }

  private memoryBoundCapacity(limitBytes: number): number {
    return Math.max(
      0,
      Math.floor(
        (limitBytes - this.baselineBytes - this.nativeHeadroomBytes) / this.hardBytesPerTurn,
      ),
    );
  }

  private pendingSlots(): number {
    return this.permits.size - this.usedSlots();
  }

  private usedSlots(): number {
    let used = 0;
    for (const permit of this.permits) {
      if (permit.used) used += 1;
    }
    return used;
  }

  private ownedPermit(permit: SlotPermit): TurnSlotPermit {
    const candidate = permit as Partial<TurnSlotPermit>;
    if (candidate.owner !== this.owner || !this.permits.has(permit as TurnSlotPermit)) {
      throw new Error("Temporal returned a turn slot permit owned by another supplier");
    }
    return permit as TurnSlotPermit;
  }

  private refreshMetrics(memory = this.memorySnapshot()): void {
    if (!this.observability) return;
    const value = this.snapshot(memory);
    const set = (name: string, help: string, metricValue: number) =>
      this.observability?.setGauge({ name, help, value: metricValue });
    set(
      "opengeni_turn_slots_capacity",
      "Turn slots this worker can safely support after the hard memory contract.",
      value.memoryBoundCapacity,
    );
    set(
      "opengeni_turn_slots_reserved",
      "Temporal turn activity slots reserved for polling or execution in this worker.",
      value.reservedSlots,
    );
    set(
      "opengeni_turn_slots_used",
      "Temporal turn activity slots currently executing in this worker.",
      value.usedSlots,
    );
    set(
      "opengeni_turn_slots_available",
      "Memory-safe turn activity slots still available to reserve in this worker.",
      value.availableSlots,
    );
    set(
      "opengeni_turn_slot_saturation_ratio",
      "Fraction of this worker's memory-safe turn capacity currently executing.",
      value.memoryBoundCapacity === 0 ? 1 : value.usedSlots / value.memoryBoundCapacity,
    );
    set(
      "opengeni_turn_admission_memory_baseline_bytes",
      "Turn-worker cgroup memory at admission-controller startup.",
      value.baselineBytes,
    );
    set(
      "opengeni_turn_admission_memory_current_bytes",
      "Current cgroup memory used for turn admission decisions.",
      value.currentBytes,
    );
    set(
      "opengeni_turn_admission_memory_limit_bytes",
      "Finite cgroup memory limit used for turn admission, or zero when unlimited.",
      value.limitBytes ?? 0,
    );
    set(
      "opengeni_turn_admission_hard_bytes_per_turn",
      "Hard incremental memory budget reserved for each admitted turn.",
      value.hardBytesPerTurn,
    );
    set(
      "opengeni_turn_admission_native_headroom_bytes",
      "Cgroup memory retained for runtime, native, and GC headroom.",
      value.nativeHeadroomBytes,
    );
  }
}

export function createTurnWorkerTuner(options: TurnAdmissionOptions = {}): {
  tuner: WorkerTuner;
  admission: MemoryAwareTurnSlotSupplier;
} {
  const admission = new MemoryAwareTurnSlotSupplier(options);
  return {
    admission,
    tuner: {
      workflowTaskSlotSupplier: { type: "fixed-size", numSlots: 1 },
      activityTaskSlotSupplier: admission,
      localActivityTaskSlotSupplier: { type: "fixed-size", numSlots: 1 },
      nexusTaskSlotSupplier: { type: "fixed-size", numSlots: 1 },
    },
  };
}

export function readCgroupMemorySnapshot(): CgroupMemorySnapshot {
  for (const [index, files] of CGROUP_MEMORY_FILES.entries()) {
    const limitRaw = readCgroupText(files.limit);
    const currentRaw = readCgroupText(files.current);
    if (limitRaw === null && currentRaw === null) continue;
    if (limitRaw === null || currentRaw === null) {
      throw new Error(
        `Incomplete cgroup memory controller: limit=${files.limit} current=${files.current}`,
      );
    }
    return {
      currentBytes: parseCgroupCurrentValue(currentRaw),
      limitBytes: parseCgroupLimitValue(limitRaw),
      source: index === 0 ? "cgroup-v2" : "cgroup-v1",
    };
  }
  return {
    currentBytes: process.memoryUsage().rss,
    limitBytes: null,
    source: "process",
  };
}

export function parseCgroupLimitValue(value: string): number | null {
  if (value.trim() === "max") return null;
  const parsed = parseCgroupBigInt(value);
  if (parsed === null || parsed <= 0n) {
    throw new Error(`Malformed finite cgroup memory limit: ${JSON.stringify(value.trim())}`);
  }
  if (parsed >= UNLIMITED_CGROUP_BYTES) return null;
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `Finite cgroup memory limit exceeds JavaScript's safe integer range: ${parsed}`,
    );
  }
  return number;
}

export function parseCgroupCurrentValue(value: string): number {
  const parsed = parseCgroupBigInt(value);
  if (parsed === null || parsed < 0n) {
    throw new Error(`Malformed cgroup current memory value: ${JSON.stringify(value.trim())}`);
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Cgroup current memory exceeds JavaScript's safe integer range: ${parsed}`);
  }
  return number;
}

function parseCgroupBigInt(value: string): bigint | null {
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

function readCgroupText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Unable to read present cgroup memory controller file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function abortError(): DOMException {
  return new DOMException("Turn slot reservation aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
