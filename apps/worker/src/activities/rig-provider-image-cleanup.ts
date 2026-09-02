import type { Settings } from "@opengeni/config";
import {
  listRecoverableRigProviderImageCleanupObligationsForSource,
  markRigProviderImageCleanupObligationBuildFailed,
  recordRigProviderImageCleanupObject,
  type Database,
} from "@opengeni/db";
import {
  classifyImmutableProviderImageBuildFailure,
  recoverImmutableProviderImageBuild,
} from "@opengeni/runtime/sandbox";

export type ReconcileRigProviderImageCleanupDependencies = {
  list: typeof listRecoverableRigProviderImageCleanupObligationsForSource;
  recover: typeof recoverImmutableProviderImageBuild;
  classify: typeof classifyImmutableProviderImageBuildFailure;
  markFailed: typeof markRigProviderImageCleanupObligationBuildFailed;
  record: typeof recordRigProviderImageCleanupObject;
};

const defaultDependencies: ReconcileRigProviderImageCleanupDependencies = {
  list: listRecoverableRigProviderImageCleanupObligationsForSource,
  recover: recoverImmutableProviderImageBuild,
  classify: classifyImmutableProviderImageBuildFailure,
  markFailed: markRigProviderImageCleanupObligationBuildFailed,
  record: recordRigProviderImageCleanupObject,
};

/** Resolve every ambiguous provider image build owned by one exact source sandbox
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
    let result: Awaited<ReturnType<typeof recoverImmutableProviderImageBuild>>;
    try {
      result = await dependencies.recover({
        backend: obligation.providerBackend,
        settings: input.settings,
        sourceInstanceId: input.sourceInstanceId,
        requestId: obligation.buildRequestId,
        timeoutMs: remainingMs,
        expectedProviderBindingKey: obligation.providerBindingKey,
      });
    } catch (error) {
      if (dependencies.classify(obligation.providerBackend, error) !== "definitive_rejection") {
        throw error;
      }
      const persisted = await dependencies.markFailed(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        obligationId: obligation.id,
        buildRequestId: obligation.buildRequestId,
        providerBindingKey: obligation.providerBindingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!persisted) {
        throw new Error(
          `${obligation.providerBackend} Rig provider image recovery could not persist the definitive rejection`,
          { cause: error },
        );
      }
      continue;
    }
    if (
      !result ||
      result.backend !== obligation.providerBackend ||
      !result.imageId ||
      result.providerBindingKey !== obligation.providerBindingKey
    ) {
      throw new Error(
        `${obligation.providerBackend} Rig provider image recovery returned another provider identity`,
      );
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
      throw new Error(
        `${obligation.providerBackend} Rig provider image recovery could not persist the exact image id`,
      );
    }
    recorded += 1;
  }
  return recorded;
}
