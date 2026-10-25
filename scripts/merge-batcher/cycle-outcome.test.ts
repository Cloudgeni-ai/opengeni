import { expect, test } from "bun:test";
import {
  observeCycle,
  observationDeferred,
  observeDurableUncertainty,
  writeAttempted,
  writeResolved,
  LeasePreparationExpired,
} from "./cycle-outcome";
import { ReadUnavailable } from "./read-retry";

async function failed(step: () => void) {
  const error = new ReadUnavailable(502, 5, "/jobs");
  await expect(
    observeCycle(async () => {
      step();
      throw error;
    }),
  ).rejects.toBe(error);
  return observationDeferred(error);
}
test("pure exhausted read defers; settled earlier maintenance does not invent uncertainty", async () => {
  expect(await failed(() => {})).toBe(true);
  expect(
    await failed(() => {
      writeAttempted("maintenance");
      writeResolved("maintenance");
    }),
  ).toBe(true);
});
test("failed reads cannot clear attempted or inherited unresolved effects", async () => {
  expect(await failed(() => writeAttempted("push"))).toBe(false);
  expect(await failed(() => observeDurableUncertainty(["old-post"]))).toBe(false);
  expect(
    await failed(() => {
      writeAttempted("push");
      observeDurableUncertainty([]);
    }),
  ).toBe(false);
});
test("only positive reconciliation resolves an attempted write; cycles do not share state", async () => {
  expect(
    await failed(() => {
      writeAttempted("push");
      writeResolved("other");
    }),
  ).toBe(false);
  expect(
    await failed(() => {
      writeAttempted("push");
      writeResolved("push");
    }),
  ).toBe(true);
  expect(await failed(() => {})).toBe(true);
});
test("unclassified errors never become safe read completions", async () => {
  const error = new Error("read failed");
  await expect(
    observeCycle(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(observationDeferred(error)).toBe(false);
});
test("pre-submit lease expiry defers only without unresolved writes", async () => {
  for (const unknown of [false, true]) {
    const error = new LeasePreparationExpired("expired locally");
    await expect(
      observeCycle(async () => {
        if (unknown) writeAttempted("earlier-write");
        throw error;
      }),
    ).rejects.toBe(error);
    expect(observationDeferred(error)).toBe(!unknown);
  }
});
