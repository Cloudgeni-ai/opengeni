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
const firstFileId = "00000000-0000-4000-8000-000000000006";
const secondFileId = "00000000-0000-4000-8000-000000000007";
const now = "2026-08-16T00:00:00.000Z";

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
            fileId: membershipId === firstMembershipId ? firstFileId : secondFileId,
            objectKey: `retention/${membershipId}`,
          },
        ];
      },
      deleteObject: async (objectKey) => {
        if (objectKey.endsWith(firstMembershipId)) throw new Error("provider unavailable");
        deleted.push(objectKey);
      },
      recordObjectDeleted: async () => true,
      finalize: async ({ membershipId, operationId }) => ({
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
      { organizationId, limit: 2, dryRun: false },
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
        finalize: async () => {
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
});
