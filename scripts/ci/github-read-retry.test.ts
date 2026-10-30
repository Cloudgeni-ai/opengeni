import { describe, expect, test } from "bun:test";
import {
  TRANSIENT_READ_RETRIES,
  readWithTransientRetry,
  transientReadDelay,
} from "./github-read-retry";

const answer = (status: number) => new Response(JSON.stringify({ status }), { status });

function timing() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms), random: () => 0 };
}

describe("readWithTransientRetry", () => {
  for (const status of [200, 204, 302, 403, 404, 422, 500]) {
    test(`returns a ${status} at once`, async () => {
      const clock = timing();
      let reads = 0;
      const response = await readWithTransientRetry(async () => {
        reads += 1;
        return answer(status);
      }, clock);
      expect(response.status).toBe(status);
      expect(reads).toBe(1);
      expect(clock.slept).toEqual([]);
    });
  }

  for (const status of [502, 503, 504]) {
    test(`repeats the read after a ${status}`, async () => {
      const clock = timing();
      const answers = [answer(status), answer(status), answer(200)];
      const response = await readWithTransientRetry(async () => answers.shift()!, clock);
      expect(response.status).toBe(200);
      expect(clock.slept).toEqual([1000, 2000]);
    });
  }

  test("repeats the read after a network error or timeout", async () => {
    const clock = timing();
    let reads = 0;
    const response = await readWithTransientRetry(async () => {
      reads += 1;
      if (reads === 1) throw new TypeError("fetch failed");
      if (reads === 2) throw new DOMException("The operation timed out.", "TimeoutError");
      return answer(200);
    }, clock);
    expect(response.status).toBe(200);
    expect(reads).toBe(3);
  });

  test("returns the last gateway error once retries are spent, so callers fail closed", async () => {
    const clock = timing();
    let reads = 0;
    const response = await readWithTransientRetry(async () => {
      reads += 1;
      return answer(502);
    }, clock);
    expect(response.status).toBe(502);
    expect(reads).toBe(TRANSIENT_READ_RETRIES + 1);
    expect(clock.slept).toEqual([1000, 2000, 4000, 8000, 15000]);
  });

  test("throws the last network error once retries are spent", async () => {
    const clock = timing();
    const failure = new TypeError("fetch failed");
    await expect(
      readWithTransientRetry(async () => {
        throw failure;
      }, clock),
    ).rejects.toBe(failure);
    expect(clock.slept).toHaveLength(TRANSIENT_READ_RETRIES);
  });

  test("starts no wait that would end after the deadline", async () => {
    let now = 0;
    const slept: number[] = [];
    let reads = 0;
    const response = await readWithTransientRetry(
      async () => {
        reads += 1;
        return answer(503);
      },
      {
        sleep: async (ms: number) => {
          slept.push(ms);
          now += ms;
        },
        random: () => 0,
        now: () => now,
        deadline: 3500,
      },
    );
    // Waits of 1 s and 2 s fit; the next 4 s wait would end at 7 s.
    expect(response.status).toBe(503);
    expect(slept).toEqual([1000, 2000]);
    expect(reads).toBe(3);
  });

  test("waits 2 s doubling to at most 30 s, with up to half as jitter", () => {
    expect(transientReadDelay(0, () => 0)).toBe(1000);
    expect(transientReadDelay(0, () => 1)).toBe(2000);
    expect(transientReadDelay(4, () => 1)).toBe(30000);
    expect(transientReadDelay(9, () => 0)).toBe(15000);
  });
});
