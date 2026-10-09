/**
 * Failure, usage and quota bookkeeping for Codex turns placed by the shared
 * subscription core (M3 PR 1, inventory EP-T06..T08). Every write is scoped
 * to the exact accepted turn and its live lease, and is best effort: it can
 * never change how the turn itself settles.
 */
import type { CodexUsageHeaderSnapshot } from "@opengeni/codex";
import {
  applySubscriptionCoreCodexQuotaObservation,
  quarantineSubscriptionCoreCodexConnection,
  recordSubscriptionCoreCodexModelCooldown,
  recordSubscriptionCoreCodexQuotaObservation,
  recordSubscriptionCoreCodexTurnFailure,
  SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS,
  touchSubscriptionCoreCodexBinding,
  type Database,
  type SubscriptionCoreCodexLeaseRef,
} from "@opengeni/db";
import type { QuotaWindow, SubscriptionQuota } from "@opengeni/subscriptions";
import { codexCredentialCooldownUntil, type CodexCredentialFailure } from "./errors";
import type { CodexTurnLease } from "./credential-leases";
import type { CodexSubscriptionCoreTurn, ProviderTurnState } from "./turn-context";

/** Record a Codex model call that produced a response (diagnostic phase `completed`). */
export function observeCodexResponseCompletion(
  providerTurn: Pick<ProviderTurnState, "lastCodexResponseCompletedAt">,
  event: { phase: string },
  now: number = Date.now(),
): void {
  if (event.phase === "completed") providerTurn.lastCodexResponseCompletedAt = now;
}

/**
 * When the binding's cache clock may advance: only after a model call that
 * produced a response. A refused or failed call leaves no warm cache.
 */
export function coreCodexModelCallCompletedAt(
  providerTurn: Pick<ProviderTurnState, "lastCodexResponseCompletedAt">,
): Date | null {
  const at = providerTurn.lastCodexResponseCompletedAt;
  return typeof at === "number" && Number.isFinite(at) ? new Date(at) : null;
}

/** Same banding as the legacy usage cache projection (legacy-subscription-world). */
const NEAR_EXHAUSTION_PERCENT = 90;

function usageWindow(id: string, usedPercent: number, resetsAt: Date | null): QuotaWindow {
  return {
    id,
    usedPercent,
    resetsAt: resetsAt?.getTime() ?? null,
    status:
      usedPercent >= 100 ? "exhausted" : usedPercent >= NEAR_EXHAUSTION_PERCENT ? "warning" : "ok",
  };
}

/** Codex usage response headers as a shared quota observation (design 2.2). */
export function codexUsageHeadersQuotaObservation(
  snapshot: CodexUsageHeaderSnapshot,
  observedRefreshGeneration: number,
): SubscriptionQuota {
  return {
    windows: [
      usageWindow("primary", snapshot.primaryUsedPercent, snapshot.primaryResetAt),
      usageWindow("secondary", snapshot.secondaryUsedPercent, snapshot.secondaryResetAt),
    ],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 0,
    observedAt: snapshot.checkedAt.getTime(),
    observedRefreshGeneration,
    source: "response_headers",
  };
}

/** A Codex quota or rate-limit refusal as a shared quota observation. */
export function codexRefusalQuotaObservation(
  failure: CodexCredentialFailure,
  observedRefreshGeneration: number,
  now: Date,
): SubscriptionQuota | null {
  if (failure.kind !== "quota" && failure.kind !== "rate_limit") return null;
  const until = codexCredentialCooldownUntil(failure, null, now);
  return {
    windows: [],
    modelCooldowns: {},
    exhaustedUntil: until?.getTime() ?? null,
    exhaustedKind: failure.kind,
    revision: 0,
    observedAt: now.getTime(),
    observedRefreshGeneration,
    source: "refusal",
  };
}

function leaseRef(
  core: CodexSubscriptionCoreTurn,
  lease: Pick<CodexTurnLease, "holderId" | "generation">,
): SubscriptionCoreCodexLeaseRef | null {
  if (!lease.holderId || lease.generation === null) return null;
  return {
    connectionId: core.connectionId,
    holderId: lease.holderId,
    generation: lease.generation,
  };
}

