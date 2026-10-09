/**
 * Durable capacity waits and wakes for Codex chat turns on the shared
 * subscription core (M3 PR 2a, inventory EP-T09/T10). Reached only for an
 * account whose Codex cutover row is enabled; the legacy Codex waiter path is
 * untouched. Workflow activity names, signal names and argument shapes stay
 * those of the legacy Codex wait: the activities look a waiter id up in the
 * core table first and fall back to the legacy table.
 */
import {
  abandonSubscriptionCapacityWakeDelivery,
  claimSubscriptionCapacityWakeDeliveries,
  evaluateSubscriptionCoreCodexPlacement,
  getSubscriptionCoreCodexCapacityWaitById,
  markSubscriptionCapacityWakeDelivered,
  readSubscriptionCoreCodexTurnModel,
  readSubscriptionCoreTurnIdentity,
  reconcileSubscriptionCoreCodexCapacityWait,
  recoverSubscriptionCoreCodexConnectionHealth,
  retrySubscriptionCapacityWakeDelivery,
  subscriptionCoreCodexCapacityWaitRef,
  wakeSubscriptionCoreCodexCapacityWaiters,
  withSubscriptionCapacityWakeOutboxScope,
  type Database,
  type SubscriptionCoreCodexWaitEvaluation,
  type SubscriptionCoreCodexWakeScope,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import type { CodexCapacityWaitRef, SignalCodexCapacityWorkflow } from "./types";
import { workflowIdForSession } from "./common";

/** Typed wake signal attempts before the outbox gives the fast path up. */
export const CORE_CODEX_WAKE_DELIVERY_MAX_ATTEMPTS = 8;
const CORE_CODEX_WAKE_DELIVERY_BATCH = 100;
const CORE_CODEX_WAKE_CLAIM_TTL_MS = 60_000;

/** Exponential retry for one typed wake signal: 1 s doubling to 5 minutes. */
export function coreCodexWakeRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 16));
  return Math.min(1_000 * 2 ** exponent, 5 * 60_000);
}

export type CoreCodexWakeServices = {
  db: Database;
  signalCodexCapacityWorkflow?: SignalCodexCapacityWorkflow | null | undefined;
};

export type CoreCodexWakeDeliveryResult = {
  claimed: number;
  delivered: number;
  retried: number;
  abandoned: number;
};

/**
 * Drain one workspace's due typed wake obligations: claim (fenced by claim
 * generation), signal `codexCapacityChanged` with the waiter's wake revision,
 * then mark delivered; a failed signal is retried with bounded backoff and
 * given up after a fixed number of attempts. Idempotent across a crash
 * between the database wake and the signal: an unacknowledged claim becomes
 * due again when its claim expires, and the generic session workflow wake
 * committed with the same database wake still reaches the workflow.
 */
export async function deliverSubscriptionCoreCodexWakes(
  services: CoreCodexWakeServices,
  scope: SubscriptionCoreCodexWakeScope,
): Promise<CoreCodexWakeDeliveryResult> {
  const result: CoreCodexWakeDeliveryResult = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    abandoned: 0,
  };
  const signal = services.signalCodexCapacityWorkflow;
  // A host without a typed signaler claims nothing: the rows stay pending for
  // a worker that can signal (the generic durable wake committed with each
  // row still reaches the workflow meanwhile).
  if (!signal) return result;
  const deliveries = await withSubscriptionCapacityWakeOutboxScope(services.db, scope, (tx) =>
    claimSubscriptionCapacityWakeDeliveries(tx, {
      limit: CORE_CODEX_WAKE_DELIVERY_BATCH,
      claimTtlMs: CORE_CODEX_WAKE_CLAIM_TTL_MS,
    }),
  );
  result.claimed = deliveries.length;
  for (const delivery of deliveries) {
    try {
      await signal({
        accountId: delivery.accountId,
        workspaceId: delivery.workspaceId,
        sessionId: delivery.sessionId,
        workflowId: workflowIdForSession(delivery.sessionId),
        wakeRevision: delivery.wakeRevision,
      });
      await withSubscriptionCapacityWakeOutboxScope(services.db, scope, (tx) =>
        markSubscriptionCapacityWakeDelivered(tx, delivery),
      );
      result.delivered += 1;
    } catch {
      const exhausted = delivery.attemptCount >= CORE_CODEX_WAKE_DELIVERY_MAX_ATTEMPTS;
      await withSubscriptionCapacityWakeOutboxScope(services.db, scope, (tx) =>
        exhausted
          ? abandonSubscriptionCapacityWakeDelivery(tx, {
              id: delivery.id,
              claimGeneration: delivery.claimGeneration,
              failureCode: "signal_attempts_exhausted",
            })
          : retrySubscriptionCapacityWakeDelivery(tx, {
              id: delivery.id,
              claimGeneration: delivery.claimGeneration,
              retryInMs: coreCodexWakeRetryDelayMs(delivery.attemptCount),
              failureCode: "signal_failed",
            }),
      ).catch(() => false);
      if (exhausted) result.abandoned += 1;
      else result.retried += 1;
    }
  }
  return result;
}

