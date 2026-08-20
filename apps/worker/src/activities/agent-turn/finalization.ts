import {
  commitSessionAttemptQuiescence,
  recordCodexAccountUsageWithWakeTargets,
  releaseCodexCredentialLease,
  releaseXaiCredentialLease,
  updateXaiQuotaMetadata,
  type SessionAttemptQuiescenceCommit,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced, publishDurableSessionEvents } from "@opengeni/events";
import { sandboxLeaseTelemetryKey } from "@opengeni/observability";
import { clearRunCredentialsForAttempt } from "@opengeni/runtime";
import { fetchXaiSubscriptionQuota } from "@opengeni/xai-subscription";
import type { Settings } from "@opengeni/config";
import { signalCodexCapacityWakeTargets } from "../codex-capacity";
import type { CodemodeTokenRenewalController } from "../codemode-token-renewal";
import type { RunCredentialRenewalController } from "../run-credential-renewal";
import type {
  RunAgentTurnInput,
  SessionAttemptQuiescenceProof,
  TurnActivityServices as ActivityServices,
} from "../types";
import { captureWorkspaceRevision, openFreshWorkspaceCaptureSession } from "../workspace-capture";
import { type ChannelASession } from "@opengeni/runtime/sandbox";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";
import { makeMachineOpObserver, turnLifecycleMetricsFor } from "../../observability-metrics";
import {
  maybePersistWarmWorkspaceSnapshot,
  waitForWarmSnapshot,
  type ResumedTurnSandbox,
} from "../../sandbox-resume";
import { createTurnCredentialLeases } from "./credential-leases";
import { safeErrorDiagnostic, safeErrorForTelemetry } from "./errors";
import {
  assertPhysicalToolQuiescenceForCancellation,
  assertSessionAttemptQuiescenceRecoveryDurable,
  clearAttemptCredentialsWithSettledFence,
  drainAttemptOwnedSandboxWriters,
  persistOrSignalSessionAttemptQuiescence,
  releaseTurnSandboxAfterWriterDrain,
  shouldRunTurnEndWorkspacePersistence,
  turnFinalizerCancellationSignal,
  waitForTurnFinalizerStep,
} from "./quiescence";
import type {
  AttemptIdentityState,
  EventingState,
  ProviderTurnState,
  RecordingState,
  RenewalState,
  SandboxRuntimeState,
  TurnControlState,
  WorkspaceRefState,
} from "./turn-context";

export type TurnFinalizationDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  signalSessionAttemptQuiesced: ActivityServices["signalSessionAttemptQuiesced"];
  signalCodexCapacityWorkflow: ActivityServices["signalCodexCapacityWorkflow"];
  cancellationSignal: AbortSignal | undefined;
  sandboxResumeController: AbortController;
  activityContext: ReturnType<typeof import("../streaming").currentActivityContext>;
  activityStarted: number;
  activitySpan: ReturnType<ActivityServices["observability"]["startSpan"]>;
  dispatchId: string;
  noteCancellationRequested: () => void;
  machineOpObserver: ReturnType<typeof makeMachineOpObserver>;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  sandboxState: SandboxRuntimeState;
  renewals: RenewalState;
  recordingState: RecordingState;
  eventing: EventingState;
  providerTurn: ProviderTurnState;
  workspaceRefs: WorkspaceRefState;
  runWorkspaceMutationForSandbox: <T>(
    sandbox: ResumedTurnSandbox,
    operation: string,
    mutation: () => Promise<T>,
  ) => Promise<T>;
  requireResolvedSandboxForMutation: (message: string) => ResumedTurnSandbox;
  stopLeaseHeartbeat: () => void;
  abandonActiveRecording: (reason: string, disposition?: "failed" | "discard") => Promise<void>;
  turnCompletionMemoryCollector: ReturnType<typeof createModelCheckpointMemoryCollector>;
};

