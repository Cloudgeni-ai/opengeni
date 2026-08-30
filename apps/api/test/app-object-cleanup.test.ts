import { describe, expect, mock, test } from "bun:test";

const realDb = await import("@opengeni/db");
const settleAppObjectCleanup = mock(async () => true);
const reapAbandonedAppUploads = mock(async () => 0);
const claimAppObjectCleanups = mock(async () => []);

mock.module("@opengeni/db", () => ({
  ...realDb,
  claimAppObjectCleanups,
  reapAbandonedAppUploads,
  settleAppObjectCleanup,
}));

const { drainAppObjectCleanupOutbox, processAppObjectCleanupClaims } =
  await import("../src/app-object-cleanup");

describe("App object cleanup pump", () => {
  test("deletes every claimed key and settles the exact claim", async () => {
    settleAppObjectCleanup.mockClear();
    const deleteObject = mock(async () => undefined);
    const result = await processAppObjectCleanupClaims(
      { db: {} as never, objectStorage: { deleteObject } },
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          appId: "44444444-4444-4444-8444-444444444444",
          objectKey: "apps/staging/source.tar",
          reason: "workspace_delete",
          claimId: "55555555-5555-4555-8555-555555555555",
          attemptCount: 1,
        },
      ],
    );

    expect(deleteObject).toHaveBeenCalledWith("apps/staging/source.tar");
    expect(settleAppObjectCleanup).toHaveBeenCalledWith(
      {},
      {
        id: "11111111-1111-4111-8111-111111111111",
        claimId: "55555555-5555-4555-8555-555555555555",
      },
    );
    expect(result).toEqual({ claimed: 1, deleted: 1, failed: 0, stale: 0 });
  });

  test("releases a failed provider delete with a bounded retry error", async () => {
    settleAppObjectCleanup.mockClear();
    const deleteObject = mock(async () => {
      throw new Error("provider unavailable");
    });
    const result = await processAppObjectCleanupClaims(
      { db: {} as never, objectStorage: { deleteObject } },
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          appId: "44444444-4444-4444-8444-444444444444",
          objectKey: "apps/frozen/source.tar",
          reason: "archive",
          claimId: "55555555-5555-4555-8555-555555555555",
          attemptCount: 2,
        },
      ],
    );

    expect(settleAppObjectCleanup.mock.calls[0]?.[1]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      claimId: "55555555-5555-4555-8555-555555555555",
      error: "Error: provider unavailable",
    });
    expect(result).toEqual({ claimed: 1, deleted: 0, failed: 1, stale: 0 });
  });

  test("polls due object cleanup without rescanning abandoned uploads every tick", async () => {
    reapAbandonedAppUploads.mockClear();
    claimAppObjectCleanups.mockClear();

    expect(
      await drainAppObjectCleanupOutbox(
        { db: {} as never, objectStorage: { deleteObject: mock(async () => undefined) } },
        { reapAbandoned: false },
      ),
    ).toEqual({ reaped: 0, claimed: 0, deleted: 0, failed: 0, stale: 0 });
    expect(reapAbandonedAppUploads).not.toHaveBeenCalled();
    expect(claimAppObjectCleanups).toHaveBeenCalledTimes(1);
  });
});
