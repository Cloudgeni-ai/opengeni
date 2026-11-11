import { describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import { createCodexCapacityActivities } from "../src/activities/codex-capacity";

describe("Codex capacity availability diagnostics", () => {
  test("an omitted-provider historical waiter missing from core is stale without a legacy lookup", async () => {
    const coreWait = spyOn(
      opengeniDb,
      "getSubscriptionCoreCodexCapacityWaitById",
    ).mockResolvedValue(null);
    const activities = createCodexCapacityActivities(
      async () => ({ db: {}, bus: { publish: async () => undefined } }) as never,
    );
    try {
      expect(
        await activities.reconcileCodexCapacityWait({
          accountId: "account",
          workspaceId: "workspace",
          sessionId: "session",
          waiterId: "historical-waiter",
          generation: 2,
          cause: "timer",
        }),
      ).toEqual({ action: "stale" });
      expect(coreWait).toHaveBeenCalledTimes(1);
    } finally {
      coreWait.mockRestore();
    }
  });
});
