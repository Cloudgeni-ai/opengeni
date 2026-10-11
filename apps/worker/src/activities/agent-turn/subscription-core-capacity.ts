/**
 * Chat-turn placement on the shared subscription core, for any provider
 * (generalized from the M3 Codex placement, inventory EP-T01..T05). A
 * provider supplies a `CoreTurnPlacementProvider`: its database runtimes and
 * the few genuinely provider-specific steps (Codex refreshes plan
 * entitlements before placement and records a selection receipt). Nothing
 * here names a provider.
 */
import { getSessionGoal, subscriptionCoreTurnActor } from "@opengeni/db";
import type {
  Database,
  SubscriptionCorePlacement,
  SubscriptionCorePlacementRequest,
  SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { readSubscriptionCoreTurnIdentity } from "@opengeni/db";
import { recordTurnStartupPhase } from "../../observability-metrics";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import {
  subscriptionCoreCapacityFailure,
  subscriptionCoreCutoverDisabledFailure,
  subscriptionCoreLeaseBusyFailure,
} from "./codex-core-errors";
import type { CoreSubscriptionTurnLease } from "./credential-leases";
import type { SubscriptionCoreTurn } from "./turn-context";

type WaitPlacement = Extract<SubscriptionCorePlacement, { kind: "wait" }>;
type RunPlacement = Extract<SubscriptionCorePlacement, { kind: "run" }>;

/** One provider's chat placement on the core, as the worker uses it. */
export type CoreTurnPlacementProvider = {
  /** The provider id on the core. */
  id: string;
  /** The provider's name in failure copy. */
  displayName: string;
  /** The startup-phase metric's provider label. */
  startupPhaseProvider: string;
  leaseTtlMs: number;
  /** The turn's lease for this provider. */
  lease: (deps: CapacityPhaseDeps) => CoreSubscriptionTurnLease;
  place: (
    db: Database,
    request: SubscriptionCorePlacementRequest,
  ) => Promise<SubscriptionCorePlacement>;
  /** Quarantines that ran out return to service before placement reads the world. */
  recoverHealth: (deps: CapacityPhaseDeps, identity: SubscriptionCoreTurnIdentity) => Promise<void>;
  /** A provider-specific read before placement (Codex: plan entitlements). */
  beforePlacement?: (
    deps: CapacityPhaseDeps,
    identity: SubscriptionCoreTurnIdentity,
  ) => Promise<void>;
  /** Record the placement on the provider's turn fields. */
  adopt: (deps: CapacityPhaseDeps, core: SubscriptionCoreTurn, placement: RunPlacement) => void;
  /** The provider's selection receipt (events and metrics), if it records one. */
  recordSelection?: (
    deps: CapacityPhaseDeps,
    placement: RunPlacement,
    turnId: string,
  ) => Promise<void>;
  /**
   * Park a chat turn on the durable core waiter. Without it a wait is a
   * terminal capacity failure (fail closed; the session stays usable).
   */
  park?: (deps: CapacityPhaseDeps, wait: WaitPlacement) => Promise<CapacityPhaseOutcome>;
  isSourceDisconnected: (
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    connectionId: string,
  ) => Promise<boolean>;
  sourceDisconnectedError: () => Error;
  /** The attempt-fence refusal the selection receipt raises. */
  isAttemptFenced: (error: unknown) => boolean;
};

/** Lifecycle disappearance is not an auth refusal or an ordinary account pause. */
export async function assertCoreSourceConnected(
  db: Database,
  provider: Pick<CoreTurnPlacementProvider, "isSourceDisconnected" | "sourceDisconnectedError">,
  core: Pick<SubscriptionCoreTurn, "identity" | "connectionId">,
): Promise<void> {
  if (await provider.isSourceDisconnected(db, core.identity, core.connectionId)) {
    throw provider.sourceDisconnectedError();
  }
}

/**
 * Wrap a core credential resolver for one attempt: every read and refresh
 * rechecks the source and this attempt's live lease. A lost lease marks the
 * local holder lost, so dispatch stops with the ordinary lease-loss error; a
 * failure is reclassified as a disconnect only on proven lifecycle
 * disconnect, never on an ordinary pause.
 */
export function guardCoreTokenResolver<Snapshot>(
  db: Database,
  provider: Pick<CoreTurnPlacementProvider, "isSourceDisconnected" | "sourceDisconnectedError">,
  core: SubscriptionCoreTurn,
  lease: CoreSubscriptionTurnLease,
  resolver: { getToken: () => Promise<Snapshot>; refresh: () => Promise<Snapshot> },
  isLeaseLost: (error: unknown) => boolean,
): { getToken: () => Promise<Snapshot>; refresh: () => Promise<Snapshot> } {
  const guarded = (resolve: () => Promise<Snapshot>) => async (): Promise<Snapshot> => {
    await assertCoreSourceConnected(db, provider, core);
    try {
      lease.assertUsable();
      return await resolve();
    } catch (error) {
      // The loader/refresh may have raced secret scrubbing or lease expiry.
      // Reclassify only a proven lifecycle disconnect, never ordinary pause.
      await assertCoreSourceConnected(db, provider, core);
      if (isLeaseLost(error)) {
        lease.markLost("not_found");
        lease.assertUsable();
      }
      throw error;
    }
  };
  return { getToken: guarded(resolver.getToken), refresh: guarded(resolver.refresh) };
}

/** The lease reference a core turn's credential reads and requests carry. */
export function coreLeaseRef(
  lease: CoreSubscriptionTurnLease,
  core: Pick<SubscriptionCoreTurn, "connectionId">,
  displayName: string,
): { connectionId: string; holderId: string; generation: number } {
  if (!lease.holderId || lease.generation === null) {
    throw new Error(`Core ${displayName} lease was not acquired before credential materialization`);
  }
  if (lease.subscriptionCoreConnection !== core.connectionId) {
    throw new Error(`Core ${displayName} lease does not hold the placed connection`);
  }
  return {
    connectionId: core.connectionId,
    holderId: lease.holderId,
    generation: lease.generation,
  };
}

export async function selectCoreSubscriptionTurnCapacity(
  deps: CapacityPhaseDeps,
  provider: CoreTurnPlacementProvider,
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    db,
    observability,
    control,
    attempt,
    claimedResult,
    acknowledgeLostAttemptOwnership,
    turn,
    turnExecutionPolicy,
  } = deps;
  const lease = provider.lease(deps);
  const turnId = attempt.turnId;
  const holderId = lease.holderId;
  if (!turnId) throw new Error("Turn id was not initialized");
  if (!holderId) throw new Error(`${provider.displayName} lease holder was not initialized`);
  // A compaction turn places, leases and refreshes exactly like a chat turn
  // (PR 2c): the same accepted authority (copied from the turn it compacts
  // after), lease, and history sanitization. A session locked to a provider
  // by its compaction state keeps it because placement uses only the
  // accepted model with cross-provider failover off.

  const fenced = (): CapacityPhaseOutcome => {
    acknowledgeLostAttemptOwnership();
    control.activityStatus = "cancelled";
    control.turnMetricOutcome = "cancelled";
    return { exit: claimedResult({ status: "cancelled" }) };
  };

  const startedAt = performance.now();
  let outcome: "completed" | "failed" = "completed";
  try {
    const identity = await readSubscriptionCoreTurnIdentity(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
    });
    if (!identity) return fenced();
    await provider.recoverHealth(deps, identity);
    await provider.beforePlacement?.(deps, identity);
    const leaseRequestedAt = performance.now();
    const placement = await provider.place(db, {
      identity,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
      holderId,
      productModelId: turnExecutionPolicy.productModelId,
      reasoningLevel: turnExecutionPolicy.reasoningEffort,
      leaseTtlMs: provider.leaseTtlMs,
    });
    switch (placement.kind) {
      case "not_visible":
      case "attempt_fenced":
        return fenced();
      case "cutover_not_enabled":
        throw subscriptionCoreCutoverDisabledFailure(provider.displayName);
      case "lease_busy":
        throw subscriptionCoreLeaseBusyFailure(
          placement.leasedUntil,
          placement.cause,
          provider.displayName,
        );
      case "wait":
        // Maintenance never parks: as on the legacy path, compaction is
        // cancelled with its request preserved and runs again with the
        // session's next work, instead of holding a capacity waiter.
        if (turn.source === "compaction") return await deferCoreCompaction(deps, placement);
        // Park the same turn on the durable core waiter (EP-T09); it resumes
        // when placement can serve it again (a reset, a wake or a timer).
        if (provider.park) return await provider.park(deps, placement);
        throw subscriptionCoreCapacityFailure(
          placement.reason,
          placement.earliestResetAt,
          provider.displayName,
        );
      case "run":
        break;
    }

    provider.adopt(
      deps,
      {
        identity,
        connectionId: placement.connectionId,
        placedRefreshGeneration: placement.refreshGeneration,
        personal: placement.personal,
      },
      placement,
    );
    lease.useSubscriptionCoreLease(placement.connectionId, subscriptionCoreTurnActor(identity));
    lease.generation = attempt.executionGeneration;
    lease.confirmedUntilMs = leaseRequestedAt + provider.leaseTtlMs;
    lease.held = true;
    lease.startHeartbeat();

    await provider.recordSelection?.(deps, placement, turnId);
    return { ok: true };
  } catch (error) {
    outcome = "failed";
    if (provider.isAttemptFenced(error)) return fenced();
    throw error;
  } finally {
    recordTurnStartupPhase(observability, {
      phase: "credential_selection",
      provider: provider.startupPhaseProvider,
      backend: turn.sandboxBackend,
      outcome,
      durationSeconds: (performance.now() - startedAt) / 1_000,
    });
  }
}

