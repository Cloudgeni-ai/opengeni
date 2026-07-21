import {
  fetchCodexUsageForAccount,
  getCodexCapacityWaitForSession,
  listCodexAccountStatuses,
  listPendingCodexCapacityWakeTargets,
  reconcileCodexCapacityWait as reconcileCodexCapacityWaitDb,
  type CodexCapacityWakeTarget,
  type CodexCapacitySelectionContext,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  authoritativeCodexCapacityResetAt,
  isCodexCredentialEligible,
  selectCodexCredentialLeaseForTurn,
} from "./codex-rotation";
import type {
  ActivityServices,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
} from "./types";

type CodexCapacitySignalServices = {
  signalCodexCapacityWorkflow?:
    | NonNullable<ActivityServices["signalCodexCapacityWorkflow"]>
    | null
    | undefined;
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
};

/**
 * Run a bounded set of usage refreshes, then repair every committed waiter
 * revision even when an individual provider refresh failed. The database
 * outbox remains authoritative; this helper only guarantees that every worker
 * refresh path reaches the same post-commit delivery seam.
 */
export async function refreshCodexUsageAndRepairCapacityWaiters(
  refreshes: readonly (() => Promise<unknown>)[],
  repairPendingWakes: () => Promise<void>,
): Promise<void> {
  await Promise.all(refreshes.map((refresh) => refresh().catch(() => undefined)));
  await repairPendingWakes();
}

/** Deliver committed waiter revisions; Postgres remains the repairable outbox. */
export async function signalCodexCapacityWakeTargets(
  services: CodexCapacitySignalServices,
  targets: readonly CodexCapacityWakeTarget[],
): Promise<void> {
  await Promise.allSettled(
    targets.map((target) =>
      services.signalCodexCapacityWorkflow
        ? services.signalCodexCapacityWorkflow({
            accountId: target.accountId,
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            workflowId: target.workflowId,
            wakeRevision: target.wakeRevision,
          })
        : services.wakeSessionWorkflow
          ? services.wakeSessionWorkflow({
              accountId: target.accountId,
              workspaceId: target.workspaceId,
              sessionId: target.sessionId,
              workflowId: target.workflowId,
              wakeRevision: target.workflowWakeRevision,
            })
          : Promise.resolve(),
    ),
  );
}

/** Repair a commit/signal crash edge by redelivering every pending revision. */
export async function signalPendingCodexCapacityWakeTargets(
  services: CodexCapacitySignalServices & { db: ActivityServices["db"] },
  workspaceId: string,
): Promise<void> {
  const targets = await listPendingCodexCapacityWakeTargets(services.db, workspaceId).catch(
    () => [],
  );
  await signalCodexCapacityWakeTargets(services, targets);
}

export function codexCapacityDecision(
  context: CodexCapacitySelectionContext,
  settings: Settings,
): ReturnType<Parameters<typeof reconcileCodexCapacityWaitDb>[2]> {
  const now = new Date();
  const selected = selectCodexCredentialLeaseForTurn({
    context,
    leasingEnabled: settings.codexCredentialLeasingEnabled,
    sessionId: context.sessionId,
    sessionPinnedCredentialId: context.sessionPinnedCredentialId,
    sessionPinSource: context.sessionPinSource,
    sessionLastCredentialId: context.sessionLastCredentialId,
    continuationCredentialId: null,
    nearExhaustionPct: settings.codexRotationNearExhaustionPct,
    now,
  });
  if (selected.credentialId) {
    return {
      kind: "available",
      credentialId: selected.credentialId,
      diagnostic: {
        connectedCount: context.accounts.length,
        eligibleCount: context.accounts.filter((account) =>
          isCodexCredentialEligible(account, settings.codexRotationNearExhaustionPct, now),
        ).length,
      },
    };
  }
  const authoritativeReset = authoritativeCodexCapacityResetAt(
    context.accounts,
    settings.codexRotationNearExhaustionPct,
    now,
  );
  return {
    kind: "unavailable",
    earliestResetAt: authoritativeReset,
    resetKind: authoritativeReset ? "authoritative" : "bounded_refresh",
    diagnostic: {
      connectedCount: context.accounts.length,
      allocatorEnabledCount: context.accounts.filter((account) => account.allocatorEnabled).length,
      policyHash: context.policyHash,
    },
  };
}

async function refreshCapacityMetadata(
  services: ActivityServices,
  workspaceId: string,
): Promise<void> {
  const accounts = await listCodexAccountStatuses(services.db, workspaceId).catch(() => []);
  const stale = accounts.filter(
    (account) =>
      account.allocatorEnabled &&
      account.status === "active" &&
      ((account.primaryUsedPercent ?? 0) >= services.settings.codexRotationNearExhaustionPct ||
        (account.secondaryUsedPercent ?? 0) >= services.settings.codexRotationNearExhaustionPct ||
        account.usageCheckedAt === null),
  );
  await refreshCodexUsageAndRepairCapacityWaiters(
    stale.map(
      (account) => () =>
        fetchCodexUsageForAccount(services.db, services.settings, workspaceId, account.id),
    ),
    () => signalPendingCodexCapacityWakeTargets(services, workspaceId),
  );
}

export function createCodexCapacityActivities(services: () => Promise<ActivityServices>) {
  async function getCodexCapacityWait(input: GetCodexCapacityWaitInput) {
    const { db } = await services();
    const waiter = await getCodexCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    return waiter
      ? {
          waiterId: waiter.id,
          generation: waiter.generation,
          // A capacity mutation may have committed while its Temporal signal
          // was lost or while the workflow continued-as-new. Reconstruct that
          // outbox edge as an immediate re-evaluation rather than waiting for
          // the older timer.
          nextCheckAt:
            waiter.wakeRevision > waiter.observedWakeRevision
              ? new Date(0).toISOString()
              : waiter.nextCheckAt.toISOString(),
          wakeRevision: waiter.wakeRevision,
        }
      : null;
  }

  async function reconcileCodexCapacityWait(
    input: ReconcileCodexCapacityWaitInput,
  ): Promise<ReconcileCodexCapacityWaitResult> {
    const resolved = await services();
    const current = await getCodexCapacityWaitForSession(
      resolved.db,
      input.workspaceId,
      input.sessionId,
    );
    if (!current || current.id !== input.waiterId || current.generation !== input.generation) {
      return { action: "stale" };
    }
    if (input.cause === "timer" && current.nextCheckAt.getTime() <= Date.now()) {
      // This is a bounded secret-safe control-plane quota refresh. It creates no
      // turn, model call, user message, schedule, or entitlement action.
      await refreshCapacityMetadata(resolved, input.workspaceId);
    }
    const result = await reconcileCodexCapacityWaitDb(
      resolved.db,
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: input.waiterId,
        generation: input.generation,
      },
      (context) => codexCapacityDecision(context, resolved.settings),
    );
    if (result.events.length > 0) {
      try {
        await resolved.bus.publish(input.workspaceId, input.sessionId, result.events);
      } catch {
        // Postgres is authoritative; SSE replay/gap fill repairs missed fanout.
      }
    }
    if (result.action === "resumed") {
      return { action: "resumed", updateId: result.update.id };
    }
    if (result.action === "waiting") {
      return {
        action: "waiting",
        waiterId: result.waiter.id,
        generation: result.waiter.generation,
        nextCheckAt: result.waiter.nextCheckAt.toISOString(),
        wakeRevision: result.waiter.wakeRevision,
      };
    }
    return { action: result.action };
  }

  return { getCodexCapacityWait, reconcileCodexCapacityWait };
}
