import {
  getSubscriptionCoreCapacityWaitForSession,
  subscriptionCoreCapacityWaitRef,
} from "@opengeni/db";

import { reconcileCoreCapacityWait } from "./subscription-core-codex-waits";
import { subscriptionCoreWaitBindings } from "./subscription-core-wait-bindings";

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
    // reference shape; a SuperGrok one carries `provider: "xai"` and a
    // Claude one `provider: "claude"`, so their reconcile also looks the core
    // up first.
    const coreWaiter = await getSubscriptionCoreCapacityWaitForSession(
      db,
      input.workspaceId,
      input.sessionId,
    );
    if (coreWaiter) return subscriptionCoreCapacityWaitRef(coreWaiter);
    return null;
  }

  async function reconcileCodexCapacityWait(
    input: ReconcileCodexCapacityWaitInput,
  ): Promise<ReconcileCodexCapacityWaitResult> {
    const resolved = await services();
    // Histories without a provider keep the original Codex binding. Migrated
    // waiters retain their ids/generations; lookup never infers new authority.
    const binding = subscriptionCoreWaitBindings().find(
      (candidate) => candidate.provider === (input.provider ?? "codex"),
    );
    if (!binding) return { action: "stale" };
    const core = await reconcileCoreCapacityWait(resolved, binding, {
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
