import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../src/database";
import {
  observeSandboxFleetWarmBoxes,
  readSandboxFleetPressure,
  readSandboxUnpaidFleetBoxSecondsToday,
  resetSandboxFleetState,
} from "../src/sandbox-fleet-limits";

const limits = { pressureEngageWarmBoxes: 50, pressureReleaseWarmBoxes: 40 };

function warmCountDatabase(read: () => number): Database {
  return {
    execute: async () => [{ liveness: "warm", count: read() }],
  } as unknown as Database;
}

afterEach(() => resetSandboxFleetState());

describe("sandbox fleet pressure", () => {
  test("engages above the engage level and releases only below the release level", () => {
    expect(observeSandboxFleetWarmBoxes(limits, 50)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 51)).toBe("engaged");
    expect(observeSandboxFleetWarmBoxes(limits, 45)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 40)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 39)).toBe("released");
    expect(observeSandboxFleetWarmBoxes(limits, 45)).toBeNull();
  });

  test("releases only after the warm count stays below the release level long enough", () => {
    const sustained = { ...limits, pressureReleaseAfterMs: 15 * 60_000 };
    const start = Date.now();
    expect(observeSandboxFleetWarmBoxes(sustained, 60, start)).toBe("engaged");
    expect(observeSandboxFleetWarmBoxes(sustained, 30, start + 60_000)).toBeNull();
    // Back over the release level: the window starts again.
    expect(observeSandboxFleetWarmBoxes(sustained, 42, start + 10 * 60_000)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(sustained, 30, start + 11 * 60_000)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(sustained, 30, start + 25 * 60_000)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(sustained, 30, start + 26 * 60_000)).toBe("released");
  });

  test("removing the engage level releases pressure", () => {
    observeSandboxFleetWarmBoxes(limits, 60);
    expect(observeSandboxFleetWarmBoxes({}, 60)).toBe("released");
  });

  test("unconfigured pressure never reads and never fails", async () => {
    const db = warmCountDatabase(() => {
      throw new Error("not read");
    });
    expect(await readSandboxFleetPressure(db, {})).toEqual({
      engaged: false,
      warmBoxes: null,
      failed: false,
    });
  });

  test("reads the warm count at most every fifteen seconds", async () => {
    let reads = 0;
    const db = warmCountDatabase(() => {
      reads += 1;
      return 60;
    });
    const start = Date.now();
    expect((await readSandboxFleetPressure(db, limits, { now: start })).engaged).toBe(true);
    await readSandboxFleetPressure(db, limits, { now: start + 1_000 });
    expect(reads).toBe(1);
  });

  test("a failed read reports failure, and the last good reading goes stale", async () => {
    const failures: unknown[] = [];
    const failing = warmCountDatabase(() => {
      throw new Error("database unavailable");
    });
    const first = await readSandboxFleetPressure(failing, limits, {
      onReadFailure: (error) => failures.push(error),
    });
    expect(first.failed).toBe(true);
    expect(failures).toHaveLength(1);

    resetSandboxFleetState();
    const now = Date.now();
    observeSandboxFleetWarmBoxes(limits, 10, now);
    expect((await readSandboxFleetPressure(failing, limits, { now: now + 1_000 })).failed).toBe(
      false,
    );
    expect((await readSandboxFleetPressure(failing, limits, { now: now + 121_000 })).failed).toBe(
      true,
    );
  });
});

describe("unpaid fleet box time", () => {
  test("a failed read is reused briefly instead of read again for every admission", async () => {
    let reads = 0;
    let failing = true;
    const db = {
      execute: async () => {
        reads += 1;
        if (failing) throw new Error("database unavailable");
        return [{ available: true, running_boxes: 3, box_seconds_today: 7200 }];
      },
    } as unknown as Database;
    const start = Date.now();
    await expect(readSandboxUnpaidFleetBoxSecondsToday(db, start)).rejects.toThrow(
      "database unavailable",
    );
    expect(reads).toBe(1);
    await expect(readSandboxUnpaidFleetBoxSecondsToday(db, start + 5_000)).rejects.toThrow(
      "database unavailable",
    );
    expect(reads).toBe(1);
    failing = false;
    expect(await readSandboxUnpaidFleetBoxSecondsToday(db, start + 16_000)).toBe(7200);
  });
});
