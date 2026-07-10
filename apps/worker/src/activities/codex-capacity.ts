import {
  fetchCodexUsageForAccount,
  getCodexCapacityWaitForSession,
  listCodexAccountStatuses,
  listPendingCodexCapacityWakeTargets,
  reconcileCodexCapacityWait as reconcileCodexCapacityWaitDb,
  type CodexCapacitySelectionContext,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  authoritativeCodexCapacityResetAt,
  selectCodexCredentialLeaseForTurn,
} from "./codex-rotation";
import type {
  ActivityServices,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
} from "./types";

function capacityDecision(
  context: CodexCapacitySelectionContext,
  settings: Settings,
): ReturnType<Parameters<typeof reconcileCodexCapacityWaitDb>[2]> {
  const now = new Date();
  const selected = selectCodexCredentialLeaseForTurn({
    context,
    leasingEnabled: settings.codexCredentialLeasingEnabled,
    sessionPinnedCredentialId: context.sessionPinnedCredentialId,
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
        eligibleCount: context.accounts.filter(
          (account) => account.allocatorEnabled && account.status === "active",
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
  await Promise.all(
    stale.map((account) =>
      fetchCodexUsageForAccount(services.db, services.settings, workspaceId, account.id).catch(
        () => undefined,
      ),
    ),
  );
  if (services.wakeSessionWorkflow) {
    const targets = await listPendingCodexCapacityWakeTargets(services.db, workspaceId).catch(
      () => [],
    );
    await Promise.allSettled(
      targets.map((target) =>
        services.wakeSessionWorkflow!({
          accountId: target.accountId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          workflowId: target.workflowId,
        }),
      ),
    );
  }
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
      (context) => capacityDecision(context, resolved.settings),
    );
    if (result.events.length > 0) {
      try {
        await resolved.bus.publish(input.workspaceId, input.sessionId, result.events);
      } catch {
        // Postgres is authoritative; SSE replay/gap fill repairs missed fanout.
      }
    }
    if (result.action === "resumed") {
      return { action: "resumed", turnId: result.turn.id };
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
