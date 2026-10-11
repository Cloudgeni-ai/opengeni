import {
  getSubscriptionCoreCapacityWaitForSession,
  subscriptionCoreCapacityWaitRef,
  getClaudeCapacityWaitForSession,
  reconcileClaudeCapacityWait as reconcileClaudeCapacityWaitDb,
} from "@opengeni/db";

import {
  reconcileCoreCapacityWait,
  reconcileCoreCodexCapacityWait,
} from "./subscription-core-codex-waits";
import { XAI_CORE_WAIT_BINDING } from "./subscription-core-xai-waits";

import type {
  ControlActivityServices,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
} from "./types";

export function createCodexCapacityActivities(services: () => Promise<ControlActivityServices>) {
  async function getCodexCapacityWait(input: GetCodexCapacityWaitInput) {
    const { db } = await services();
    // A core waiter (shared subscription core) is the only waiter written
    // after its provider's cutover. A Codex one keeps the legacy Codex
    // reference shape; a SuperGrok one carries `provider: "xai"`. Only Claude
    // still has a legacy waiter.
    const coreWaiter = await getSubscriptionCoreCapacityWaitForSession(
      db,
      input.workspaceId,
      input.sessionId,
    );
    if (coreWaiter) return subscriptionCoreCapacityWaitRef(coreWaiter);
    const waiter = await getClaudeCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    return waiter
      ? {
          provider: "claude" as const,
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
      // SuperGrok waiters live only on the core: the cutover moved each one
      // there with its id and generation, so a history that recorded the
      // legacy reference reconciles against the core waiter. Anything else
      // is stale.
      const core = await reconcileCoreCapacityWait(resolved, XAI_CORE_WAIT_BINDING, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: input.waiterId,
        generation: input.generation,
      });
      return core ?? { action: "stale" };
    }
    if (input.provider === "claude") {
      const current = await getClaudeCapacityWaitForSession(
        resolved.db,
        input.workspaceId,
        input.sessionId,
      );
      if (!current || current.id !== input.waiterId || current.generation !== input.generation) {
        return { action: "stale" };
      }
      const result = await reconcileClaudeCapacityWaitDb(resolved.db, {
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
