import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  claimOrganizationRetentionDeletion,
  createDb,
  failOrganizationRetentionDeletion,
  finalizeOrganizationRetentionDeletion,
  listOrganizationRetentionDeletionObjects,
  previewOrganizationRetentionDeletions,
  recordOrganizationRetentionObjectDeleted,
  type DbClient,
} from "@opengeni/db";
import type {
  OrganizationRetentionDeletionClaim,
  OrganizationRetentionDeletionObject,
  OrganizationRetentionDeletionPreview,
  OrganizationRetentionDeletionResult,
} from "@opengeni/contracts";
import { createObjectStorage } from "../packages/storage/src/index";

export type OrganizationRetentionSweepPorts = Readonly<{
  preview: (input: {
    organizationId: string;
    limit: number;
  }) => Promise<OrganizationRetentionDeletionPreview[]>;
  claim: (input: {
    organizationId: string;
    operationId: string;
    excludedMembershipIds: string[];
  }) => Promise<OrganizationRetentionDeletionClaim | null>;
  listObjects: (input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    limit: number;
  }) => Promise<OrganizationRetentionDeletionObject[]>;
  deleteObject: (objectKey: string) => Promise<void>;
  recordObjectDeleted: (input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    fileId: string;
    objectKey: string;
  }) => Promise<boolean>;
  finalize: (input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
  }) => Promise<OrganizationRetentionDeletionResult>;
  fail: (input: {
    organizationId: string;
    membershipId: string;
    operationId: string;
    reasonCode: string;
  }) => Promise<boolean>;
  newOperationId: () => string;
}>;

export async function runOrganizationRetentionSweep(
  input: { organizationId: string; limit: number; dryRun: boolean },
  ports: OrganizationRetentionSweepPorts,
): Promise<
  | { dryRun: true; organizationId: string; candidates: OrganizationRetentionDeletionPreview[] }
  | {
      dryRun: false;
      organizationId: string;
      completed: OrganizationRetentionDeletionResult[];
      failed: Array<{ membershipId: string; operationId: string; reasonCode: string }>;
    }
> {
  if (input.dryRun) {
    return {
      dryRun: true,
      organizationId: input.organizationId,
      candidates: await ports.preview({
        organizationId: input.organizationId,
        limit: input.limit,
      }),
    };
  }
  const completed: OrganizationRetentionDeletionResult[] = [];
  const failed: Array<{ membershipId: string; operationId: string; reasonCode: string }> = [];
  const attemptedMembershipIds: string[] = [];
  for (let index = 0; index < input.limit; index += 1) {
    const operationId = ports.newOperationId();
    const claim = await ports.claim({
      organizationId: input.organizationId,
      operationId,
      excludedMembershipIds: attemptedMembershipIds,
    });
    if (!claim) break;
    attemptedMembershipIds.push(claim.membershipId);
    try {
      for (;;) {
        const objects = await ports.listObjects({
          organizationId: input.organizationId,
          membershipId: claim.membershipId,
          operationId,
          limit: 100,
        });
        if (objects.length === 0) break;
        for (const object of objects) {
          await ports.deleteObject(object.objectKey);
          await ports.recordObjectDeleted({
            organizationId: input.organizationId,
            membershipId: claim.membershipId,
            operationId,
            fileId: object.fileId,
            objectKey: object.objectKey,
          });
        }
      }
      completed.push(
        await ports.finalize({
          organizationId: input.organizationId,
          membershipId: claim.membershipId,
          operationId,
        }),
      );
    } catch {
      const reasonCode = "operator_execution_failed";
      await ports
        .fail({
          organizationId: input.organizationId,
          membershipId: claim.membershipId,
          operationId,
          reasonCode,
        })
        .catch(() => false);
      failed.push({ membershipId: claim.membershipId, operationId, reasonCode });
    }
  }
  return { dryRun: false, organizationId: input.organizationId, completed, failed };
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const rawLimit = argument("--limit") ?? "10";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const dryRun = process.argv.includes("--dry-run");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const storage = dryRun ? null : createObjectStorage(settings);
    if (!dryRun && !storage)
      throw new Error("Object storage is required for destructive retention");
    const result = await runOrganizationRetentionSweep(
      { organizationId, limit, dryRun },
      {
        preview: async (request) => await previewOrganizationRetentionDeletions(client.db, request),
        claim: async (request) => await claimOrganizationRetentionDeletion(client.db, request),
        listObjects: async (request) =>
          await listOrganizationRetentionDeletionObjects(client.db, request),
        deleteObject: async (objectKey) => await storage!.deleteObject(objectKey),
        recordObjectDeleted: async (request) =>
          await recordOrganizationRetentionObjectDeleted(client.db, request),
        finalize: async (request) =>
          await finalizeOrganizationRetentionDeletion(client.db, request),
        fail: async (request) => await failOrganizationRetentionDeletion(client.db, request),
        newOperationId: () => crypto.randomUUID(),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.dryRun && result.failed.length > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
