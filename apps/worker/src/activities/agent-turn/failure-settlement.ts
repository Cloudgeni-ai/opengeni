import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  requestSessionTurnRecovery,
  getSessionGoal,
  armXaiCapacityWait,
  armClaudeCapacityWait,
  reconcileClaudeCapacityWait,
  recordClaudeAccountUsage,
  resolveClaudeAccountCredential,
  loadClaudeAccountCredential,
  ClaudeSubscriptionConnectionChanged,
  reconcileXaiCapacityWait,
  listCodexAccountStatuses,
  quarantineCodexCredentialForLease,
  recordUsageEvent,
  getActiveSessionHistoryItemsPaged,
  recheckCodexCredentialPlan,
  settleCodexCredentialLeaseLoss,
  settleCodexCredentialFailover,
  readLease,
  SandboxLeaseSupersededError,
  isSessionEventPersistenceError,
  SANDBOX_SETUP_RECOVERY_LIMIT,
  type CodexLeaseAccountStatus,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  maxTurnsExceededRunState,
  isModalTaskExecStartPreDispatchUnavailableError,
  isModalCommandStartOutcomeUnknownError,
  isProviderCommandObservationUnavailableError,
} from "@opengeni/runtime";
import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import {
  authoritativeCodexCapacityResetAt,
  classifyCodexPin,
  selectCodexCredentialLeaseForTurn,
  type CodexRotationStrategy,
} from "../codex-rotation";
import { TurnExecutionPolicyDefinitionMismatchError, type Settings } from "@opengeni/config";
import {
  classifyCodexEncryptedArtifactRejection,
  classifyCodexEntitlementRejection,
  classifyCodexUsageLimitError,
  isCodexTransportError,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import {
  assessCodexPlanEntitlement,
  codexAccountDisplayLabel,
  codexPlanEntitlementFailurePayload,
  codexRequestRejectedFailurePayload,
  type CodexPlanEntitlementFailurePayload,
  type CodexRequestRejectedFailurePayload,
} from "./codex-plan-entitlement";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { CodexCredentialLeaseLostError, createTurnCredentialLeases } from "./credential-leases";
import { createTurnHistorySink } from "./history-sink";

import { BudgetExhaustedError } from "./admission";
import {
  providerRecoveryExhaustedFailure,
  postClaimDatabaseRecoveryFailure,
  providerRecoveryResult,
  providerRetryAfterMs,
  escapedMcpTimeoutRecoveryFailure,
  preClaimAdmissionFailure,
  isWorkerShutdownCancellation,
  sandboxLifecycleTransitionDiagnostic,
  sandboxRouteTransitionCode,
  safeErrorDiagnostic,
  classifyXaiCredentialFailure,
  classifyClaudeCredentialFailure,
  agentRunFailurePayload,
  agentRunRecoveryFailurePayload,
  codexCredentialCooldownUntil,
  classifyCodexCredentialFailure,
  codexUsageLimitFailurePayload,
  type CodexCredentialFailure,
} from "./errors";
import { selectRejectedProviderArtifactHistoryIds } from "./history";
import { waitForTurnFinalizerStep, turnFinalizerCancellationSignal } from "./quiescence";
import {
  SandboxDeadlineRotationError,
  turnOperationCancellationFailure,
  sandboxDeadlineRotationRecoveryDelayMs,
} from "./sandbox-provision";
import type {
  AttemptIdentityState,
  BillingState,
  EventingState,
  ProviderTurnState,
  TurnControlState,
} from "./turn-context";
import type { CodexCredentialPolicySnapshotV1 } from "@opengeni/contracts";
import { armAndReconcileCodexCapacityWait } from "../codex-capacity";

export type TurnFailureDeps = {
  error: unknown;
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  cancellationSignal: AbortSignal | undefined;
  sandboxRotationController: AbortController;
  noteCancellationRequested: () => void;
  codexWorkspaceKey: string;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  eventing: EventingState;
  providerTurn: ProviderTurnState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  historySink: ReturnType<typeof createTurnHistorySink>;
  claimedResult: (
    result: Omit<
      Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
      "turnId" | "attemptId"
    >,
  ) => RunAgentTurnResult;
  flushRuntimeBatcher: () => Promise<void>;
  acknowledgeLostAttemptOwnership: () => void;
  acknowledgeRecoveryQuiescence: () => void;
};

export type CodexDefinitiveFailureDisposition = "failover" | "wait" | "terminal";

type CodexCapacityWaitFailurePayload = {
  error: string;
  code: string;
  detail?: string;
  retryable: false;
};

/**
 * Pure policy for a definitive serving-credential refusal. A policy-constrained
 * account and an all-unavailable pool wait for the same selected capacity to
 * recover; only a truly empty/non-allocatable pool makes an auth/forbidden
 * failure terminal. A different eligible account under rotation-on policy may
 * recover the same durable turn immediately.
 */
export function codexDefinitiveFailureDisposition(input: {
  failureKind: CodexCredentialFailure["kind"];
  rotationEnabled: boolean;
  pinDisposition: "manual" | "sharded" | "clearStale" | "unpinned";
  decisionKind: "active" | "allCapped" | "none";
  decisionCredentialId: string | null;
  servingCredentialId: string;
}): CodexDefinitiveFailureDisposition {
  const alternateAvailable =
    input.rotationEnabled &&
    input.pinDisposition !== "manual" &&
    input.decisionKind === "active" &&
    input.decisionCredentialId !== null &&
    input.decisionCredentialId !== input.servingCredentialId;
  if (alternateAvailable) return "failover";
  // A plan that no longer includes the model does not recover by itself, and
  // a manual pin or rotation-off pointer names exactly that account. Only a
  // rotation-on pool whose OTHER accounts are temporarily capped is worth a
  // durable wait; everything else fails the turn with typed copy.
  if (input.failureKind === "plan_entitlement") {
    return input.decisionKind === "allCapped" &&
      input.rotationEnabled &&
      input.pinDisposition !== "manual"
      ? "wait"
      : "terminal";
  }
  if (
    input.failureKind === "quota" ||
    input.failureKind === "rate_limit" ||
    input.decisionKind === "allCapped" ||
    !input.rotationEnabled ||
    input.pinDisposition === "manual"
  ) {
    return "wait";
  }
  return "terminal";
}

/**
 * Bound one turn to the alternate credentials that policy actually permits.
 * The effective account list is already workspace/organization scoped;
 * allocator-disabled rows must not enlarge the retry budget. The database
 * requires a positive bound even though one-account paths never fail over.
 */
export function codexCredentialFailoverLimit(
  accounts: ReadonlyArray<{ id: string; allocatorEnabled: boolean }>,
  servingCredentialId: string,
): number {
  const allocatableAccounts = accounts.filter((account) => account.allocatorEnabled).length;
  const servingIsAllocatable = accounts.some(
    (account) => account.id === servingCredentialId && account.allocatorEnabled,
  );
  return Math.max(1, allocatableAccounts - (servingIsAllocatable ? 1 : 0));
}

/** Build the durable waiter payload without collapsing quota refusals into 403. */
export function codexCapacityWaitFailurePayload(input: {
  failureKind: CodexCredentialFailure["kind"];
  usageLimit: { resetsInSeconds: number | null } | null;
  cooldownSeconds: number | null;
  detail: string;
  allAccounts: boolean;
  planEntitlement?: CodexPlanEntitlementFailurePayload | null;
}): CodexCapacityWaitFailurePayload {
  if (input.failureKind === "plan_entitlement") {
    return {
      error:
        input.planEntitlement?.error ??
        "The serving ChatGPT account's plan does not include this model. OpenGeni is waiting for another connected account to become available.",
      code: "codex_plan_entitlement",
      detail: input.detail,
      retryable: false,
    };
  }
  if (input.failureKind === "quota") {
    return codexUsageLimitFailurePayload(
      input.usageLimit ?? { resetsInSeconds: input.cooldownSeconds },
      input.detail,
      input.allAccounts ? { allAccounts: true } : undefined,
    );
  }
  if (input.failureKind === "rate_limit") {
    return {
      error: "The serving Codex subscription is temporarily rate limited.",
      code: "codex_account_rate_limited",
      detail: input.detail,
      retryable: false,
    };
  }
  if (input.failureKind === "auth") {
    return {
      error: "The serving Codex account requires reconnection.",
      code: "codex_relogin_required",
      detail: "the same accepted turn is waiting for the selected account to recover",
      retryable: false,
    };
  }
  return {
    error: "The serving Codex account is not authorized for this request.",
    code: "codex_account_forbidden",
    detail: "the same accepted turn is waiting for the selected account to recover",
    retryable: false,
  };
}

function codexLeaseAccountsForSelection(
  accounts: Awaited<ReturnType<typeof listCodexAccountStatuses>>,
): CodexLeaseAccountStatus[] {
  return accounts.map((account) => ({
    ...account,
    activeLeaseCount: 0,
    selectionCount: 0,
    lastSelectedAt: null,
  }));
}

function acceptedCodexPolicySnapshot(
  providerTurn: ProviderTurnState,
): CodexCredentialPolicySnapshotV1 {
  if (!providerTurn.codexPolicySnapshot) {
    throw new Error("Codex accepted policy snapshot is missing after durable lease acquisition");
  }
  return providerTurn.codexPolicySnapshot;
}

export async function settleTurnFailure(deps: TurnFailureDeps): Promise<RunAgentTurnResult> {
  if (deps.settings.environment === "local" && deps.error instanceof Error) {
    // Keep local startup failures diagnosable without logging error messages,
    // absolute host paths, prompts, credentials, or provider response bodies.
    const locations = (deps.error.stack ?? "")
      .split("\n")
      .slice(1)
      .flatMap((line) => line.match(/(?:apps|packages)\/[A-Za-z0-9_./-]+:\d+:\d+/g) ?? [])
      .slice(0, 8);
    console.error(JSON.stringify({ message: "Local turn failure source locations", locations }));
  }
  const {
    error,
    input,
    settings,
    db,
    bus,
    observability,
    wakeSessionWorkflow,
    cancellationSignal,
    sandboxRotationController,
    noteCancellationRequested,
    codexWorkspaceKey,
    control,
    attempt,
    billingState,
    eventing,
    providerTurn,
    leases,
    historySink,
    claimedResult,
    flushRuntimeBatcher,
    acknowledgeLostAttemptOwnership,
    acknowledgeRecoveryQuiescence,
  } = deps;
  // Capture before any recovery/checkpoint DB operation can fail again.
  if (isSessionEventPersistenceError(error)) {
    try {
      const diagnosticId = observability.recordFailureDiagnostic({
        code: error.details.code,
        stage:
          error.details.stage === "session_events.append_generic"
            ? "session_events.append_generic"
            : error.details.stage === "session_events.append_for_turn_attempt"
              ? "session_events.append_for_turn_attempt"
              : error.details.stage === "session_attempts.claim"
                ? "session_attempts.claim"
                : "failure_settlement",
        retryDecision: error.details.retryOutcome,
        error,
        sessionId: input.sessionId,
        ...(attempt.turnId ? { turnId: attempt.turnId } : {}),
        attemptId: input.attemptId,
        attempts: error.details.attempts,
        eventTypes: error.details.eventTypes,
        sqlState: error.details.sqlState,
        ...(error.details.database.constraint
          ? { constraint: error.details.database.constraint }
          : {}),
      });
      observability.error("session event persistence failed", { correlationId: diagnosticId });
    } catch {
      // Failure settlement must not depend on telemetry availability.
    }
  }
  // Graceful worker shutdown (deploy / rollout restart): checkpoint the
  // same current inference for a new fenced attempt instead of failing the
  // session. Conversation truth is already persisted per model response;
  // the final reconcile bounds loss to the one in-flight model step.
  //
  // The branch deliberately does NOT require turn.started to have been
  // published: a shutdown landing during setup (claim/billing, before the
  // turn visibly started) must also recover, not fail the session. In that
  // early case nothing ran, so the new attempt uses the original trigger.
  // The turn id falls
  // back to the workflow-claimed turn when the local lookup had not
  // finished yet.
  const recoveryTurnId = attempt.turnId;
  // Unlike proven pre-dispatch failure, a genuine SDK Start/Wait uncertainty
  // cannot reconstruct setup on a replacement attempt. The exact command and
  // writer remain retained by sandbox-runtime; the logical turn is parked as
  // recovering with a durable no-replay marker, not failed or completed.
  const observationUnavailable = isProviderCommandObservationUnavailableError(error);
  if (
    (isModalCommandStartOutcomeUnknownError(error) || observationUnavailable) &&
    recoveryTurnId &&
    attempt.triggerEventId &&
    attempt.executionGeneration > 0
  ) {
    let recovery: Awaited<ReturnType<typeof requestSessionTurnRecovery>>;
    try {
      if (eventing.turnStartedPublished) {
        await flushRuntimeBatcher();
        await historySink.reconcileConversationTruth({ requireDurable: true });
      }
      recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId,
        attemptId: input.attemptId,
        reason: observationUnavailable
          ? "sandbox_command_observation_unavailable"
          : "sandbox_command_start_outcome_unknown",
        sandboxSetupOutcomeUnknown: true,
        detail: {
          code: observationUnavailable
            ? "sandbox_command_observation_unavailable"
            : "sandbox_command_start_outcome_unknown",
          retryable: false,
          setupOutcome: "unknown",
          replay: "blocked",
          providerRecoveryCount: attempt.providerRecoveryCount,
        },
      });
    } catch (checkpointError) {
      const databaseRecovery = postClaimDatabaseRecoveryFailure({
        error: checkpointError,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId,
        executionGeneration: attempt.executionGeneration,
        sandboxSetupOutcomeUnknown: true,
      });
      if (!databaseRecovery) throw checkpointError;
      control.activityStatus = "recovering";
      control.turnMetricOutcome = "recovering";
      control.activityError = error;
      throw databaseRecovery;
    }
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
    return claimedResult({ status: "recovering", deferredUntilWake: true });
  }
  // A true epoch supersession and a provider lifecycle transition are both
  // recoverable control-plane states, never session failures. A rotation
  // persists an exact group/epoch wait marker so the workflow parks before
  // another turn-worker dispatch; shorter non-rotation transitions retain
  // their existing paced retry.
  const lifecycleTransition = sandboxLifecycleTransitionDiagnostic(error);
  const leaseControlError =
    error instanceof SandboxLeaseSupersededError ? error : lifecycleTransition;
  if (leaseControlError && recoveryTurnId) {
    try {
      const fencedLease = await readLease(
        db,
        input.workspaceId,
        leaseControlError.sandboxGroupId,
      ).catch(() => null);
      const rotationPending =
        fencedLease?.rotationRequestedAt != null ||
        lifecycleTransition?.reason === "rotation_in_progress";
      const transitionPending = lifecycleTransition !== null || rotationPending;
      const deadlineRotationPending =
        rotationPending && fencedLease?.rotationReason === "provider_deadline";
      const sandboxLifecycleWait = rotationPending
        ? {
            version: 1 as const,
            sandboxGroupId: leaseControlError.sandboxGroupId,
            leaseEpoch: fencedLease?.leaseEpoch ?? leaseControlError.leaseEpoch,
            reason: "rotation_in_progress" as const,
          }
        : undefined;
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: deadlineRotationPending
          ? "sandbox_deadline_rotation"
          : lifecycleTransition !== null
            ? "sandbox_lifecycle_transition"
            : "sandbox_lease_superseded",
        ...(transitionPending
          ? {
              detail: {
                sandboxGroupId: leaseControlError.sandboxGroupId,
                leaseEpoch: leaseControlError.leaseEpoch,
                ...(rotationPending
                  ? {
                      rotationReason: fencedLease?.rotationReason ?? "operator",
                    }
                  : {}),
                ...(lifecycleTransition ? { transitionReason: lifecycleTransition.reason } : {}),
              },
            }
          : {}),
        ...(sandboxLifecycleWait ? { sandboxLifecycleWait } : {}),
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
      return claimedResult({
        status: "recovering",
        ...(transitionPending && !sandboxLifecycleWait
          ? {
              continueDelayMs: sandboxDeadlineRotationRecoveryDelayMs(settings),
            }
          : {}),
      });
    } catch (recoveryError) {
      console.error("sandbox lifecycle recovery failed", safeErrorDiagnostic(recoveryError));
      throw recoveryError;
    }
  }
  // A route change can require a different home, filesystem root, or native
  // capability set than this attempt established. Preserve the completed attach
  // and every preceding model/tool receipt, close only the unresolved suffix,
  // and continue the SAME logical turn in a fresh attempt. That next attempt
  // starts from the committed pointer and establishes its route normally.
  const routeTransitionCode = sandboxRouteTransitionCode(error);
  if (routeTransitionCode && recoveryTurnId && eventing.publish && eventing.turnStartedPublished) {
    try {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: "sandbox_route_transition",
        detail: {
          code: routeTransitionCode,
          effectiveBoundary: "next_attempt",
        },
      });
      if (recovery.action === "stale") {
        acknowledgeLostAttemptOwnership();
        control.activityStatus = "cancelled";
        control.turnMetricOutcome = "cancelled";
        return claimedResult({ status: "cancelled" });
      }
      if (recovery.action !== "recovering") {
        throw new Error("Sandbox route transition could not recover the current turn");
      }
      acknowledgeRecoveryQuiescence();
      await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
      control.activityStatus = "recovering";
      control.turnMetricOutcome = "recovering";
      control.activityError = error;
      return claimedResult({ status: "recovering" });
    } catch (recoveryError) {
      console.error("sandbox route-transition recovery failed", safeErrorDiagnostic(recoveryError));
      throw recoveryError;
    }
  }
  if (
    sandboxRotationController.signal.aborted &&
    sandboxRotationController.signal.reason instanceof SandboxDeadlineRotationError &&
    !cancellationSignal?.aborted &&
    recoveryTurnId
  ) {
    try {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
      const rotation = sandboxRotationController.signal.reason;
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: "sandbox_deadline_rotation",
        detail: {
          sandboxGroupId: rotation.sandboxGroupId,
          leaseEpoch: rotation.leaseEpoch,
        },
        sandboxLifecycleWait: {
          version: 1,
          sandboxGroupId: rotation.sandboxGroupId,
          leaseEpoch: rotation.leaseEpoch,
          reason: "rotation_in_progress",
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
      return claimedResult({ status: "recovering" });
    } catch (recoveryError) {
      console.error(
        "sandbox deadline rotation recovery failed",
        safeErrorDiagnostic(recoveryError),
      );
      throw recoveryError;
    }
  }
  const cancellationFailure = turnOperationCancellationFailure(error);
  if (cancellationFailure && isWorkerShutdownCancellation(cancellationFailure) && recoveryTurnId) {
    try {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth();
      // An approval-decision rerun always replays its original trigger. The
      // decision is applied through the exact durable open-suffix receipt and
      // its paired history, so swapping the trigger for a resume notice could
      // drop the user's decision. Re-applying an already-consumed approval
      // re-enters at most the single approved step. Every approval-gated MCP
      // action crosses the durable execution-admission fence before provider
      // invocation, so a consumed step resumes as already-executed or
      // outcome-unknown rather than calling MCP again.
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: "worker_shutdown",
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
      return claimedResult({ status: "recovering" });
    } catch (recoveryError) {
      // The database transition is atomic. If it could not commit, surface
      // the failure so Temporal can retry on a healthy worker; never mutate
      // the turn through a second cancellation path.
      console.error(
        "worker-shutdown recovery checkpoint failed",
        safeErrorDiagnostic(recoveryError),
      );
      throw recoveryError;
    }
  }
  if (error instanceof TurnAttemptFencedError) {
    control.activityStatus = "cancelled";
    control.activityError = error;
    control.acknowledgeQuiescence = true;
    noteCancellationRequested();
    await waitForTurnFinalizerStep(
      flushRuntimeBatcher(),
      turnFinalizerCancellationSignal(cancellationSignal, control.activityStatus),
    );
    // Ownership already moved to a newer attempt or an authoritative
    // control transaction. Surface the exact transport cancellation rather
    // than a normal result. Temporal terminalization remains diagnostic
    // only; replacement admission waits for the activity-owned durable
    // quiescence receipt written from the hard tool fence below.
    control.turnMetricOutcome = "cancelled";
    throw new CancelledFailure("TURN_ATTEMPT_FENCED", [], error);
  }
  if (cancellationFailure) {
    control.activityStatus = "cancelled";
    control.activityError = error;
    control.acknowledgeQuiescence = true;
    noteCancellationRequested();
    await waitForTurnFinalizerStep(
      flushRuntimeBatcher(),
      turnFinalizerCancellationSignal(cancellationSignal, control.activityStatus),
    );
    // The workflow owns cancellation settlement: Pause/Steer controls use
    // settleSessionControl, and heartbeat timeouts use worker-death
    // recovery. A dying activity must never append a
    // competing cancellation or mutate the turn/session on its own.
    control.turnMetricOutcome = "cancelled";
    throw cancellationFailure;
  }
  // The SDK's per-segment turn cap is a pacing valve, not a failure: end
  // the turn gracefully and idle the session so an active goal continues
  // via a synthesized continuation turn (or a user message resumes work).
  // The run state captured at the cap keeps full conversation context for
  // that resumption.
  const maxTurns = maxTurnsExceededRunState(error);
  if (maxTurns && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    await flushRuntimeBatcher();
    // The SDK attaches the run state at the throw site; persisting it lets
    // the continuation resume with this segment's full context. If capture
    // ever fails, the continuation falls back to the previous snapshot --
    // degraded context, flagged on the event, but still strictly better
    // than a terminal failed session: the sandbox filesystem state
    // persists independently and the agent re-derives from it.
    await historySink.reconcileConversationTruth();
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "turn.completed",
            payload: { output: "", segmentLimit: "max_turns" },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
      }))
    ) {
      return claimedResult({ status: "cancelled" });
    }
    control.turnMetricOutcome = "completed";
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "agent_run.completed",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session_turn",
      sourceResourceId: attempt.turnId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      turnAttemptId: input.attemptId,
      idempotencyKey: `usage:agent_run.completed:${attempt.turnId}`,
    });
    control.activityStatus = "idle";
    return claimedResult({ status: "idle" });
  }
  const settleLostCodexAttempt = async (
    lostTurnId: string,
    holderId: string,
    generation: number,
    historyCheckpointDurable = false,
  ): Promise<RunAgentTurnResult> => {
    let checkpointDurable = historyCheckpointDurable;
    try {
      if (!historyCheckpointDurable) {
        await flushRuntimeBatcher();
        await historySink.reconcileConversationTruth({ requireDurable: true });
      }
      checkpointDurable = true;
    } catch {
      observability.warn("Codex lease-loss checkpoint failed; refusing automatic turn replay", {
        errorClass: "CodexCheckpointOperationError",
        errorCode: "codex_lease_loss_checkpoint_failed",
        origin: "worker",
      });
    }

    const settlement = await settleCodexCredentialLeaseLoss(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: lostTurnId,
      attemptId: input.attemptId,
      holderId,
      generation,
      expectedRedispatches: attempt.redispatchesAtDispatch,
      checkpointDurable,
      recoveryPayload: {
        triggerEventId: attempt.triggerEventId!,
        reason: "codex_lease_lost",
        credentialId: providerTurn.effectiveCodexCredentialId,
      },
      failedPayload: {
        error:
          "The Codex credential lease was lost and the latest conversation checkpoint could not be persisted. Automatic replay was refused.",
        code: "codex_lease_checkpoint_failed",
        retryable: false,
      },
    });
    leases.codex.held = false;
    observability.incrementCounter({
      name: "opengeni_codex_lease_loss_settlements_total",
      help: "Fenced Codex lease-loss settlements by outcome.",
      labels: {
        workspace_key: codexWorkspaceKey,
        outcome: settlement.action,
      },
    });
    await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, settlement.events);
    control.activityError = error;
    if (settlement.action === "failed") {
      control.activityStatus = "failed";
      control.turnMetricOutcome = "failed";
      await deliverFailedChildTurnToParent(
        { db, bus, settings, observability, wakeSessionWorkflow },
        input.workspaceId,
        input.sessionId,
        lostTurnId,
      );
      return claimedResult({ status: "failed" });
    }
    control.activityStatus = "recovering";
    control.turnMetricOutcome = "recovering";
    return claimedResult({ status: "recovering" });
  };

  // A missing/expired/superseded lease is an execution-ownership failure,
  // not a provider failure. Settle it before credential quarantine or the
  // generic terminal path: the DB transaction marks a still-current turn
  // recoverable, but a successor attempt or worker recovery makes this activity
  // stale and unable to clobber the shared turn/session.
  if (
    (leases.codex.lost || error instanceof CodexCredentialLeaseLostError) &&
    billingState.isCodexTurn &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished &&
    leases.codex.holderId &&
    leases.codex.generation !== null
  ) {
    return await settleLostCodexAttempt(
      attempt.turnId,
      leases.codex.holderId,
      leases.codex.generation,
    );
  }
  const scopedLeaseLost =
    billingState.isClaudeTurn && leases.claude.lost
      ? "claude"
      : billingState.isXaiTurn && leases.xai.lost
        ? "xai"
        : null;
  if (scopedLeaseLost && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId!,
      attemptId: input.attemptId,
      reason: scopedLeaseLost + "_lease_lost",
      detail: {
        provider: scopedLeaseLost === "claude" ? "claude-subscription" : "supergrok-subscription",
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
    return claimedResult({ status: "recovering" });
  }
  // Definitive Codex credential/account refusals are the only provider
  // errors that may walk the pool. This is an explicit checkpoint + SAME
  // turn recovery, never an SDK/Temporal blind retry. A network break,
  // malformed/partial 200 stream, invalid content, prompt 4xx, or provider
  // 5xx does not classify here and therefore cannot consume another
  // subscription or duplicate a side effect.
  const usageLimit = isCodexTransportError(error) ? classifyCodexUsageLimitError(error) : null;
  let codexCredentialFailure: CodexCredentialFailure | null =
    billingState.isCodexTurn && providerTurn.effectiveCodexCredentialId
      ? classifyCodexCredentialFailure(error)
      : null;
  // Plan entitlement evidence (an explicit plan refusal, or an HTTP 400 with no
  // body) is ambiguous until the serving account's CURRENT plan is re-read. A
  // proven loss becomes a definitive `plan_entitlement` refusal for this model
  // only and walks the pool through the same checkpointed failover below; an
  // unexplained rejection stays terminal with typed copy. Nothing retries the
  // rejected request itself.
  let codexTerminalFailure:
    | CodexPlanEntitlementFailurePayload
    | CodexRequestRejectedFailurePayload
    | null = null;
  let codexPlanEntitlement: {
    modelId: string;
    planType: string | null;
    planObserved: boolean;
    credentialVersion: number | null;
    waitPayload: CodexPlanEntitlementFailurePayload;
  } | null = null;
  const codexEntitlementRejection =
    billingState.isCodexTurn && providerTurn.effectiveCodexCredentialId && !codexCredentialFailure
      ? classifyCodexEntitlementRejection(error)
      : null;
  if (
    codexEntitlementRejection &&
    providerTurn.effectiveCodexCredentialId &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished &&
    leases.codex.holderId &&
    leases.codex.generation !== null
  ) {
    const servingCredentialId = providerTurn.effectiveCodexCredentialId;
    const servingAccount = (
      await listCodexAccountStatuses(db, input.workspaceId, attempt.turnId).catch(() => [])
    ).find((account) => account.id === servingCredentialId);
    const accountLabel = codexAccountDisplayLabel(servingAccount);
    const recheck = await recheckCodexCredentialPlan(
      db,
      settings,
      input.workspaceId,
      servingCredentialId,
      {
        turnId: attempt.turnId,
        holderId: leases.codex.holderId,
        generation: leases.codex.generation,
      },
    ).catch(() => null);
    const modelId = providerTurn.codexProductModelId ?? null;
    const assessment = recheck
      ? assessCodexPlanEntitlement(codexEntitlementRejection, recheck, modelId)
      : codexEntitlementRejection.evidence === "plan_entitlement"
        ? {
            kind: "entitlement_lost" as const,
            planType: servingAccount?.planType ?? null,
            planObserved: false,
            planChanged: false,
            credentialVersion: null,
          }
        : { kind: "unexplained" as const, planType: null };
    observability.incrementCounter({
      name: "opengeni_codex_plan_rechecks_total",
      help: "Codex plan re-checks after an entitlement-shaped rejection, by outcome.",
      labels: {
        workspace_key: codexWorkspaceKey,
        evidence: codexEntitlementRejection.evidence,
        outcome: assessment.kind,
        source: recheck?.source ?? "none",
      },
    });
    if (assessment.kind === "entitlement_lost") {
      const payloadInput = {
        accountLabel,
        // Name a plan only when the provider just reported it; a recorded
        // plan may be the very one that changed.
        planType: assessment.planObserved ? assessment.planType : null,
        planChanged: assessment.planChanged,
        modelId,
        rejection: codexEntitlementRejection,
      };
      codexTerminalFailure = codexPlanEntitlementFailurePayload(payloadInput);
      if (modelId) {
        codexCredentialFailure = { kind: "plan_entitlement", cooldownSeconds: null };
        codexPlanEntitlement = {
          modelId,
          planType: assessment.planType,
          planObserved: assessment.planObserved,
          credentialVersion: assessment.credentialVersion,
          waitPayload: codexPlanEntitlementFailurePayload({ ...payloadInput, waiting: true }),
        };
      }
    } else {
      codexTerminalFailure = codexRequestRejectedFailurePayload({
        accountLabel,
        planType: recheck?.planType ?? null,
        rejection: codexEntitlementRejection,
      });
    }
  }
  if (
    codexCredentialFailure &&
    providerTurn.effectiveCodexCredentialId &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    observability.incrementCounter({
      name: "opengeni_codex_credential_failures_total",
      help: "Definitive Codex credential failures classified for safe failover.",
      labels: {
        workspace_key: codexWorkspaceKey,
        kind: codexCredentialFailure.kind,
        outcome: "classified",
      },
    });
    const failoverStartedAt = performance.now();
    let checkpointDurable = false;
    try {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
      checkpointDurable = true;
    } catch {
      observability.incrementCounter({
        name: "opengeni_codex_failover_checkpoints_total",
        help: "Durable Codex failover checkpoint attempts by outcome.",
        labels: { workspace_key: codexWorkspaceKey, outcome: "failed" },
      });
      observability.warn("Codex failover checkpoint failed; refusing automatic replay", {
        errorClass: "CodexCheckpointOperationError",
        errorCode: "codex_failover_checkpoint_failed",
        origin: "worker",
      });
    }

    if (checkpointDurable) {
      observability.incrementCounter({
        name: "opengeni_codex_failover_checkpoints_total",
        help: "Durable Codex failover checkpoint attempts by outcome.",
        labels: { workspace_key: codexWorkspaceKey, outcome: "completed" },
      });
      const now = new Date();
      const before = await listCodexAccountStatuses(db, input.workspaceId, attempt.turnId).catch(
        () => [],
      );
      const servingCached = before.find(
        (account) => account.id === providerTurn.effectiveCodexCredentialId,
      );
      const usageSnapshot = providerTurn.latestCodexUsage as CodexUsageHeaderSnapshot | null;
      const serving = servingCached
        ? {
            ...servingCached,
            ...(usageSnapshot
              ? {
                  primaryUsedPercent: usageSnapshot.primaryUsedPercent,
                  primaryResetAt: usageSnapshot.primaryResetAt,
                  secondaryUsedPercent: usageSnapshot.secondaryUsedPercent,
                  secondaryResetAt: usageSnapshot.secondaryResetAt,
                }
              : {}),
          }
        : null;
      const cooldownUntil = codexCredentialCooldownUntil(codexCredentialFailure, serving, now);
      // A plan re-check may itself have rotated tokens (same family, version
      // CAS-advanced by this holder); fence the quarantine on that version.
      const quarantineCredentialVersion =
        codexPlanEntitlement?.credentialVersion ?? providerTurn.effectiveCodexCredentialVersion;
      const quarantineResult =
        leases.codex.holderId &&
        leases.codex.generation !== null &&
        quarantineCredentialVersion !== null
          ? await quarantineCodexCredentialForLease(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: attempt.turnId,
              attemptId: input.attemptId,
              executionGeneration: attempt.executionGeneration,
              workflowId: input.workflowId,
              workflowRunId: input.workflowRunId,
              dispatchId: attempt.dispatchId,
              expectedRedispatches: attempt.redispatchesAtDispatch,
              credentialId: providerTurn.effectiveCodexCredentialId,
              credentialVersion: quarantineCredentialVersion,
              holderId: leases.codex.holderId,
              generation: leases.codex.generation,
              maxFailovers: providerTurn.codexCredentialFailoverLimit,
              quarantine:
                codexCredentialFailure.kind === "auth"
                  ? {
                      kind: "status",
                      status: "needs_relogin",
                      lastError: "model request remained unauthorized after refresh",
                    }
                  : codexCredentialFailure.kind === "forbidden"
                    ? {
                        kind: "status",
                        status: "error",
                        lastError: "model request was forbidden for this credential",
                      }
                    : codexCredentialFailure.kind === "plan_entitlement"
                      ? {
                          kind: "plan_entitlement",
                          modelId: codexPlanEntitlement!.modelId,
                          planType: codexPlanEntitlement!.planType,
                          planObserved: codexPlanEntitlement!.planObserved,
                        }
                      : {
                          kind: "cooldown",
                          until: cooldownUntil!,
                          cooldownKind: codexCredentialFailure.kind,
                        },
            })
          : null;
      if (
        quarantineResult?.action === "credential_changed" &&
        leases.codex.holderId &&
        leases.codex.generation !== null
      ) {
        const recovery = await settleCodexCredentialLeaseLoss(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          attemptId: input.attemptId,
          holderId: leases.codex.holderId,
          generation: leases.codex.generation,
          expectedRedispatches: attempt.redispatchesAtDispatch,
          checkpointDurable: true,
          recoveryPayload: {
            triggerEventId: attempt.triggerEventId!,
            reason: "codex_credential_version_changed",
          },
          failedPayload: {},
        });
        if (recovery.action === "recovering") {
          leases.codex.held = false;
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          control.activityStatus = "recovering";
          control.turnMetricOutcome = "recovering";
          return claimedResult({ status: "recovering" });
        }
        acknowledgeLostAttemptOwnership();
        control.activityStatus = "cancelled";
        control.turnMetricOutcome = "cancelled";
        return claimedResult({ status: "cancelled" });
      }
      const statePersisted = quarantineResult?.action === "recorded";
      if (!statePersisted && leases.codex.holderId && leases.codex.generation !== null) {
        leases.codex.lost = true;
        return await settleLostCodexAttempt(
          attempt.turnId,
          leases.codex.holderId,
          leases.codex.generation,
          true,
        );
      }
      if (
        quarantineResult?.action === "recorded" &&
        quarantineResult.exhausted &&
        leases.codex.holderId &&
        leases.codex.generation !== null
      ) {
        const settlement = await settleCodexCredentialFailover(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          attemptId: input.attemptId,
          holderId: leases.codex.holderId,
          generation: leases.codex.generation,
          expectedRedispatches: attempt.redispatchesAtDispatch,
          maxFailovers: quarantineResult.maxFailovers,
          recoveryPayload: {
            triggerEventId: attempt.triggerEventId!,
            reason: "codex_credential_failover",
            credentialId: providerTurn.effectiveCodexCredentialId,
            failureKind: codexCredentialFailure.kind,
          },
          failedPayload: {
            error:
              "Automatic Codex credential failover stopped after every bounded account attempt was consumed. Send a new message after checking account health or capacity.",
            code: "codex_credential_failover_exhausted",
            retryable: false,
            recovery: "user_message",
            failoverCount: quarantineResult.failoverCount,
            maxFailovers: quarantineResult.maxFailovers,
          },
        });
        if (settlement.action === "limit_exceeded") {
          leases.codex.held = false;
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            settlement.events,
          );
          control.activityError = error;
          control.activityStatus = "idle";
          control.turnMetricOutcome = "failed";
          await deliverFailedChildTurnToParent(
            { db, bus, settings, observability, wakeSessionWorkflow },
            input.workspaceId,
            input.sessionId,
            attempt.turnId,
          );
          return claimedResult({ status: "idle" });
        }
        if (settlement.action === "stale") {
          acknowledgeLostAttemptOwnership();
          control.activityStatus = "cancelled";
          control.turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        throw new Error("Exhausted Codex failover receipt unexpectedly recovered");
      }
      let accounts: Awaited<ReturnType<typeof listCodexAccountStatuses>>;
      try {
        accounts = await listCodexAccountStatuses(db, input.workspaceId, attempt.turnId);
      } catch (metadataError) {
        // Current account health/cooldown metadata is still required after
        // quarantine. Operational database failures re-enter the existing
        // exact-attempt recovery lane; no policy choice is made from partial
        // account state.
        const recoveryFailure = postClaimDatabaseRecoveryFailure({
          error: metadataError,
          turnId: attempt.turnId,
          triggerEventId: attempt.triggerEventId!,
          executionGeneration: attempt.executionGeneration,
        });
        if (recoveryFailure) {
          control.activityStatus = "recovering";
          control.turnMetricOutcome = "recovering";
          control.activityError = metadataError;
          throw recoveryFailure;
        }
        throw metadataError;
      }
      const acceptedPolicy = acceptedCodexPolicySnapshot(providerTurn);
      const selected = selectCodexCredentialLeaseForTurn({
        context: {
          accounts: codexLeaseAccountsForSelection(accounts),
          activeCredentialId: acceptedPolicy.activeCredentialId,
          rotationEnabled: acceptedPolicy.rotationEnabled,
          rotationStrategy: acceptedPolicy.rotationStrategy,
          existingCredentialId: null,
          failedCredentialIds: [providerTurn.effectiveCodexCredentialId],
          ...(providerTurn.codexProductModelId
            ? { modelId: providerTurn.codexProductModelId }
            : {}),
          policyScope: null,
          unavailableDiagnostics: [],
        },
        sessionId: input.sessionId,
        sessionPinnedCredentialId: acceptedPolicy.pinnedCredentialId,
        sessionPinSource: acceptedPolicy.pinSource,
        sessionLastCredentialId: acceptedPolicy.lastCredentialId,
        now,
      });
      const decisionKind =
        selected.decision.kind === "allocatorDisabled" ? "allCapped" : selected.decision.kind;
      const pinDisposition = classifyCodexPin({
        pinnedCredentialId: acceptedPolicy.pinnedCredentialId,
        pinSource: acceptedPolicy.pinSource,
        strategy: acceptedPolicy.rotationStrategy as CodexRotationStrategy,
        rotationEnabled: acceptedPolicy.rotationEnabled,
      });
      const failureDisposition = codexDefinitiveFailureDisposition({
        failureKind: codexCredentialFailure.kind,
        rotationEnabled: acceptedPolicy.rotationEnabled,
        pinDisposition,
        decisionKind,
        decisionCredentialId: selected.decision.kind === "active" ? selected.credentialId : null,
        servingCredentialId: providerTurn.effectiveCodexCredentialId,
      });
      const maxFailovers = providerTurn.codexCredentialFailoverLimit;

      if (
        statePersisted &&
        failureDisposition === "failover" &&
        leases.codex.holderId &&
        leases.codex.generation !== null
      ) {
        const settlement = await settleCodexCredentialFailover(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          attemptId: input.attemptId,
          holderId: leases.codex.holderId,
          generation: leases.codex.generation,
          expectedRedispatches: attempt.redispatchesAtDispatch,
          maxFailovers,
          recoveryPayload: {
            triggerEventId: attempt.triggerEventId!,
            reason: "codex_credential_failover",
            credentialId: providerTurn.effectiveCodexCredentialId,
            failureKind: codexCredentialFailure.kind,
            ...(cooldownUntil ? { cooldownUntil: cooldownUntil.toISOString() } : {}),
          },
          failedPayload: {
            error:
              "Automatic Codex credential failover stopped after every bounded account attempt was consumed. Send a new message after checking account health or capacity.",
            code: "codex_credential_failover_exhausted",
            retryable: false,
            recovery: "user_message",
            failoverCount: quarantineResult.failoverCount,
            maxFailovers: quarantineResult.maxFailovers,
          },
        });
        observability.incrementCounter({
          name: "opengeni_codex_failover_settlements_total",
          help: "Atomic Codex failover settlements by outcome.",
          labels: {
            workspace_key: codexWorkspaceKey,
            outcome: settlement.action,
          },
        });
        if (settlement.action === "recovering") {
          leases.codex.held = false;
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            settlement.events,
          );
          observability.observeHistogram({
            name: "opengeni_codex_failover_recovery_seconds",
            help: "Time from credential refusal to durable same-turn recovery.",
            labels: {
              workspace_key: codexWorkspaceKey,
              kind: codexCredentialFailure.kind,
            },
            value: Math.max(0, (performance.now() - failoverStartedAt) / 1000),
          });
          control.activityStatus = "recovering";
          control.turnMetricOutcome = "recovering";
          return claimedResult({ status: "recovering" });
        }
        if (settlement.action === "stale") {
          // One transaction proves both exact-holder recovery (including a
          // just-expired or reaped lease row) and successor/control-gate
          // rejection. Cross the hard tool fence so a control-gate loss can
          // write its quiescence receipt; a successor-only loss is a no-op.
          acknowledgeLostAttemptOwnership();
          control.activityStatus = "cancelled";
          control.turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        if (settlement.action === "limit_exceeded") {
          leases.codex.held = false;
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            settlement.events,
          );
          control.activityError = error;
          control.activityStatus = "idle";
          control.turnMetricOutcome = "failed";
          await deliverFailedChildTurnToParent(
            { db, bus, settings, observability, wakeSessionWorkflow },
            input.workspaceId,
            input.sessionId,
            attempt.turnId,
          );
          return claimedResult({ status: "idle" });
        }
      }

      if (
        statePersisted &&
        failureDisposition === "wait" &&
        leases.codex.holderId &&
        leases.codex.generation !== null
      ) {
        let goal: Awaited<ReturnType<typeof getSessionGoal>>;
        try {
          goal = await getSessionGoal(db, input.workspaceId, input.sessionId);
        } catch (metadataError) {
          const recoveryFailure = postClaimDatabaseRecoveryFailure({
            error: metadataError,
            turnId: attempt.turnId,
            triggerEventId: attempt.triggerEventId!,
            executionGeneration: attempt.executionGeneration,
          });
          if (recoveryFailure) {
            control.activityStatus = "recovering";
            control.turnMetricOutcome = "recovering";
            control.activityError = metadataError;
            throw recoveryFailure;
          }
          throw metadataError;
        }
        const activeGoal = goal?.status === "active" ? goal : null;
        const exactProviderReset =
          codexCredentialFailure.cooldownSeconds !== null &&
          Number.isFinite(codexCredentialFailure.cooldownSeconds) &&
          codexCredentialFailure.cooldownSeconds > 0;
        const policyCredentialId =
          pinDisposition === "manual" && acceptedPolicy.pinnedCredentialId
            ? acceptedPolicy.pinnedCredentialId
            : !acceptedPolicy.rotationEnabled
              ? acceptedPolicy.activeCredentialId
              : null;
        const capacityAccounts = policyCredentialId
          ? accounts.filter((account) => account.id === policyCredentialId)
          : accounts;
        const authoritativeResetAt =
          exactProviderReset || codexCredentialFailure.kind === "plan_entitlement"
            ? (authoritativeCodexCapacityResetAt(capacityAccounts, now) ?? cooldownUntil)
            : null;
        const allAccounts =
          acceptedPolicy.rotationEnabled &&
          pinDisposition !== "manual" &&
          decisionKind === "allCapped";
        const failurePayload = codexCapacityWaitFailurePayload({
          failureKind: codexCredentialFailure.kind,
          usageLimit,
          cooldownSeconds: codexCredentialFailure.cooldownSeconds,
          detail:
            codexCredentialFailure.kind === "quota"
              ? error instanceof Error
                ? error.message
                : String(error)
              : "the same accepted turn is waiting for eligible credential capacity",
          allAccounts,
          planEntitlement: codexPlanEntitlement?.waitPayload ?? null,
        });
        const evaluated = await armAndReconcileCodexCapacityWait(
          { db, bus },
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: attempt.turnId,
            attemptId: input.attemptId,
            workflowId: input.workflowId,
            goalId: activeGoal?.id ?? null,
            goalVersion: activeGoal?.version ?? null,
            earliestResetAt: authoritativeResetAt,
            // plan_entitlement waits only on OTHER capped accounts, so it keeps
            // their reset/bounded-refresh cadence rather than a mutation-only wait.
            resetKind: authoritativeResetAt
              ? "authoritative"
              : codexCredentialFailure.kind === "auth" ||
                  codexCredentialFailure.kind === "forbidden"
                ? "mutation_only"
                : "bounded_refresh",
            failurePayload,
            leaseFence: {
              holderId: leases.codex.holderId,
              generation: leases.codex.generation,
            },
            expectedRedispatches: attempt.redispatchesAtDispatch,
          },
          { onArmed: () => (leases.codex.held = false) },
        );
        control.activityError = error;
        if (evaluated.action === "stopped") {
          control.activityStatus = evaluated.sessionStatus === "queued" ? "idle" : "failed";
          control.turnMetricOutcome = "failed";
          return claimedResult({ status: control.activityStatus });
        }
        if (evaluated.action === "resumed") {
          control.activityStatus = "recovering";
          control.turnMetricOutcome = "recovering";
          return claimedResult({ status: "recovering" });
        }
        if (evaluated.action === "waiting") {
          control.activityError = error;
          control.activityStatus = "waiting_capacity";
          control.turnMetricOutcome = "recovering";
          return claimedResult({
            status: "waiting_capacity",
            capacityWait: {
              waiterId: evaluated.waiter.id,
              generation: evaluated.waiter.generation,
              nextCheckAt: evaluated.waiter.nextCheckAt.toISOString(),
              wakeRevision: evaluated.waiter.wakeRevision,
            },
          });
        }
        acknowledgeLostAttemptOwnership();
        control.activityStatus = "cancelled";
        control.turnMetricOutcome = "cancelled";
        return claimedResult({ status: "cancelled" });
      }
    }
  }
  const xaiFailure =
    billingState.isXaiTurn && providerTurn.effectiveXaiCredentialId
      ? classifyXaiCredentialFailure(error)
      : null;
  const claudeFailure =
    billingState.isClaudeTurn && providerTurn.effectiveClaudeCredentialId
      ? classifyClaudeCredentialFailure(error)
      : null;
  const scopedFailure = claudeFailure ?? xaiFailure;
  const scopedProvider = claudeFailure ? ("claude" as const) : ("xai" as const);
  const scopedName = claudeFailure ? "Claude" : "SuperGrok";
  const scopedCredentialId = claudeFailure
    ? providerTurn.effectiveClaudeCredentialId
    : providerTurn.effectiveXaiCredentialId;
  const scopedAuthority = claudeFailure
    ? providerTurn.claudeAuthoritySnapshot
    : providerTurn.xaiAuthoritySnapshot;
  const scopedLease = claudeFailure ? leases.claude : leases.xai;
  const armScopedWait = claudeFailure ? armClaudeCapacityWait : armXaiCapacityWait;
  const reconcileScopedWait = claudeFailure
    ? reconcileClaudeCapacityWait
    : reconcileXaiCapacityWait;
  if (
    scopedFailure &&
    scopedCredentialId &&
    scopedAuthority &&
    scopedLease.subjectId &&
    scopedLease.holderId &&
    scopedLease.generation !== null &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    const recoverChangedAccount = async () => {
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: attempt.turnId!,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: "claude_credential_changed",
        detail: { code: "claude_credential_changed", retryable: true },
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
    };
    const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
    const activeGoal = goal?.status === "active" ? goal : null;
    const now = new Date();
    const cooldownUntil =
      scopedFailure.kind === "rate_limit"
        ? new Date(now.getTime() + Math.max(1, scopedFailure.cooldownMs ?? 60_000))
        : null;
    if (claudeFailure) {
      const key = environmentsEncryptionKeyBytes(settings);
      const matchingReceipts = [...providerTurn.latestClaudeUsage.values()].filter(
        (value) =>
          value.expectedConnectionId === scopedCredentialId &&
          value.expectedCredentialVersion === providerTurn.effectiveClaudeCredentialVersion &&
          value.upstreamModelId === providerTurn.claudeUpstreamModelId &&
          (value.responseStatus === (scopedFailure.kind === "rate_limit" ? 429 : 401) ||
            (value.responseStatus === 200 &&
              !!claudeFailure.requestId &&
              value.requestId === claudeFailure.requestId)) &&
          (!claudeFailure.requestId || value.requestId === claudeFailure.requestId),
      );
      const receipt = matchingReceipts.length === 1 ? matchingReceipts[0] : undefined;
      if (
        !key ||
        !providerTurn.claudeUpstreamModelId ||
        providerTurn.effectiveClaudeCredentialVersion === null
      )
        throw new Error("Claude refused request has no exact serving account");
      if (!receipt) {
        // Refresh may discover a revoked grant before any physical model call.
        // Verify durable reconnect evidence instead of inventing a response receipt.
        const current = await loadClaudeAccountCredential(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: scopedLease.subjectId,
            credentialId: scopedCredentialId,
            authoritySnapshot: scopedAuthority,
          },
          key,
        );
        if (current.version !== providerTurn.effectiveClaudeCredentialVersion)
          return await recoverChangedAccount();
        if (scopedFailure.kind !== "auth" || current.usage.refreshStatus !== "reconnect")
          throw new Error("Claude refused request has no exact account receipt");
      }
      if (
        receipt &&
        scopedFailure.kind === "auth" &&
        !(
          attempt.claudeAuthRecovery?.credentialId === scopedCredentialId &&
          attempt.claudeAuthRecovery.credentialVersion === receipt.expectedCredentialVersion
        )
      ) {
        const credential = await resolveClaudeAccountCredential(
          db,
          settings,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: scopedLease.subjectId,
            credentialId: scopedCredentialId,
            authoritySnapshot: scopedAuthority,
          },
          {
            expectedCredentialVersion: receipt.expectedCredentialVersion,
            forceRefresh: true,
            observedAccessToken: receipt.token,
          },
        ).catch((error) => {
          if (error instanceof ClaudeSubscriptionConnectionChanged) return null;
          throw error;
        });
        if (!credential) return await recoverChangedAccount();
        if (!("reconnectRequired" in credential) && credential.secret.token !== receipt.token) {
          const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
            sessionId: input.sessionId,
            turnId: attempt.turnId,
            triggerEventId: attempt.triggerEventId!,
            attemptId: input.attemptId,
            reason: "claude_token_renewed",
            claudeAuthRecovery: {
              credentialId: scopedCredentialId,
              credentialVersion: receipt.expectedCredentialVersion,
            },
            detail: { code: "claude_token_renewed", retryable: true },
          });
          if (recovery.action === "stale") {
            acknowledgeLostAttemptOwnership();
            control.activityStatus = "cancelled";
            control.turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          control.activityStatus = "recovering";
          control.turnMetricOutcome = "recovering";
          control.activityError = error;
          return claimedResult({ status: "recovering" });
        }
      }
      const recorded = receipt
        ? await recordClaudeAccountUsage(
            db,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              subjectId: scopedLease.subjectId,
              credentialId: scopedCredentialId,
              authoritySnapshot: scopedAuthority,
            },
            {
              encryptionKey: key,
              token: receipt.token,
              expectedCredentialVersion: receipt.expectedCredentialVersion,
              ...(receipt.observation ? { observation: receipt.observation } : {}),
              ...(receipt.refresh ? { refresh: receipt.refresh } : {}),
              ...(cooldownUntil
                ? {
                    modelCooldown: {
                      upstreamModelId:
                        receipt.upstreamModelId ?? providerTurn.claudeUpstreamModelId,
                      until: cooldownUntil,
                    },
                  }
                : {}),
            },
          )
        : true;
      if (!recorded) return await recoverChangedAccount();
    }
    const failurePayload = {
      error:
        scopedFailure.kind === "auth"
          ? "The serving " + scopedName + " account requires reconnection"
          : scopedFailure.kind === "forbidden"
            ? "The serving " + scopedName + " account is not authorized for this request"
            : "The serving " + scopedName + " account is temporarily rate limited",
      code:
        scopedFailure.kind === "auth"
          ? scopedProvider + "_relogin_required"
          : scopedFailure.kind === "forbidden"
            ? scopedProvider + "_account_forbidden"
            : scopedProvider + "_account_rate_limited",
      detail: "the same accepted turn is waiting for another eligible account",
    };
    const armed = await armScopedWait(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: scopedLease.subjectId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      attemptId: input.attemptId,
      workflowId: input.workflowId,
      authoritySnapshot: scopedAuthority,
      goalId: activeGoal?.id ?? null,
      goalVersion: activeGoal?.version ?? null,
      earliestResetAt: cooldownUntil,
      failurePayload,
      leaseFence: {
        holderId: scopedLease.holderId,
        generation: scopedLease.generation,
      },
      ...(claudeFailure
        ? { expectedCredentialVersion: providerTurn.effectiveClaudeCredentialVersion! }
        : {}),
      ...(!claudeFailure || scopedFailure.kind !== "rate_limit"
        ? {
            credentialQuarantine:
              scopedFailure.kind === "auth"
                ? {
                    kind: "status",
                    status: "needs_relogin",
                    lastError: "model request remained unauthorized after refresh",
                  }
                : scopedFailure.kind === "forbidden"
                  ? {
                      kind: "status",
                      status: "error",
                      lastError: "model request was forbidden for this credential",
                    }
                  : { kind: "cooldown", until: cooldownUntil! },
          }
        : {}),
      now,
    });
    if (armed.action === "waiting") {
      scopedLease.held = false;
      if (!claudeFailure) providerTurn.xaiCredentialQuarantined = true;
      await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
      const evaluated = await reconcileScopedWait(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        waiterId: armed.waiter.id,
        generation: armed.waiter.generation,
        now,
      });
      if (evaluated.events.length > 0) {
        await publishDurableSessionEvents(
          bus,
          input.workspaceId,
          input.sessionId,
          evaluated.events,
        );
      }
      control.activityError = error;
      if (evaluated.action === "resumed") {
        control.activityStatus = "recovering";
        control.turnMetricOutcome = "recovering";
        return claimedResult({ status: "recovering" });
      }
      if (evaluated.action === "waiting") {
        control.activityStatus = "waiting_capacity";
        control.turnMetricOutcome = "recovering";
        return claimedResult({
          status: "waiting_capacity",
          capacityWait: {
            provider: scopedProvider,
            waiterId: evaluated.waiter.id,
            generation: evaluated.waiter.generation,
            nextCheckAt: evaluated.waiter.nextCheckAt.toISOString(),
            wakeRevision: evaluated.waiter.wakeRevision,
          },
        });
      }
      acknowledgeLostAttemptOwnership();
      control.activityStatus = "cancelled";
      control.turnMetricOutcome = "cancelled";
      return claimedResult({ status: "cancelled" });
    }

    const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId!,
      attemptId: input.attemptId,
      reason: scopedProvider + "_credential_recheck",
      detail: failurePayload,
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
  // The leased credential path above normally quarantines quota state and
  // either recovers the same turn or arms a durable capacity wait. This narrow
  // fallback covers failures before a credential lease existed, or a failed
  // durable checkpoint where replay would be unsafe. Keep the session usable,
  // but never synthesize another turn or walk an unfenced legacy pointer.
  if (usageLimit && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth();
    const failurePayload = codexUsageLimitFailurePayload(
      usageLimit,
      error instanceof Error ? error.message : String(error),
    );
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "turn.failed",
            payload: {
              ...failurePayload,
              recovery: "user_message",
            },
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
    return claimedResult({ status: "idle" });
  }
  // Budget/limit exhaustion between model calls is account state, not an
  // agent failure: idle the session for goal-bearing and goal-less runs
  // alike (a failed session would reject the user's next message after a
  // top-up). An active goal pauses visibly with reason "limits" at the
  // next continuation evaluation, without consuming continuation budget.
  if (
    error instanceof BudgetExhaustedError &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth();
    if (
      !(await eventing.settle!({
        events: [
          ...(error.allowance
            ? [{ type: "usage.exhausted" as const, payload: error.allowance }]
            : []),
          {
            type: "turn.completed",
            payload: {
              output: "",
              segmentLimit: "budget_exhausted",
              detail: error.message,
              ...(error.allowance ?? {}),
            },
          },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        ...(error.allowance ? { allowanceGoalPause: { rationale: error.allowance.message } } : {}),
      }))
    ) {
      return claimedResult({ status: "cancelled" });
    }
    control.turnMetricOutcome = "completed";
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "agent_run.completed",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session_turn",
      sourceResourceId: attempt.turnId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      turnAttemptId: input.attemptId,
      idempotencyKey: `usage:agent_run.completed:${attempt.turnId}`,
    });
    control.activityStatus = "idle";
    return claimedResult({ status: "idle" });
  }
  // The Codex backend can reject an opaque reasoning artifact that it
  // minted on the immediately preceding successful request, even when the
  // credential-row UUID is unchanged. HTTP 400 + the exact provider
  // semantic proves this request never entered inference. Atomically mark
  // the active opaque artifacts rejected and recover the SAME logical turn
  // from durable history; messages, tool calls/results, readable reasoning,
  // and the original audit rows remain intact. Opaque remote compaction has
  // no portable plaintext representation. If no artifact can be invalidated,
  // fall through to the terminal path rather than resend an equivalent
  // request forever.
  const encryptedArtifactRejection =
    billingState.isCodexTurn && providerTurn.effectiveCodexCredentialId
      ? classifyCodexEncryptedArtifactRejection(error)
      : null;
  if (
    encryptedArtifactRejection &&
    providerTurn.effectiveCodexCredentialId &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    const activeHistory = await getActiveSessionHistoryItemsPaged(
      db,
      input.workspaceId,
      input.sessionId,
    );
    const rejectedHistoryItemIds = selectRejectedProviderArtifactHistoryIds(
      activeHistory,
      historySink.providerArtifactCandidates,
      providerTurn.lastCodexRequestOpaqueArtifacts,
    );
    const rejectedRunStateId =
      historySink.providerArtifactCandidates.runStateId &&
      providerTurn.lastCodexRequestOpaqueArtifacts.length > 0
        ? historySink.providerArtifactCandidates.runStateId
        : undefined;
    const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId!,
      attemptId: input.attemptId,
      reason: encryptedArtifactRejection.kind,
      detail: {
        code: encryptedArtifactRejection.kind,
        retryable: true,
      },
      providerArtifactInvalidation: {
        historyItemIds: rejectedHistoryItemIds,
        ...(rejectedRunStateId ? { runStateId: rejectedRunStateId } : {}),
        reason: encryptedArtifactRejection.kind,
      },
    });
    if (recovery.action === "stale") {
      acknowledgeLostAttemptOwnership();
      control.activityStatus = "cancelled";
      control.turnMetricOutcome = "cancelled";
      return claimedResult({ status: "cancelled" });
    }
    if (recovery.action === "recovering") {
      acknowledgeRecoveryQuiescence();
      await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
      control.turnMetricOutcome = "recovering";
      control.activityStatus = "recovering";
      control.activityError = error;
      return claimedResult({ status: "recovering" });
    }
  }
  // A retryable provider/MCP failure is transient external backpressure,
  // not a session or goal failure. The in-client retry budget is already
  // exhausted by the time the error reaches here. Checkpoint conversation
  // truth, recover this SAME accepted turn, then let the workflow re-claim
  // it after a pacing delay. This is independent of goal state and never
  // relies on a synthetic continuation prompt.
  // A rolling-deployment definition mismatch is a separate configuration
  // class: only the exact typed setup error can use this checkpoint before
  // eventing exists. No generic setup/credential failure gains retry authority.
  const earlyDefinitionMismatch =
    error instanceof TurnExecutionPolicyDefinitionMismatchError &&
    !attempt.modelRequestStarted &&
    !eventing.turnStartedPublished &&
    !!attempt.turnId &&
    !!attempt.triggerEventId &&
    attempt.executionGeneration > 0;
  const earlyCommandStartUnavailable =
    isModalTaskExecStartPreDispatchUnavailableError(error) &&
    !attempt.modelRequestStarted &&
    !eventing.turnStartedPublished &&
    !!attempt.turnId &&
    !!attempt.triggerEventId &&
    attempt.executionGeneration > 0;
  const earlyRecoverableSetup = earlyDefinitionMismatch || earlyCommandStartUnavailable;
  let failure = (
    earlyDefinitionMismatch
      ? { error: error.message, code: error.code, retryable: true }
      : (codexTerminalFailure ??
        agentRunFailurePayload(error, {
          isCodexTurn: billingState.isCodexTurn,
        }))
  ) as ReturnType<typeof agentRunFailurePayload>;
  if (
    attempt.turnId &&
    (earlyRecoverableSetup ||
      (failure.retryable && eventing.publish && eventing.turnStartedPublished))
  ) {
    const nextProviderRecoveryCount = attempt.providerRecoveryCount + 1;
    const recoveryResult = providerRecoveryResult({
      failureCode: failure.code,
      attemptNumber: nextProviderRecoveryCount,
      retryAfterMs: providerRetryAfterMs(error),
    });
    const setupRecoveryExhausted =
      earlyCommandStartUnavailable &&
      recoveryResult.status === "exhausted" &&
      attempt.providerRecoveryCount === SANDBOX_SETUP_RECOVERY_LIMIT;
    try {
      if (setupRecoveryExhausted) {
        // This is positive pre-dispatch proof, not an ambiguous command. Park
        // the SAME accepted turn without resetting or advancing its budget.
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          triggerEventId: attempt.triggerEventId!,
          attemptId: input.attemptId,
          reason: "sandbox_command_start_recovery_exhausted",
          sandboxSetupRecoveryExhausted: true,
          detail: {
            code: failure.code,
            error:
              "Automatic sandbox setup recovery exhausted after five retries; the accepted turn remains parked without starting a command.",
            retryable: false,
            setupOutcome: "not_started",
            replay: "blocked",
            recoveryExhausted: true,
            providerRecoveryCount: SANDBOX_SETUP_RECOVERY_LIMIT,
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
        control.turnMetricOutcome = "recovering";
        control.activityStatus = "recovering";
        control.activityError = error;
        return claimedResult({ status: "recovering" });
      }
      if (recoveryResult.status === "recovering") {
        if (!earlyRecoverableSetup) {
          await flushRuntimeBatcher();
          await historySink.reconcileConversationTruth({ requireDurable: true });
        }
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          triggerEventId: attempt.triggerEventId!,
          attemptId: input.attemptId,
          reason: failure.code ?? "provider_unavailable",
          providerRecoveryCount: nextProviderRecoveryCount,
          detail: {
            ...agentRunRecoveryFailurePayload(error, failure),
            continueDelayMs: recoveryResult.continueDelayMs,
            providerRecoveryCount: nextProviderRecoveryCount,
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
        control.turnMetricOutcome = "recovering";
        control.activityStatus = "recovering";
        control.activityError = error;
        return claimedResult(recoveryResult);
      }
      failure = providerRecoveryExhaustedFailure(failure, recoveryResult);
      if (earlyRecoverableSetup) {
        // Setup has no eventing sink yet. Carry only the fixed, safe diagnostic
        // through Temporal into exact-attempt workflow failure settlement.
        control.activityStatus = "failed";
        control.turnMetricOutcome = "failed";
        control.activityError = error;
        throw ApplicationFailure.create({
          message: earlyDefinitionMismatch
            ? `${error.message}. Automatic same-turn configuration recovery exhausted after ${recoveryResult.providerRecoveryCount} retries.`
            : failure.error,
          type: earlyDefinitionMismatch
            ? "TurnExecutionPolicyDefinitionMismatchError"
            : "SandboxCommandStartUnavailableError",
          nonRetryable: true,
        });
      }
    } catch (recoveryError) {
      const escaped =
        recoveryResult.status === "recovering"
          ? escapedMcpTimeoutRecoveryFailure({
              failureCode: failure.code,
              modelRequestStarted: attempt.modelRequestStarted,
              detail: {
                turnId: attempt.turnId,
                triggerEventId: attempt.triggerEventId!,
                executionGeneration: attempt.executionGeneration,
                providerRecoveryCount: nextProviderRecoveryCount,
                continueDelayMs: recoveryResult.continueDelayMs,
              },
            })
          : null;
      if (escaped) {
        control.activityStatus = "recovering";
        control.turnMetricOutcome = "recovering";
        control.activityError = error;
        throw escaped;
      }
      const postClaimRecovery =
        recoveryResult.status === "recovering"
          ? postClaimDatabaseRecoveryFailure({
              error: recoveryError,
              turnId: attempt.turnId,
              triggerEventId: attempt.triggerEventId!,
              executionGeneration: attempt.executionGeneration,
              providerRecovery: {
                failureCode: failure.code ?? "provider_unavailable",
                providerRecoveryCount: nextProviderRecoveryCount,
              },
            })
          : setupRecoveryExhausted
            ? postClaimDatabaseRecoveryFailure({
                error: recoveryError,
                turnId: attempt.turnId,
                triggerEventId: attempt.triggerEventId!,
                executionGeneration: attempt.executionGeneration,
                sandboxSetupRecoveryExhausted: true,
              })
            : null;
      if (postClaimRecovery) {
        control.activityStatus = "recovering";
        control.turnMetricOutcome = "recovering";
        control.activityError = error;
        throw postClaimRecovery;
      }
      throw recoveryError;
    }
  }
  if (
    attempt.turnId &&
    attempt.triggerEventId &&
    attempt.executionGeneration > 0 &&
    !eventing.turnStartedPublished &&
    !attempt.modelRequestStarted
  ) {
    const recoveryFailure = postClaimDatabaseRecoveryFailure({
      error,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId,
      executionGeneration: attempt.executionGeneration,
    });
    if (recoveryFailure) {
      control.activityStatus = "recovering";
      control.turnMetricOutcome = "recovering";
      control.activityError = error;
      throw recoveryFailure;
    }
  }
  control.activityStatus = "failed";
  control.activityError = error;
  if (!attempt.turnId) {
    throw preClaimAdmissionFailure(error);
  }
  if (!eventing.publish || !eventing.turnStartedPublished) {
    throw error;
  }
  // A partial/malformed stream may have emitted assistant/tool items (and
  // external side effects) before its terminal error. Persist every item the
  // SDK state observed before marking the turn failed so a later user revive
  // never replays work from an incomplete history. This does not retry or
  // rotate the ambiguous request.
  await flushRuntimeBatcher();
  await historySink.reconcileConversationTruth();
  if (
    !(await eventing.settle!({
      events: [
        { type: "turn.failed", payload: failure },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
    }))
  ) {
    return claimedResult({ status: "cancelled" });
  }
  control.turnMetricOutcome = "failed";
  // The common failure path ends here: runAgentTurn marks the session
  // failed and returns "failed", and the session workflow then exits
  // WITHOUT calling failSession/markSessionIdle. Wake a spawned worker's
  // parent here too, so a manager learns of a worker that died inside its
  // turn (not just one failed by the workflow's failSession path). Turn
  // settlement already owns the durable outbox payload; this call only
  // delivers that exact turn-scoped row.
  await deliverFailedChildTurnToParent(
    { db, bus, settings, observability, wakeSessionWorkflow },
    input.workspaceId,
    input.sessionId,
    attempt.turnId,
  );
  return claimedResult({ status: "failed" });
}
