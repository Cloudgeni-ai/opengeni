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
  recordUsageEvent,
  getActiveSessionHistoryItemsPaged,
  readLease,
  SandboxLeaseSupersededError,
  isSessionEventPersistenceError,
  SANDBOX_SETUP_RECOVERY_LIMIT,
  SubscriptionCoreCodexAccessLostError,
  SubscriptionCoreCodexSourceDisconnectedError,
  SubscriptionCoreCodexRequestOutcomeUnknownError,
  isSubscriptionCoreCodexSourceDisconnected,
  SubscriptionCoreCodexLeaseLostError,
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
  subscriptionCapacityArmingDiagnostic,
  subscriptionCapacityArmingFailure,
} from "./subscription-capacity-arming";
import { TurnExecutionPolicyDefinitionMismatchError, type Settings } from "@opengeni/config";
import {
  CodexReloginRequired,
  classifyCodexEncryptedArtifactRejection,
  classifyCodexEntitlementRejection,
  classifyCodexUsageLimitError,
  isCodexTransportError,
} from "@opengeni/codex";

import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { CodexCredentialLeaseLostError, createTurnCredentialLeases } from "./credential-leases";
import {
  SubscriptionCoreCodexTurnError,
  subscriptionCoreAccountRefusedFailure,
  subscriptionCoreLeaseBusyChain,
  subscriptionCoreLeaseBusyDelayMs,
  subscriptionCoreLeaseBusyExhaustedFailure,
} from "./codex-core-errors";
import { recordCoreCodexRefusal } from "./codex-core-settlement";
import { failOverCoreCodexTurn } from "./codex-core-failover";
import { createTurnHistorySink } from "./history-sink";

