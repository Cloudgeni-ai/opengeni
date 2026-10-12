/** TEST ONLY: the exact pre-PR4 peek body from 8c43a921. Produces a real
 * pre-cutover activity result; the current activity must reconcile it after
 * 0689. Do not replace this with a synthetic waiter reference. */
import {
  getSubscriptionCoreCodexCapacityWaitForSession,
  subscriptionCoreCodexCapacityWaitRef,
  getXaiCapacityWaitForSession,
  getClaudeCapacityWaitForSession,
} from "@opengeni/db";
import { getCodexCapacityWaitForSession } from "../../../../../packages/db/test/fixtures/legacy-codex";
import type { ControlActivityServices, GetCodexCapacityWaitInput } from "../../../src/activities/types";

export function createHistoricalCodexCapacityPeek(services: () => Promise<ControlActivityServices>) {
  async function getCodexCapacityWait(input: GetCodexCapacityWaitInput) {
    const { db } = await services();
    const coreWaiter = await getSubscriptionCoreCodexCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    if (coreWaiter) return subscriptionCoreCodexCapacityWaitRef(coreWaiter);
    const codexWaiter = await getCodexCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const xaiWaiter = codexWaiter ? null : await getXaiCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const claudeWaiter = codexWaiter || xaiWaiter ? null : await getClaudeCapacityWaitForSession(db, input.workspaceId, input.sessionId);
    const waiter = codexWaiter ?? xaiWaiter ?? claudeWaiter;
    return waiter ? {
      ...(xaiWaiter ? { provider: "xai" as const } : claudeWaiter ? { provider: "claude" as const } : {}),
      waiterId: waiter.id,
      generation: waiter.generation,
      nextCheckAt: waiter.wakeRevision > waiter.observedWakeRevision ? new Date(0).toISOString() : waiter.nextCheckAt.toISOString(),
      wakeRevision: waiter.wakeRevision,
    } : null;
  }
  return { getCodexCapacityWait };
}
