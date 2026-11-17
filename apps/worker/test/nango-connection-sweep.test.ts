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
  markedMissing: 0,
  skippedPeople: 0,
  deferredPeople: 0,
  orphanBreakerTripped: false,
  missingBreakerTripped: false,
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
        markedMissing: 0,
        skippedPeople: 0,
        deferredPeople: 0,
        orphanBreakerTripped: false,
        missingBreakerTripped: false,
      }),
    });
    expect(await activity.sweepUnusedNangoConnections()).toEqual({
      skipped: false,
      listed: 5,
      deleted: 3,
      repointed: 1,
      markedMissing: 0,
      skippedPeople: 0,
      deferredPeople: 0,
      orphanBreakerTripped: false,
      missingBreakerTripped: false,
    });
    expect(logs).toEqual(["info:Nango connection sweep"]);
  });

  test("warns when people were left for a later pass, and heartbeats between people", async () => {
    const logs: string[] = [];
    let progressed = false;
    const activity = createNangoConnectionSweepActivities(services("key", logs), {
      sweep: async (_deps, options) => {
        options?.onProgress?.();
        progressed = true;
        return {
          listed: 4,
          deletedOrphans: [],
          deletedDuplicates: [],
          deletedBroken: [],
          repointed: 0,
          markedMissing: 0,
          skippedPeople: 1,
          deferredPeople: 2,
          orphanBreakerTripped: false,
          missingBreakerTripped: false,
        };
      },
    });
    expect(await activity.sweepUnusedNangoConnections()).toMatchObject({
      skippedPeople: 1,
      deferredPeople: 2,
    });
    expect(progressed).toBe(true);
    expect(logs).toEqual(["warn:Nango connection sweep left people for a later pass"]);
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