import { BudgetExhaustedError } from "./admission";
import {
  providerRecoveryExhaustedFailure,
  withModelRoutePresentation,
  postClaimDatabaseRecoveryFailure,
  providerRecoveryResult,
  providerRecoveryCode,
  providerRecoveryLimit,
  PROVIDER_OVERLOAD_RECOVERY_CODE,
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
  classifyCodexCredentialFailure,
  codexUsageLimitFailurePayload,
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

import { providerRecoveryCause, recordProviderRecoveryOutcome } from "./provider-recovery-metrics";

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

export async function settleTurnFailure(deps: TurnFailureDeps): Promise<RunAgentTurnResult> {
  try {
    return await settleTurnFailureInAttempt(deps);
  } catch (error) {
    if (
      deps.control.activityStatus === "recovering" &&
      error instanceof ApplicationFailure &&
      error.type === "OpenGeniPostClaimDatabaseRecovery"
    )
      throw error;
    // Connectivity can disappear while settling an unrelated run error too.
    // Do not overwrite a possibly committed settlement; the control lane
    // re-reads exact ownership and becomes a stale no-op if it already closed.
    if (deps.attempt.turnId && deps.attempt.triggerEventId) {
      const recovery = postClaimDatabaseRecoveryFailure({
        // A failed rollback/terminal write must not erase no-replay evidence
        // from the failure we were settling (notably unknown tool effects).
        error: new AggregateError([error, deps.error], "Turn failure settlement failed"),
        turnId: deps.attempt.turnId,
        triggerEventId: deps.attempt.triggerEventId,
        executionGeneration: deps.attempt.executionGeneration,
        requireDatabaseProvenance: true,
      });
      if (recovery) {
        deps.control.activityStatus = "recovering";
        deps.control.turnMetricOutcome = "recovering";
        deps.control.activityError = error;
        throw recovery;
      }
    }
    throw error;
  }
}

async function settleTurnFailureInAttempt(deps: TurnFailureDeps): Promise<RunAgentTurnResult> {
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
  if (attempt.turnId && attempt.triggerEventId && attempt.executionGeneration > 0) {
    const recoveryFailure = postClaimDatabaseRecoveryFailure({
      error,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId,
      executionGeneration: attempt.executionGeneration,
      requireDatabaseProvenance: eventing.turnStartedPublished || attempt.modelRequestStarted,
    });
    if (recoveryFailure) {
      // Stop this non-retryable activity without terminal logical settlement.
      // Do not retry a delta/tool-ledger mutation with an unknown commit, nor
      // claim that DB-down cleanup proved writer exit. Finally still drains
      // the physical writers; the existing DB-only workflow lane closes this
      // exact owner after connectivity returns and admission waits for its
      // ordinary durable quiescence/writer fences.
      control.activityStatus = "recovering";
      control.turnMetricOutcome = "recovering";
      control.activityError = error;
      throw recoveryFailure;
    }
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
  // A missing/expired/superseded lease is an execution-ownership failure,
  // not a provider failure. Settle it before credential quarantine or the
  // generic terminal path: the DB transaction marks a still-current turn
  // recoverable, but a successor attempt or worker recovery makes this activity
  // stale and unable to clobber the shared turn/session.
  // Codex refusal, quota attribution and failover belong exclusively to the
  // exact core placement and its generation fence.
  const coreCodex = billingState.isCodexTurn ? (providerTurn.codexSubscriptionCore ?? null) : null;
  const coreRequestOutcomeUnknown = hasErrorInCauseChain(
    error,
    SubscriptionCoreCodexRequestOutcomeUnknownError,
  )
    ? new SubscriptionCoreCodexRequestOutcomeUnknownError()
    : null;
  const coreCodexLeaseLost =
    coreCodex !== null &&
    !coreRequestOutcomeUnknown &&
    (leases.codex.lost ||
      error instanceof CodexCredentialLeaseLostError ||
      error instanceof SubscriptionCoreCodexLeaseLostError);
  let coreCodexLeaseRecoverable = false;
  let coreLeaseCheckpointFailed = false;
  if (coreCodexLeaseLost && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    try {
      // A completed response still owns a pending reservation until its
      // history commits. Test replay safety after that rendezvous, not before.
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
      await coreCodex.requests?.checkpoint();
      coreCodexLeaseRecoverable =
        (!coreCodex.requests || coreCodex.requests.canRecover()) &&
        (!coreCodex.titleRequests || coreCodex.titleRequests.canRecover());
    } catch {
      coreLeaseCheckpointFailed = true;
      observability.incrementCounter({
        name: "opengeni_codex_failover_checkpoints_total",
        help: "Durable Codex failover checkpoint attempts by outcome.",
        labels: { workspace_key: codexWorkspaceKey, outcome: "failed" },
      });
    }
  }
  const scopedLeaseLost =
    billingState.isClaudeTurn && leases.claude.lost
      ? "claude"
      : billingState.isXaiTurn && leases.xai.lost
        ? "xai"
        : coreCodexLeaseRecoverable
          ? "codex"
          : null;
  if (scopedLeaseLost && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    if (scopedLeaseLost !== "codex") {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
    }
    const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId!,
      attemptId: input.attemptId,
      reason: scopedLeaseLost + "_lease_lost",
      detail: {
        provider:
          scopedLeaseLost === "claude"
            ? "claude-subscription"
            : scopedLeaseLost === "codex"
              ? "codex-subscription"
              : "supergrok-subscription",
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
  // A definitive account refusal on a core turn becomes a typed terminal
  // failure that idles the session (settled below).
  let coreAccountRefusal: SubscriptionCoreCodexTurnError | null = null;
  if (coreCodex && !coreRequestOutcomeUnknown && !coreLeaseCheckpointFailed) {
    // Core turns record the refusal against the leased connection (failure
    // receipt, plus the quota, health or model-cooldown state that keeps
    // placement away from it) and re-place the same turn within the per-turn
    // failover bound (M3 PR 2a). Without a recorded refusal or a durable
    // checkpoint they settle through the typed paths below instead.
    const coreFailure = classifyCodexCredentialFailure(error);
    // Only explicit plan evidence is an entitlement refusal; an unexplained
    // 400 keeps the generic typed "request rejected" copy.
    const planEntitlement =
      !coreFailure && classifyCodexEntitlementRejection(error)?.evidence === "plan_entitlement";
    const refusal =
      coreFailure ??
      (planEntitlement ? { kind: "plan_entitlement" as const, cooldownSeconds: null } : null);
    // Only a pre-dispatch lifecycle fence or a definite refusal can enter
    // graceful recovery. A concurrent disconnect never upgrades a timeout,
    // partial stream, missing response, or failed checkpoint into replay proof.
    const disconnected =
      hasErrorInCauseChain(error, SubscriptionCoreCodexSourceDisconnectedError) ||
      (!!refusal &&
        (await isSubscriptionCoreCodexSourceDisconnected(
          db,
          coreCodex.identity,
          coreCodex.connectionId,
        )));
    if (disconnected) {
      const settled = await failOverCoreCodexTurn(deps, coreCodex, "source_disconnected");
      if (settled) return settled;
    }
    if (refusal && !disconnected) {
      const recorded = await recordCoreCodexRefusal({
        db,
        core: coreCodex,
        lease: leases.codex,
        failure: refusal,
        credentialVersion: providerTurn.effectiveCodexCredentialVersion,
        modelId: providerTurn.codexProductModelId ?? null,
      }).catch(() => ({ receipt: false, health: false }));
      if (recorded.receipt && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
        const settled = await failOverCoreCodexTurn(deps, coreCodex, refusal);
        if (settled) return settled;
      }
    }
    coreAccountRefusal =
      disconnected || hasErrorInCauseChain(error, SubscriptionCoreCodexAccessLostError)
        ? subscriptionCoreAccountRefusedFailure("access_lost")
        : refusal?.kind === "auth" || hasErrorInCauseChain(error, CodexReloginRequired)
          ? subscriptionCoreAccountRefusedFailure("sign_in")
          : refusal?.kind === "forbidden"
            ? subscriptionCoreAccountRefusedFailure("forbidden")
            : refusal?.kind === "plan_entitlement"
              ? subscriptionCoreAccountRefusedFailure("entitlement")
              : null;
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
    let claudeTokenFence: { encryptionKey: Uint8Array; observedAccessToken: string } | undefined;
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
        claudeTokenFence = { encryptionKey: key, observedAccessToken: current.secret.token };
      }
      if (receipt) claudeTokenFence = { encryptionKey: key, observedAccessToken: receipt.token };
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
        ).catch((refreshError) => {
          if (refreshError instanceof ClaudeSubscriptionConnectionChanged) return null;
          throw refreshError;
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
    let armed: Awaited<ReturnType<typeof armScopedWait>>;
    try {
      armed = await armScopedWait(db, {
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
          ? {
              expectedCredentialVersion: providerTurn.effectiveClaudeCredentialVersion!,
              ...(claudeTokenFence ? { credentialTokenFence: claudeTokenFence } : {}),
            }
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
    } catch (armError) {
      // A wait that cannot be armed must surface as an explicit state, never
      // as a generic activity failure. Database failures keep their own
      // exact-attempt recovery path.
      const failure = subscriptionCapacityArmingFailure(scopedProvider, armError);
      if (!failure) throw armError;
      observability.warn(
        "Subscription capacity wait could not be armed; failing the turn",
        subscriptionCapacityArmingDiagnostic(scopedProvider, armError),
      );
      if (
        !(await eventing.settle!({
          events: [
            { type: "turn.failed", payload: failure },
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
      control.activityError = armError;
      return claimedResult({ status: "idle" });
    }
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
  // A lease-busy chain that outlived its bound becomes a terminal failure.
  const leaseBusyChain =
    error instanceof SubscriptionCoreCodexTurnError &&
    error.payload.code === "subscription_lease_busy" &&
    error.payload.retryable
      ? subscriptionCoreLeaseBusyChain(
          attempt.subscriptionLeaseBusy,
          attempt.executionGeneration,
          Date.now(),
        )
      : null;
  // An older attempt of this turn still holds its core lease. Retry right
  // after that lease can expire, outside the provider recovery budget: this
  // is ownership handover, not provider backpressure. The chain is bounded
  // above (SUBSCRIPTION_CORE_LEASE_BUSY_MAX_MS).
  let leaseBusyNotRecoverable = false;
  if (
    leaseBusyChain &&
    !leaseBusyChain.exhausted &&
    error instanceof SubscriptionCoreCodexTurnError &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    const continueDelayMs = subscriptionCoreLeaseBusyDelayMs(
      error.payload.resetsAt,
      Date.now(),
      Math.random(),
    );
    let recovery: Awaited<ReturnType<typeof requestSessionTurnRecovery>>;
    try {
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ requireDurable: true });
      recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: "subscription_lease_busy",
        subscriptionLeaseBusy: {
          startedAt: new Date(leaseBusyChain.startedAt).toISOString(),
          executionGeneration: leaseBusyChain.executionGeneration,
        },
        detail: { ...error.payload, continueDelayMs },
      });
    } catch (recoveryError) {
      // Keep the turn recoverable across a transient database failure, as
      // the provider recovery path does.
      const postClaimRecovery = postClaimDatabaseRecoveryFailure({
        error: recoveryError,
        turnId: attempt.turnId,
        triggerEventId: attempt.triggerEventId!,
        executionGeneration: attempt.executionGeneration,
      });
      if (postClaimRecovery) {
        control.activityStatus = "recovering";
        control.turnMetricOutcome = "recovering";
        control.activityError = error;
        throw postClaimRecovery;
      }
      throw recoveryError;
    }
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
      return claimedResult({ status: "recovering", continueDelayMs });
    }
    leaseBusyNotRecoverable = true;
  }
  // A shared-core placement outcome (no capacity, a waiting explicit choice,
  // a paused cutover, or a consumer not yet on the core) or a definitive
  // refusal from the leased account fails this turn with its typed copy and
  // keeps the session usable for the next message.
  const coreTurnFailure =
    leaseBusyChain?.exhausted || leaseBusyNotRecoverable
      ? subscriptionCoreLeaseBusyExhaustedFailure()
      : error instanceof SubscriptionCoreCodexTurnError
        ? error
        : coreAccountRefusal;
  if (
    coreTurnFailure &&
    !coreTurnFailure.payload.retryable &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth();
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "turn.failed",
            payload: { ...coreTurnFailure.payload, recovery: "user_message" },
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
      attempt.turnId,
    );
    return claimedResult({ status: "idle" });
  }
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
    !coreRequestOutcomeUnknown &&
    !coreLeaseCheckpointFailed &&
    billingState.isCodexTurn &&
    providerTurn.effectiveCodexCredentialId
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
  let failure = withModelRoutePresentation(
    (coreRequestOutcomeUnknown
      ? {
          error: coreRequestOutcomeUnknown.message,
          code: coreRequestOutcomeUnknown.code,
          retryable: false,
        }
      : earlyDefinitionMismatch
        ? { error: error.message, code: error.code, retryable: true }
        : agentRunFailurePayload(error, {
            isCodexTurn: billingState.isCodexTurn,
          })) as ReturnType<typeof agentRunFailurePayload>,
    attempt.modelRoutePresentation,
  );
  if (
    attempt.turnId &&
    !coreRequestOutcomeUnknown &&
    !coreLeaseCheckpointFailed &&
    (!coreCodex?.requests || coreCodex.requests.canRecover()) &&
    (!coreCodex?.titleRequests || coreCodex.titleRequests.canRecover()) &&
    (earlyRecoverableSetup ||
      (failure.retryable && eventing.publish && eventing.turnStartedPublished))
  ) {
    const nextProviderRecoveryCount = attempt.providerRecoveryCount + 1;
    const recoveryCode = providerRecoveryCode(error, failure);
    const recoveryResult = providerRecoveryResult({
      failureCode: recoveryCode,
      attemptNumber: nextProviderRecoveryCount,
      recoveryStartedAt:
        attempt.providerRecoveryCount > 0 ? attempt.providerRecoveryStartedAt : undefined,
      retryAfterMs: providerRetryAfterMs(error),
      jitterSample: Math.random(),
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
          reason: recoveryCode ?? "provider_unavailable",
          providerRecoveryCount: nextProviderRecoveryCount,
          detail: {
            ...agentRunRecoveryFailurePayload(error, failure),
            continueDelayMs: recoveryResult.continueDelayMs,
            providerRecoveryCount: nextProviderRecoveryCount,
            maxProviderRecoveryCount: providerRecoveryLimit(recoveryCode),
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
        const recoveryCause = providerRecoveryCause(failure.code);
        if (recoveryCause) {
          recordProviderRecoveryOutcome(observability, {
            route: attempt.modelMetricRoute,
            cause: recoveryCause,
            outcome: "scheduled",
            delayMs: recoveryResult.continueDelayMs,
          });
        }
        return claimedResult(recoveryResult);
      }
      failure = providerRecoveryExhaustedFailure(failure, recoveryResult);
      const recoveryCause = providerRecoveryCause(failure.code);
      if (recoveryCause) {
        recordProviderRecoveryOutcome(observability, {
          route: attempt.modelMetricRoute,
          cause: recoveryCause,
          outcome: "exhausted",
          ...(attempt.providerRecoveryObservation
            ? { elapsedMs: Date.now() - attempt.providerRecoveryObservation.startedAt }
            : {}),
        });
      }
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
                failureCode: recoveryCode ?? "provider_unavailable",
                providerRecoveryCount: nextProviderRecoveryCount,
                ...(recoveryCode === PROVIDER_OVERLOAD_RECOVERY_CODE
                  ? { continueDelayMs: recoveryResult.continueDelayMs }
                  : {}),
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
  if (coreRequestOutcomeUnknown) {
    await historySink.reconcileConversationTruth({ requireDurable: true });
  } else {
    await historySink.reconcileConversationTruth();
  }
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

/** An error of the given class, directly or anywhere in the cause chain. */
function hasErrorInCauseChain(
  error: unknown,
  type: abstract new (...args: never[]) => Error,
): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (current instanceof type) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
