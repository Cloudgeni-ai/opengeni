/**
 * Codex chat-turn placement on the shared subscription core (M3 PR 1,
 * inventory EP-T01..T05). Reached only when the organization's Codex cutover
 * row is enabled; missing or disabled cutover state fails closed.
 */
import {
  armSubscriptionCoreCodexCapacityWait,
  assertModelConnectionAllowsTurn,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  getSessionGoal,
  CodexCredentialLeaseAttemptFencedError,
  SubscriptionCoreCodexLeaseLostError,
  SubscriptionCoreCodexSourceDisconnectedError,
  isSubscriptionCoreCodexSourceDisconnected,
  buildSubscriptionCoreCodexTokenResolver,
  placeSubscriptionCoreCodexTurn,
  readSubscriptionCoreTurnIdentity,
  recordSubscriptionCoreCodexSelectionForTurnAttempt,
  subscriptionCoreTurnActor,
  type CodexCredentialTokenSnapshot,
  type Database,
  type SubscriptionCoreCodexPlacement,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { refreshCoreCodexModelEntitlements } from "@opengeni/core";
import { publishDurableSessionEvents } from "@opengeni/events";
import { recordTurnStartupPhase } from "../../observability-metrics";
import {
  recoverCoreCodexHealthAndWake,
  reconcileCoreCodexCapacityWait,
  wakeSubscriptionCoreCodexWaitersAndDeliver,
  type CoreCodexWakeServices,
} from "../subscription-core-codex-waits";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import {
  subscriptionCoreCapacityWaitPayload,
  subscriptionCoreCutoverDisabledFailure,
  subscriptionCoreLeaseBusyFailure,
} from "./codex-core-errors";
import type { CodexTurnLease } from "./credential-leases";
import type { CodexSubscriptionCoreTurn, ProviderTurnState } from "./turn-context";

export function isCoreCodexSourceDisconnectedError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof SubscriptionCoreCodexSourceDisconnectedError) return true;
    current = current.cause;
  }
  return false;
}

/** Lifecycle disappearance is not an auth refusal or an ordinary account pause. */
export async function assertCoreCodexSourceConnected(
  db: Database,
  core: CodexSubscriptionCoreTurn,
): Promise<void> {
  if (await isSubscriptionCoreCodexSourceDisconnected(db, core.identity, core.connectionId)) {
    throw new SubscriptionCoreCodexSourceDisconnectedError();
  }
}

/**
 * The turn's model-connection check. A shared-core Codex placement already
 * enforced the connection's model allowlist, entitlement exclusions and the
 * workspace model policy in the same transaction as its lease; the legacy
 * check reads legacy Codex rows and must never see a core connection id.
 */
export async function assertTurnModelConnection(
  db: Database,
  providerTurn: Pick<ProviderTurnState, "codexSubscriptionCore">,
  input: Parameters<typeof assertModelConnectionAllowsTurn>[1],
): Promise<void> {
  if (providerTurn.codexSubscriptionCore) return;
  await assertModelConnectionAllowsTurn(db, input);
}

/**
 * The bearer resolver for a core-placed turn (EP-T03): the same snapshot
 * shape as the legacy resolver, but every read and refresh goes through the
 * exact accepted turn and this attempt's live core lease. A lost lease marks
 * the local holder lost, so dispatch stops with the ordinary lease-loss error.
 */
