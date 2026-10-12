import {
  getSubscriptionCoreCapacityWaitForSession,
  subscriptionCoreCapacityWaitRef,
} from "@opengeni/db";

import {
  reconcileCoreCapacityWait,
  reconcileCoreCodexCapacityWait,
} from "./subscription-core-codex-waits";
import { XAI_CORE_WAIT_BINDING } from "./subscription-core-xai-waits";
import { CLAUDE_CORE_WAIT_BINDING } from "./subscription-core-claude-waits";

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
    if (input.provider === "xai" || input.provider === "claude") {
      // The core waiter by its exact id and generation first: a SuperGrok or
      // Claude waiter the cutover moved to the core keeps both, so a history
      // that recorded the legacy reference reconciles against the core
      // waiter.
      const core = await reconcileCoreCapacityWait(
        resolved,
        input.provider === "xai" ? XAI_CORE_WAIT_BINDING : CLAUDE_CORE_WAIT_BINDING,
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          waiterId: input.waiterId,
          generation: input.generation,
        },
      );
      return core ?? { action: "stale" };
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
