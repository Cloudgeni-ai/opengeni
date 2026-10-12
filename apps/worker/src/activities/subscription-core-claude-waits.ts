/**
 * Claude's binding of the provider-neutral core waits (Claude track C1b).
 * Dormant: the Claude binding is unregistered until the drained cutover
 * (C3), so every entry point here fails closed until then, and the workflow
 * reaches it only for a waiter the core holds.
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
};
