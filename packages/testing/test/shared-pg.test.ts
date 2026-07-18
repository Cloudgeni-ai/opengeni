import { describe, expect, test } from "bun:test";

import { retrySharedPostgresStartup } from "../src/shared-pg";

describe("shared PostgreSQL startup boundary", () => {
  test("retries two transient startup failures, then succeeds", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const available = await retrySharedPostgresStartup(
      async () => {
        attempts += 1;
        return attempts === 3;
      },
      {
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(available).toBe(true);
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  test("persistent startup failure stays unavailable after the bounded retry", async () => {
    let attempts = 0;
    const available = await retrySharedPostgresStartup(
      async () => {
        attempts += 1;
        return false;
      },
      { sleep: async () => undefined },
    );

    expect(available).toBe(false);
    expect(attempts).toBe(3);
  });
});
