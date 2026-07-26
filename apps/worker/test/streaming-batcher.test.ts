import { describe, expect, test } from "bun:test";
import type { SessionEventType } from "@opengeni/contracts";
import type { AppendEventInput } from "@opengeni/db";
import { createRuntimeBatcher } from "../src/activities/streaming";

// Lever A: token deltas coalesce through the batcher (one appendSessionEvents
// txn + one publish per flush) instead of one DB round-trip per token. These
// tests pin: (1) coalescing under burst, (2) the trailing timer flushing on
// model silence, (3) structural events still flushing immediately AND carrying
// any pending deltas in order, (4) flushes never interleaving, and (5) the
// before/after flush-count reduction for a 1000-delta turn, and (6) slow
// storage never serializes provider ingestion while memory remains bounded.

const DELTA: SessionEventType = "agent.message.delta";
const REASONING: SessionEventType = "agent.reasoning.delta";
const PTY: SessionEventType = "terminal.pty.output.delta"; // stays structural
const TOOLCALL: SessionEventType = "agent.toolCall.created"; // structural

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Records every flushEvents call as the ordered list of payload `n` markers. */
function recordingBatcher() {
  const flushes: number[][] = [];
  const batcher = createRuntimeBatcher(async (events: AppendEventInput[]) => {
    flushes.push(events.map((e) => (e.payload as { n: number }).n));
  });
  return { batcher, flushes };
}

function delta(n: number, type: SessionEventType = DELTA) {
  return { type, payload: { n } };
}

