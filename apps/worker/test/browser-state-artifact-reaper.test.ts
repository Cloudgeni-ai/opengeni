import { describe, expect, mock, test } from "bun:test";
import type { BrowserStateArtifactCleanupClaim } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { createBrowserStateArtifactMaintenanceActivities } from "../src/activities/browser-state-artifact-reaper";
import type { ActivityServices } from "../src/activities/types";

const first: BrowserStateArtifactCleanupClaim = {
  claimId: "11111111-1111-4111-8111-111111111111",
  artifactId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444",
  objectKey: "workspaces/44444444-4444-4444-8444-444444444444/browser-state/checkpoints/a.ogbp",
};

const second: BrowserStateArtifactCleanupClaim = {
  ...first,
  claimId: "55555555-5555-4555-8555-555555555555",
  artifactId: "66666666-6666-4666-8666-666666666666",
  objectKey: "workspaces/44444444-4444-4444-8444-444444444444/browser-state/checkpoints/b.ogbp",
};

function services(warn = mock(() => undefined)): () => Promise<ActivityServices> {
  return async () =>
    ({
      db: {} as never,
      objectStorage: {} as ObjectStorage,
      observability: { info: mock(() => undefined), warn } as never,
    }) as ActivityServices;
}

describe("browser state artifact maintenance", () => {
  test("deletes and settles every exact durable claim", async () => {
    const deleted: string[] = [];
    const completed: BrowserStateArtifactCleanupClaim[] = [];
    const activity = createBrowserStateArtifactMaintenanceActivities(services(), {
      claimTimeoutMs: 123,
      batchSize: 2,
      claim: async (_db, input) => {
        expect(input).toEqual({ claimTimeoutMs: 123, limit: 2 });
        return [first, second];
      },
      deleteObject: async (_storage, key) => {
        deleted.push(key);
      },
      complete: async (_db, claim) => {
        completed.push(claim);
        return true;
      },
    });

    expect(await activity.maintainBrowserStateArtifacts()).toEqual({
      claimed: 2,
      deleted: 2,
      retryable: 0,
    });
    expect(deleted).toEqual([first.objectKey, second.objectKey]);
    expect(completed).toEqual([first, second]);
  });

  test("isolates failures, redacts provider details, and leaves claims reclaimable", async () => {
    const warn = mock(() => undefined);
    const complete = mock(async () => true);
    const activity = createBrowserStateArtifactMaintenanceActivities(services(warn), {
      claim: async () => [first, second],
      deleteObject: async (_storage, key) => {
        if (key === first.objectKey) {
          throw Object.assign(new Error(`private ${key}`), {
            code: "provider-private-value",
          });
        }
      },
      complete,
    });

    expect(await activity.maintainBrowserStateArtifacts()).toEqual({
      claimed: 2,
      deleted: 1,
      retryable: 1,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.anything(), second);
    const attributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(attributes).toEqual({
      workspaceId: first.workspaceId,
      artifactId: first.artifactId,
      errorCategory: "unknown",
    });
    expect(JSON.stringify(attributes)).not.toContain(first.objectKey);
  });

  test("treats lost DB settlement as retryable after provider deletion", async () => {
    const warn = mock(() => undefined);
    const activity = createBrowserStateArtifactMaintenanceActivities(services(warn), {
      claim: async () => [first],
      deleteObject: async () => undefined,
      complete: async () => false,
    });
    expect(await activity.maintainBrowserStateArtifacts()).toEqual({
      claimed: 1,
      deleted: 0,
      retryable: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
