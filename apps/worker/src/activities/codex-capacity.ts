import {
  getSubscriptionCoreCodexCapacityWaitForSession,
  subscriptionCoreCodexCapacityWaitRef,
  getXaiCapacityWaitForSession,
  getClaudeCapacityWaitForSession,
  resolveClaudeWaiterSubject,
  reconcileClaudeCapacityWait as reconcileClaudeCapacityWaitDb,
  resolveXaiWaiterSubject,
  reconcileXaiCapacityWait as reconcileXaiCapacityWaitDb,
} from "@opengeni/db";

import { refreshExhaustedXaiQuota } from "./xai-quota";
import { reconcileCoreCodexCapacityWait } from "./subscription-core-codex-waits";

import type {
  ControlActivityServices,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
} from "./types";

export function createCodexCapacityActivities(services: () => Promise<ControlActivityServices>) {
  async function getCodexCapacityWait(input: GetCodexCapacityWaitInput) {
    const { db } = await services();
    // A core Codex waiter (shared subscription core, M3) keeps the legacy
    // Codex reference shape and is the only waiter written after cutover.
    const coreWaiter = await getSubscriptionCoreCodexCapacityWaitForSession(
      db,
      input.workspaceId,
      input.sessionId,
    );
    if (coreWaiter) return subscriptionCoreCodexCapacityWaitRef(coreWaiter);
    const xaiWaiter = await getXaiCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const claudeWaiter = xaiWaiter
      ? null
      : await getClaudeCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const waiter = xaiWaiter ?? claudeWaiter;
    return waiter
      ? {
          ...(xaiWaiter
            ? { provider: "xai" as const }
            : claudeWaiter
              ? { provider: "claude" as const }
              : {}),
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
    if (input.provider === "xai" || input.provider === "claude") {
      const claude = input.provider === "claude";
      const getWaiter = claude ? getClaudeCapacityWaitForSession : getXaiCapacityWaitForSession;
      const resolveAuthority = claude ? resolveClaudeWaiterSubject : resolveXaiWaiterSubject;
      const reconcile = claude ? reconcileClaudeCapacityWaitDb : reconcileXaiCapacityWaitDb;
      const current = await getWaiter(resolved.db, input.workspaceId, input.sessionId);
      if (!current || current.id !== input.waiterId || current.generation !== input.generation) {
        return { action: "stale" };
      }
      const authority = await resolveAuthority(resolved.db, input.workspaceId, input.sessionId);
      if (authority && !claude)
        await refreshExhaustedXaiQuota({
          db: resolved.db,
          settings: resolved.settings,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: authority.turnId,
          subjectId: authority.subjectId,
          authoritySnapshot: authority.snapshot,
        });
      const result = await reconcile(resolved.db, {
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
          provider: input.provider,
          waiterId: result.waiter.id,
          generation: result.waiter.generation,
          nextCheckAt: result.waiter.nextCheckAt.toISOString(),
          wakeRevision: result.waiter.wakeRevision,
        };
      }
      return { action: result.action };
    }
    // The same reference may name a core waiter (looked up by its exact id).
    const core = await reconcileCoreCodexCapacityWait(resolved, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      waiterId: input.waiterId,
      generation: input.generation,
    });
    return core ?? { action: "stale" };
  }

  return { getCodexCapacityWait, reconcileCodexCapacityWait };
}
