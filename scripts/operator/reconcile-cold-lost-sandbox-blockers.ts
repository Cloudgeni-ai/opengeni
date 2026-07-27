import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, reconcileColdLostLeaseInstanceBlockers } from "@opengeni/db";

if (process.env.OPENGENI_COLD_LOST_LEASE_RECONCILE !== "apply") {
  throw new Error(
    "Set OPENGENI_COLD_LOST_LEASE_RECONCILE=apply to authorize exact blocker settlement",
  );
}

const input = {
  accountId: required("OPENGENI_RECOVERY_ACCOUNT_ID"),
  workspaceId: required("OPENGENI_RECOVERY_WORKSPACE_ID"),
  sandboxGroupId: required("OPENGENI_RECOVERY_SANDBOX_GROUP_ID"),
  expectedCurrentEpoch: nonnegativeInteger("OPENGENI_RECOVERY_CURRENT_EPOCH"),
  expectedLostEpoch: nonnegativeInteger("OPENGENI_RECOVERY_LOST_EPOCH"),
  expectedLostInstanceId: required("OPENGENI_RECOVERY_LOST_INSTANCE_ID"),
  expectedWorkspaceGeneration: nonnegativeInteger("OPENGENI_RECOVERY_WORKSPACE_GENERATION"),
  expectedArchiveGeneration: nullableNonnegativeInteger("OPENGENI_RECOVERY_ARCHIVE_GENERATION"),
  expectedArchiveComplete: exactBoolean("OPENGENI_RECOVERY_ARCHIVE_COMPLETE"),
};

const settings = getSettings();
const searchPath = dbSearchPath(settings);
const client = createDb(settings.databaseUrl, {
  ...(searchPath ? { searchPath } : {}),
  rlsStrategy: settings.rlsStrategy,
  max: 1,
});

try {
  const result = await reconcileColdLostLeaseInstanceBlockers(client.db, input);
  const receipt =
    result.status === "reconciled"
      ? {
          status: result.status,
          leaseEpoch: result.lease.leaseEpoch,
          workspaceGeneration: result.lease.workspaceGeneration,
          archiveGeneration: result.lease.archiveGeneration,
          archiveComplete: result.lease.archiveComplete,
          recovery: {
            provider: result.lease.recovery.provider.status,
            restore: result.lease.recovery.restore.status,
            workspace: result.lease.recovery.workspace.status,
          },
          settlement: result.settlement,
        }
      : {
          status: result.status,
          observed: result.lease
            ? {
                liveness: result.lease.liveness,
                leaseEpoch: result.lease.leaseEpoch,
                workspaceGeneration: result.lease.workspaceGeneration,
                archiveGeneration: result.lease.archiveGeneration,
                archiveComplete: result.lease.archiveComplete,
                provider: result.lease.recovery.provider.status,
              }
            : null,
        };
  console.log(`OPENGENI_COLD_LOST_LEASE_RECONCILE_RESULT=${JSON.stringify(receipt)}`);
  if (result.status !== "reconciled") process.exitCode = 2;
} finally {
  await client.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonnegativeInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function nullableNonnegativeInteger(name: string): number | null {
  const value = required(name);
  return value === "null" ? null : nonnegativeInteger(name);
}

function exactBoolean(name: string): boolean {
  const value = required(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}
