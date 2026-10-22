/**
 * Claude's binding of the provider-neutral core waits (Claude track C1b).
 * The workflow reaches it only for a waiter the core holds.
 */
import {
  armSubscriptionCoreCapacityWait,
  getSubscriptionCoreCapacityWaitById,
  readSubscriptionCoreTurnModel,
  reconcileSubscriptionCoreCapacityWait,
  SUBSCRIPTION_CORE_CLAUDE,
  subscriptionCoreTurns,
  wakeSubscriptionCoreProviderCapacityWaiters,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import type { CoreWaitBinding } from "./subscription-core-codex-waits";
import { refreshBlockedCoreQuotaBeforeReconcile } from "./subscription-core-usage-recheck";

const CLAUDE = SUBSCRIPTION_CORE_CLAUDE as SubscriptionCoreProvider;

export const CLAUDE_CORE_WAIT_BINDING: CoreWaitBinding = {
  provider: "claude",
  arm: (db, input) => armSubscriptionCoreCapacityWait(db, "claude", input),
  getWaiterById: async (db, input) => {
    const waiter = await getSubscriptionCoreCapacityWaitById(db, input);
    return waiter?.provider === "claude" ? waiter : null;
  },
  readTurnModel: (db, input) => readSubscriptionCoreTurnModel(db, input),
  recoverHealth: (db, identity) =>
    subscriptionCoreTurns(CLAUDE).recoverSubscriptionCoreConnectionHealth(db, identity),
  evaluatePlacement: (db, request) =>
    subscriptionCoreTurns(CLAUDE).evaluateSubscriptionCorePlacement(db, request),
  wakeWaiters: (db, input) => wakeSubscriptionCoreProviderCapacityWaiters(db, "claude", input),
  reconcileWaiter: (db, input) =>
    reconcileSubscriptionCoreCapacityWait(db, { ...input, provider: "claude" }),
  // Anthropic can reset a plan limit before the reset a refused request
  // reported, so a parked turn re-reads the Claude usage endpoint
  // (rate-limited per connection and per probe scope) at each bounded
  // recheck instead of sleeping until a stale reset: the shared pool, and the
  // personal connections its exact accepted identity authorizes.
  refreshBeforeReconcile: ({ db, settings }, turn) =>
    refreshBlockedCoreQuotaBeforeReconcile({
      provider: CLAUDE,
      db,
      settings,
      accountId: turn.accountId,
      workspaceId: turn.workspaceId,
      personalTurn: turn,
    }),
};
