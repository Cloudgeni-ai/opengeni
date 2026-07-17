import { expect, test } from "bun:test";
import { waitFor } from "../src/process";

test("waitFor enforces its deadline when one predicate attempt never settles", async () => {
  const startedAt = Date.now();

  await expect(
    waitFor(() => new Promise<boolean>(() => undefined), {
      timeoutMs: 25,
      intervalMs: 1,
    }),
  ).rejects.toThrow("Timed out waiting for condition");
  expect(Date.now() - startedAt).toBeLessThan(500);
});
