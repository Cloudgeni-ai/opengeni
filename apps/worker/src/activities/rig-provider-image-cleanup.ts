import type { Settings } from "@opengeni/config";
import {
  listRecoverableRigProviderImageCleanupObligationsForSource,
  recordRigProviderImageCleanupObject,
  type Database,
} from "@opengeni/db";
import { recoverModalImmutableProviderImageBuild } from "@opengeni/runtime/sandbox";

export type ReconcileRigProviderImageCleanupDependencies = {
  list: typeof listRecoverableRigProviderImageCleanupObligationsForSource;
  recover: typeof recoverModalImmutableProviderImageBuild;
  record: typeof recordRigProviderImageCleanupObject;
};

const defaultDependencies: ReconcileRigProviderImageCleanupDependencies = {
  list: listRecoverableRigProviderImageCleanupObligationsForSource,
  recover: recoverModalImmutableProviderImageBuild,
  record: recordRigProviderImageCleanupObject,
};

/** Resolve every ambiguous Modal image build owned by one exact source sandbox
 * before that sandbox is terminated. A worker restart enters this same path
 * through the global reaper, using the durable request id instead of the dead
 * activity's in-memory promise. */
export async function reconcileRigProviderImageCleanupObligationsForSource(
  input: {
    db: Database;
    settings: Settings;
    accountId: string;
    workspaceId: string;
    sourceLeaseId: string;
    sourceInstanceId: string;
    timeoutMs: number;
  },
  dependencies: ReconcileRigProviderImageCleanupDependencies = defaultDependencies,
): Promise<number> {
  const obligations = await dependencies.list(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sourceLeaseId: input.sourceLeaseId,
    sourceInstanceId: input.sourceInstanceId,
  });
  if (obligations.length === 0) return 0;
  const deadlineAtMs = Date.now() + Math.max(1, input.timeoutMs);
  let recorded = 0;
  for (const obligation of obligations) {
    const remainingMs = Math.floor(deadlineAtMs - Date.now());
    if (remainingMs <= 0) {
      throw new Error("Rig provider image cleanup reconciliation deadline was reached");
    }
    const result = await dependencies.recover(input.settings, {
      sandboxId: input.sourceInstanceId,
      requestId: obligation.buildRequestId,
      timeoutMs: remainingMs,
      expectedProviderBindingKey: obligation.providerBindingKey,
    });
    if (
      result.backend !== "modal" ||
      !result.imageId ||
      result.providerBindingKey !== obligation.providerBindingKey
    ) {
      throw new Error("Modal Rig provider image recovery returned another provider identity");
    }
    const persisted = await dependencies.record(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      obligationId: obligation.id,
      buildRequestId: obligation.buildRequestId,
      providerBindingKey: obligation.providerBindingKey,
      objectId: result.imageId,
    });
    if (!persisted) {
      throw new Error("Modal Rig provider image recovery could not persist the exact image id");
    }
    recorded += 1;
  }
  return recorded;
}
