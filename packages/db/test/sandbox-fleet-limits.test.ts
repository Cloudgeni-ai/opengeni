import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../src/database";
import {
  observeSandboxFleetWarmBoxes,
  readSandboxFleetPressure,
  resetSandboxFleetState,
} from "../src/sandbox-fleet-limits";

const limits = { pressureEngageWarmBoxes: 50, pressureReleaseWarmBoxes: 35 };

function warmCountDatabase(read: () => number): Database {
  return {
    execute: async () => [{ liveness: "warm", count: read() }],
  } as unknown as Database;
}

afterEach(() => resetSandboxFleetState());

describe("sandbox fleet pressure", () => {
  test("engages above the engage level and releases only at the release level", () => {
    expect(observeSandboxFleetWarmBoxes(limits, 50)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 51)).toBe("engaged");
    expect(observeSandboxFleetWarmBoxes(limits, 40)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 36)).toBeNull();
    expect(observeSandboxFleetWarmBoxes(limits, 35)).toBe("released");
    expect(observeSandboxFleetWarmBoxes(limits, 45)).toBeNull();
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
