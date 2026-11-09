import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { createObservability } from "@opengeni/observability";
import { internalMaintenanceCadences } from "../src/internal-maintenance";

test("billing alerts reuse the bounded control cadence without creating Temporal work", async () => {
  let queries = 0;
  const [cadence] = await internalMaintenanceCadences({
    settings: testSettings(),
    observability: createObservability(testSettings(), { component: "test" }),
    db: {
      execute: async () => {
        queries++;
        return [];
      },
    } as never,
    workflow: {
      start: () => {
        throw new Error("no new workflow");
      },
    } as never,
    jobs: ["billing-credit-alerts"],
  });
  expect(cadence!.periodMs).toBe(60_000);
  expect(await cadence!.hasWork()).toBe(false);
  expect(await cadence!.start()).toBe("started");
  expect(queries).toBe(1);
});
