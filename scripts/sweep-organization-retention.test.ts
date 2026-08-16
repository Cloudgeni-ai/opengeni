import { describe, expect, test } from "bun:test";
import {
  runOrganizationRetentionSweep,
  type OrganizationRetentionSweepPorts,
} from "./sweep-organization-retention";

const organizationId = "00000000-0000-4000-8000-000000000001";
const firstMembershipId = "00000000-0000-4000-8000-000000000002";
const secondMembershipId = "00000000-0000-4000-8000-000000000003";
const firstOperationId = "00000000-0000-4000-8000-000000000004";
const secondOperationId = "00000000-0000-4000-8000-000000000005";
const firstObjectId = "00000000-0000-4000-8000-000000000006";
const secondObjectId = "00000000-0000-4000-8000-000000000007";
const now = "2026-08-16T00:00:00.000Z";
const objectBucket = "retention-test";

describe("organization retention operator", () => {
  test("isolates a failed membership and continues the bounded batch", async () => {
    const claims = [firstMembershipId, secondMembershipId];
    const operations = [firstOperationId, secondOperationId];
    const exclusions: string[][] = [];
    const failed: string[] = [];
    const deleted: string[] = [];
    const listed = new Set<string>();
    const ports: OrganizationRetentionSweepPorts = {
      preview: async () => [],
      newOperationId: () => operations.shift()!,
      claim: async (input) => {
        exclusions.push([...input.excludedMembershipIds]);
        const membershipId = claims.shift();
        return membershipId
          ? {
              organizationId,
              membershipId,
              operationId: input.operationId,
              retentionUntil: now,
              claimExpiresAt: now,
              personalWorkspaceId: null,
              objectCount: 1,
              deletedObjectCount: 0,
            }
          : null;
      },
      listObjects: async ({ membershipId }) => {
        if (listed.has(membershipId)) return [];
        listed.add(membershipId);
        return [
          {
            objectKind: "file",
            sourceId: membershipId === firstMembershipId ? firstObjectId : secondObjectId,
            objectBucket,
            objectKey: `retention/${membershipId}`,
          },
        ];
      },
      deleteObject: async ({ objectKey }) => {
        if (objectKey.endsWith(firstMembershipId)) throw new Error("provider unavailable");
        deleted.push(objectKey);
      },
      recordObjectDeleted: async () => true,
      finalizeDatabase: async ({ membershipId, operationId }) => ({
        organizationId,
        membershipId,
        operationId,
        outcome: "cleanup_pending",
        objectBucket,
        objectCount: 1,
        deletedResources: { personalWorkspaces: 1 },
        databaseFinalizedAt: now,
      }),
      complete: async ({ membershipId, operationId }) => ({
        organizationId,
        membershipId,
        operationId,
        outcome: "completed",
        deletedResources: { personalWorkspaces: 1 },
        completedAt: now,
      }),
      fail: async ({ membershipId }) => {
        failed.push(membershipId);
        return true;
      },
    };

    const result = await runOrganizationRetentionSweep(
      { organizationId, limit: 2, dryRun: false, objectBucket },
      ports,
    );
    expect(result).toMatchObject({
      dryRun: false,
      completed: [{ membershipId: secondMembershipId }],
      failed: [{ membershipId: firstMembershipId, reasonCode: "operator_execution_failed" }],
    });
    expect(exclusions).toEqual([[], [firstMembershipId]]);
    expect(failed).toEqual([firstMembershipId]);
    expect(deleted).toEqual([`retention/${secondMembershipId}`]);
  });

  test("dry-run previews without acquiring or deleting", async () => {
    let claimed = false;
    const result = await runOrganizationRetentionSweep(
      { organizationId, limit: 1, dryRun: true },
      {
        preview: async () => [
          {
            membershipId: firstMembershipId,
            retentionUntil: now,
            personalWorkspaceId: null,
            resourceCount: 0,
            objectCount: 0,
          },
        ],
        newOperationId: () => firstOperationId,
        claim: async () => {
          claimed = true;
          return null;
        },
        listObjects: async () => [],
        deleteObject: async () => undefined,
        recordObjectDeleted: async () => true,
        finalizeDatabase: async () => {
          throw new Error("not reached");
        },
        complete: async () => {
          throw new Error("not reached");
        },
        fail: async () => true,
      },
    );
    expect(result).toMatchObject({
      dryRun: true,
      candidates: [{ membershipId: firstMembershipId }],
    });
    expect(claimed).toBe(false);
  });

  test("retries only unfinished object obligations after a partial provider failure", async () => {
    const remaining = new Set([firstObjectId, secondObjectId]);
    const deleted: string[] = [];
    let invocation = 0;
    let failedOnce = false;
    const ports: OrganizationRetentionSweepPorts = {
      preview: async () => [],
      newOperationId: () => (invocation++ === 0 ? firstOperationId : secondOperationId),
      claim: async ({ operationId }) => ({
        organizationId,
        membershipId: firstMembershipId,
        operationId,
        retentionUntil: now,
        claimExpiresAt: now,
        personalWorkspaceId: null,
        objectCount: 2,
        deletedObjectCount: 2 - remaining.size,
      }),
      finalizeDatabase: async ({ operationId }) => ({
        organizationId,
        membershipId: firstMembershipId,
        operationId,
        outcome: "cleanup_pending",
        objectBucket,
        objectCount: 2,
        deletedResources: { personalWorkspaces: 1 },
        databaseFinalizedAt: now,
      }),
      listObjects: async () =>
        [...remaining].map((sourceId) => ({
          objectKind: "file" as const,
          sourceId,
          objectBucket,
          objectKey: `retention/${sourceId}`,
        })),
      deleteObject: async ({ objectKey }) => {
        if (objectKey.endsWith(secondObjectId) && !failedOnce) {
          failedOnce = true;
          throw new Error("transient storage failure");
        }
        deleted.push(objectKey);
      },
      recordObjectDeleted: async ({ sourceId }) => remaining.delete(sourceId),
      complete: async ({ operationId }) => ({
        organizationId,
        membershipId: firstMembershipId,
        operationId,
        outcome: "completed",
        deletedResources: { personalWorkspaces: 1, externalObjects: 2 },
        completedAt: now,
      }),
      fail: async () => true,
    };

    const first = await runOrganizationRetentionSweep(
      { organizationId, limit: 1, dryRun: false, objectBucket },
      ports,
    );
    expect(first).toMatchObject({ dryRun: false, completed: [], failed: [{}] });
    expect(remaining).toEqual(new Set([secondObjectId]));
    const second = await runOrganizationRetentionSweep(
      { organizationId, limit: 1, dryRun: false, objectBucket },
      ports,
    );
    expect(second).toMatchObject({ dryRun: false, completed: [{}], failed: [] });
    expect(remaining.size).toBe(0);
    expect(deleted).toEqual([`retention/${firstObjectId}`, `retention/${secondObjectId}`]);
  });

  test("refuses a resumed cleanup under a changed configured bucket", async () => {
    const frozenBucket = "retention-original";
    const changedBucket = "retention-reconfigured";
    const deleted: Array<{ objectBucket: string; objectKey: string }> = [];
    let invocation = 0;
    const ports: OrganizationRetentionSweepPorts = {
      preview: async () => [],
      newOperationId: () => (invocation++ === 0 ? firstOperationId : secondOperationId),
      claim: async ({ operationId }) => ({
        organizationId,
        membershipId: firstMembershipId,
        operationId,
        retentionUntil: now,
        claimExpiresAt: now,
        personalWorkspaceId: null,
        objectCount: 1,
        deletedObjectCount: 0,
      }),
      finalizeDatabase: async ({ operationId, objectBucket: configuredBucket }) => {
        if (configuredBucket !== frozenBucket) throw new Error("bucket changed");
        return {
          organizationId,
          membershipId: firstMembershipId,
          operationId,
          outcome: "cleanup_pending",
          objectBucket: frozenBucket,
          objectCount: 1,
          deletedResources: { personalWorkspaces: 1 },
          databaseFinalizedAt: now,
        };
      },
      listObjects: async () => [
        {
          objectKind: "file",
          sourceId: firstObjectId,
          objectBucket: frozenBucket,
          objectKey: `retention/${firstObjectId}`,
        },
      ],
      deleteObject: async (object) => {
        deleted.push(object);
        throw new Error("first provider attempt failed");
      },
      recordObjectDeleted: async () => true,
      complete: async () => {
        throw new Error("not reached");
      },
      fail: async () => true,
    };

    await runOrganizationRetentionSweep(
      { organizationId, limit: 1, dryRun: false, objectBucket: frozenBucket },
      ports,
    );
    expect(deleted).toEqual([
      { objectBucket: frozenBucket, objectKey: `retention/${firstObjectId}` },
    ]);
    await runOrganizationRetentionSweep(
      { organizationId, limit: 1, dryRun: false, objectBucket: changedBucket },
      ports,
    );
    expect(deleted).toHaveLength(1);
  });
});
