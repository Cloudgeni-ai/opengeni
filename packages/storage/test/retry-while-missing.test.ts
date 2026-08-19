import { describe, expect, test } from "bun:test";
import { retryWhileMissing } from "../src/retry-while-missing";

describe("retryWhileMissing", () => {
  test("returns the first present value without sleeping", async () => {
    const sleeps: number[] = [];
    const value = await retryWhileMissing(async () => "ready", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(value).toBe("ready");
    expect(sleeps).toEqual([]);
  });

  test("retries only while the load returns null, then returns the value", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const value = await retryWhileMissing(
      async () => {
        attempts += 1;
        return attempts < 3 ? null : { ok: true };
      },
      {
        delaysMs: [10, 20, 30],
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(value).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test("returns null after the budget is exhausted", async () => {
    let attempts = 0;
    const value = await retryWhileMissing(
      async () => {
        attempts += 1;
        return null;
      },
      {
        delaysMs: [1, 2],
        sleep: async () => undefined,
      },
    );
    expect(value).toBeNull();
    expect(attempts).toBe(3);
  });

  test("does not retry non-missing errors", async () => {
    let attempts = 0;
    await expect(
      retryWhileMissing(
        async () => {
          attempts += 1;
          throw new Error("backend failure");
        },
        { delaysMs: [1], sleep: async () => undefined },
      ),
    ).rejects.toThrow("backend failure");
    expect(attempts).toBe(1);
  });

  test("stops when the signal aborts", async () => {
    const signal = AbortSignal.abort(new Error("stopped"));
    await expect(
      retryWhileMissing(async () => null, {
        signal,
        delaysMs: [1],
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("stopped");
  });
});
