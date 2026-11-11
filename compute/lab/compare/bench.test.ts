import { expect, test } from "bun:test";
import { eachLimited } from "./bench.ts";

test("eachLimited keeps order and the concurrency limit", async () => {
  let running = 0;
  let most = 0;
  const results = await eachLimited([5, 1, 3, 2, 4], 2, async (value) => {
    running += 1;
    most = Math.max(most, running);
    await Bun.sleep(value);
    running -= 1;
    return value * 10;
  });
  expect(results).toEqual([50, 10, 30, 20, 40]);
  expect(most).toBe(2);
});

test("eachLimited starts nothing after a failure and waits for started items", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const outcome = eachLimited([0, 1, 2, 3, 4, 5], 2, async (value) => {
    started.push(value);
    if (value === 1) throw new Error("boom");
    await Bun.sleep(20);
    finished.push(value);
    return value;
  });
  await expect(outcome).rejects.toThrow("boom");
  // 0 and 1 start together; 1 fails at once, so nothing after it starts,
  // and the rejection comes only after 0 has finished.
  expect(started).toEqual([0, 1]);
  expect(finished).toEqual([0]);
});
