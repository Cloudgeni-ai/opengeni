/**
 * Codex chat-turn placement on the shared subscription core (M3 PR 1,
 * inventory EP-T01..T05). Reached only when the organization's Codex cutover
 * row is enabled; the legacy selector is untouched for every other turn.
 */
import {
  assertModelConnectionAllowsTurn,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  CodexCredentialLeaseAttemptFencedError,
  SubscriptionCoreCodexLeaseLostError,
  buildSubscriptionCoreCodexTokenResolver,
  placeSubscriptionCoreCodexTurn,
  readSubscriptionCoreTurnIdentity,
  recordSubscriptionCoreCodexSelectionForTurnAttempt,
  subscriptionCoreTurnActor,
  type CodexCredentialTokenSnapshot,
  type Database,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { publishDurableSessionEvents } from "@opengeni/events";
import { recordTurnStartupPhase } from "../../observability-metrics";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import {
  subscriptionCoreCapacityFailure,
  subscriptionCoreCutoverDisabledFailure,
  subscriptionCoreLeaseBusyFailure,
  subscriptionCoreUnsupportedFailure,
} from "./codex-core-errors";
import type { CodexTurnLease } from "./credential-leases";
import type { CodexSubscriptionCoreTurn, ProviderTurnState } from "./turn-context";

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
  const resolver = buildSubscriptionCoreCodexTokenResolver(db, settings, core.identity, {
    connectionId: core.connectionId,
    holderId: lease.holderId,
    generation: lease.generation,
  });
  const guarded =
    (resolve: () => Promise<CodexCredentialTokenSnapshot>) =>
    async (): Promise<CodexCredentialTokenSnapshot> => {
      lease.assertUsable();
      try {
        return await resolve();
      } catch (error) {
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
  } = deps;
  const turnId = attempt.turnId;
  const holderId = leases.codex.holderId;
  if (!turnId) throw new Error("Turn id was not initialized");
  if (!holderId) throw new Error("Codex lease holder was not initialized");
  // Compaction turns move to the core with the other Codex consumers (PR 2).
  // Until then they fail closed instead of reading the legacy Codex tables.
  if (turn.source === "compaction") throw subscriptionCoreUnsupportedFailure("Context compaction");

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
        throw subscriptionCoreCapacityFailure(placement.reason, placement.earliestResetAt);
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
