/**
 * In-turn re-placement after a definitive refusal on a chat turn placed by
 * the shared subscription core, for any provider (generalized from the M3
 * Codex failover, PR 2a; Codex binds it in `codex-core-failover.ts` under
 * the names it shipped).
 *
 * The refusal was already recorded against the leased connection (failure
 * receipt plus the state that keeps placement away from it). After a durable
 * checkpoint the same accepted turn is recovered with a new attempt, whose
 * placement chooses again under the core rules: another eligible account, or
 * a durable wait when nothing can serve it. An explicit choice never fails
 * over: its placement waits on the chosen account. The per-turn bound counts
 * every refusal of the turn, by any account, so a turn cannot alternate
 * between failing accounts forever; the refusal that reaches the bound fails
 * the turn with typed copy and leaves the session usable.
 */
import {
  requestSessionTurnRecovery,
  type Database,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import type { RunAgentTurnResult } from "../types";
import { subscriptionCoreFailoverExhaustedFailure } from "./codex-core-errors";
import type { CoreSubscriptionTurnLease } from "./credential-leases";
import type { TurnFailureDeps } from "./failure-settlement";
import type { SubscriptionCoreTurn } from "./turn-context";

/** One provider's failover inputs. */
export type CoreFailoverBinding = {
  displayName: string;
  lease: (deps: TurnFailureDeps) => CoreSubscriptionTurnLease;
  countRefusals: (db: Database, identity: SubscriptionCoreTurnIdentity) => Promise<number | null>;
  /** Refusals one turn may take before it stops. */
  refusalLimit: number;
  /** The in-turn recovery's reason and its detail's provider label. */
  recoveryReason: string;
  recoveryProvider: string;
  metrics: {
    checkpoints: { name: string; help: string };
    settlements: { name: string; help: string };
    labels: (deps: TurnFailureDeps) => Record<string, string>;
  };
};

/** A recorded refusal (`unbounded`: it does not count toward the bound), or a graceful disconnect. */
export type CoreFailoverRefusal = { kind: string; unbounded: boolean } | "source_disconnected";

/**
 * Refusals one turn may take before it stops: at most three in-turn switches
 * (the contract and design require a bound but do not fix it; this is the
 * small fixed bound chosen for M3, see design 5.1.1 "PR 2a").
 */
export const SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT = 4;

/** Pure bound: fail over while under the limit, stop at it. */
export function coreFailoverDisposition(
  refusals: number | null,
  limit: number,
): "failover" | "exhausted" | "unrecorded" {
  if (refusals === null || !Number.isSafeInteger(refusals) || refusals < 1) return "unrecorded";
  return refusals >= limit ? "exhausted" : "failover";
}

/**
 * Re-place the same turn after graceful source disappearance, without a
 * refusal budget, or settle a recorded refusal within its bound. Returns
 * null when automatic replay is unsafe (the checkpoint did not become
 * durable, or the bound could not be read): the caller then fails the turn
 * with its typed copy instead.
 */
export async function failOverCoreSubscriptionTurn(
  deps: TurnFailureDeps,
  core: SubscriptionCoreTurn,
  refusal: CoreFailoverRefusal,
  binding: CoreFailoverBinding,
): Promise<RunAgentTurnResult | null> {
  const {
    error,
    input,
    db,
    bus,
    settings,
    observability,
    wakeSessionWorkflow,
    control,
    attempt,
    eventing,
    historySink,
    claimedResult,
    flushRuntimeBatcher,
    acknowledgeLostAttemptOwnership,
    acknowledgeRecoveryQuiescence,
  } = deps;
  const turnId = attempt.turnId;
  if (!turnId || !attempt.triggerEventId || !eventing.publish || !eventing.settle) return null;
  try {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    await core.requests?.checkpoint();
  } catch {
    observability.incrementCounter({
      ...binding.metrics.checkpoints,
      labels: { ...binding.metrics.labels(deps), outcome: "failed" },
    });
    return null;
  }
  // Logical disconnect/lease loss never proves an outstanding fetch quiescent.
  // The tool-less session-title request is cancelled and joined before
  // settlement and never enters history, so it does not fence failover.
  if (core.requests && !core.requests.canRecover()) return null;
  const disconnected = refusal === "source_disconnected";
  const refusals = disconnected
    ? null
    : await binding.countRefusals(db, core.identity).catch(() => null);
  const disposition =
    disconnected || refusal.unbounded
      ? "failover"
      : coreFailoverDisposition(refusals, binding.refusalLimit);
  observability.incrementCounter({
    ...binding.metrics.settlements,
    labels: { ...binding.metrics.labels(deps), outcome: `core_${disposition}` },
  });
  if (disposition === "unrecorded") return null;

  // The next placement must not wait for this attempt's lease to expire.
  const lease = binding.lease(deps);
  lease.stopHeartbeat();
  await lease.releaseCurrent().catch(() => false);
  lease.held = false;

  if (disposition === "exhausted") {
    const failure = subscriptionCoreFailoverExhaustedFailure(
      refusals!,
      binding.refusalLimit,
      binding.displayName,
    );
    if (
      !(await eventing.settle({
        events: [
          {
            type: "turn.failed",
            payload: { ...failure.payload, recovery: "user_message" },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "failed",
        sessionStatus: "idle",
        activeTurnId: null,
      }))
    ) {
      return claimedResult({ status: "cancelled" });
    }
    control.turnMetricOutcome = "failed";
    control.activityStatus = "idle";
    control.activityError = error;
    await deliverFailedChildTurnToParent(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      turnId,
    );
    return claimedResult({ status: "idle" });
  }

  const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
    sessionId: input.sessionId,
    turnId,
    triggerEventId: attempt.triggerEventId,
    attemptId: input.attemptId,
    reason: binding.recoveryReason,
    detail: {
      provider: binding.recoveryProvider,
      credentialId: core.connectionId,
      failureKind: disconnected ? "source_disconnected" : refusal.kind,
      // The legacy detail shape counts switches: refusal n (below the
      // bound) starts switch n of at most limit - 1. The exhausted failure
      // reports the refusals themselves (refusals / maxRefusals).
      ...(disconnected ? {} : { failoverCount: refusals, maxFailovers: binding.refusalLimit - 1 }),
    },
  });
  if (recovery.action === "stale") {
    acknowledgeLostAttemptOwnership();
    control.activityStatus = "cancelled";
    control.turnMetricOutcome = "cancelled";
    return claimedResult({ status: "cancelled" });
  }
  acknowledgeRecoveryQuiescence();
  await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
  control.activityStatus = "recovering";
  control.turnMetricOutcome = "recovering";
  control.activityError = error;
  return claimedResult({ status: "recovering" });
}
