import { test, expect } from "bun:test";
import { attemptCommand, retryOnce } from "./retry-once";

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
test.each([0, 70, 124, 130, 137, 143])(
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

test("attempt profiles have distinct paths without changing tested command arguments", () => {
  const command = [
    "bun",
    "profile-command.ts",
    "--output",
    "/tmp/queue-unit-{attempt}.json",
    "--",
    "bun",
    "test",
  ];
  expect(attemptCommand(command, 1)[3]).toBe("/tmp/queue-unit-1.json");
  expect(attemptCommand(command, 2)[3]).toBe("/tmp/queue-unit-2.json");
  expect(attemptCommand(command, 2).slice(4)).toEqual(command.slice(4));
});
