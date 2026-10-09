/**
 * Failure, usage and quota bookkeeping for Codex turns placed by the shared
 * subscription core (M3 PR 1, inventory EP-T06..T08). Every write is scoped
 * to the exact accepted turn and its live lease, and is best effort: it can
 * never change how the turn itself settles.
 */
import type { CodexUsageHeaderSnapshot } from "@opengeni/codex";
import {
  recordSubscriptionCoreCodexQuotaObservation,
  recordSubscriptionCoreCodexTurnFailure,
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
 * Record a definitive Codex refusal against the leased connection: a
 * (turn, connection) failure receipt, and for quota and rate limits a quota
 * observation fenced on the refresh generation the refused bearer carried.
 * Health changes for revoked sign-ins are written by the refresh seam itself.
 */
export async function recordCoreCodexRefusal(input: {
  db: Database;
  core: CodexSubscriptionCoreTurn;
  lease: Pick<CodexTurnLease, "holderId" | "generation">;
  failure: CodexCredentialFailure;
  credentialVersion: number | null;
  now?: Date;
}): Promise<void> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return;
  const generation = input.credentialVersion ?? input.core.placedRefreshGeneration;
  const observation = codexRefusalQuotaObservation(
    input.failure,
    generation,
    input.now ?? new Date(),
  );
  await Promise.allSettled([
    recordSubscriptionCoreCodexTurnFailure(input.db, input.core.identity, ref, {
      kind: input.failure.kind,
      evidence: {
        refreshGeneration: generation,
        cooldownSeconds: input.failure.cooldownSeconds,
      },
    }),
    ...(observation
      ? [
          recordSubscriptionCoreCodexQuotaObservation(
            input.db,
            input.core.identity,
            ref,
            observation,
          ),
        ]
      : []),
  ]);
}

/**
 * Finalization for a core turn: the latest usage headers become a quota
 * observation on the leased connection, and a completed model call moves
 * the binding's cache-warmth clock. Both run before the lease is released.
 */
export async function finalizeCoreCodexUsage(input: {
  db: Database;
  core: CodexSubscriptionCoreTurn;
  lease: Pick<CodexTurnLease, "holderId" | "generation">;
  usage: CodexUsageHeaderSnapshot | null;
  credentialVersion: number | null;
  modelCallCompletedAt: Date | null;
}): Promise<void> {
  const ref = leaseRef(input.core, input.lease);
  if (!ref) return;
  const writes: Promise<unknown>[] = [];
  if (input.usage && input.credentialVersion !== null) {
    writes.push(
      recordSubscriptionCoreCodexQuotaObservation(
        input.db,
        input.core.identity,
        ref,
        codexUsageHeadersQuotaObservation(input.usage, input.credentialVersion),
      ),
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
}
