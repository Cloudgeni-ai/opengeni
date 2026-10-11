/**
 * Refusal and finalization bookkeeping for a chat turn on the shared
 * subscription core, for any provider whose adapter classifies its errors
 * into shared outcomes (SuperGrok track X1b). Every write is scoped to the
 * exact accepted turn and its live lease, and is best effort: it can never
 * change how the turn itself settles. Codex keeps its own M3 step
 * (`codex-core-settlement.ts`), whose refusal kinds predate the shared
 * outcomes.
 */
import {
  subscriptionCoreSettlement,
  subscriptionCoreTurns,
  type Database,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import { planSubscriptionCoreRefusal, type ProviderErrorOutcome } from "@opengeni/subscriptions";
import type { CoreSubscriptionTurnLease } from "./credential-leases";
import type { SubscriptionCoreTurn } from "./turn-context";

type LeaseFence = Pick<CoreSubscriptionTurnLease, "holderId" | "generation">;

function leaseRef(core: SubscriptionCoreTurn, lease: LeaseFence) {
  if (!lease.holderId || lease.generation === null) return null;
  return {
    connectionId: core.connectionId,
    holderId: lease.holderId,
    generation: lease.generation,
  };
}

/** The refresh generation the turn's latest request carried. */
export function coreRequestRefreshGeneration(core: SubscriptionCoreTurn): number {
  return core.credentialVersion ?? core.placedRefreshGeneration;
}

/**
 * Record a definitive refusal against the leased connection through the
 * shared plan (`planSubscriptionCoreRefusal`): the (turn, connection)
 * failure receipt, which counts toward the per-turn failover bound, then the
 * health state that keeps placement away (a quota observation fenced on the
 * refresh generation the refused bearer carried, a model cooldown, or a
 * sign-in or forbidden quarantine). The transport already refreshed and
 * retried an unauthorized request once, so the refusal is settled as is.
 * `receipt` reports whether the refusal was recorded.
 */
export async function recordCoreSubscriptionRefusal(input: {
  db: Database;
  provider: SubscriptionCoreProvider;
  core: SubscriptionCoreTurn;
  lease: LeaseFence;
  outcome: ProviderErrorOutcome;
  now?: Date;
}): Promise<{ receipt: boolean; health: boolean }> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return { receipt: false, health: false };
  const now = (input.now ?? new Date()).getTime();
  const refreshGeneration = coreRequestRefreshGeneration(input.core);
  const plan = planSubscriptionCoreRefusal(input.provider.adapter, input.outcome, {
    now,
    refreshGeneration,
    renewable: true,
    refreshed: true,
  });
  if (plan.kind !== "settle") return { receipt: false, health: false };
  return await subscriptionCoreSettlement(input.provider)
    .applySubscriptionCoreRefusal(input.db, input.core.identity, ref, plan, {
      refreshGeneration,
      now,
    })
    .catch(() => ({ receipt: false, health: false }));
}

/**
 * Finalization for a core turn before its lease is released: a completed
 * model call moves the binding's cache-warmth clock. A refused or failed
 * call leaves no warm cache.
 */
export async function touchCoreSubscriptionBinding(input: {
  db: Database;
  provider: SubscriptionCoreProvider;
  core: SubscriptionCoreTurn;
  lease: LeaseFence;
  modelCallCompletedAt: Date | null;
}): Promise<void> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref || !input.modelCallCompletedAt) return;
  await subscriptionCoreTurns(input.provider)
    .touchSubscriptionCoreBinding(input.db, input.core.identity, ref, input.modelCallCompletedAt)
    .catch(() => false);
}
