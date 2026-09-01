import {
  fetchCodexUsageForAccount,
  getCodexCapacityWaitForSession,
  getXaiCapacityWaitForSession,
  listCodexAccountStatuses,
  listPendingCodexCapacityWakeTargets,
  reconcileCodexCapacityWait as reconcileCodexCapacityWaitDb,
  reconcileXaiCapacityWait as reconcileXaiCapacityWaitDb,
  type CodexCapacityWakeTarget,
  type CodexCapacitySelectionContext,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  authoritativeCodexCapacityResetAt,
  codexAccountNeedsLiveCapacityRefresh,
  isCodexCredentialEligible,
  isCodexCredentialHealthy,
  selectCodexCredentialLeaseForTurn,
} from "./codex-rotation";
import type {
  ControlActivityServices,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
} from "./types";

type CodexCapacitySignalServices = {
  signalCodexCapacityWorkflow?:
    | NonNullable<ControlActivityServices["signalCodexCapacityWorkflow"]>
    | null
    | undefined;
  wakeSessionWorkflow: ControlActivityServices["wakeSessionWorkflow"];
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
  services: CodexCapacitySignalServices & { db: ControlActivityServices["db"] },
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
    now,
  });
  const selectedAccount = selected.credentialId
    ? context.accounts.find((account) => account.id === selected.credentialId)
    : undefined;
  const selectedIsAvailable =
    selectedAccount !== undefined &&
    (selectedAccount.id === context.existingCredentialId
      ? isCodexCredentialHealthy(selectedAccount, now)
      : isCodexCredentialEligible(selectedAccount, now));
  if (selected.credentialId && selectedIsAvailable) {
    return {
      kind: "available",
      credentialId: selected.credentialId,
      diagnostic: {
        connectedCount: context.accounts.length,
        eligibleCount: context.accounts.filter((account) => isCodexCredentialEligible(account, now))
          .length,
      },
    };
  }
  const authoritativeReset = authoritativeCodexCapacityResetAt(context.accounts, now);
  const hasReconcilableQuotaCooldown = context.accounts.some(
    (account) =>
      account.status === "active" &&
      account.allocatorEnabled &&
      (account.exhaustedKind === "quota" || account.exhaustedKind === null) &&
      account.exhaustedUntil !== null &&
      account.exhaustedUntil > now,
  );
  return {
    kind: "unavailable",
    earliestResetAt: authoritativeReset,
    resetKind:
      authoritativeReset && !hasReconcilableQuotaCooldown ? "authoritative" : "bounded_refresh",
    diagnostic: {
      connectedCount: context.accounts.length,
      allocatorEnabledCount: context.accounts.filter((account) => account.allocatorEnabled).length,
      policyHash: context.policyHash,
    },
  };
}

async function refreshCapacityMetadata(
  services: ControlActivityServices,
  workspaceId: string,
): Promise<void> {
  const accounts = await listCodexAccountStatuses(services.db, workspaceId).catch(() => []);
  const now = new Date();
  const stale = accounts.filter(
    (account) =>
      account.allocatorEnabled &&
      account.status === "active" &&
      (codexAccountNeedsLiveCapacityRefresh(account, now) || account.usageCheckedAt === null),
  );
  await refreshCodexUsageAndRepairCapacityWaiters(
    stale.map(
      (account) => () =>
        fetchCodexUsageForAccount(services.db, services.settings, workspaceId, account.id),
    ),
    () => signalPendingCodexCapacityWakeTargets(services, workspaceId),
  );
}

export function createCodexCapacityActivities(services: () => Promise<ControlActivityServices>) {
  async function getCodexCapacityWait(input: GetCodexCapacityWaitInput) {
    const { db } = await services();
    const codexWaiter = await getCodexCapacityWaitForSession(
      db,
      input.workspaceId,
      input.sessionId,
    );
    const xaiWaiter = codexWaiter
      ? null
      : await getXaiCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const waiter = codexWaiter ?? xaiWaiter;
    return waiter
      ? {
          ...(xaiWaiter ? { provider: "xai" as const } : {}),
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
    if (input.provider === "xai") {
      const current = await getXaiCapacityWaitForSession(
        resolved.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!current || current.id !== input.waiterId || current.generation !== input.generation) {
        return { action: "stale" };
      }
      const result = await reconcileXaiCapacityWaitDb(resolved.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: input.waiterId,
        generation: input.generation,
      });
      if (result.events.length > 0) {
        try {
          await resolved.bus.publish(input.workspaceId, input.sessionId, result.events);
        } catch {
          // Postgres is authoritative; SSE replay/gap fill repairs missed fanout.
        }
      }
      if (result.action === "resumed") return { action: "resumed" };
      if (result.action === "waiting") {
        return {
          action: "waiting",
          provider: "xai",
          waiterId: result.waiter.id,
          generation: result.waiter.generation,
          nextCheckAt: result.waiter.nextCheckAt.toISOString(),
          wakeRevision: result.waiter.wakeRevision,
        };
      }
      return { action: result.action };
    }
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
      return { action: "resumed" };
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