export function buildCoreCodexRequestTokenResolver(
  db: Database,
  settings: Settings,
  core: CodexSubscriptionCoreTurn,
  lease: CodexTurnLease,
  wake?: Pick<CoreCodexWakeServices, "signalCodexCapacityWorkflow">,
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  if (!lease.holderId || lease.generation === null) {
    throw new Error("Core Codex lease was not acquired before credential materialization");
  }
  if (lease.subscriptionCoreConnection !== core.connectionId) {
    throw new Error("Core Codex lease does not hold the placed connection");
  }
  const resolver = buildSubscriptionCoreCodexTokenResolver(
    db,
    settings,
    core.identity,
    {
      connectionId: core.connectionId,
      holderId: lease.holderId,
      generation: lease.generation,
    },
    {
      // A rotated id_token reporting a new plan cleared the connection's
      // model cooldowns in the same commit; waiters may now place (EP-T10).
      onPlanChanged: () =>
        void wakeSubscriptionCoreCodexWaitersAndDeliver(
          { db, signalCodexCapacityWorkflow: wake?.signalCodexCapacityWorkflow },
          { accountId: core.identity.accountId, reason: "plan_changed" },
        ),
    },
  );
  const guarded =
    (resolve: () => Promise<CodexCredentialTokenSnapshot>) =>
    async (): Promise<CodexCredentialTokenSnapshot> => {
      await assertCoreCodexSourceConnected(db, core);
      try {
        lease.assertUsable();
        return await resolve();
      } catch (error) {
        // The loader/refresh may have raced secret scrubbing or lease expiry.
        // Reclassify only a proven lifecycle disconnect, never ordinary pause.
        await assertCoreCodexSourceConnected(db, core);
        if (error instanceof SubscriptionCoreCodexLeaseLostError) {
          lease.markLost("not_found");
          lease.assertUsable();
        }
        throw error;
      }
    };
  return { getToken: guarded(resolver.getToken), refresh: guarded(resolver.refresh) };
}

export async function selectCoreCodexTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    db,
    bus,
    observability,
    control,
    attempt,
    providerTurn,
    leases,
    claimedResult,
    acknowledgeLostAttemptOwnership,
    turn,
    turnExecutionPolicy,
    codexWorkspaceKey,
    signalCodexCapacityWorkflow,
  } = deps;
  const turnId = attempt.turnId;
  const holderId = leases.codex.holderId;
  if (!turnId) throw new Error("Turn id was not initialized");
  if (!holderId) throw new Error("Codex lease holder was not initialized");
  // A compaction turn places, leases and refreshes exactly like a chat turn
  // (PR 2c): the same accepted authority (copied from the turn it compacts
  // after), lease, and history sanitization. An existing remote_v2 session
  // keeps its Codex model lock because placement uses only the accepted
  // model with cross-provider failover off.

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
    // Quarantines that ran out return to service before placement reads the
    // world; a recovery wakes the account's other waiters too.
    await recoverCoreCodexHealthAndWake({ db, signalCodexCapacityWorkflow }, identity);
    await refreshCoreCodexModelEntitlements(db, deps.settings, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: identity.initiatingHumanSubjectId,
    });
    const leaseRequestedAt = performance.now();
    const placement = await placeSubscriptionCoreCodexTurn(db, {
      identity,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
      holderId,
      productModelId: turnExecutionPolicy.productModelId,
      reasoningLevel: turnExecutionPolicy.reasoningEffort,
      leaseTtlMs: CODEX_CREDENTIAL_LEASE_TTL_MS,
    });
    switch (placement.kind) {
      case "not_visible":
      case "attempt_fenced":
        return fenced();
      case "cutover_not_enabled":
        throw subscriptionCoreCutoverDisabledFailure();
      case "lease_busy":
        throw subscriptionCoreLeaseBusyFailure(placement.leasedUntil);
      case "wait":
        // Maintenance never parks: as on the legacy path, compaction is
        // cancelled with its request preserved and runs again with the
        // session's next work, instead of holding a capacity waiter.
        if (turn.source === "compaction") return await deferCoreCodexCompaction(deps, placement);
        // Park the same turn on the durable core waiter (EP-T09); it resumes
        // when placement can serve it again (a reset, a wake or a timer).
        return await parkCoreCodexTurn(deps, placement);
      case "run":
        break;
    }

    providerTurn.codexSubscriptionCore = {
      identity,
      connectionId: placement.connectionId,
      placedRefreshGeneration: placement.refreshGeneration,
      personal: placement.personal,
    };
    providerTurn.effectiveCodexCredentialId = placement.connectionId;
    providerTurn.codexProductModelId = turnExecutionPolicy.productModelId;
    providerTurn.codexPolicySnapshot = null;
    // In-turn re-placement after a refusal arrives with the core failover
    // bound (PR 2); this turn never walks to a second account.
    providerTurn.codexCredentialFailoverLimit = 1;
    leases.codex.useSubscriptionCoreLease(
      placement.connectionId,
      subscriptionCoreTurnActor(identity),
    );
    leases.codex.generation = attempt.executionGeneration;
    leases.codex.confirmedUntilMs = leaseRequestedAt + CODEX_CREDENTIAL_LEASE_TTL_MS;
    leases.codex.held = true;
    leases.codex.startHeartbeat();

    const receipt = await recordSubscriptionCoreCodexSelectionForTurnAttempt(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
      credentialId: placement.connectionId,
      previousCredentialId: placement.previousConnectionId,
      strategy: placement.rotationMode,
      reusedLease: placement.reusedLease,
      pinnedCredentialId: placement.explicit ? placement.connectionId : null,
      eligibleCount: placement.eligibleCount,
      connectedCount: placement.connectedCount,
    });
    await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, receipt.events);
    observability.incrementCounter({
      name: "opengeni_codex_credential_selections_total",
      help: "Codex credential selections by strategy and reason.",
      labels: {
        workspace_key: codexWorkspaceKey,
        strategy: `core_${placement.rotationMode}`,
        reason: receipt.diagnostics.reason,
      },
    });
    return { ok: true };
  } catch (error) {
    outcome = "failed";
    if (error instanceof CodexCredentialLeaseAttemptFencedError) return fenced();
    throw error;
  } finally {
    recordTurnStartupPhase(observability, {
      phase: "credential_selection",
      provider: "codex-subscription",
      backend: turn.sandboxBackend,
      outcome,
      durationSeconds: (performance.now() - startedAt) / 1_000,
    });
  }
}