describe("createRuntimeBatcher", () => {
  test("coalesces a delta burst into ONE flush, order preserved (trailing timer)", async () => {
    const { batcher, flushes } = recordingBatcher();
    // 10 deltas pushed fast (< 50 count, < 33ms) => no immediate flush.
    for (let n = 0; n < 10; n++) {
      await batcher.push(delta(n));
    }
    expect(flushes.length).toBe(0); // still pending — nothing flushed yet
    await sleep(60); // trailing timer (~33ms) fires
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("trailing timer flushes whatever accumulated on silence", async () => {
    const { batcher, flushes } = recordingBatcher();
    await batcher.push(delta(1, REASONING));
    await batcher.push(delta(2, REASONING));
    expect(flushes.length).toBe(0);
    await sleep(60);
    expect(flushes).toEqual([[1, 2]]);
  });

  test("a structural event flushes immediately and CARRIES pending deltas in order", async () => {
    const { batcher, flushes } = recordingBatcher();
    await batcher.push(delta(0));
    await batcher.push(delta(1));
    await batcher.push(delta(2));
    expect(flushes.length).toBe(0); // coalesced, waiting
    await batcher.push(delta(3, TOOLCALL)); // structural -> flush now
    expect(flushes.length).toBe(1);
    expect(flushes[0]).toEqual([0, 1, 2, 3]); // deltas ride the structural flush, in order
    // Timer must have been cleared: nothing more flushes on silence.
    await sleep(60);
    expect(flushes.length).toBe(1);
  });

  test("PTY output stays structural (flush-immediately)", async () => {
    const { batcher, flushes } = recordingBatcher();
    await batcher.push(delta(0, PTY));
    expect(flushes).toEqual([[0]]); // no coalescing for interactive terminal bytes
  });

  test("flushes never interleave; second flushEvents waits for the first (order preserved)", async () => {
    const starts: number[][] = [];
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const batcher = createRuntimeBatcher(async (events: AppendEventInput[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(events.map((e) => (e.payload as { n: number }).n));
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
    });

    const p1 = batcher.push(delta(1, TOOLCALL)); // flush #1 starts, blocks on gate[0]
    const p2 = batcher.push(delta(2, TOOLCALL)); // must NOT start flushEvents yet
    await sleep(10);
    expect(active).toBe(1);
    expect(gates.length).toBe(1); // second flush is queued behind the first
    expect(starts).toEqual([[1]]);

    gates[0]!(); // release first
    await sleep(10);
    expect(gates.length).toBe(2); // now the second flush runs, with event 2
    expect(starts).toEqual([[1], [2]]);
    gates[1]!();

    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1); // never two flushEvents in flight at once
  });

  test("a slow append does not block ordinary model deltas and the drain preserves order", async () => {
    const starts: number[][] = [];
    const gates: Array<() => void> = [];
    const batcher = createRuntimeBatcher(async (events: AppendEventInput[]) => {
      starts.push(events.map((event) => (event.payload as { n: number }).n));
      await new Promise<void>((resolve) => gates.push(resolve));
    });

    // The 50th delta starts a flush. The next 50 pushes must still resolve while
    // that slow append is blocked; this is the production regression where each
    // model delta previously waited ~0.75s for its own DB transaction.
    for (let n = 0; n < 100; n += 1) {
      await batcher.push(delta(n));
    }
    expect(starts).toEqual([Array.from({ length: 50 }, (_, index) => index)]);

    const drained = batcher.flush();
    gates[0]!();
    await sleep(10);
    expect(starts[1]).toEqual(Array.from({ length: 50 }, (_, index) => index + 50));
    gates[1]!();
    await drained;
  });

  test("a failed timer flush is retained and rethrown at the next boundary", async () => {
    const batcher = createRuntimeBatcher(async () => {
      throw new Error("durable append failed");
    });

    await batcher.push(delta(1));
    await sleep(60);
    await expect(batcher.push(delta(2))).rejects.toThrow("durable append failed");
    await expect(batcher.flush()).rejects.toThrow("durable append failed");
  });

  test("provider ingestion backpressures at the bounded high-water mark", async () => {
    let releaseFirst: (() => void) | null = null;
    let flushCount = 0;
    const flushed: number[] = [];
    const batcher = createRuntimeBatcher(async (events: AppendEventInput[]) => {
      flushCount += 1;
      flushed.push(...events.map((event) => (event.payload as { n: number }).n));
      if (flushCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    // 50 active + 949 pending stays below the 1,000-event high-water mark.
    for (let n = 0; n < 999; n += 1) {
      await batcher.push(delta(n));
    }
    let cappedPushSettled = false;
    const cappedPush = batcher.push(delta(999)).then(() => {
      cappedPushSettled = true;
    });
    await sleep(10);
    expect(cappedPushSettled).toBe(false);

    releaseFirst!();
    await cappedPush;
    await batcher.flush();
    expect(flushed).toEqual(Array.from({ length: 1_000 }, (_, index) => index));
  });

  test("1000-delta turn: flush count collapses vs the per-delta (structural) path", async () => {
    // Freeze time so the count is purely coalescing-policy driven (removes the
    // 33ms elapsed variable), making the before/after numbers deterministic.
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      // BEFORE this change, message deltas were structural -> one flush per delta.
      const beforeLike = recordingBatcher();
      for (let n = 0; n < 1000; n++) {
        await beforeLike.batcher.push(delta(n, PTY)); // PTY = still-structural stand-in
      }
      expect(beforeLike.flushes.length).toBe(1000); // one DB round-trip per token

      // AFTER: message deltas coalesce under the 50-event policy.
      const after = recordingBatcher();
      for (let n = 0; n < 1000; n++) {
        await after.batcher.push(delta(n));
      }
      await after.batcher.flush(); // turn-end drain
      expect(after.flushes.length).toBeLessThanOrEqual(35);
      expect(after.flushes.length).toBe(20); // 1000 / 50-event batches
      // Order + completeness preserved across all batches.
      expect(after.flushes.flat()).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    } finally {
      Date.now = realNow;
    }
  });

  test("flush() is a no-op when nothing is pending", async () => {
    const { batcher, flushes } = recordingBatcher();
    await batcher.flush();
    expect(flushes.length).toBe(0);
  });

  test("onFlush reports coalesced size and duration for each flush (success and failure)", async () => {
    const seen: Array<{ events: number; durationSeconds: number }> = [];
    let clock = 0;
    let fail = false;
    const batcher = createRuntimeBatcher(
      async () => {
        clock += 5; // simulate 5ms of flush work
        if (fail) {
          throw new Error("append failed");
        }
      },
      { onFlush: (info) => seen.push(info), now: () => clock },
    );

    // A structural event flushes one event immediately.
    await batcher.push(delta(0, TOOLCALL));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ events: 1, durationSeconds: 0.005 });

    // Three coalesced deltas ride out on the next structural flush → size 4.
    await batcher.push(delta(1));
    await batcher.push(delta(2));
    await batcher.push(delta(3));
    await batcher.push(delta(4, TOOLCALL));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.events).toBe(4);

    // A FAILED flush still reports its shape (onFlush runs in the finally).
    fail = true;
    await expect(batcher.push(delta(5, TOOLCALL))).rejects.toThrow("append failed");
    expect(seen).toHaveLength(3);
    expect(seen[2]!.events).toBe(1); // the single structural delta(5) that failed to flush
  });
});
