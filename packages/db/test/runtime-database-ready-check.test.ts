import { describe, expect, test } from "bun:test";
import type { Database } from "../src/database";
import {
  RUNTIME_DATABASE_READINESS_TTL_MS,
  RuntimeDatabasePostureError,
  runCachedRuntimeDatabaseReadiness,
  runtimeDatabaseReadyCheck,
} from "../src/runtime-posture";

function fakeDatabase() {
  const inspections: { reject: (error: Error) => void }[] = [];
  const db = {
    // Every inspection runs in one database transaction. Hold it open until
    // the test settles it, as a slow or stalled database would.
    transaction: () =>
      new Promise<never>((_resolve, reject) => {
        inspections.push({ reject });
      }),
  } as unknown as Database;
  return { db, inspections };
}

test("concurrent readiness probes share one outstanding posture inspection", async () => {
  const { db, inspections } = fakeDatabase();
  const check = runtimeDatabaseReadyCheck(db, { rlsStrategy: "force" });
  const first = check();
  const second = check();
  const third = check();
  expect(second).toBe(first);
  expect(third).toBe(first);
  expect(inspections).toHaveLength(1);

  const failure = new Error("database unavailable");
  inspections[0]!.reject(failure);
  for (const probe of [first, second, third]) await expect(probe).rejects.toBe(failure);
});

test("the next probe after a settled inspection inspects again", async () => {
  const { db, inspections } = fakeDatabase();
  const check = runtimeDatabaseReadyCheck(db, { rlsStrategy: "force" });
  const failed = check();
  inspections[0]!.reject(new Error("first"));
  await expect(failed).rejects.toThrow("first");

  const retried = check();
  expect(retried).not.toBe(failed);
  expect(inspections).toHaveLength(2);
  inspections[1]!.reject(new Error("second"));
  await expect(retried).rejects.toThrow("second");

  check().catch(() => {});
  expect(inspections).toHaveLength(3);
  inspections[2]!.reject(new Error("third"));
});

describe("a passing posture stands for the readiness TTL", () => {
  function probes() {
    const calls: string[] = [];
    const outcome = {
      inspect: undefined as Error | undefined,
      connect: undefined as Error | undefined,
    };
    return {
      calls,
      outcome,
      probes: {
        connect: async () => {
          calls.push("connect");
          if (outcome.connect) throw outcome.connect;
        },
        inspect: async () => {
          calls.push("inspect");
          if (outcome.inspect) throw outcome.inspect;
        },
      },
    };
  }

  test("probes within 60 s of a passing inspection only check connectivity", async () => {
    expect(RUNTIME_DATABASE_READINESS_TTL_MS).toBe(60_000);
    const { calls, probes: run } = probes();
    const state: { passedAt?: number } = {};
    let clock = 1_000_000;
    const cache = { now: () => clock };
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("inspected");
    // The kubelet probes every 10 s: five connectivity checks, then a full one.
    for (let probe = 1; probe <= 5; probe += 1) {
      clock += 10_000;
      expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("cached");
    }
    clock += 9_999;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("cached");
    clock += 1;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("inspected");
    expect(calls).toEqual(["inspect", ...Array.from({ length: 6 }, () => "connect"), "inspect"]);
  });

  test("an incompatible posture is never cached: every probe inspects until one passes", async () => {
    const { calls, outcome, probes: run } = probes();
    const state: { passedAt?: number } = {};
    let clock = 0;
    const cache = { now: () => clock };
    outcome.inspect = new RuntimeDatabasePostureError(["runtime role has BYPASSRLS"]);
    for (let probe = 0; probe < 3; probe += 1) {
      await expect(runCachedRuntimeDatabaseReadiness(state, run, cache)).rejects.toBe(
        outcome.inspect,
      );
      clock += 10_000;
    }
    outcome.inspect = undefined;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("inspected");
    clock += 10_000;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("cached");
    expect(calls).toEqual(["inspect", "inspect", "inspect", "inspect", "connect"]);
  });

  test("a failed connectivity check ends the pass: the next probe inspects in full", async () => {
    const { calls, outcome, probes: run } = probes();
    const state: { passedAt?: number } = {};
    let clock = 0;
    const cache = { now: () => clock };
    await runCachedRuntimeDatabaseReadiness(state, run, cache);
    clock += 10_000;
    outcome.connect = new Error("connection refused");
    await expect(runCachedRuntimeDatabaseReadiness(state, run, cache)).rejects.toThrow(
      "connection refused",
    );
    outcome.connect = undefined;
    clock += 10_000;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, cache)).toBe("inspected");
    expect(calls).toEqual(["inspect", "connect", "inspect"]);
  });

  test("a clock that moves backwards, or a TTL of 0, inspects", async () => {
    const { calls, probes: run } = probes();
    const state: { passedAt?: number } = {};
    let clock = 50_000;
    await runCachedRuntimeDatabaseReadiness(state, run, { now: () => clock });
    clock = 40_000;
    expect(await runCachedRuntimeDatabaseReadiness(state, run, { now: () => clock })).toBe(
      "inspected",
    );
    expect(
      await runCachedRuntimeDatabaseReadiness(state, run, { now: () => clock, ttlMs: 0 }),
    ).toBe("inspected");
    expect(calls).toEqual(["inspect", "inspect", "inspect"]);
  });

  test("the ready check shares one probe and inspects again after a failure", async () => {
    const executions: string[] = [];
    const inspections: { reject: (error: Error) => void }[] = [];
    const db = {
      transaction: () =>
        new Promise<never>((_resolve, reject) => {
          inspections.push({ reject });
        }),
      execute: async () => {
        executions.push("select 1");
        return [];
      },
    } as unknown as Database;
    const check = runtimeDatabaseReadyCheck(db, { rlsStrategy: "force" });
    const first = check();
    inspections[0]!.reject(new Error("down"));
    await expect(first).rejects.toThrow("down");
    check().catch(() => {});
    expect(inspections).toHaveLength(2);
    expect(executions).toEqual([]);
    inspections[1]!.reject(new Error("still down"));
  });
});
