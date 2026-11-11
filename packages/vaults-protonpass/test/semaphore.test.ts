import { describe, expect, test } from "bun:test";
import { createSlotSemaphore } from "../src/session";

describe("process slot semaphore", () => {
  test("a released slot goes to the waiter; a caller arriving meanwhile cannot take it", async () => {
    const slots = createSlotSemaphore(2);
    const first = await slots.acquire();
    await slots.acquire();
    let waiterHolds = false;
    const waiter = slots.acquire().then((release) => {
      waiterHolds = true;
      return release;
    });
    expect(slots.waiting()).toBe(1);
    first();
    // The waiter has not resumed yet, but the slot is already its.
    expect(waiterHolds).toBe(false);
    expect(slots.active()).toBe(2);
    let latecomerHolds = false;
    const latecomer = slots.acquire().then((release) => {
      latecomerHolds = true;
      return release;
    });
    await waiter;
    expect(waiterHolds).toBe(true);
    expect(latecomerHolds).toBe(false);
    expect(slots.active()).toBe(2);
    expect(slots.waiting()).toBe(1);
    (await waiter)();
    (await latecomer)();
    expect(slots.active()).toBe(1);
  });

  test("never exceeds its limit under churn", async () => {
    const slots = createSlotSemaphore(4);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 64 }, async (_, index) => {
        const release = await slots.acquire();
        running += 1;
        peak = Math.max(peak, running);
        if (index % 3 === 0) await Promise.resolve();
        else await Bun.sleep(index % 5);
        running -= 1;
        release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(slots.active()).toBe(0);
    expect(slots.waiting()).toBe(0);
  });

  test("an aborted waiter leaves the queue; release is idempotent", async () => {
    const slots = createSlotSemaphore(1);
    const held = await slots.acquire();
    const controller = new AbortController();
    const aborted = slots.acquire(controller.signal);
    controller.abort(new Error("stop"));
    await expect(aborted).rejects.toThrow("stop");
    expect(slots.waiting()).toBe(0);
    const already = new AbortController();
    already.abort(new Error("late"));
    await expect(slots.acquire(already.signal)).rejects.toThrow("late");
    held();
    held();
    expect(slots.active()).toBe(0);
  });
});