/**
 * A capacity change for the account's Codex pool: wake every waiting core
 * waiter (database first, outbox and generic wake in the same commit), then
 * deliver the typed signals. Best effort after the commit; never throws.
 */
export async function wakeSubscriptionCoreCodexWaitersAndDeliver(
  services: CoreCodexWakeServices,
  input: { accountId: string; reason: string; workspaceIds?: readonly string[] },
): Promise<SubscriptionCoreCodexWakeScope[]> {
  let scopes: SubscriptionCoreCodexWakeScope[] = [];
  try {
    scopes = await wakeSubscriptionCoreCodexCapacityWaiters(services.db, input);
  } catch {
    return [];
  }
  await Promise.allSettled(
    scopes.map((scope) => deliverSubscriptionCoreCodexWakes(services, scope)),
  );
  return scopes;
}

/**
 * What core placement says about a blocked turn now: run, wait (with its
 * reason, earliest reset and quarantine end), revoked (the exact accepted
 * turn no longer authorizes core use) or paused (the cutover is switched off;
 * the work stays parked). Due quarantines are returned to service first, and
 * a recovery wakes the account's other waiters.
 */
export async function evaluateCoreCodexBlockedTurn(
  services: CoreCodexWakeServices,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<SubscriptionCoreCodexWaitEvaluation> {
  const identity = await readSubscriptionCoreTurnIdentity(services.db, input);
  if (!identity) return { kind: "revoked" };
  const model = await readSubscriptionCoreCodexTurnModel(services.db, input);
  if (!model) return { kind: "revoked" };
  await recoverCoreCodexHealthAndWake(services, identity);
  const evaluation = await evaluateSubscriptionCoreCodexPlacement(services.db, {
    identity,
    productModelId: model.productModelId,
    reasoningLevel: model.reasoningLevel,
  });
  switch (evaluation.kind) {
    case "not_visible":
      return { kind: "revoked" };
    case "cutover_not_enabled":
      return { kind: "paused" };
    case "run":
      return { kind: "run" };
    case "wait":
      return {
        kind: "wait",
        waitReason: evaluation.reason,
        earliestResetAt: evaluation.earliestResetAt,
        healthRetryAt: evaluation.healthRetryAt,
      };
  }
}

/** Return due quarantines to service under this accepted turn; wake others if any recovered. */
export async function recoverCoreCodexHealthAndWake(
  services: CoreCodexWakeServices,
  identity: SubscriptionCoreTurnIdentity,
): Promise<number> {
  const recovered = await recoverSubscriptionCoreCodexConnectionHealth(services.db, identity).catch(
    () => 0,
  );
  if (recovered > 0) {
    await wakeSubscriptionCoreCodexWaitersAndDeliver(services, {
      accountId: identity.accountId,
      reason: "connection_health_recovered",
    });
  }
  return recovered;
}

export type CoreCodexReconcileResult =
  | ({ action: "waiting" } & CodexCapacityWaitRef)
  | { action: "resumed" | "paused" | "superseded" | "stale" };

/**
 * Reconcile one core waiter for the workflow (timer, signal, queue wake or
 * recovery). Returns null when the waiter id is not a core waiter, so the
 * caller falls back to the legacy Codex waiter with the same reference.
 */
export async function reconcileCoreCodexCapacityWait(
  services: CoreCodexWakeServices & { bus: EventBus },
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    waiterId: string;
    generation: number;
  },
): Promise<CoreCodexReconcileResult | null> {
  const waiter = await getSubscriptionCoreCodexCapacityWaitById(services.db, input);
  if (!waiter) return null;
  // Repair: drain this workspace's typed wakes that a crash left behind.
  await deliverSubscriptionCoreCodexWakes(services, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  }).catch(() => undefined);
  if (waiter.accountId !== input.accountId || waiter.generation !== input.generation) {
    return { action: "stale" };
  }
  // A row left behind by a Steer, Cancel or other transition is superseded by
  // the reconcile without placing (a non-run evaluation never resumes).
  const evaluation: SubscriptionCoreCodexWaitEvaluation =
    waiter.blockedTurnLive === false
      ? { kind: "paused" }
      : await evaluateCoreCodexBlockedTurn(services, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: waiter.blockedTurnId,
        });
  const result = await reconcileSubscriptionCoreCodexCapacityWait(services.db, {
    ...input,
    evaluatedWakeRevision: waiter.wakeRevision,
    evaluation,
  });
  await publishDurableSessionEvents(
    services.bus,
    input.workspaceId,
    input.sessionId,
    result.events,
  );
  if (result.action === "waiting") {
    return { action: "waiting", ...subscriptionCoreCodexCapacityWaitRef(result.waiter) };
  }
  return { action: result.action };
}
