import {
  requestSessionTurnRecovery,
  getSessionGoal,
  armCodexCapacityWait,
  armXaiCapacityWait,
  reconcileXaiCapacityWait,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  getSessionCodexState,
  setSessionCodexPinInTransaction,
  quarantineCodexCredentialForLease,
  setCodexCredentialExhaustedWithWakeTargets,
  withSessionCodexCapacityMutation,
  countConsecutiveReactiveRotations,
  recordUsageEvent,
  getActiveSessionHistoryItemsPaged,
  settleCodexCredentialLeaseLoss,
  settleCodexCredentialFailover,
  readLease,
  SandboxLeaseSupersededError,
  SandboxLeaseTransitionError,
  isSessionEventPersistenceError,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { maxTurnsExceededRunState } from "@opengeni/runtime";
import { CancelledFailure } from "@temporalio/activity";
import {
  authoritativeCodexCapacityResetAt,
  chooseRotationActive,
  classifyCodexPin,
  computeIdleDelayMs,
  computeReactiveRotationResume,
  shardCredentialForSession,
  earliestCodexReset,
  type CodexRotationStrategy,
} from "../codex-rotation";
import { signalCodexCapacityWakeTargets } from "../codex-capacity";
import type { Settings } from "@opengeni/config";
import {
  classifyCodexEncryptedArtifactRejection,
  classifyCodexUsageLimitError,
  isCodexTransportError,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnHistorySink } from "./history-sink";

import { BudgetExhaustedError } from "./admission";
import {
  providerRecoveryExhaustedFailure,
  providerRecoveryResult,
  providerRetryAfterMs,
  escapedMcpTimeoutRecoveryFailure,
  preClaimAdmissionFailure,
  isWorkerShutdownCancellation,
  sandboxRouteTransitionCode,
  safeErrorDiagnostic,
  classifyXaiCredentialFailure,
  agentRunFailurePayload,
  codexCredentialCooldownUntil,
  classifyCodexCredentialFailure,
  codexUsageLimitFailurePayload,
  CODEX_USAGE_LIMIT_MAX_RESUME_MS,
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

export type TurnFailureDeps = {
  error: unknown;
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  signalCodexCapacityWorkflow: ActivityServices["signalCodexCapacityWorkflow"];
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

export async function settleTurnFailure(deps: TurnFailureDeps): Promise<RunAgentTurnResult> {
  const {
    error,
    input,
    settings,
    db,
    bus,
    observability,
    wakeSessionWorkflow,
    signalCodexCapacityWorkflow,
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
  // A true epoch supersession and a provider lifecycle transition are both
  // recoverable control-plane states, never session failures. The latter is
  // paced briefly; the next acquire waits on the durable claim and resumes
  // immediately when it clears.
  if (
    (error instanceof SandboxLeaseSupersededError ||
      error instanceof SandboxLeaseTransitionError) &&
    recoveryTurnId
  ) {
    try {
      const fencedLease = await readLease(db, input.workspaceId, error.sandboxGroupId).catch(
        () => null,
      );
      const lifecycleTransition = error instanceof SandboxLeaseTransitionError;
      const rotationPending =
        fencedLease?.rotationRequestedAt != null ||
        (lifecycleTransition && error.reason === "rotation_in_progress");
      const transitionPending = lifecycleTransition || rotationPending;
      const deadlineRotationPending =
        rotationPending && fencedLease?.rotationReason === "provider_deadline";
      const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
        sessionId: input.sessionId,
        turnId: recoveryTurnId,
        triggerEventId: attempt.triggerEventId!,
        attemptId: input.attemptId,
        reason: deadlineRotationPending
          ? "sandbox_deadline_rotation"
          : lifecycleTransition
            ? "sandbox_lifecycle_transition"
            : "sandbox_lease_superseded",
        ...(transitionPending
          ? {
              detail: {
                sandboxGroupId: error.sandboxGroupId,
                leaseEpoch: error.leaseEpoch,
                ...(rotationPending
                  ? {
                      rotationReason: fencedLease?.rotationReason ?? "operator",
                    }
                  : {}),
                ...(lifecycleTransition ? { transitionReason: error.reason } : {}),
              },
            }
          : {}),
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
        ...(transitionPending
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
  // A managed-home session can start directly on a Connected Machine without
  // creating or leasing its cloud home. If sandbox_attach/sandbox_swap then
  // clears the durable pointer to home, the commit is valid but this exact
  // attempt cannot serve a later home operation. Preserve the completed attach
  // and every preceding model/tool receipt, close only the unresolved suffix,
  // and continue the SAME logical turn in a fresh attempt. That next attempt
  // starts from the now-null pointer and establishes home normally.
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
        throw new Error("Home sandbox route transition could not recover the current turn");
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
        continueDelayMs: sandboxDeadlineRotationRecoveryDelayMs(settings),
      });
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
    leases.codex.lost &&
    settings.codexCredentialLeasingEnabled &&
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
  if (
    leases.xai.lost &&
    billingState.isXaiTurn &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      triggerEventId: attempt.triggerEventId!,
      attemptId: input.attemptId,
      reason: "xai_lease_lost",
      detail: { provider: "supergrok-subscription" },
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
  const codexCredentialFailure =
    settings.codexCredentialLeasingEnabled &&
    billingState.isCodexTurn &&
    providerTurn.effectiveCodexCredentialId
      ? classifyCodexCredentialFailure(error)
      : null;
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
      const before = await listCodexAccountStatuses(db, input.workspaceId).catch(() => []);
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
      const statePersisted =
        leases.codex.holderId && leases.codex.generation !== null
          ? await quarantineCodexCredentialForLease(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              turnId: attempt.turnId,
              credentialId: providerTurn.effectiveCodexCredentialId,
              holderId: leases.codex.holderId,
              generation: leases.codex.generation,
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
                    : { kind: "cooldown", until: cooldownUntil! },
            })
          : false;
      if (!statePersisted && leases.codex.holderId && leases.codex.generation !== null) {
        leases.codex.lost = true;
        return await settleLostCodexAttempt(
          attempt.turnId,
          leases.codex.holderId,
          leases.codex.generation,
          true,
        );
      }
      const [rotation, accounts] = await Promise.all([
        getCodexRotationSettings(db, input.workspaceId).catch(() => null),
        listCodexAccountStatuses(db, input.workspaceId).catch(() => []),
      ]);
      const decision = rotation
        ? chooseRotationActive({
            rotationStrategy: rotation.rotationStrategy as CodexRotationStrategy,
            activeCredentialId: rotation.activeCredentialId,
            priorCredentialId: providerTurn.effectiveCodexCredentialId,
            accounts,
            now: new Date(),
          })
        : ({ kind: "none" } as const);
      const candidateAvailable =
        statePersisted &&
        Boolean(rotation?.rotationEnabled && rotation?.leaseRotationEnabled) &&
        decision.kind === "active" &&
        decision.credentialId !== providerTurn.effectiveCodexCredentialId;

      if (candidateAvailable && leases.codex.holderId && leases.codex.generation !== null) {
        const settlement = await settleCodexCredentialFailover(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          attemptId: input.attemptId,
          holderId: leases.codex.holderId,
          generation: leases.codex.generation,
          expectedRedispatches: attempt.redispatchesAtDispatch,
          maxFailovers: Math.max(1, accounts.length),
          recoveryPayload: {
            triggerEventId: attempt.triggerEventId!,
            reason: "codex_credential_failover",
            credentialId: providerTurn.effectiveCodexCredentialId,
            failureKind: codexCredentialFailure.kind,
            ...(cooldownUntil ? { cooldownUntil: cooldownUntil.toISOString() } : {}),
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
          return claimedResult({ status: "recovering" });
        }
      }
    }
  }
  const xaiCredentialFailure =
    billingState.isXaiTurn && providerTurn.effectiveXaiCredentialId
      ? classifyXaiCredentialFailure(error)
      : null;
  if (
    xaiCredentialFailure &&
    providerTurn.effectiveXaiCredentialId &&
    providerTurn.xaiAuthoritySnapshot &&
    leases.xai.subjectId &&
    leases.xai.holderId &&
    leases.xai.generation !== null &&
    eventing.publish &&
    attempt.turnId &&
    eventing.turnStartedPublished
  ) {
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth({ requireDurable: true });
    const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
    const activeGoal = goal?.status === "active" ? goal : null;
    const now = new Date();
    const cooldownUntil =
      xaiCredentialFailure.kind === "rate_limit"
        ? new Date(now.getTime() + Math.max(1, xaiCredentialFailure.cooldownMs ?? 60_000))
        : null;
    const failurePayload = {
      error:
        xaiCredentialFailure.kind === "auth"
          ? "The serving SuperGrok account requires reconnection"
          : xaiCredentialFailure.kind === "forbidden"
            ? "The serving SuperGrok account is not authorized for this request"
            : "The serving SuperGrok account is temporarily rate limited",
      code:
        xaiCredentialFailure.kind === "auth"
          ? "xai_relogin_required"
          : xaiCredentialFailure.kind === "forbidden"
            ? "xai_account_forbidden"
            : "xai_account_rate_limited",
      detail: "the same accepted turn is waiting for another eligible account",
    };
    const armed = await armXaiCapacityWait(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: leases.xai.subjectId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      attemptId: input.attemptId,
      workflowId: input.workflowId,
      authoritySnapshot: providerTurn.xaiAuthoritySnapshot,
      goalId: activeGoal?.id ?? null,
      goalVersion: activeGoal?.version ?? null,
      earliestResetAt: cooldownUntil,
      failurePayload,
      leaseFence: {
        holderId: leases.xai.holderId,
        generation: leases.xai.generation,
      },
      credentialQuarantine:
        xaiCredentialFailure.kind === "auth"
          ? {
              kind: "status",
              status: "needs_relogin",
              lastError: "model request remained unauthorized after refresh",
            }
          : xaiCredentialFailure.kind === "forbidden"
            ? {
                kind: "status",
                status: "error",
                lastError: "model request was forbidden for this credential",
              }
            : { kind: "cooldown", until: cooldownUntil! },
      now,
    });
    if (armed.action === "waiting") {
      leases.xai.held = false;
      providerTurn.xaiCredentialQuarantined = true;
      await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
      const evaluated = await reconcileXaiCapacityWait(db, {
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
            provider: "xai",
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
      reason: "xai_credential_recheck",
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
  // A ChatGPT/Codex usage cap (429 usage_limit_reached) is account state,
  // NOT an agent failure: surface the precise, actionable message (so the
  // user sees the reset window) but idle the session — never go terminal,
  // which would reject the user's next message after the cap lifts. The
  // payload is retryable:false so the generic provider-backpressure auto-retry
  // does not loop. For an active goal we hold the continuation for the reported
  // reset window (capped) so it resumes itself when access returns, instead of
  // hammering the capped backend.
  const usageLimit = isCodexTransportError(error) ? classifyCodexUsageLimitError(error) : null;
  if (usageLimit && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
    const goalActive = Boolean(goal && goal.status === "active");
    await flushRuntimeBatcher();
    await historySink.reconcileConversationTruth();
    // --- P3 reactive rotation (gated; re-fetch fresh state on this already-failed,
    // already-idling path). Mark THIS account cooling until its reset, then CONSULT the
    // engine over fresh accounts to decide continueDelayMs: a fast 0-delay re-dispatch
    // when another account is available, or idle-until-earliest when all are capped. The
    // catch deliberately does NOT move the active pointer — the re-dispatched turn's
    // proactive seam (turn-start) is the single authoritative pointer-move + strip site.
    let rotated = false;
    let rotationResumeMs: number | null = null; // 0 ⇒ a candidate is available; re-dispatch now
    let rotationResumeIdleUntilReset = false; // circuit-breaker fall (Finding 1b) ⇒ MANDATORY hold
    let allCappedResetAt: Date | null = null; // set ⇒ every account capped; idle until this
    let capacityAuthoritativeResetAt: Date | null = null;
    if (providerTurn.effectiveCodexCredentialId) {
      const [rotation, sessionCodex] = await Promise.all([
        getCodexRotationSettings(db, input.workspaceId).catch(() => null),
        getSessionCodexState(db, input.workspaceId, input.sessionId).catch(() => null),
      ]);
      const reactiveStrategy = (rotation?.rotationStrategy ??
        "most_remaining") as CodexRotationStrategy;
      const reactiveDisposition = classifyCodexPin({
        pinnedCredentialId: sessionCodex?.pinnedCredentialId ?? null,
        pinSource: sessionCodex?.pinSource ?? null,
        strategy: reactiveStrategy,
        rotationEnabled: Boolean(rotation?.rotationEnabled),
      });
      const reactiveSharded = reactiveDisposition === "sharded";
      const rotating =
        Boolean(rotation?.rotationEnabled || rotation?.leaseRotationEnabled) &&
        reactiveDisposition !== "manual";
      if (rotating && rotation) {
        const accounts = await listCodexAccountStatuses(db, input.workspaceId).catch(() => []);
        const serving =
          accounts.find((a) => a.id === providerTurn.effectiveCodexCredentialId) ?? null;
        // Both provider allowance windows bind. Use the same canonical
        // quarantine calculation as the fenced failover path so a short
        // five-hour reset can never overwrite a later weekly reset.
        const until = codexCredentialCooldownUntil(
          { kind: "quota", cooldownSeconds: usageLimit.resetsInSeconds },
          serving,
          new Date(),
        )!;
        // Finding 1a: INSPECT the cooldown-write result. A swallowed best-effort
        // write whose failure went unnoticed is exactly what lets the next proactive
        // rank re-pick this just-capped account (stale-low cached usedPercent, not
        // cooling) — so capture whether it PERSISTED and feed it into the resume floor.
        const cooldownMutation = await setCodexCredentialExhaustedWithWakeTargets(
          db,
          input.workspaceId,
          providerTurn.effectiveCodexCredentialId,
          until,
        ).catch(() => null);
        const cooldownPersisted = cooldownMutation?.result ?? false;
        if (cooldownMutation) {
          await signalCodexCapacityWakeTargets(
            { signalCodexCapacityWorkflow, wakeSessionWorkflow },
            cooldownMutation.wakeTargets,
          );
        }
        // Re-rank over the fresh accounts; the in-memory list predates the cooldown
        // write, so stamp the just-cooled account so the engine excludes it now. The
        // serving account is thus walked AT MOST ONCE per turn (invariant 4: bounded).
        const fresh = accounts.map((a) =>
          a.id === providerTurn.effectiveCodexCredentialId ? { ...a, exhaustedUntil: until } : a,
        );
        if (reactiveSharded) {
          // AM-5: RE-SHARD over the healthy survivors (the just-capped serving account is
          // marked cooling in `fresh` → excluded) so sessions sharing a capped account
          // spread across the pool rather than re-concentrating on one first-eligible
          // failover. AM-3: DURABLY REWRITE the session's POLICY pin to the new home —
          // selectCodexCredentialForTurn returns a cooling pinned account with NO
          // exhaustion check, so a pointer-only move would leave the re-dispatched turn on
          // the capped pin. Like the classic path we do NOT touch the workspace active
          // pointer; the session pin is the sharded home.
          const newHome = shardCredentialForSession({
            sessionId: input.sessionId,
            accounts: fresh,
            now: new Date(),
          });
          if (newHome) {
            rotated = true;
            const pinMutation = await withSessionCodexCapacityMutation(
              db,
              {
                workspaceId: input.workspaceId,
                reason: "codex_policy_pin_resharded",
              },
              async (tx) => {
                const changed = await setSessionCodexPinInTransaction(
                  tx,
                  input.workspaceId,
                  input.sessionId,
                  newHome,
                  "policy",
                  {
                    expected: {
                      pinnedCredentialId: sessionCodex?.pinnedCredentialId ?? null,
                      pinSource: sessionCodex?.pinSource ?? null,
                    },
                  },
                );
                return { result: changed, changed };
              },
            ).catch(() => null);
            if (pinMutation) {
              await signalCodexCapacityWakeTargets(
                { signalCodexCapacityWorkflow, wakeSessionWorkflow },
                pinMutation.wakeTargets,
              );
            }
            const priorConsecutiveRotations = await countConsecutiveReactiveRotations(
              db,
              input.workspaceId,
              input.sessionId,
            ).catch(() => 0);
            const resume = computeReactiveRotationResume({
              cooldownPersisted,
              priorConsecutiveRotations,
              connectedAccountCount: accounts.length,
            });
            rotationResumeMs = resume.continueDelayMs;
            rotationResumeIdleUntilReset = resume.idleUntilReset;
          } else {
            // Every account capped/cooling → idle until the earliest reset across all.
            rotated = true;
            allCappedResetAt = earliestCodexReset(fresh, new Date());
            capacityAuthoritativeResetAt = authoritativeCodexCapacityResetAt(fresh, new Date());
          }
        } else {
          const decision = chooseRotationActive({
            rotationStrategy: reactiveStrategy,
            activeCredentialId: rotation.activeCredentialId,
            priorCredentialId: providerTurn.effectiveCodexCredentialId,
            accounts: fresh,
            now: new Date(),
          });
          if (decision.kind === "active") {
            rotated = true;
            // Finding 1: a live candidate normally re-dispatches NOW (0). Two second-order
            // faults would turn that 0 into a hot loop, so bound it. Count the consecutive
            // reactive failovers since the last successful turn (this one is not yet
            // published) and combine with the cooldown-persistence result.
            const priorConsecutiveRotations = await countConsecutiveReactiveRotations(
              db,
              input.workspaceId,
              input.sessionId,
            ).catch(() => 0);
            const resume = computeReactiveRotationResume({
              cooldownPersisted,
              priorConsecutiveRotations,
              connectedAccountCount: accounts.length,
            });
            rotationResumeMs = resume.continueDelayMs; // 0 (happy path), a slow-retry floor, or the circuit-breaker idle
            rotationResumeIdleUntilReset = resume.idleUntilReset; // true only on the circuit-breaker fall (MANDATORY hold)
          } else if (decision.kind === "allCapped") {
            rotated = true;
            allCappedResetAt = decision.earliestResetAt;
            capacityAuthoritativeResetAt = authoritativeCodexCapacityResetAt(fresh, new Date());
          }
          // kind:"none" → fall through to today's single-account idle.
        }
      }
    }

    const failurePayload = allCappedResetAt
      ? codexUsageLimitFailurePayload(
          {
            resetsInSeconds: Math.ceil(Math.max(0, allCappedResetAt.getTime() - Date.now()) / 1000),
          },
          error instanceof Error ? error.message : String(error),
          { allAccounts: true },
        )
      : codexUsageLimitFailurePayload(
          usageLimit,
          error instanceof Error ? error.message : String(error),
        );
    // A live alternate is still handled by the existing immediate,
    // same-policy continuation path. When no alternate exists (all capped,
    // or a single non-rotating account), persist the native capacity wait
    // instead of an in-memory delay/user-message recovery.
    if (rotationResumeMs === null) {
      const providerResetAt =
        capacityAuthoritativeResetAt ??
        (usageLimit.resetsInSeconds !== null &&
        Number.isFinite(usageLimit.resetsInSeconds) &&
        usageLimit.resetsInSeconds > 0
          ? new Date(Date.now() + Math.ceil(usageLimit.resetsInSeconds) * 1000)
          : null);
      const armed = await armCodexCapacityWait(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        goalId: goalActive && goal ? goal.id : null,
        goalVersion: goalActive && goal ? goal.version : null,
        earliestResetAt: providerResetAt,
        resetKind: providerResetAt ? "authoritative" : "bounded_refresh",
        failurePayload,
        ...(leases.codex.holderId && leases.codex.generation !== null
          ? {
              leaseFence: {
                holderId: leases.codex.holderId,
                generation: leases.codex.generation,
              },
              expectedRedispatches: attempt.redispatchesAtDispatch,
            }
          : {}),
      });
      if (armed.action === "waiting") {
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, armed.events);
        control.turnMetricOutcome = "recovering";
        control.activityStatus = "waiting_capacity";
        control.activityError = error;
        return claimedResult({
          status: "waiting_capacity",
          capacityWait: {
            waiterId: armed.waiter.id,
            generation: armed.waiter.generation,
            nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
            wakeRevision: armed.waiter.wakeRevision,
          },
        });
      }
    }
    if (
      !(await eventing.settle!({
        events: [
          // `rotated:true` ONLY on the reactive rotation path tells evaluateGoalContinuation to
          // freeze autoContinuations (a rotation walk must not burn the goal's continuation budget).
          {
            type: "turn.failed",
            payload: {
              ...failurePayload,
              recovery: goalActive ? "goal_continuation" : "user_message",
              ...(rotated ? { rotated: true } : {}),
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
    if (goalActive) {
      // Rotation: a candidate is available → continue NOW (0). All-capped → idle until the
      // earliest reset across all accounts (capped at 1h). Else the unchanged single-account idle.
      if (rotationResumeMs !== null) {
        // A candidate IS available. Normally the just-failed account is now cooling so
        // the ranker cannot re-pick it → 0 (re-dispatch NOW, the legitimate skip-the-hold
        // case). Finding 1 bounds the two exceptions: a persistence fault yields a positive
        // slow-retry floor, and once consecutive failovers exceed the account count + margin
        // the circuit breaker returns a fixed MANDATORY idle (idleUntilReset) — never a 0-delay
        // hot loop against a capped backend + DB.
        return claimedResult({
          status: "idle",
          continueDelayMs: rotationResumeMs,
          ...(rotationResumeIdleUntilReset ? { idleUntilReset: true } : {}),
        });
      }
      // All-capped: clamp to [MIN_IDLE_MS, max] — a POSITIVE, BOUNDED hold (never 0,
      // so session.ts can never tight-loop). The post-idle continuation re-dispatch
      // hits the proactive seam, which refreshes usage and self-heals.
      const resumeMs = allCappedResetAt
        ? computeIdleDelayMs(allCappedResetAt, new Date(), CODEX_USAGE_LIMIT_MAX_RESUME_MS)
        : usageLimit.resetsInSeconds !== null &&
            Number.isFinite(usageLimit.resetsInSeconds) &&
            usageLimit.resetsInSeconds > 0
          ? Math.min(Math.ceil(usageLimit.resetsInSeconds) * 1000, CODEX_USAGE_LIMIT_MAX_RESUME_MS)
          : CODEX_USAGE_LIMIT_MAX_RESUME_MS;
      return claimedResult({
        status: "idle",
        continueDelayMs: resumeMs,
        ...(allCappedResetAt ? { idleUntilReset: true } : {}),
      });
    }
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
          {
            type: "turn.completed",
            payload: {
              output: "",
              segmentLimit: "budget_exhausted",
              detail: error.message,
            },
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
  let failure = agentRunFailurePayload(error, {
    isCodexTurn: billingState.isCodexTurn,
  }) as ReturnType<typeof agentRunFailurePayload>;
  if (isSessionEventPersistenceError(error)) {
    // Preserve the exact source message in the internal runtime diagnostic;
    // SQLSTATE/catalog facts remain separate classification attributes.
    observability.error("session event persistence failed", {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: attempt.turnId,
      attemptId: input.attemptId,
      code: error.details.code,
      sqlState: error.details.sqlState ?? "unknown",
      stage: error.details.stage,
      eventTypes: error.details.eventTypes.join(","),
      correlationId: error.details.correlationId,
      attempts: error.details.attempts,
      retryOutcome: error.details.retryOutcome,
      dbSeverity: error.details.database.severity,
      dbSchema: error.details.database.schema,
      dbTable: error.details.database.table,
      dbColumn: error.details.database.column,
      dbDataType: error.details.database.dataType,
      dbConstraint: error.details.database.constraint,
      dbRoutine: error.details.database.routine,
      error: error.message,
    });
  }
  if (failure.retryable && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
    try {
      const nextProviderRecoveryCount = attempt.providerRecoveryCount + 1;
      const recoveryResult = providerRecoveryResult({
        failureCode: failure.code,
        attemptNumber: nextProviderRecoveryCount,
        retryAfterMs: providerRetryAfterMs(error),
      });
      if (recoveryResult.status === "recovering") {
        await flushRuntimeBatcher();
        await historySink.reconcileConversationTruth({ requireDurable: true });
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          triggerEventId: attempt.triggerEventId!,
          attemptId: input.attemptId,
          reason: failure.code ?? "provider_unavailable",
          providerRecoveryCount: nextProviderRecoveryCount,
          detail: {
            ...failure,
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
    } catch (recoveryError) {
      const escaped = escapedMcpTimeoutRecoveryFailure({
        failureCode: failure.code,
        modelRequestStarted: attempt.modelRequestStarted,
        detail: {
          turnId: attempt.turnId,
          triggerEventId: attempt.triggerEventId!,
          executionGeneration: attempt.executionGeneration,
        },
      });
      if (escaped) {
        control.activityStatus = "recovering";
        control.turnMetricOutcome = "recovering";
        control.activityError = error;
        throw escaped;
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
