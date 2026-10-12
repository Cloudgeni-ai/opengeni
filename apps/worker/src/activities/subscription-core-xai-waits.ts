/**
 * SuperGrok's binding of the provider-neutral core waits (SuperGrok track
 * X1b). The only SuperGrok waits: the drained cutover moved every legacy
 * waiter onto the core with its id and generation, and the workflow reaches
 * this binding only for a waiter the core holds.
 */
import {
  armSubscriptionCoreCapacityWait,
  getSubscriptionCoreCapacityWaitById,
  readSubscriptionCoreTurnModel,
  reconcileSubscriptionCoreCapacityWait,
  SUBSCRIPTION_CORE_XAI,
  subscriptionCoreTurns,
  wakeSubscriptionCoreProviderCapacityWaiters,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import type { CoreWaitBinding } from "./subscription-core-codex-waits";

const XAI = SUBSCRIPTION_CORE_XAI as SubscriptionCoreProvider;

export const XAI_CORE_WAIT_BINDING: CoreWaitBinding = {
  provider: "xai",
  arm: (db, input) => armSubscriptionCoreCapacityWait(db, "xai", input),
  getWaiterById: async (db, input) => {
    const waiter = await getSubscriptionCoreCapacityWaitById(db, input);
    return waiter?.provider === "xai" ? waiter : null;
  },
  readTurnModel: (db, input) => readSubscriptionCoreTurnModel(db, input),
  recoverHealth: (db, identity) =>
    subscriptionCoreTurns(XAI).recoverSubscriptionCoreConnectionHealth(db, identity),
  evaluatePlacement: (db, request) =>
    subscriptionCoreTurns(XAI).evaluateSubscriptionCorePlacement(db, request),
  wakeWaiters: (db, input) => wakeSubscriptionCoreProviderCapacityWaiters(db, "xai", input),
  reconcileWaiter: (db, input) =>
    reconcileSubscriptionCoreCapacityWait(db, { ...input, provider: "xai" }),
};
