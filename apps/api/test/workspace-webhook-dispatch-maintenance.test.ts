import { afterEach, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { drainWorkspaceWebhookDeliveries } from "../src/workspace-webhook-dispatch";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("a failing allowance pass does not skip usage-limit maintenance, and still surfaces", async () => {
  const order: string[] = [];
  spies.push(
    spyOn(opengeniDb, "maintainSessionUsageLimits").mockImplementation(async () => {
      order.push("usage");
      return { processed: 0, failed: 0, errors: {}, resolvedLost: 1 };
    }),
    spyOn(opengeniDb, "maintainWorkspaceAllowances").mockImplementation(async () => {
      order.push("allowances");
      throw new Error("allowance maintenance down");
    }),
  );
  const counters: Array<Record<string, string>> = [];
  await expect(
    drainWorkspaceWebhookDeliveries({
      db: {} as Database,
      settings: testSettings(),
      observability: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        incrementCounter: (metric) => {
          counters.push(metric.labels ?? {});
        },
      },
    }),
  ).rejects.toThrow("allowance maintenance down");
  expect(order).toEqual(["usage", "allowances"]);
  expect(counters).toContainEqual({ boundary: "single_call", outcome: "lost_resolved" });
});
