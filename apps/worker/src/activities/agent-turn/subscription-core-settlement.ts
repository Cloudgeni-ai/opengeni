/**
 * Refusal settlement and finalization for a chat turn on the shared
 * subscription core, for any provider whose errors classify into shared
 * outcomes (SuperGrok track X1b; the Claude track binds the same steps).
 * Every write is scoped to the exact accepted turn and its live lease, and
 * the bookkeeping is best effort: it never changes how the turn settles by
 * itself. Codex keeps its own M3 step (`codex-core-settlement.ts` and the
 * Codex branch of `failure-settlement.ts`), whose refusal kinds predate the
 * shared outcomes.
 */
import {
  SubscriptionCoreError,
  subscriptionCoreSettlement,
  subscriptionCoreTurns,
  type Database,
  type SubscriptionCoreProvider,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { planSubscriptionCoreRefusal, type ProviderErrorOutcome } from "@opengeni/subscriptions";
import type { RunAgentTurnResult } from "../types";
import {
  subscriptionCoreAccountRefusedFailure,
  type SubscriptionCoreCodexTurnError,
} from "./codex-core-errors";
import type { CoreSubscriptionTurnLease } from "./credential-leases";
import type { TurnFailureDeps } from "./failure-settlement";
import {
  failOverCoreSubscriptionTurn,
  type CoreFailoverBinding,
} from "./subscription-core-failover";
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
 * sign-in or forbidden quarantine). Whether the credential renews and was
 * already refreshed before the refusal comes from the provider's binding.
 * `receipt` reports whether the refusal was recorded.
 */
export async function recordCoreSubscriptionRefusal(input: {
  db: Database;
  provider: SubscriptionCoreProvider;
  core: SubscriptionCoreTurn;
  lease: LeaseFence;
  outcome: ProviderErrorOutcome;
  /** How the provider's transport treats the refused credential (`CoreRefusalBinding.credential`). */
  credential: CoreRefusalCredential;
  now?: Date;
}): Promise<{ receipt: boolean; health: boolean }> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return { receipt: false, health: false };
  const now = (input.now ?? new Date()).getTime();
  const refreshGeneration = coreRequestRefreshGeneration(input.core);
  const plan = planSubscriptionCoreRefusal(input.provider.adapter, input.outcome, {
    now,
    refreshGeneration,
    renewable: input.credential.renewable,
    refreshed: input.credential.refreshedBeforeRefusal,
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

/** One provider's refusal settlement inputs. */
/**
 * How a provider's transport treats a refused credential: whether it renews,
 * and whether an unauthorized request was already refreshed and retried once
 * before the refusal reached settlement.
 */
export type CoreRefusalCredential = { renewable: boolean; refreshedBeforeRefusal: boolean };

export type CoreRefusalBinding = {
  provider: SubscriptionCoreProvider;
  displayName: string;
  credential: CoreRefusalCredential;
  /** The provider's classification of a failed model request (null: not a refusal). */
  classify: (error: unknown) => ProviderErrorOutcome | null;
  lease: (deps: TurnFailureDeps) => CoreSubscriptionTurnLease;
  isSourceDisconnected: (
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    connectionId: string,
  ) => Promise<boolean>;
  failover: CoreFailoverBinding;
};

function causeHasCoreCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof SubscriptionCoreError && current.code === code) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Failure settlement of a core turn's definitive refusal: the provider's
 * classification becomes a shared outcome, the refusal is recorded against
 * the leased connection, and the same turn re-places within the per-turn
 * bound (another account, or a durable wait). A graceful source disconnect
 * re-places without a refusal. Returns the settled result, or the typed
 * terminal failure when automatic re-placement was not possible (null: not
 * an account refusal, so the generic failure path settles the turn). The
 * caller runs this only when no request outcome is unknown and the lease
 * was not lost.
 */
export async function settleCoreSubscriptionRefusal(
  deps: TurnFailureDeps,
  core: SubscriptionCoreTurn,
  binding: CoreRefusalBinding,
): Promise<{ result: RunAgentTurnResult | null; failure: SubscriptionCoreCodexTurnError | null }> {
  const { error, db, eventing, attempt } = deps;
  const outcome = binding.classify(error);
  // Only a pre-dispatch lifecycle fence or a definite refusal can enter
  // graceful recovery; a concurrent disconnect never upgrades an ambiguous
  // failure into replay proof.
  const disconnected =
    causeHasCoreCode(error, "subscription_core_source_disconnected") ||
    (!!outcome &&
      (await binding
        .isSourceDisconnected(db, core.identity, core.connectionId)
        .catch(() => false)));
  if (disconnected) {
    const settled = await failOverCoreSubscriptionTurn(
      deps,
      core,
      "source_disconnected",
      binding.failover,
    );
    if (settled) return { result: settled, failure: null };
  } else if (outcome) {
    const recorded = await recordCoreSubscriptionRefusal({
      db,
      provider: binding.provider,
      core,
      lease: binding.lease(deps),
      outcome,
      credential: binding.credential,
    });
    if (recorded.receipt && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
      const settled = await failOverCoreSubscriptionTurn(
        deps,
        core,
        { kind: outcome.kind, unbounded: false },
        binding.failover,
      );
      if (settled) return { result: settled, failure: null };
    }
  }
  const refusal =
    disconnected || causeHasCoreCode(error, "subscription_core_access_lost")
      ? "access_lost"
      : outcome?.kind === "unauthorized"
        ? "sign_in"
        : outcome?.kind === "forbidden"
          ? "forbidden"
          : null;
  return {
    result: null,
    failure: refusal ? subscriptionCoreAccountRefusedFailure(refusal, binding.displayName) : null,
  };
}

/**
 * Finalization of a core turn before its lease is released: a completed
 * model call of the conversation lane moves the binding's cache clock (a
 * session-title request has another prompt prefix and warms no conversation
 * cache, as for Codex). No per-turn quota call runs on the core path: quota
 * is observed on refusal and by the out-of-turn probe.
 */
export async function finalizeCoreSubscriptionTurn(input: {
  db: Database;
  provider: SubscriptionCoreProvider;
  core: SubscriptionCoreTurn;
  lease: LeaseFence;
}): Promise<void> {
  const at = input.core.requests?.lastResponseReceivedAt() ?? null;
  await touchCoreSubscriptionBinding({ ...input, modelCallCompletedAt: at });
}