export async function finalizeTurnAttempt(deps: TurnFinalizationDeps): Promise<void> {
  const {
    input,
    settings,
    db,
    bus,
    objectStorage,
    observability,
    wakeSessionWorkflow,
    signalSessionAttemptQuiesced,
    signalCodexCapacityWorkflow,
    cancellationSignal,
    sandboxResumeController,
    activityContext,
    activityStarted,
    activitySpan,
    dispatchId,
    noteCancellationRequested,
    machineOpObserver,
    leases,
    control,
    attempt,
    sandboxState,
    renewals,
    recordingState,
    eventing,
    providerTurn,
    workspaceRefs,
    runWorkspaceMutationForSandbox,
    requireResolvedSandboxForMutation,
    stopLeaseHeartbeat,
    abandonActiveRecording,
    turnCompletionMemoryCollector,
  } = deps;
  // This is the logical ownership boundary. Abort before any fallible
  // housekeeping so a still-pending provider establish releases its private
  // holder/timer even when Temporal itself never delivered cancellation.
  if (sandboxState.resolvedSandbox === null && !sandboxResumeController.signal.aborted) {
    sandboxResumeController.abort(
      cancellationSignal?.reason ?? new Error("TURN_ATTEMPT_FINALIZED"),
    );
  }
  const finalizationStarted = performance.now();
  let finalizationError: unknown;
  let physicalToolQuiescenceConfirmed = !control.acknowledgeQuiescence;
  let quiescenceReceiptOrProofDurable = !control.acknowledgeQuiescence;
  const finalizerSignal = turnFinalizerCancellationSignal(
    cancellationSignal,
    control.activityStatus,
  );
  try {
    const toolCancellationFence = eventing.toolCancellationFenceRef.current;
    // Every renewal controller is an attempt-owned sandbox writer. Capture
    // and close all of them before the tool/run-writer drain and before the
    // quiescence receipt; none may start another admitted write afterward.
    renewals.gitCredentialRenewalClosed = true;
    const gitRenewalsToStop = renewals.gitCredentialRenewals;
    renewals.gitCredentialRenewals = [];
    renewals.codemodeTokenRenewalClosed = true;
    const codemodeRenewalToStop =
      renewals.codemodeTokenRenewal as CodemodeTokenRenewalController | null;
    renewals.codemodeTokenRenewal = null;
    renewals.runCredentialRenewalClosed = true;
    const runRenewalToStop = renewals.runCredentialRenewal as RunCredentialRenewalController | null;
    renewals.runCredentialRenewal = null;

    // Attempt-qualified credential deletion is also a real workspace write.
    // Perform it under the same admission fence before publishing physical
    // quiescence; a failure deliberately keeps the receipt closed.
    const credentialSessionToClear = renewals.runCredentialSession;
    renewals.runCredentialSession = null;
    if (credentialSessionToClear) {
      const clearAttemptCredentials = async (): Promise<void> =>
        await clearRunCredentialsForAttempt(credentialSessionToClear, {
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          executionGeneration: attempt.executionGeneration,
        });
      await clearAttemptCredentialsWithSettledFence({
        activityStatus: control.activityStatus,
        runWorkspaceFencedClear: async () =>
          await runWorkspaceMutationForSandbox(
            requireResolvedSandboxForMutation(
              "Run credential cleanup has no exact sandbox lease target",
            ),
            "runCredentialAttemptClear",
            clearAttemptCredentials,
          ),
        clearExactAttempt: clearAttemptCredentials,
        onSettledAttemptFence: () => {
          // Terminal settlement closes the active attempt before this finally
          // runs, so the ordinary workspace admission correctly rejects it.
          // The attempt-qualified delete is nevertheless successor-safe: it
          // removes only this attempt/generation and clears the pointer only
          // when it still names that exact generation. Finish that cleanup
          // directly so a successful turn can continue into workspace capture,
          // tool teardown, and lease release.
          observability.info("retrying exact run credential cleanup after turn settlement", {
            "opengeni.session_id": input.sessionId,
            "opengeni.turn_id": attempt.turnId ?? "",
            "opengeni.attempt_id": input.attemptId,
          });
        },
      });
    }
    await drainAttemptOwnedSandboxWriters({
      // Normal turn completion owns the same process boundary as
      // Pause/Steer: yielded provider shells must be terminated, polled,
      // and durably settled before workspace capture. Only receipt
      // publication remains conditional on acknowledgeQuiescence.
      toolCancellationFence,
      cancellationReason: cancellationSignal?.reason ?? new Error("TURN_ATTEMPT_FINALIZED"),
      gitCredentialRenewals: gitRenewalsToStop,
      codemodeTokenRenewal: codemodeRenewalToStop,
      runCredentialRenewal: runRenewalToStop,
    });
    sandboxState.attemptWritersDrained = true;
    if (control.acknowledgeQuiescence) {
      // A cancellation before sandbox-backed capabilities exist still has
      // no tool controller to drain. Sandbox agent construction fails closed
      // when a backend exists but no controller was installed. Renewal
      // writers, when present, were drained above in either case.
      physicalToolQuiescenceConfirmed = true;
    }
    if (control.acknowledgeQuiescence && physicalToolQuiescenceConfirmed) {
      // This receipt is part of the hard cancellation boundary, not
      // housekeeping. Persist it immediately after the sandbox/tool fence
      // and before lease, cache, recording, or provider cleanup. Its
      // transaction also enqueues the exact workflow wake that will admit
      // the replacement; Temporal activity terminalization does neither.
      const proof: SessionAttemptQuiescenceProof = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        activityId: dispatchId,
      };
      const recoveryMode = await persistOrSignalSessionAttemptQuiescence({
        proof,
        persistReceipt: async () =>
          await commitSessionAttemptQuiescence(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            temporalWorkflowId: input.workflowId,
            temporalWorkflowRunId: input.workflowRunId,
            temporalActivityId: dispatchId,
            allowUninterrupted: true,
          }),
        ...(wakeSessionWorkflow
          ? {
              deliverWorkflowWake: async (
                wake: NonNullable<SessionAttemptQuiescenceCommit["workflowWake"]>,
              ) =>
                await wakeSessionWorkflow({
                  accountId: wake.accountId,
                  workspaceId: wake.workspaceId,
                  sessionId: wake.sessionId,
                  workflowId: wake.temporalWorkflowId,
                  wakeRevision: wake.wakeRevision,
                  interruptionRequested: wake.interruptionRequested,
                }),
            }
          : {}),
        publishEvents: async (events) => {
          await waitForTurnFinalizerStep(
            publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events),
            finalizerSignal,
          );
        },
        signalProof: signalSessionAttemptQuiesced,
        heartbeat: (deliveryAttempt, retryMs) => {
          activityContext?.heartbeat({
            phase: "quiescence-proof-delivery",
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            deliveryAttempt,
            retryMs,
            at: new Date().toISOString(),
          });
        },
        onReceiptFailure: (error) => {
          console.error(
            "agent turn quiescence receipt exhausted; signalling proof",
            safeErrorDiagnostic(error),
          );
        },
        onWakeFailure: (error) => {
          console.error(
            "agent turn quiescence immediate workflow wake failed; outbox repair retained",
            safeErrorDiagnostic(error),
          );
        },
        onPublishFailure: (error) => {
          console.error("agent turn quiescence event fanout failed", safeErrorDiagnostic(error));
        },
        onSignalFailure: (error, deliveryAttempt, retryMs) => {
          console.error("agent turn quiescence proof signal failed; retrying", {
            error: safeErrorDiagnostic(error),
            attempt: deliveryAttempt,
            retryMs,
          });
        },
      });
      quiescenceReceiptOrProofDurable = true;
      if (recoveryMode === "signal") {
        observability.info("agent turn quiescence proof handed to workflow recovery", {
          "opengeni.session_id": input.sessionId,
          "opengeni.attempt_id": input.attemptId,
          "opengeni.workflow_run_id": input.workflowRunId,
          "opengeni.activity_id": dispatchId,
        });
      }
    }
    // Drain the buffered Connected Machine op events (infra failures + healed
    // recoveries) to durable session events — awaited, best-effort, never blocking
    // the turn. Sync observer → buffer → single awaited append here (no unawaited
    // DB write inside the activity). Scoped to this turn; skipped if no turnId
    // (the op ran under a turn, so on the normal path turnId is set).
    const machineOpEvents = machineOpObserver.drainEvents();
    if (machineOpEvents.length > 0 && attempt.turnId && attempt.executionGeneration > 0) {
      await waitForTurnFinalizerStep(
        appendAndPublishTurnEventsFenced(
          db,
          bus,
          input.workspaceId,
          input.sessionId,
          attempt.turnId,
          attempt.executionGeneration,
          input.attemptId,
          machineOpEvents.map((event) => ({
            ...event,
            turnId: attempt.turnId ?? null,
          })),
        ).catch(() => undefined),
        finalizerSignal,
      );
    }
    // Multi-account P4: flush the serving account's free per-turn caches ONCE,
    // best-effort (same discipline as today's usage write). Both writers skip
    // version/updatedAt, so neither can race the token-refresh CAS.
    if (providerTurn.effectiveCodexCredentialId) {
      // Part A: the latest scraped usage-header snapshot → the P2 usage cache. A
      // full both-windows snapshot (parseCodexUsageHeaders gates on both), so this
      // is byte-identical to the /wham/usage write — no partial-window clobber.
      if (providerTurn.latestCodexUsage) {
        const usageMutation = await waitForTurnFinalizerStep(
          recordCodexAccountUsageWithWakeTargets(
            db,
            input.workspaceId,
            providerTurn.effectiveCodexCredentialId,
            providerTurn.latestCodexUsage,
          ).catch(() => null),
          finalizerSignal,
        );
        if (usageMutation) {
          await waitForTurnFinalizerStep(
            signalCodexCapacityWakeTargets(
              { signalCodexCapacityWorkflow, wakeSessionWorkflow },
              usageMutation.wakeTargets,
            ),
            finalizerSignal,
          );
        }
      }
    }
    leases.codex.stopHeartbeat();
    if (
      leases.codex.held &&
      attempt.turnId &&
      leases.codex.holderId &&
      leases.codex.generation !== null
    ) {
      await waitForTurnFinalizerStep(
        releaseCodexCredentialLease(
          db,
          input.accountId,
          input.workspaceId,
          attempt.turnId,
          leases.codex.holderId,
          leases.codex.generation,
        ).catch(() => undefined),
        finalizerSignal,
      );
      leases.codex.held = false;
    }
    if (
      providerTurn.effectiveXaiCredentialId &&
      leases.xai.subjectId &&
      providerTurn.xaiRequestContext &&
      !providerTurn.xaiCredentialQuarantined
    ) {
      const quota = await waitForTurnFinalizerStep(
        fetchXaiSubscriptionQuota({ context: providerTurn.xaiRequestContext }).catch(() => null),
        finalizerSignal,
      );
      if (quota) {
        await waitForTurnFinalizerStep(
          updateXaiQuotaMetadata(db, {
            workspaceId: input.workspaceId,
            subjectId: leases.xai.subjectId,
            credentialId: providerTurn.effectiveXaiCredentialId,
            quotaUsedPercent: quota.usedPercent,
            quotaResetAt: quota.period?.end ?? null,
            quotaCheckedAt: quota.checkedAt,
            exhaustedUntil:
              quota.usedPercent !== null && quota.usedPercent >= 100
                ? (quota.period?.end ?? null)
                : null,
          }).catch(() => undefined),
          finalizerSignal,
        );
      }
    }
    leases.xai.stopHeartbeat();
    if (
      leases.xai.held &&
      attempt.turnId &&
      leases.xai.subjectId &&
      leases.xai.holderId &&
      leases.xai.generation !== null
    ) {
      await waitForTurnFinalizerStep(
        releaseXaiCredentialLease(db, {
          workspaceId: input.workspaceId,
          subjectId: leases.xai.subjectId,
          turnId: attempt.turnId,
          holderId: leases.xai.holderId,
          generation: leases.xai.generation,
        }).catch(() => undefined),
        finalizerSignal,
      );
      leases.xai.held = false;
    }
    // Workbench v2 turn-end workspace capture — runs FIRST in
    // the turn-end finally, while the box is MAXIMALLY ALIVE. The agent's last
    // tool ran before this finally, so /workspace is already final; capture is
    // FS-equivalent to the already-settled recording preparation and the warm
    // snapshot (neither mutates workspace files). Running it here — BEFORE
    // preparedTools.close() (which tears down tools / computer-use / the display
    // stack and is what starts the Modal box exiting a few seconds later) —
    // gives capture the full live-box margin instead of racing the teardown
    // tail, which was dropping 100% of captures on real Modal desktop boxes
    // ("request cancelled due to container exiting", 0 rows). External module:
    // self-capped at 120s, best-effort (never throws past its boundary),
    // epoch-fenced, and it NEVER closes the box. The emitted
    // workspace.revision.captured event is ANNOUNCE-ONLY (metadata, never
    // content).
    if (process.env.OPENGENI_TEST_SCENARIO === "sandbox") {
      console.log(
        `[sandbox-e2e] capture preflight ownership=${settings.sandboxOwnershipEnabled} enabled=${settings.workspaceCaptureEnabled} resolved=${Boolean(sandboxState.resolvedSandbox)} session=${Boolean(sandboxState.setupBoxSession)} group=${Boolean(sandboxState.sandboxGroupId)} storage=${Boolean(objectStorage)}`,
      );
    }
    const runTurnEndPersistence = shouldRunTurnEndWorkspacePersistence({
      activityStatus: control.activityStatus,
      cancellationRequested: finalizerSignal?.aborted === true,
    });
    if (
      runTurnEndPersistence &&
      attempt.turnId &&
      sandboxState.resolvedSandbox &&
      sandboxState.setupBoxSession &&
      sandboxState.sandboxGroupId
    ) {
      // Block new periodic snapshots, then drain any one already in flight.
      // Keep the lease heartbeat itself running: capture may legitimately
      // exceed the 90s holder TTL, and the reaper must remain unable to drain
      // the exact box while this holder still reads it.
      sandboxState.turnEndCaptureInProgress = true;
      if (sandboxState.snapshotInFlight) {
        await waitForWarmSnapshot(
          sandboxState.snapshotInFlight,
          settings.sandboxSnapshotTimeoutMs,
          finalizerSignal,
        );
      }
      const captureEstablished = sandboxState.resolvedSandbox.established;
      await captureWorkspaceRevision({
        db,
        objectStorage,
        settings,
        publish: async (events) => {
          await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
        },
        session: sandboxState.setupBoxSession as ChannelASession,
        openReadSession: async () =>
          await openFreshWorkspaceCaptureSession({
            backendId: captureEstablished.backendId,
            client: captureEstablished.client,
            session: sandboxState.setupBoxSession as ChannelASession,
            expectedInstanceId: captureEstablished.instanceId,
          }),
        leaseEpoch: sandboxState.resolvedSandbox.leaseEpoch,
        sandboxGroupId: sandboxState.sandboxGroupId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        attemptId: input.attemptId,
        observability,
        ...(finalizerSignal ? { signal: finalizerSignal } : {}),
      });
    }
    eventing.toolPreparationClosing = true;
    if (eventing.toolPreparationReady) {
      await waitForTurnFinalizerStep(
        eventing.toolPreparationReady.catch(() => undefined),
        finalizerSignal,
      );
    }
    if (eventing.codemodeDispatcher) {
      await waitForTurnFinalizerStep(
        eventing.codemodeDispatcher.close().catch(() => undefined),
        finalizerSignal,
      );
      eventing.codemodeDispatcher = null;
    }
    if (eventing.preparedTools) {
      await waitForTurnFinalizerStep(
        eventing.preparedTools.close().catch(() => undefined),
        finalizerSignal,
      );
    }
    if (eventing.heartbeatTimer) {
      clearInterval(eventing.heartbeatTimer);
    }
    if (sandboxState.turnSandboxProvisioner?.hasStarted()) {
      await waitForTurnFinalizerStep(
        sandboxState.turnSandboxProvisioner.waitForSettled(30_000),
        finalizerSignal,
      );
    } else if (sandboxState.prefetchedManagedBox) {
      // Create finished (or was aborted) before get()/setup. Join so a
      // successful prefetch cannot leak a holder after this attempt ends.
      await waitForTurnFinalizerStep(
        sandboxState.prefetchedManagedBox.then(
          (box) => {
            sandboxState.prefetchedManagedBoxResult = box;
          },
          () => undefined,
        ),
        finalizerSignal,
      );
    }
    // P1.2: stop the lease-TTL refresh, release the turn holder (idempotent
    // delete-my-row; refcount-- and warm->draining if it hit 0 with no turns),
    // and DROP the in-memory handle. Release NEVER stops the box — the reaper
    // (P1.3) issues the provider stop() past the drain grace at refcount 0; the
    // box rides the provider idle-timeout in the meantime. Best-effort: a
    // release failure must never mask the turn's real outcome.
    if (sandboxState.leaseHeartbeatTimer) {
      stopLeaseHeartbeat();
    }
    if (sandboxState.rotationInFlight) {
      await waitForTurnFinalizerStep(sandboxState.rotationInFlight, finalizerSignal).catch(
        () => undefined,
      );
    }
    // A recording normally closes inside the attempt-fenced turn settlement.
    // Reaching finally with one still active means settlement threw, never ran,
    // or lost ownership. Stop ffmpeg and mark only this exact attempt-owned row
    // failed; publish no event and leave the artifact recoverable on the box.
    await waitForTurnFinalizerStep(
      abandonActiveRecording(
        "activity ended without recording settlement",
        recordingState.didComputerUse ? "failed" : "discard",
      ),
      finalizerSignal,
    );
    if (sandboxState.resolvedSandbox) {
      // TURN-END mid-session snapshot (sandbox-file-persistence): fold the
      // turn's finished /workspace onto the lease before releasing the holder,
      // so the work this turn just produced survives any unclean box death in
      // the idle window ahead. Throttled by the same interval as the heartbeat
      // tick (a short turn right after a snapshot skips — bounded-loss contract
      // is the interval, not per-turn). Best-effort and time-capped by the
      // helper's own failure discipline; never delays release on failure.
      const settledTurnId = attempt.turnId;
      if (
        runTurnEndPersistence &&
        sandboxState.setupBoxSession &&
        sandboxState.sandboxGroupId &&
        settledTurnId
      ) {
        // Single-flight vs the heartbeat capture: the timer is already cleared
        // above, but a capture it launched may still be in flight — and that
        // capture predates the turn's final writes. Wait for it, but only up
        // to the snapshot timeout: release must never depend on an unbounded
        // provider capture.
        if (sandboxState.snapshotInFlight) {
          await waitForWarmSnapshot(
            sandboxState.snapshotInFlight,
            settings.sandboxSnapshotTimeoutMs,
            finalizerSignal,
          );
        }
        const persisted = await maybePersistWarmWorkspaceSnapshot(
          { db, settings },
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: settledTurnId,
            attemptId: input.attemptId,
            sandboxGroupId: sandboxState.sandboxGroupId,
          },
          sandboxState.setupBoxSession,
          sandboxState.resolvedSandbox.leaseEpoch,
          finalizerSignal,
        );
        if (persisted && eventing.publish) {
          await eventing
            .publish([
              {
                type: "sandbox.box.snapshot",
                payload: { trigger: "turn-end" },
              },
            ])
            .catch(() => undefined);
        }
        // NB workspace capture no longer runs here — it moved to
        // the TOP of this finally (before preparedTools.close) so it completes
        // while the box is still solidly alive, instead of racing the turn-end
        // teardown that was killing 100% of captures on real Modal desktop boxes.
      }
    }
  } catch (error) {
    finalizationError ??= error;
    console.error(
      "agent turn finalization failed (turn outcome unaffected)",
      safeErrorDiagnostic(error),
    );
  } finally {
    // The writer drain is the only authority that licenses settling an
    // abandoned turn admission. Keep this second-stage release outside all
    // later housekeeping so an event/cache/capture/recording failure cannot
    // strand a null-outcome admission forever. Do not race it against
    // Temporal cancellation: the eager listener may already have dropped
    // the holder, and this idempotent proof-bearing pass still must run.
    stopLeaseHeartbeat();
    const sandboxReleaseTargets = new Set(sandboxState.lateSandboxesAwaitingWriterDrain);
    sandboxState.lateSandboxesAwaitingWriterDrain.clear();
    if (sandboxState.resolvedSandbox) {
      sandboxReleaseTargets.add(sandboxState.resolvedSandbox);
      sandboxState.resolvedSandbox = null;
    } else if (sandboxState.prefetchedManagedBoxResult) {
      sandboxReleaseTargets.add(sandboxState.prefetchedManagedBoxResult);
    }
    sandboxState.prefetchedManagedBoxResult = null;
    if (sandboxState.attemptWritersDrained) {
      for (const sandboxToRelease of sandboxReleaseTargets) {
        try {
          await releaseTurnSandboxAfterWriterDrain(sandboxToRelease);
        } catch (releaseError) {
          finalizationError ??= releaseError;
          console.error(
            "sandbox lease quiesced release failed (turn outcome unaffected)",
            safeErrorDiagnostic(releaseError),
          );
        }
      }
    } else {
      // No proof exists. Ensure every late result still receives the eager
      // leak-prevention release while preserving its admissions as a
      // fail-closed archive-capture fence.
      for (const sandboxToRelease of sandboxReleaseTargets) {
        await sandboxToRelease.release().catch(() => undefined);
      }
    }
    // Close provisioning after consuming the currently known targets. A
    // provider result that races in later is routed through releaseLateSandbox;
    // targets already released above synchronously removed their listener.
    if (!sandboxResumeController.signal.aborted) {
      sandboxResumeController.abort(
        cancellationSignal?.reason ?? new Error("TURN_ATTEMPT_FINALIZED"),
      );
    }
    cancellationSignal?.removeEventListener("abort", noteCancellationRequested);
    const completedAt = performance.now();
    const durationSeconds = (completedAt - activityStarted) / 1000;
    const finalizationDurationSeconds = (completedAt - finalizationStarted) / 1000;
    observability.observeHistogram({
      name: "opengeni_turn_finalization_duration_seconds",
      help: "Agent turn finalization duration, including workspace housekeeping and lease release.",
      labels: {
        cancellation_requested: String(control.cancellationRequestedAt !== null),
      },
      value: finalizationDurationSeconds,
    });
    if (control.cancellationRequestedAt !== null) {
      const physicalCancellationDurationSeconds =
        (completedAt - control.cancellationRequestedAt) / 1000;
      observability.observeHistogram({
        name: "opengeni_turn_physical_cancellation_duration_seconds",
        help: "Time from Temporal cancellation delivery until the activity physically stops.",
        value: physicalCancellationDurationSeconds,
      });
      observability.info("agent turn physical cancellation completed", {
        durationMs: Math.round(physicalCancellationDurationSeconds * 1000),
        ...(sandboxState.sandboxGroupId
          ? {
              sandboxLeaseKey: sandboxLeaseTelemetryKey(
                input.workspaceId,
                sandboxState.sandboxGroupId,
              ),
            }
          : {}),
      });
    }
    observability.recordWorkerActivity({
      activity: "runAgentTurn",
      status: finalizationError ? "cleanup_failed" : control.activityStatus,
      durationSeconds,
    });
    if (attempt.turnId && control.activityStatus !== "unknown") {
      turnLifecycleMetricsFor(observability).finish(
        attempt.turnId,
        control.turnMetricOutcome,
        durationSeconds,
      );
    }
    activitySpan.end({
      attributes: {
        "opengeni.turn_id": attempt.turnId ?? "",
        "opengeni.status": control.activityStatus,
        "opengeni.variable_set_id": workspaceRefs.variableSetId,
        "opengeni.rig_id": workspaceRefs.rigId,
        "opengeni.rig_version_id": workspaceRefs.rigVersionId,
        "opengeni.codex_credential_id": providerTurn.effectiveCodexCredentialId ?? "",
        "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        "opengeni.finalization_duration_ms": Math.round(finalizationDurationSeconds * 1000),
      },
      error:
        finalizationError || control.activityError
          ? safeErrorForTelemetry(finalizationError ?? control.activityError)
          : undefined,
    });
    // This timer runs only after the activity promise and its full turn
    // stack unwind. Checkpoint collection alone cannot reclaim objects that
    // remain strongly reachable until this terminal boundary.
    turnCompletionMemoryCollector.schedule(observability);
    assertPhysicalToolQuiescenceForCancellation({
      acknowledgeQuiescence: control.acknowledgeQuiescence,
      physicalToolQuiescenceConfirmed,
      failure: finalizationError,
    });
    assertSessionAttemptQuiescenceRecoveryDurable({
      acknowledgeQuiescence: control.acknowledgeQuiescence,
      physicalToolQuiescenceConfirmed,
      receiptOrProofDurable: quiescenceReceiptOrProofDurable,
      failure: finalizationError,
    });
  }
}
