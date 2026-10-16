import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  internalMaintenanceCadences,
  SUBSCRIPTION_PLAN_MAINTENANCE_PERIOD_MS,
} from "../src/internal-maintenance";
import { startMaintenanceCadences } from "../src/maintenance-cadence";
import { deferred, flushTelemetry } from "./fixtures/telemetry-clock";

const job = "subscription-plan-maintenance" as const;
const observability = () => createObservability(testSettings(), { component: "worker-control" });
const workflow = {
  start: async () => {
    throw new Error("plan maintenance must not start Temporal");
  },
  signalWithStart: async () => {
    throw new Error("plan maintenance must not signal Temporal");
  },
} as never;

test("default-off subscription maintenance is absent and makes no DB calls", async () => {
  const db = new Proxy(
    {},
    {
      get: () => {
        throw new Error("default-off DB call");
      },
    },
  ) as never;
  expect(
    await internalMaintenanceCadences({
      settings: testSettings(),
      observability: observability(),
      db,
      workflow,
      jobs: [job],
    }),
  ).toEqual([]);
});

test("enabled maintenance uses the native cadence for a bounded DB-only pass", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls += 1;
      return [];
    },
  } as never;
  const settings = { ...testSettings(), subscriptionPlansEnabled: true };
  const [cadence] = await internalMaintenanceCadences({
    settings,
    observability: observability(),
    db,
    workflow,
    jobs: [job],
  });
  expect(cadence!.job).toBe(job);
  expect(cadence!.periodMs).toBe(60_000);
  expect(SUBSCRIPTION_PLAN_MAINTENANCE_PERIOD_MS).toBe(60_000);
  expect(await cadence!.hasWork()).toBe(false);
  expect(await cadence!.start()).toBe("started");
  expect(calls).toBe(2);
  const excluded = await internalMaintenanceCadences({
    settings,
    observability: observability(),
    db,
    workflow,
    jobs: [],
  });
  expect(excluded).toEqual([]);
});

test("subscription cadence owns overlap and shutdown until its DB pass settles", async () => {
  const gate = deferred<never[]>();
  const db = { execute: async () => await gate.promise } as never;
  const settings = { ...testSettings(), subscriptionPlansEnabled: true };
  const [cadence] = await internalMaintenanceCadences({
    settings,
    observability: observability(),
    db,
    workflow,
    jobs: [job],
  });
  // Force the actual direct DB pass; close must wait for it, not just a workflow start.
  const cadences = startMaintenanceCadences({
    cadences: [{ ...cadence!, hasWork: async () => true }],
    observability: observability(),
    autoStart: false,
  });
  const tick = cadences.tick(job);
  expect(await cadences.tick(job)).toBe("busy");
  let closed = false;
  const closing = cadences.close().then(() => {
    closed = true;
  });
  await flushTelemetry();
  expect(closed).toBe(false);
  gate.resolve([]);
  expect(await tick).toBe("started");
  await closing;
  expect(closed).toBe(true);
  expect(await cadences.tick(job)).toBe("busy");
});