/** The legacy compaction capacity outcome (`requestPreserved`), on a core wait. */
async function deferCoreCodexCompaction(
  deps: CapacityPhaseDeps,
  wait: Extract<SubscriptionCoreCodexPlacement, { kind: "wait" }>,
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

/**
 * Arm the session's core waiter for this attempt's turn and re-evaluate it at
 * once: a capacity change that committed before the waiter existed could not
 * wake it, so the arm closes that edge itself (as the legacy Codex arm does).
 */
async function parkCoreCodexTurn(
  deps: CapacityPhaseDeps,
  wait: Extract<SubscriptionCoreCodexPlacement, { kind: "wait" }>,
): Promise<CapacityPhaseOutcome> {
  const {
    input,
    db,
    bus,
    control,
    attempt,
    claimedResult,
    acknowledgeLostAttemptOwnership,
    signalCodexCapacityWorkflow,
  } = deps;
  const turnId = attempt.turnId!;
  const goal = await getSessionGoal(db, input.workspaceId, input.sessionId);
  const activeGoal = goal?.status === "active" ? goal : null;
  const armed = await armSubscriptionCoreCodexCapacityWait(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId,
    attemptId: input.attemptId,
    goalId: activeGoal?.id ?? null,
    goalVersion: activeGoal?.version ?? null,
    waitReason: wait.reason,
    earliestResetAt: wait.earliestResetAt,
    healthRetryAt: wait.healthRetryAt,
    failurePayload: subscriptionCoreCapacityWaitPayload(wait.reason, wait.earliestResetAt),
  });
  await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
  if (armed.action === "stopped") {
    control.turnMetricOutcome = "failed";
    control.activityStatus = armed.sessionStatus === "queued" ? "idle" : "failed";
    return { exit: claimedResult({ status: control.activityStatus }) };
  }
  if (armed.action === "waiting") {
    const evaluated = await reconcileCoreCodexCapacityWait(
      { db, bus, signalCodexCapacityWorkflow },
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: armed.waiter.waiterId,
        generation: armed.waiter.generation,
      },
    );
    if (evaluated?.action === "resumed") {
      control.turnMetricOutcome = "recovering";
      control.activityStatus = "recovering";
      return { exit: claimedResult({ status: "recovering" }) };
    }
    if (evaluated?.action === "waiting") {
      control.turnMetricOutcome = "recovering";
      control.activityStatus = "waiting_capacity";
      return {
        exit: claimedResult({
          status: "waiting_capacity",
          capacityWait: {
            waiterId: evaluated.waiterId,
            generation: evaluated.generation,
            nextCheckAt: evaluated.nextCheckAt,
            wakeRevision: evaluated.wakeRevision,
          },
        }),
      };
    }
  }
  acknowledgeLostAttemptOwnership();
  control.turnMetricOutcome = "cancelled";
  control.activityStatus = "cancelled";
  return { exit: claimedResult({ status: "cancelled" }) };
}