/** The legacy compaction capacity outcome (`requestPreserved`), on a core wait. */
async function deferCoreCompaction(
  deps: CapacityPhaseDeps,
  wait: WaitPlacement,
): Promise<CapacityPhaseOutcome> {
  const { eventing, control, claimedResult } = deps;
  const settled = await eventing.settle({
    events: [
      {
        type: "turn.cancelled",
        payload: {
          maintenance: "context_compaction",
          reason: "subscription_capacity_unavailable",
          waitReason: wait.reason,
          requestPreserved: true,
        },
      },
      { type: "session.status.changed", payload: { status: "idle" } },
    ],
    turnStatus: "cancelled",
    sessionStatus: "idle",
    activeTurnId: null,
  });
  if (!settled) return { exit: claimedResult({ status: "cancelled" }) };
  control.turnMetricOutcome = "cancelled";
  control.activityStatus = "idle";
  return { exit: claimedResult({ status: "idle", deferredUntilWake: true }) };
}

/** The session's active goal fence for a capacity waiter. */
export async function activeGoalFence(
  deps: Pick<CapacityPhaseDeps, "db" | "input">,
): Promise<{ goalId: string | null; goalVersion: number | null }> {
  const goal = await getSessionGoal(deps.db, deps.input.workspaceId, deps.input.sessionId);
  const activeGoal = goal?.status === "active" ? goal : null;
  return { goalId: activeGoal?.id ?? null, goalVersion: activeGoal?.version ?? null };
}
