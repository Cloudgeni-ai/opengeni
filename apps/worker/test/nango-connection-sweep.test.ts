import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { createNangoConnectionSweepActivities } from "../src/activities/nango-connection-sweep";
import type { ControlActivityServices } from "../src/activities/types";

function services(nangoSecretKey: string | undefined, logs: string[]) {
  return async () =>
    ({
      db: {} as never,
      settings: testSettings({ nangoSecretKey }),
      observability: {
        info: (message: string) => logs.push(`info:${message}`),
        warn: (message: string) => logs.push(`warn:${message}`),
      },
    }) as unknown as ControlActivityServices;
}

const SKIPPED = {
  skipped: true,
  listed: 0,
  deleted: 0,
  repointed: 0,
  skippedPeople: 0,
  orphanBreakerTripped: false,
};

describe("the Nango connection sweep activity", () => {
  test("does nothing without a Nango secret key", async () => {
    let called = false;
    const activity = createNangoConnectionSweepActivities(services(undefined, []), {
      sweep: async () => {
        called = true;
        return null;
      },
    });
    expect(await activity.sweepUnusedNangoConnections()).toEqual(SKIPPED);
    expect(called).toBe(false);
  });

  test("summarizes and logs what it deleted", async () => {
    const logs: string[] = [];
    const activity = createNangoConnectionSweepActivities(services("key", logs), {
      sweep: async () => ({
        listed: 5,
        deletedOrphans: ["a"],
        deletedDuplicates: ["b"],
        deletedBroken: ["c"],
        repointed: 1,
        skippedPeople: 0,
        orphanBreakerTripped: false,
      }),
    });
    expect(await activity.sweepUnusedNangoConnections()).toEqual({
      skipped: false,
      listed: 5,
      deleted: 3,
      repointed: 1,
      skippedPeople: 0,
      orphanBreakerTripped: false,
    });
    expect(logs).toEqual(["info:Nango connection sweep"]);
  });

  test("a failed sweep does not fail the maintenance workflow", async () => {
    const logs: string[] = [];
    const activity = createNangoConnectionSweepActivities(services("key", logs), {
      sweep: async () => {
        throw new Error("Nango unavailable");
      },
    });
    expect(await activity.sweepUnusedNangoConnections()).toEqual(SKIPPED);
    expect(logs).toEqual(["warn:Nango connection sweep failed"]);
  });
});