/**
 * Record a definitive Codex refusal against the leased connection: always a
 * (turn, connection) failure receipt, which also counts toward the per-turn
 * failover bound, then the connection state that keeps placement away from
 * it (M3 PR 2a):
 *
 * - quota and rate limits: a quota observation fenced on the refresh
 *   generation the refused bearer carried (exhausted until the reset);
 * - a 401 that survived refresh: health `needs_relogin` (the refresh seam
 *   itself already marks a refused OAuth refresh);
 * - a 403 that survived refresh: a time-bound health quarantine;
 * - a plan-entitlement refusal: a cooldown of that model on the connection.
 *
 * Every write requires the exact accepted turn, the enabled gate and this
 * turn's live lease. `receipt` reports whether the refusal was recorded.
 */
export async function recordCoreCodexRefusal(input: {
  db: Database;
  core: CodexSubscriptionCoreTurn;
  lease: Pick<CodexTurnLease, "holderId" | "generation">;
  failure: CodexCredentialFailure;
  credentialVersion: number | null;
  /** The refused model; required to keep a plan-entitlement refusal model-scoped. */
  modelId?: string | null;
  now?: Date;
}): Promise<{ receipt: boolean; health: boolean }> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return { receipt: false, health: false };
  const now = input.now ?? new Date();
  const generation = input.credentialVersion ?? input.core.placedRefreshGeneration;
  const receipt = await recordSubscriptionCoreCodexTurnFailure(input.db, input.core.identity, ref, {
    kind: input.failure.kind,
    evidence: {
      refreshGeneration: generation,
      cooldownSeconds: input.failure.cooldownSeconds,
      ...(input.failure.origin ? { origin: input.failure.origin } : {}),
    },
  }).catch(() => false);
  let health = false;
  try {
    switch (input.failure.kind) {
      case "quota":
      case "rate_limit": {
        const observation = codexRefusalQuotaObservation(input.failure, generation, now);
        health = observation
          ? await recordSubscriptionCoreCodexQuotaObservation(
              input.db,
              input.core.identity,
              ref,
              observation,
            )
          : false;
        break;
      }
      case "auth":
      case "forbidden":
        health = await quarantineSubscriptionCoreCodexConnection(
          input.db,
          input.core.identity,
          ref,
          {
            kind: input.failure.kind === "auth" ? "sign_in" : "forbidden",
            refreshGeneration: generation,
            now,
          },
        );
        break;
      case "plan_entitlement":
        health = input.modelId
          ? await recordSubscriptionCoreCodexModelCooldown(input.db, input.core.identity, ref, {
              modelId: input.modelId,
              until: new Date(now.getTime() + SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS),
              refreshGeneration: generation,
            })
          : false;
        break;
    }
  } catch {
    health = false;
  }
  return { receipt, health };
}

/**
 * Finalization for a core turn: the latest usage headers become a quota
 * observation on the leased connection, and a completed model call moves
 * the binding's cache-warmth clock. Both run before the lease is released.
 * `capacityRecovered` reports an observation that ended a stored exhaustion,
 * which the caller turns into a wake for the account's waiters.
 */
export async function finalizeCoreCodexUsage(input: {
  db: Database;
  core: CodexSubscriptionCoreTurn;
  lease: Pick<CodexTurnLease, "holderId" | "generation">;
  usage: CodexUsageHeaderSnapshot | null;
  credentialVersion: number | null;
  modelCallCompletedAt: Date | null;
}): Promise<{ capacityRecovered: boolean }> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return { capacityRecovered: false };
  let capacityRecovered = false;
  const writes: Promise<unknown>[] = [];
  if (input.usage && input.credentialVersion !== null) {
    writes.push(
      applySubscriptionCoreCodexQuotaObservation(
        input.db,
        input.core.identity,
        ref,
        codexUsageHeadersQuotaObservation(input.usage, input.credentialVersion),
      ).then((applied) => {
        capacityRecovered = applied.recovered;
      }),
    );
  }
  if (input.modelCallCompletedAt) {
    writes.push(
      touchSubscriptionCoreCodexBinding(
        input.db,
        input.core.identity,
        ref,
        input.modelCallCompletedAt,
      ),
    );
  }
  await Promise.allSettled(writes);
  return { capacityRecovered };
}
