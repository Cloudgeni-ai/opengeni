/**
 * In-turn re-placement after a definitive refusal on a Codex turn placed by
 * the shared subscription core (M3 PR 2a, inventory EP-T06).
 *
 * The refusal was already recorded against the leased connection (failure
 * receipt plus the quota, health or model-cooldown state that keeps placement
 * away from it). After a durable checkpoint the same accepted turn is
 * recovered with a new attempt, whose placement chooses again under the
 * core rules: another eligible account (emitting the existing
 * `codex.account.switched`), or a durable wait when nothing can serve it.
 * An explicit choice never fails over (D-24): its placement waits on the
 * chosen account. The per-turn bound counts every refusal of the turn, by
 * any account, so a turn cannot alternate between failing accounts forever
 * (SUB-FAIL-11); the refusal that reaches the bound fails the turn with
 * typed copy and leaves the session usable.
 */
import { countSubscriptionCoreCodexTurnRefusals, requestSessionTurnRecovery } from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import type { RunAgentTurnResult } from "../types";
import { subscriptionCoreFailoverExhaustedFailure } from "./codex-core-errors";
import type { CodexCredentialFailure } from "./errors";
import type { TurnFailureDeps } from "./failure-settlement";
import type { CodexSubscriptionCoreTurn } from "./turn-context";

/**
 * Refusals one turn may take before it stops: at most three in-turn switches
 * (the contract and design require a bound but do not fix it; this is the
 * small fixed bound chosen for M3, see design 5.1.1 "PR 2a").
 */
export const SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT = 4;

/** Pure bound: fail over while under the limit, stop at it. */
export function coreCodexFailoverDisposition(
  refusals: number | null,
  limit: number = SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT,
): "failover" | "exhausted" | "unrecorded" {
  if (refusals === null || !Number.isSafeInteger(refusals) || refusals < 1) return "unrecorded";
  return refusals >= limit ? "exhausted" : "failover";
}

/**
 * Settle a recorded core refusal by re-placing the same turn, or stop it at
 * the bound. Returns null when automatic replay is unsafe (the checkpoint
 * did not become durable, or the bound could not be read): the caller then
 * fails the turn with its typed copy instead.
 */
export async function failOverCoreCodexTurn(
  deps: TurnFailureDeps,
  core: CodexSubscriptionCoreTurn,
  refusal: CodexCredentialFailure,
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
    leases,
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
  } catch {
    observability.incrementCounter({
      name: "opengeni_codex_failover_checkpoints_total",
      help: "Durable Codex failover checkpoint attempts by outcome.",
      labels: { workspace_key: deps.codexWorkspaceKey, outcome: "failed" },
    });
    return null;
  }
  const refusals = await countSubscriptionCoreCodexTurnRefusals(db, core.identity).catch(
    () => null,
  );
  const disposition = coreCodexFailoverDisposition(refusals);
  observability.incrementCounter({
    name: "opengeni_codex_failover_settlements_total",
    help: "Atomic Codex failover settlements by outcome.",
    labels: { workspace_key: deps.codexWorkspaceKey, outcome: `core_${disposition}` },
  });
  if (disposition === "unrecorded") return null;

  // The next placement must not wait for this attempt's lease to expire.
  leases.codex.stopHeartbeat();
  await leases.codex.releaseCurrent().catch(() => false);
  leases.codex.held = false;

  if (disposition === "exhausted") {
    const failure = subscriptionCoreFailoverExhaustedFailure(
      refusals!,
      SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT,
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
    reason: "codex_credential_failover",
    detail: {
      provider: "codex-subscription",
      credentialId: core.connectionId,
      failureKind: refusal.kind,
      // The legacy detail shape counts switches: refusal n (below the
      // bound) starts switch n of at most limit - 1. The exhausted failure
      // reports the refusals themselves (refusals / maxRefusals).
      failoverCount: refusals,
      maxFailovers: SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT - 1,
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
