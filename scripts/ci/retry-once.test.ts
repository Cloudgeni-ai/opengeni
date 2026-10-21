import { test, expect } from "bun:test";
import { retryOnce } from "./retry-once";

test("retries a failure once, returns the real second result", async () => {
  const attempts: number[] = [];
  expect(
    await retryOnce(async (attempt) => {
      attempts.push(attempt);
      return attempt === 1 ? 1 : 0;
    }),
  ).toBe(0);
  expect(attempts).toEqual([1, 2]);
  expect(await retryOnce(async () => 1)).toBe(1);
});
test.each([0, 124, 130, 137, 143])(
  "does not retry success/cancellation/deadline %i",
  async (code) => {
    let attempts = 0;
    expect(
      await retryOnce(async () => {
        attempts++;
        return code;
      }),
    ).toBe(code);
    expect(attempts).toBe(1);
  },
);
