import {
  setSessionLastInputTokensForTurnAttempt,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
} from "@opengeni/db";
import { createDetachedSessionEventFanout } from "@opengeni/events";
import { sandboxOperationMetricObserver } from "@opengeni/observability";
import type { SessionEvent } from "@opengeni/contracts";
import {
  REMOTE_COMPACTION_V2_BETA_FEATURE,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  materializeSandboxFileDownloads,
  sandboxFileDownloadFailureNote,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type CodemodeTokenWriterSession,
} from "@opengeni/runtime";
import { buildCodexTokenResolver } from "../codex-auth";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  codexRequestStorage,
  withCodexRequestOverrides,
  type CodexRequestContext,
} from "@opengeni/codex";
import {
  xaiSubscriptionRequestStorage,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import { buildXaiTurnRequestAuthorization } from "../xai-auth";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { currentActivityContext } from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import {
  AgentLoopPhaseTracker,
  makeMachineOpObserver,
  modelRequestLifecycleMetricsFor,
  recordDetachedSessionEventFanoutOutcome,
  recordModelRequestPhase,
  recordCompanyBrainContributions,
  recordSessionEventPublishLatency,
  recordTurnStartupPhase,
  runtimeMetricsHooksForObservability,
} from "../../observability-metrics";
import { summarizeCompanyBrainContributions } from "../../model-context-contributions";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { createTurnHistorySink } from "./history-sink";
import { checkpointHistoryBeforeProviderDispatch } from "./provider-dispatch-barrier";
import { providerRecoveryCountAfterModelRequestPhase } from "./errors";
import { sandboxRunAs } from "@opengeni/runtime";
import { randomUUID } from "node:crypto";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";

import { codexWorkspaceMetricKey } from "./codex";
import {
  filterUnmaterializedSandboxFileDownloads,
  sandboxFileMaterializationOutcome,
  sandboxFileDownloadsForRun,
  objectStorageForSandboxDownloads,
} from "./file-resources";
import { TurnEventPublisher } from "./model-usage";
import { waitForTurnOperation } from "./sandbox-provision";
import { createTurnContext, type EventingState } from "./turn-context";
import { finalizeTurnAttempt } from "./finalization";
import { settleTurnFailure } from "./failure-settlement";
import { runTurnStreamAttempt } from "./stream-attempt";
import { claimTurnAttempt } from "./claim";
import { selectCodexTurnCapacity, type CapacityPhaseDeps } from "./codex-capacity";
import { prepareGovernanceAndModel } from "./governance-model";
import { prepareCompaction, runPostAgentCompaction } from "./compaction-prep";
import { createSandboxTurnRuntime } from "./sandbox-runtime";
import {
  resolveSandboxRoute,
  establishTurnSandbox,
  bindLazySandboxProvisioner,
} from "./sandbox-establish";
import { selectXaiTurnCapacity } from "./xai-capacity";
import { prepareRunCredentials } from "./run-credentials";
import { prepareTurnToolPolicy, prepareTurnToolRuntime } from "./tool-environment";
import { applyTurnGitHubRepositoryBindings } from "./github-repository-bindings";
import { buildTurnAgent } from "./agent-build";

/**
 * Retain subscription credential/account authority for the title sidecar
 * without sharing main-stream recovery, startup, audit, or opaque-artifact
 * callbacks. Title usage is returned by the runtime and metered separately.
 */
export function sessionTitleCodexRequestContext(
  context: CodexRequestContext,
  nextRequestId: () => string,
): CodexRequestContext {
  return {
    clientVersion: context.clientVersion,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    getToken: context.getToken,
    refresh: context.refresh,
    resolveModel: context.resolveModel,
    ...(context.onUsageHeaders ? { onUsageHeaders: context.onUsageHeaders } : {}),
    ...(context.responseTimeoutPolicy
      ? { responseTimeoutPolicy: context.responseTimeoutPolicy }
      : {}),
    nextRequestId,
    turnMetadata: { request_kind: "session_title" },
  };
}

export function sessionTitleXaiRequestContext(
  context: XaiSubscriptionRequestContext,
  nextRequestId: () => string,
): XaiSubscriptionRequestContext {
  return {
    clientVersion: context.clientVersion,
    sessionId: context.sessionId,
    turnId: context.turnId,
    getToken: context.getToken,
    refresh: context.refresh,
    resolveModel: context.resolveModel,
    ...(context.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: context.streamIdleTimeoutMs }
      : {}),
    ...(context.hostedToolContinuationTimeoutMs !== undefined
      ? { hostedToolContinuationTimeoutMs: context.hostedToolContinuationTimeoutMs }
      : {}),
    nextRequestId,
  };
}

/** Lifecycle orchestrator: claim → capacity → governance → sandbox → tools → stream. */
export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  const modelCheckpointMemoryCollector = createModelCheckpointMemoryCollector();
  // Keep a distinct cooldown for terminal collection. A collection at the
  // final model checkpoint happens while the activity still owns its complete
  // turn graph and must not suppress collection after that graph is released.
  const turnCompletionMemoryCollector = createModelCheckpointMemoryCollector();
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const {
      settings,
      catalogSourceSettings = settings,
      db,
      bus,
      runtime,
      summarizeContextForCompaction,
      objectStorage,
      observability,
      wakeSessionWorkflow,
      signalSessionAttemptQuiesced,
      signalCodexCapacityWorkflow,
      entitlements,
      connectionCredentials,
      personalGitHubCredentials,
      startVideoGenerationWorkflow,
    } = await services();
    const activityContext = currentActivityContext();
    const cancellationSignal = activityContext?.cancellationSignal;
    // Temporal cancellation is not the only way an activity loses ownership:
    // a database attempt fence or workflow abandonment can finalize the logical
    // turn while the SDK cancellation signal remains open. Bind sandbox
    // provisioning to both lifetimes so an uninterruptible, late provider
    // promise cannot resurrect a holder after this activity has finalized.
    const sandboxResumeController = new AbortController();
    const sandboxResumeSignal = cancellationSignal
      ? AbortSignal.any([cancellationSignal, sandboxResumeController.signal])
      : sandboxResumeController.signal;
    const sandboxRotationController = new AbortController();
    const runtimeCancellationSignal = cancellationSignal
      ? AbortSignal.any([cancellationSignal, sandboxRotationController.signal])
      : sandboxRotationController.signal;

    const detachedLifecycleFanout = createDetachedSessionEventFanout(bus, {
      closeTimeoutMs: 250,
      onPublishOutcome: ({ outcome, durationSeconds }) => {
        recordSessionEventPublishLatency(observability, { durationSeconds });
        recordDetachedSessionEventFanoutOutcome(observability, { outcome, durationSeconds });
      },
    });
    const publishActivitySessionEvents = async (events: SessionEvent[]): Promise<void> => {
      await detachedLifecycleFanout.publishAwaited(input.workspaceId, input.sessionId, events, {
        onPublish: ({ durationSeconds }) =>
          recordSessionEventPublishLatency(observability, { durationSeconds }),
      });
    };
    const agentLoopPhaseTracker = new AgentLoopPhaseTracker();

    const {
      control,
      attempt,
      billingState,
      sandboxState,
      renewals,
      eventing,
      workspaceRefs,
      providerTurn,
    } = createTurnContext({
      settings,
      cancellationRequestedAt: cancellationSignal?.aborted ? performance.now() : null,
      detachedFanout: detachedLifecycleFanout,
      publishDurable: publishActivitySessionEvents,
      phaseTracker: agentLoopPhaseTracker,
    });
    const noteCancellationRequested = (): void => {
      control.cancellationRequestedAt ??= performance.now();
    };
    cancellationSignal?.addEventListener("abort", noteCancellationRequested, {
      once: true,
    });
    const dispatchId = activityContext?.info.activityId ?? randomUUID();
    const activityStarted = performance.now();
    const activitySpan = observability.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": input.sessionId,
      "opengeni.workflow_id": input.workflowId,
      "opengeni.trigger_kind": input.trigger.kind,
    });
    const acknowledgeLostAttemptOwnership = (): void => {
      // A stale terminal/recovery settlement can lose either to a benign
      // successor or to Pause/Steer closing this exact attempt. Only the
      // receipt transaction can distinguish those cases after the hard tool
      // fence: allowUninterrupted makes the benign case an event-free no-op.
      control.acknowledgeQuiescence = true;
      noteCancellationRequested();
    };
    const acknowledgeRecoveryQuiescence = (): void => {
      // requestSessionTurnRecovery closed this exact attempt and durably
      // recorded the replacement cause. The activity still owns the physical
      // tool/credential boundary until finally drains it and publishes the
      // exact quiescence receipt; a workflow result alone is never that proof.
      control.acknowledgeQuiescence = true;
      noteCancellationRequested();
    };
    const claimedResult = (
      result: Omit<
        Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
        "turnId" | "attemptId"
      >,
    ): RunAgentTurnResult => {
      if (!attempt.turnId)
        throw new Error("Claimed activity result produced before turn admission");
      return {
        ...result,
        turnId: attempt.turnId,
        attemptId: input.attemptId,
      } as RunAgentTurnResult;
    };
    // The Connected Machine op observer for this turn: meters every op AND buffers
    // the eventable ones (infra failures + healed recoveries) as machine.op.* session
    // events, drained (awaited) at turn end in the finally below. ONE instance shared
    // by the machine-primary establish + both routing wraps.
    const machineOpObserver = makeMachineOpObserver(
      runtimeMetricsHooksForObservability(observability),
    );
    const sandboxOperationObserver = sandboxOperationMetricObserver(observability);
    // Still required by credential-loss/capacity settlements, whose own
    // recovery transactions fence against worker-death redispatches.
    const setLastInputTokensFenced = async (lastInputTokens: number | null): Promise<void> => {
      if (!attempt.turnId || attempt.executionGeneration <= 0) {
        throw new Error("Turn attempt was not initialized before token accounting");
      }
      if (
        !(await setSessionLastInputTokensForTurnAttempt(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attempt.turnId,
          expectedExecutionGeneration: attempt.executionGeneration,
          expectedAttemptId: input.attemptId,
          lastInputTokens,
        }))
      ) {
        throw new TurnAttemptFencedError("turn attempt was fenced while recording input tokens");
      }
    };
    const codexWorkspaceKey = codexWorkspaceMetricKey(input.workspaceId);
    const leases = createTurnCredentialLeases({
      db,
      observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      codexWorkspaceKey,
      getTurnId: () => attempt.turnId,
    });

    const sandboxRuntime = createSandboxTurnRuntime({
      input,
      settings,
      db,
      objectStorage,
      observability,
      cancellationSignal,
      activityContext,
      sandboxRotationController,
      sandboxState,
      eventing,
      attempt,
    });
    const {
      requireResolvedSandboxForMutation,
      runWorkspaceMutationForSandbox,
      stopLeaseHeartbeat,
      flushRuntimeBatcher,
      finalizeTurnOpStreamOps,
    } = sandboxRuntime;

    const media = createTurnMediaArtifacts({
      db,
      objectStorage,
      observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      getTurnId: () => attempt.turnId,
      getModelRunSettings: () => eventing.modelRunSettings,
      getPublish: () => eventing.publish,
      toolCancellationFenceRef: eventing.toolCancellationFenceRef,
      getResolvedSandbox: () => sandboxState.resolvedSandbox,
      getSetupBoxSession: () => sandboxState.setupBoxSession,
      getSandboxGroupId: () => sandboxState.sandboxGroupId,
      runWorkspaceMutation: runWorkspaceMutationForSandbox,
    });
    const videoGenerationAcceptancesByCallId = new Map<
      string,
      { operationId: string; requestDigest: string }
    >();
    const requiredGeneratedVideoFiles: Array<{
      operationId: string;
      artifactId: string;
      fileId: string;
      objectKey: string;
      sizeBytes: number;
      sha256: string;
      filename: string;
    }> = [];
    const toolResultSpill = new ToolResultSpill({
      db,
      objectStorage,
      observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      attemptId: input.attemptId,
      getModelRunSettings: () => eventing.modelRunSettings,
      getSandboxFileDownloadBackend: () => media.sandboxFileDownloadBackend,
      getPublish: () => {
        const current = eventing.publish;
        if (!current) return null;
        return async (events, immediate) =>
          await current(events as Parameters<TurnEventPublisher>[0], immediate);
      },
      toolCancellationFenceRef: eventing.toolCancellationFenceRef,
      getResolvedSandbox: () => sandboxState.resolvedSandbox,
      getSetupBoxSession: () => sandboxState.setupBoxSession,
      getSdkOwnedSandboxSession: () => media.sdkOwnedSandboxSession,
      getSandboxGroupId: () => sandboxState.sandboxGroupId,
      runWorkspaceMutation: runWorkspaceMutationForSandbox,
    });
    const historySink = createTurnHistorySink({
      db,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      media,
      getTurnId: () => attempt.turnId,
      getStream: () => eventing.stream,
      getModelRunSettings: () => eventing.modelRunSettings,
      getExecutionGeneration: () => attempt.executionGeneration,
    });

    try {
      const claimed = await claimTurnAttempt({
        input,
        settings,
        catalogSourceSettings,
        db,
        bus,
        runtime,
        observability,
        entitlements,
        wakeSessionWorkflow,
        cancellationSignal,
        activityContext,
        dispatchId,
        activityStarted,
        control,
        attempt,
        billingState,
        sandboxState,
        eventing,
        leases,
        media,
        claimedResult,
        acknowledgeLostAttemptOwnership,
      });
      if ("exit" in claimed) return claimed.exit;
      if (!eventing.publish || !eventing.settle) {
        throw new Error("turn eventing was not wired during claim");
      }
      // Same object, narrowed type: every post-claim phase mutates this exact
      // context, so this must stay an assertion and never become a copy.
      const wiredEventing = eventing as EventingState & {
        publish: NonNullable<EventingState["publish"]>;
        settle: NonNullable<EventingState["settle"]>;
      };
      const {
        turn,
        session,
        installedApiIntegrations,
        credentialSubjectId,
        fileAuthoritySubjectId,
        capabilitySettings,
        codexAppsCredentialId,
        turnExecutionPolicy,
        trigger,
        humanInputResume,
        interactionInterventionResume,
        attachPendingUpdatesAfterOpenSuffix,
        throwIfWorkerShuttingDown,
        throwIfTurnCancelled,
        opJournal,
        modelUsageDispatchId,
        claimedModelUsageSourceKeys,
        emittedModelUsageSourceKeys,
      } = claimed.ok;
      if (!attempt.turnId) {
        throw new Error("Turn id was not initialized");
      }
      if (!leases.codex.holderId) {
        throw new Error("Codex lease holder was not initialized");
      }
      const workerPreparationStartedAt = performance.now();

      // Multi-account (P1): resolve the effective Codex account for this turn
      // (session-pin > workspace active) and stamp it on the session so the
      // in-session "Running on:" indicator reflects reality. Emit a switch event
      // when it changed from the prior run's account so the pill flips live.
      // Gated on the codex-billed predicate — non-codex turns never touch this.
      {
        const capacityDeps: CapacityPhaseDeps = {
          input,
          settings,
          db,
          bus,
          observability,
          wakeSessionWorkflow,
          signalCodexCapacityWorkflow,
          cancellationSignal,
          dispatchId,
          control,
          attempt,
          billingState,
          eventing: wiredEventing,
          providerTurn,
          leases,
          claimedResult,
          acknowledgeLostAttemptOwnership,
          acknowledgeRecoveryQuiescence,
          setLastInputTokensFenced,
          turn,
          session,
          turnExecutionPolicy,
          trigger,
          codexWorkspaceKey,
        };
        const codexCapacity = await selectCodexTurnCapacity(capacityDeps);
        if ("exit" in codexCapacity) return codexCapacity.exit;
        const xaiCapacity = await selectXaiTurnCapacity(capacityDeps);
        if ("exit" in xaiCapacity) return xaiCapacity.exit;
      }

      const governance = await prepareGovernanceAndModel({
        input,
        db,
        runtime,
        objectStorage,
        eventing,
        workspaceRefs,
        media,
        turn,
        session,
        capabilitySettings,
        fileAuthoritySubjectId,
        humanInputResume,
        turnExecutionPolicy,
        requiredGeneratedVideoFiles,
      });
      if ("exit" in governance) return governance.exit;
      const {
        runtimePreparationStartedAt,
        packRuntime,
        installedSkillRuntime,
        rigVersion,
        rigName,
        agentHumanInputEnabled,
        workspaceAgentInstructions,
        workspaceGovernance,
        structuredWorkspacePolicyActive,
        workspaceMemory,
        buildCompanyBrainContributionReceiptFor,
        logicalSandboxSettings,
        verifiedRigProviderImageId,
        runSettings,
        resolvedModel,
        providerApi,
        nativeImageProviderBinding,
        lazyToolTransport,
        modelInputPolicy,
        supportsImageInput,
        modelHistoryProjector,
        generatedImageHistoryProjector,
        compactionModelHistoryProjector,
      } = governance.ok;

      // A codex-subscription turn resolves the bearer for THIS turn's effective
      // codex account (effectiveCodexCredentialId; pin > workspace-active) at
      // model-call time — multi-account P1 means a workspace can hold N accounts,
      // so the bearer is per-account, not per-workspace. codexSubscriptionFetch
      // (on the provider's OpenAI client) reads this AsyncLocalStorage context.
      // Build it once and wrap BOTH the compaction summarizer (a separate model
      // call on the same codex client) and the main run; otherwise the summarizer
      // would hit the codex backend unauthenticated.
      let codexModelRequestSequence = 0;
      let firstModelRequestAuditRecorded = false;
      const firstModelRequestCheckpoints = new Set<string>();
      const codexContext: CodexRequestContext | null =
        resolvedModel?.provider.kind === "codex-subscription"
          ? ((): CodexRequestContext => {
              // The empty-string fallback yields no row → null credential → the
              // existing CodexReloginRequired path (a codex turn with no usable
              // account fails closed, exactly as before multi-account).
              const resolver = buildCodexTokenResolver(
                db,
                runSettings,
                input.workspaceId,
                providerTurn.effectiveCodexCredentialId ?? "",
              );
              return {
                clientVersion: CODEX_CLIENT_VERSION,
                // Backend sticky cache-routing key — the SAME id as the body's
                // prompt_cache_key (set from input.sessionId for codex turns),
                // so routing and cache key agree. Without this header on the
                // wire, byte-identical resends hit the prompt cache ~50%
                // (per-request shard lottery = prod's measured 48.6% on sol);
                // with it, resends pin to the warm shard (Codex CLI parity).
                sessionId: input.sessionId,
                getToken: () => resolver.getToken(),
                refresh: () => resolver.refresh(),
                resolveModel: buildModelResolver(
                  CODEX_FALLBACK_MODEL_SLUGS,
                  CODEX_FALLBACK_MODEL_SLUGS[0],
                ),
                onUsageHeaders: (snapshot) => {
                  providerTurn.latestCodexUsage = snapshot;
                }, // latest wins; flushed once in finally
                onRequestPreparationDiagnostic: (phase) => {
                  if (
                    eventing.firstModelRequestCheckpointAt === null ||
                    firstModelRequestCheckpoints.has(phase)
                  ) {
                    return;
                  }
                  const now = performance.now();
                  const metricPhase =
                    phase === "transport_entry"
                      ? "model_sdk_serialization"
                      : phase === "credential_ready"
                        ? "model_credential_resolution"
                        : "model_wire_normalization";
                  firstModelRequestCheckpoints.add(phase);
                  recordTurnStartupPhase(observability, {
                    phase: metricPhase,
                    provider: turnExecutionPolicy.providerId,
                    backend: activeSandboxBackend ?? groupBoxBackend,
                    outcome: "completed",
                    durationSeconds: (now - eventing.firstModelRequestCheckpointAt) / 1_000,
                    count: turnTools.length,
                  });
                  eventing.firstModelRequestCheckpointAt = now;
                },
                onRequestOpaqueArtifacts: ({ fingerprints }) => {
                  providerTurn.lastCodexRequestOpaqueArtifacts = fingerprints;
                },
                onModelRequestDiagnostic: (event) => {
                  if (event.phase === "started") sandboxState.firstProviderRequestStarted = true;
                  if (
                    event.phase === "started" &&
                    eventing.firstModelRequestPreparationStartedAt !== null &&
                    !eventing.firstModelRequestPreparationRecorded
                  ) {
                    eventing.firstModelRequestPreparationRecorded = true;
                    recordTurnStartupPhase(observability, {
                      phase: "model_request_preparation",
                      provider: turnExecutionPolicy.providerId,
                      backend: activeSandboxBackend ?? groupBoxBackend,
                      outcome: "completed",
                      durationSeconds:
                        (performance.now() - eventing.firstModelRequestPreparationStartedAt) /
                        1_000,
                      count: turnTools.length,
                    });
                  }
                  const phase =
                    event.phase === "headers"
                      ? "headers"
                      : event.phase === "first_byte"
                        ? "first_byte"
                        : event.phase === "completed" ||
                            event.phase === "failed" ||
                            event.phase === "timed_out"
                          ? "terminal"
                          : null;
                  if (!phase) return;
                  recordModelRequestPhase(observability, {
                    provider: "codex-subscription",
                    phase,
                    ...(event.phase === "completed"
                      ? { outcome: "completed" as const }
                      : event.phase === "failed"
                        ? { outcome: "failed" as const }
                        : event.phase === "timed_out"
                          ? { outcome: "timed_out" as const }
                          : {}),
                    durationSeconds: event.durationMs / 1000,
                  });
                },
                nextRequestId: () => `${dispatchId}:${++codexModelRequestSequence}`,
                onModelRequestEvent: async (event) => {
                  if (!eventing.publish || !attempt.turnId) {
                    throw new Error("Codex model request started before the turn event producer");
                  }
                  if (event.phase === "started") {
                    await checkpointHistoryBeforeProviderDispatch(historySink);
                  }
                  const shouldRecordStartedAudit =
                    event.phase === "started" && !firstModelRequestAuditRecorded;
                  if (shouldRecordStartedAudit) {
                    firstModelRequestAuditRecorded = true;
                  }
                  const auditStartedAt = shouldRecordStartedAudit ? performance.now() : null;
                  let auditOutcome: "completed" | "failed" = "completed";
                  try {
                    await eventing.publish([
                      ...(shouldRecordStartedAudit &&
                      eventing.firstModelRequestPreparationStartedAt !== null
                        ? [
                            {
                              type: "turn.startup.phase.completed" as const,
                              payload: {
                                phase: "model_preparation",
                                durationMs: Math.max(
                                  0,
                                  Math.round(
                                    performance.now() -
                                      eventing.firstModelRequestPreparationStartedAt,
                                  ),
                                ),
                              },
                            },
                          ]
                        : []),
                      {
                        type: "agent.model.request",
                        payload: {
                          ...event,
                          provider: "codex-subscription",
                          turnId: attempt.turnId,
                          attemptId: input.attemptId,
                          dispatchId,
                          executionGeneration: attempt.executionGeneration,
                        },
                      },
                    ]);
                    attempt.providerRecoveryCount = providerRecoveryCountAfterModelRequestPhase(
                      attempt.providerRecoveryCount,
                      event.phase,
                    );
                  } catch (error) {
                    auditOutcome = "failed";
                    throw error;
                  } finally {
                    if (auditStartedAt !== null) {
                      recordTurnStartupPhase(observability, {
                        phase: "model_request_audit",
                        provider: turnExecutionPolicy.providerId,
                        backend: activeSandboxBackend ?? groupBoxBackend,
                        outcome: auditOutcome,
                        durationSeconds: (performance.now() - auditStartedAt) / 1_000,
                        count: turnTools.length,
                      });
                    }
                  }
                },
              };
            })()
          : null;
      if (resolvedModel?.provider.kind === "xai-subscription") {
        if (!providerTurn.effectiveXaiCredentialId || !leases.xai.subjectId) {
          throw new Error("SuperGrok subscription execution has no leased credential");
        }
        let xaiModelRequestSequence = 0;
        const authorization = await buildXaiTurnRequestAuthorization({
          db,
          settings: runSettings,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: leases.xai.subjectId,
          sessionId: input.sessionId,
          turnId: turn.id,
          credentialId: providerTurn.effectiveXaiCredentialId,
          authoritySnapshot: turn.xaiProviderAccountAuthoritySnapshot,
          hostedSearch: {
            webSearch: runSettings.webSearchEnabled,
            xSearch: runSettings.webSearchEnabled,
          },
          streamIdleTimeoutMs: runSettings.supergrokResponseStreamIdleTimeoutMs,
          nextRequestId: () => `${dispatchId}:xai:${++xaiModelRequestSequence}`,
          onModelRequestDiagnostic: (event) => {
            const requestKey = `${event.requestId}:${event.transportAttempt}`;
            if (event.phase === "started") {
              sandboxState.firstProviderRequestStarted = true;
              modelRequestLifecycleMetricsFor(observability).start(
                requestKey,
                "supergrok-subscription",
              );
              if (
                eventing.firstModelRequestPreparationStartedAt !== null &&
                !eventing.firstModelRequestPreparationRecorded
              ) {
                eventing.firstModelRequestPreparationRecorded = true;
                recordTurnStartupPhase(observability, {
                  phase: "model_request_preparation",
                  provider: turnExecutionPolicy.providerId,
                  backend: activeSandboxBackend ?? groupBoxBackend,
                  outcome: "completed",
                  durationSeconds:
                    (performance.now() - eventing.firstModelRequestPreparationStartedAt) / 1_000,
                  count: turnTools.length,
                });
              }
            }
            if (event.phase === "first_event" || event.phase === "progress") {
              modelRequestLifecycleMetricsFor(observability).event(
                requestKey,
                event.phase === "progress" ? event.interEventGapMs : undefined,
              );
            }
            const terminal =
              event.phase === "completed" ||
              event.phase === "failed" ||
              event.phase === "timed_out";
            if (terminal) {
              modelRequestLifecycleMetricsFor(observability).finish(requestKey);
            }
            const phase =
              event.phase === "headers"
                ? "headers"
                : event.phase === "first_event"
                  ? "first_byte"
                  : terminal
                    ? "terminal"
                    : null;
            if (!phase) return;
            recordModelRequestPhase(observability, {
              provider: "supergrok-subscription",
              phase,
              ...(terminal
                ? {
                    outcome:
                      event.phase === "completed"
                        ? ("completed" as const)
                        : event.phase === "timed_out"
                          ? ("timed_out" as const)
                          : ("failed" as const),
                  }
                : {}),
              durationSeconds: event.durationMs / 1_000,
            });
          },
          onModelRequestEvent: async (event) => {
            if (!eventing.publish || !attempt.turnId) {
              throw new Error("SuperGrok model request started before the turn event producer");
            }
            if (event.phase === "started") {
              await checkpointHistoryBeforeProviderDispatch(historySink);
            }
            const shouldRecordStartedAudit =
              event.phase === "started" && !firstModelRequestAuditRecorded;
            if (shouldRecordStartedAudit) firstModelRequestAuditRecorded = true;
            const auditStartedAt = shouldRecordStartedAudit ? performance.now() : null;
            let auditOutcome: "completed" | "failed" = "completed";
            try {
              await eventing.publish([
                ...(shouldRecordStartedAudit &&
                eventing.firstModelRequestPreparationStartedAt !== null
                  ? [
                      {
                        type: "turn.startup.phase.completed" as const,
                        payload: {
                          phase: "model_preparation",
                          durationMs: Math.max(
                            0,
                            Math.round(
                              performance.now() - eventing.firstModelRequestPreparationStartedAt,
                            ),
                          ),
                        },
                      },
                    ]
                  : []),
                {
                  type: "agent.model.request",
                  payload: {
                    ...event,
                    provider: "supergrok-subscription",
                    turnId: attempt.turnId,
                    attemptId: input.attemptId,
                    dispatchId,
                    executionGeneration: attempt.executionGeneration,
                  },
                },
              ]);
              attempt.providerRecoveryCount = providerRecoveryCountAfterModelRequestPhase(
                attempt.providerRecoveryCount,
                event.phase,
              );
            } catch (error) {
              auditOutcome = "failed";
              throw error;
            } finally {
              if (auditStartedAt !== null) {
                recordTurnStartupPhase(observability, {
                  phase: "model_request_audit",
                  provider: turnExecutionPolicy.providerId,
                  backend: activeSandboxBackend ?? groupBoxBackend,
                  outcome: auditOutcome,
                  durationSeconds: (performance.now() - auditStartedAt) / 1_000,
                  count: turnTools.length,
                });
              }
            }
          },
        });
        providerTurn.xaiRequestContext = authorization.context;
      }
      const withCodex = <T>(fn: () => Promise<T>): Promise<T> =>
        codexContext ? codexRequestStorage.run(codexContext, fn) : fn();
      const withProviderRequestContext = <T>(fn: () => Promise<T>): Promise<T> =>
        providerTurn.xaiRequestContext
          ? xaiSubscriptionRequestStorage.run(providerTurn.xaiRequestContext, fn)
          : withCodex(fn);
      let codexSessionTitleRequestSequence = 0;
      let xaiSessionTitleRequestSequence = 0;
      const codexSessionTitleContext = codexContext
        ? sessionTitleCodexRequestContext(
            codexContext,
            () => `${dispatchId}:title:${++codexSessionTitleRequestSequence}`,
          )
        : null;
      const xaiSessionTitleContext = providerTurn.xaiRequestContext
        ? sessionTitleXaiRequestContext(
            providerTurn.xaiRequestContext,
            () => `${dispatchId}:xai:title:${++xaiSessionTitleRequestSequence}`,
          )
        : null;
      const withSessionTitleProviderRequestContext = <T>(fn: () => Promise<T>): Promise<T> =>
        xaiSessionTitleContext
          ? xaiSubscriptionRequestStorage.run(xaiSessionTitleContext, fn)
          : codexSessionTitleContext
            ? codexRequestStorage.run(codexSessionTitleContext, fn)
            : fn();
      const withCodexRemoteCompaction = <T>(fn: () => Promise<T>): Promise<T> =>
        withCodex(() =>
          withCodexRequestOverrides(
            {
              betaFeatures: [REMOTE_COMPACTION_V2_BETA_FEATURE],
              turnMetadata: {
                request_kind: "compaction",
                compaction: {
                  implementation: REMOTE_COMPACTION_V2_IMPLEMENTATION,
                  strategy: "memento",
                },
              },
            },
            fn,
          ),
        );
      const compactionPrep = await prepareCompaction({
        input,
        settings: capabilitySettings,
        db,
        bus,
        observability,
        cancellationSignal,
        control,
        attempt,
        billingState,
        eventing: wiredEventing,
        providerTurn,
        leases,
        media,
        claimedResult,
        claimedModelUsageSourceKeys,
        emittedModelUsageSourceKeys,
        modelUsageDispatchId,
        turn,
        session,
        turnExecutionPolicy,
        resolvedModel,
        workspaceAgentInstructions,
        workspaceGovernance,
        structuredWorkspacePolicyActive,
        workspaceMemory,
        rigVersion,
        rigName,
        compactionModelHistoryProjector,
        summarizeContextForCompaction,
        withProviderRequestContext,
        withCodexRemoteCompaction,
      });
      if ("exit" in compactionPrep) return compactionPrep.exit;
      const {
        promptCacheKey,
        remotePrefix,
        remoteCompactionRequester,
        publishCompactionLiveEvents,
        publishCompactionOutcomeEvents,
        compactionModeOptions,
        compactionOnlyTurn,
        compactionSummarizerFor,
        settleDeferredSteerAfterCompaction,
      } = compactionPrep.ok;

      const toolPolicy = await prepareTurnToolPolicy({
        input,
        db,
        cancellationSignal,
        connectionCredentials,
        turn,
        session,
        fileAuthoritySubjectId,
        capabilitySettings,
        runSettings,
        rigVersion,
        workspaceRefs,
      });
      const {
        turnResources: claimedTurnResources,
        runtimeResources: claimedRuntimeResources,
        mcpAvailabilityNote,
        turnTools,
        connectionScope,
        workspaceVariableSet,
        sandboxWorkspaceEnvironmentValues,
      } = toolPolicy;

      const sandboxRoute = await resolveSandboxRoute({
        input,
        settings,
        db,
        eventing,
        sandboxState,
        media,
        fileAuthoritySubjectId,
        runSettings,
        logicalSandboxSettings,
      });
      const {
        routingOn,
        activeSandboxBackend,
        machinePrimary,
        groupBoxBackend,
        sandboxCreationBackend,
        effectiveRunCredentialBackend,
      } = sandboxRoute;

      // A bare github.com repository URI (API caller, older session, or an
      // agent-spawned child inheriting its parent's resources) resolves to
      // the workspace's GitHub App binding here, before credential minting
      // and the runtime clone plan derive binding ids from the same resource
      // set. A Connected Machine receives no platform Git credential, so its
      // resources stay exactly as stored. Resolution never fails the turn;
      // an unusable bound repository stays bare and is reported visibly.
      const { turnResources, runtimeResources } = await waitForTurnOperation(
        applyTurnGitHubRepositoryBindings({
          db,
          settings: runSettings,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          activeSandboxBackend,
          claimedTurnResources,
          claimedRuntimeResources,
          publish: async (events) => {
            await eventing.publish!(events, true);
          },
          warn: (message, fields) => observability.warn(message, fields),
        }),
        cancellationSignal,
        undefined,
      );

      const runCredentials = await prepareRunCredentials({
        input,
        settings,
        db,
        observability,
        cancellationSignal,
        connectionCredentials,
        personalGitHubCredentials,
        eventing,
        attempt,
        renewals,
        sandboxState,
        sandboxRuntime,
        turn,
        session,
        fileAuthoritySubjectId,
        runSettings,
        workspaceVariableSet,
        turnResources,
        requiredGeneratedVideoFiles,
        machinePrimary,
        activeSandboxBackend,
        groupBoxBackend,
        sandboxCreationBackend,
        effectiveRunCredentialBackend,
        sandboxWorkspaceEnvironmentValues,
        connectionScope,
        runWorkspaceMutationForSandbox,
      });
      const {
        runCredentialResolver,
        establishPolicy,
        initialRunCredentialMaterial,
        runCredentialsNote,
        hostCredentialRootSessionId,
        codemodeAuthority,
        sandboxArtifactRuntime,
        sandboxEnvironment,
        sandboxGitToken,
        sandboxGitTokens,
        sandboxGitCredentialBindings,
        sandboxCodemodeToken,
        sandboxCodemodeTokenExpiresAt,
        transientCodemodeEnvironment,
        initialGitCredentials,
        startRunGitCredentialsMint,
        attachGitCredentialRenewal,
        attachCodemodeTokenRenewal,
        attachRunCredentialRenewal,
      } = runCredentials;

      await establishTurnSandbox({
        ...sandboxRoute,
        input,
        settings,
        db,
        bus,
        objectStorage,
        observability,
        cancellationSignal,
        runtimeCancellationSignal,
        sandboxResumeSignal,
        activityContext,
        opJournal,
        sandboxState,
        eventing,
        attempt,
        turn,
        session,
        fileAuthoritySubjectId,
        capabilitySettings,
        turnExecutionPolicy,
        runSettings,
        logicalSandboxSettings,
        verifiedRigProviderImageId,
        runtimePreparationStartedAt,
        establishPolicy,
        sandboxEnvironment,
        startRunGitCredentialsMint,
        machineOpObserver,
        sandboxOperationObserver,
        sandboxRuntime,
        transientCodemodeEnvironment,
        rigVersion,
        turnResources,
      });

      const ordinaryFileResourceDownloads = await (async () => {
        const fileResolutionStartedAt = performance.now();
        let fileResolutionOutcome: "completed" | "failed" = "completed";
        try {
          return await waitForTurnOperation(
            sandboxFileDownloadsForRun(
              runSettings,
              db,
              objectStorage,
              input.accountId,
              input.workspaceId,
              fileAuthoritySubjectId,
              turn.resources,
              activeSandboxBackend ?? groupBoxBackend,
            ),
            cancellationSignal,
            undefined,
          );
        } catch (error) {
          fileResolutionOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "file_resolution",
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: fileResolutionOutcome,
            durationSeconds: (performance.now() - fileResolutionStartedAt) / 1_000,
            count: turn.resources.length,
          });
        }
      })();
      if (requiredGeneratedVideoFiles.length > 0 && !objectStorage) {
        throw new Error("Generated video materialization requires object storage");
      }
      const generatedVideoDownloads: SandboxFileDownload[] = [];
      if (objectStorage && requiredGeneratedVideoFiles.length > 0) {
        const downloadStorage = objectStorageForSandboxDownloads(
          eventing.modelRunSettings,
          objectStorage,
          media.sandboxFileDownloadBackend,
        );
        for (const file of requiredGeneratedVideoFiles) {
          const signed = await downloadStorage.createGetUrl({
            key: file.objectKey,
          });
          generatedVideoDownloads.push({
            fileId: file.fileId,
            mountPath: "generated-videos",
            filename: file.filename,
            url: signed.url,
            expiresAt: signed.expiresAt,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          });
        }
      }
      const fileResourceDownloads = [
        ...new Map(
          [...ordinaryFileResourceDownloads, ...generatedVideoDownloads].map((download) => [
            download.fileId,
            download,
          ]),
        ).values(),
      ];
      const toolRuntime = await prepareTurnToolRuntime({
        input,
        catalogSourceSettings,
        db,
        bus,
        runtime,
        objectStorage,
        observability,
        cancellationSignal,
        connectionCredentials,
        eventing,
        attempt,
        sandboxState,
        media,
        toolResultSpill,
        turn,
        session,
        fileAuthoritySubjectId,
        capabilitySettings,
        installedApiIntegrations,
        codexAppsCredentialId,
        turnExecutionPolicy,
        trigger,
        runSettings,
        lazyToolTransport,
        turnTools,
        connectionScope,
        hostCredentialRootSessionId,
        sandboxArtifactRuntime,
        activeSandboxBackend,
        groupBoxBackend,
        routingOn,
        runtimeCancellationSignal,
        credentialSubjectId,
        interactionInterventionResume,
        runWorkspaceMutationForSandbox,
        throwIfWorkerShuttingDown,
        throwIfTurnCancelled,
      });
      const {
        attemptConnectorActionBindings,
        connectorActionIdentity,
        generateSessionTitleInParallel,
        postToolPreparationStartedAt,
        preparationIndependentToolNames,
      } = toolRuntime;

      const builtAgent = await buildTurnAgent({
        input,
        db,
        runtime,
        objectStorage,
        observability,
        cancellationSignal,
        runtimeCancellationSignal,
        eventing,
        attempt,
        sandboxState,
        providerTurn,
        media,
        leases,
        turn,
        session,
        fileAuthoritySubjectId,
        capabilitySettings,
        humanInputResume,
        turnExecutionPolicy,
        runSettings,
        logicalSandboxSettings,
        verifiedRigProviderImageId,
        resolvedModel,
        nativeImageProviderBinding,
        lazyToolTransport,
        modelInputPolicy,
        supportsImageInput,
        agentHumanInputEnabled,
        workspaceAgentInstructions,
        workspaceGovernance,
        structuredWorkspacePolicyActive,
        workspaceMemory,
        rigVersion,
        rigName,
        packRuntime,
        installedSkillRuntime,
        buildCompanyBrainContributionReceiptFor,
        promptCacheKey,
        workspaceVariableSet,
        runtimeResources,
        sandboxEnvironment,
        sandboxArtifactRuntime,
        sandboxGitToken,
        sandboxGitTokens,
        sandboxGitCredentialBindings,
        sandboxCodemodeToken,
        fileResourceDownloads,
        attemptConnectorActionBindings,
        connectorActionIdentity,
        preparationIndependentToolNames,
        videoGenerationAcceptancesByCallId,
        activeSandboxBackend,
        groupBoxBackend,
        postToolPreparationStartedAt,
        codexContext,
      });
      const { agent, modelVisibleRuntimeSkillActivations, postAgentPreparationStartedAt } =
        builtAgent;

      await bindLazySandboxProvisioner({
        ...sandboxRoute,
        input,
        settings,
        db,
        bus,
        objectStorage,
        observability,
        cancellationSignal,
        runtimeCancellationSignal,
        sandboxResumeSignal,
        activityContext,
        opJournal,
        sandboxState,
        eventing,
        attempt,
        turn,
        session,
        fileAuthoritySubjectId,
        capabilitySettings,
        turnExecutionPolicy,
        runSettings,
        logicalSandboxSettings,
        verifiedRigProviderImageId,
        runtimePreparationStartedAt,
        establishPolicy,
        sandboxEnvironment,
        startRunGitCredentialsMint,
        machineOpObserver,
        sandboxOperationObserver,
        sandboxRuntime,
        transientCodemodeEnvironment,
        agent,
        attachRunCredentialRenewal,
        attachGitCredentialRenewal,
        attachCodemodeTokenRenewal,
        throwIfWorkerShuttingDown,
        throwIfTurnCancelled,
        initialRunCredentialMaterial,
        sandboxCodemodeToken,
        media,
        toolResultSpill,
        connectionScope,
        codemodeAuthority,
        rigVersion,
        turnResources,
      });

      let companyBrainContributionReceiptRecorded = false;
      const recordCompanyBrainContributionReceiptOnce = (): void => {
        if (companyBrainContributionReceiptRecorded) return;
        companyBrainContributionReceiptRecorded = true;
        try {
          const companyBrainContributionReceipt = buildCompanyBrainContributionReceiptFor(
            modelVisibleRuntimeSkillActivations,
          );
          eventing.companyBrainContextContributions = summarizeCompanyBrainContributions(
            companyBrainContributionReceipt,
          );
          recordCompanyBrainContributions(observability, companyBrainContributionReceipt);
          observability.info("model context contribution receipt", {
            attemptId: companyBrainContributionReceipt.attemptId,
            turnId: companyBrainContributionReceipt.turnId,
            contextSelectionReceiptId: companyBrainContributionReceipt.contextSelectionReceiptId,
            sessionRole: companyBrainContributionReceipt.sessionRole,
            memoryPromptMode: companyBrainContributionReceipt.memoryPromptMode,
            instructionPolicySnapshotId:
              companyBrainContributionReceipt.instructionPolicySnapshotId,
            preferenceSnapshotId: companyBrainContributionReceipt.preferenceSnapshotId,
            companyProfileSnapshotId: companyBrainContributionReceipt.companyProfileSnapshotId,
            contributions: JSON.stringify(companyBrainContributionReceipt.contributions),
          });
        } catch {
          // Observability must never change model execution semantics.
        }
      };
      const postAgentCompaction = await runPostAgentCompaction({
        input,
        settings: capabilitySettings,
        db,
        bus,
        observability,
        cancellationSignal,
        control,
        attempt,
        billingState,
        eventing: wiredEventing,
        providerTurn,
        leases,
        media,
        claimedResult,
        claimedModelUsageSourceKeys,
        emittedModelUsageSourceKeys,
        modelUsageDispatchId,
        turn,
        session,
        turnExecutionPolicy,
        resolvedModel,
        workspaceAgentInstructions,
        workspaceGovernance,
        structuredWorkspacePolicyActive,
        workspaceMemory,
        rigVersion,
        rigName,
        compactionModelHistoryProjector,
        summarizeContextForCompaction,
        withProviderRequestContext,
        withCodexRemoteCompaction,
        remotePrefix,
        remoteCompactionRequester,
        publishCompactionLiveEvents,
        publishCompactionOutcomeEvents,
        compactionModeOptions,
        compactionOnlyTurn,
        compactionSummarizerFor,
        settleDeferredSteerAfterCompaction,
        agent,
      });
      if ("exit" in postAgentCompaction) return postAgentCompaction.exit;
      const { compactSummarizer } = postAgentCompaction.ok;

      recordTurnStartupPhase(observability, {
        phase: "post_agent_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - postAgentPreparationStartedAt) / 1_000,
      });
      let fileMaterializationFailures: SandboxFileDownloadFailure[] = [];
      let fileDownloadsMaterializedForRun = false;
      if (
        sandboxState.resolvedSandbox &&
        sandboxState.setupBoxSession &&
        fileResourceDownloads.length > 0
      ) {
        const fileMaterializationStartedAt = performance.now();
        let fileMaterializationOutcome: "completed" | "failed" = "completed";
        let fileMaterializationCache: "hit" | "miss" = "miss";
        try {
          const boxInstanceId = sandboxState.resolvedSandbox.established.instanceId;
          // A successful transfer is durable for this exact filesystem instance.
          // Do not turn later model startup into an integrity scan. If an owner or
          // agent removes the file, it can be restored explicitly through the
          // existing Files MCP using the durable file id carried in model history.
          const alreadyMaterialized = await getMaterializedSandboxFileResources(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sandboxGroupId: session.sandboxGroupId,
            expectedEpoch: sandboxState.resolvedSandbox.leaseEpoch,
            instanceId: boxInstanceId,
          });
          const downloadsToMaterialize = filterUnmaterializedSandboxFileDownloads(
            fileResourceDownloads,
            alreadyMaterialized,
          );
          if (downloadsToMaterialize.length === 0) {
            fileMaterializationCache = "hit";
          }
          const runAs = sandboxRunAs(runSettings);
          if (downloadsToMaterialize.length > 0) {
            const materialized = await runWorkspaceMutationForSandbox(
              sandboxState.resolvedSandbox,
              "fileMaterialization",
              async () =>
                await materializeSandboxFileDownloads(
                  sandboxState.setupBoxSession as CodemodeTokenWriterSession,
                  downloadsToMaterialize,
                  {
                    onRuntimeEvent: async (event) => {
                      await eventing.publish!([{ type: event.type, payload: event.payload }], true);
                    },
                    ...(runAs ? { runAs } : {}),
                    ...(eventing.toolCancellationFenceRef.current
                      ? {
                          commandRunner:
                            eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                              eventing.toolCancellationFenceRef.current,
                            ),
                        }
                      : {}),
                  },
                ),
            );
            fileMaterializationFailures = materialized.failures;
            fileMaterializationOutcome = sandboxFileMaterializationOutcome(materialized.failures);
            const failedFileIds = new Set(materialized.failures.map((failure) => failure.fileId));
            const succeededFileIds = downloadsToMaterialize
              .map((download) => download.fileId)
              .filter((fileId) => !failedFileIds.has(fileId));
            if (succeededFileIds.length > 0) {
              await markSandboxFileResourcesMaterialized(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sandboxGroupId: session.sandboxGroupId,
                expectedEpoch: sandboxState.resolvedSandbox.leaseEpoch,
                instanceId: boxInstanceId,
                fileIds: succeededFileIds,
              });
            }
          }
          fileDownloadsMaterializedForRun = true;
        } catch (error) {
          fileMaterializationOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "file_materialization",
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: fileMaterializationOutcome,
            durationSeconds: (performance.now() - fileMaterializationStartedAt) / 1_000,
            count: fileResourceDownloads.length,
            cache: fileMaterializationCache,
          });
        }
      } else {
        recordTurnStartupPhase(observability, {
          phase: "file_materialization",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: "completed",
          durationSeconds: 0,
          count: 0,
        });
      }
      const requiredVideoFileIds = new Set(requiredGeneratedVideoFiles.map((file) => file.fileId));
      const failedRequiredVideo = fileMaterializationFailures.find((failure) =>
        requiredVideoFileIds.has(failure.fileId),
      );
      if (failedRequiredVideo) {
        // Retention is already durable. A sandbox copy miss must not fail the
        // turn or replay generation; the File remains retrievable via Files MCP.
        observability.warn("Generated video sandbox materialization deferred", {
          errorClass: "SandboxFileDownloadFailure",
          errorCode: "generated_video_materialization_deferred",
          origin: "worker",
        });
      }
      const unavailableSandboxFilesNote = sandboxFileDownloadFailureNote(
        fileMaterializationFailures,
      );
      return await runTurnStreamAttempt({
        input,
        settings: capabilitySettings,
        db,
        bus,
        runtime,
        objectStorage,
        observability,
        entitlements,
        startVideoGenerationWorkflow,
        cancellationSignal,
        runtimeCancellationSignal,
        activityContext,
        dispatchId,
        control,
        attempt,
        billingState,
        sandboxState,
        eventing: wiredEventing,
        providerTurn,
        leases,
        historySink,
        media,
        toolResultSpill,
        claimedResult,
        flushRuntimeBatcher,
        finalizeTurnOpStreamOps,
        runWorkspaceMutationForSandbox,
        throwIfWorkerShuttingDown,
        throwIfTurnCancelled,
        setLastInputTokensFenced,
        attachGitCredentialRenewal,
        attachCodemodeTokenRenewal,
        attachRunCredentialRenewal,
        withProviderRequestContext,
        withSessionTitleProviderRequestContext,
        publishCompactionLiveEvents,
        publishCompactionOutcomeEvents,
        recordCompanyBrainContributionReceiptOnce,
        modelCheckpointMemoryCollector,
        claimedModelUsageSourceKeys,
        emittedModelUsageSourceKeys,
        modelUsageDispatchId,
        workerPreparationStartedAt,
        fileDownloadsMaterializedForRun,
        unavailableSandboxFilesNote,
        runCredentialsNote,
        mcpAvailabilityNote,
        fileAuthoritySubjectId,
        activeSandboxBackend,
        groupBoxBackend,
        turnExecutionPolicy,
        turn,
        trigger,
        humanInputResume,
        attachPendingUpdatesAfterOpenSuffix,
        agent,
        resolvedModel,
        providerApi,
        runSettings,
        turnTools,
        generateSessionTitleInParallel,
        sessionTitlePrompt: session.initialMessage.trim() ? session.initialMessage : turn.prompt,
        compactSummarizer,
        settleDeferredSteerAfterCompaction,
        compactionModelHistoryProjector,
        generatedImageHistoryProjector,
        modelHistoryProjector,
        compactionModeOptions,
        initialRunCredentialMaterial,
        initialGitCredentials,
        sandboxEnvironment,
        sandboxCodemodeToken,
        sandboxCodemodeTokenExpiresAt,
        fileResourceDownloads,
        runCredentialResolver,
        videoGenerationAcceptancesByCallId,
      });
    } catch (error) {
      return await settleTurnFailure({
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
      });
    } finally {
      await finalizeTurnAttempt({
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
        eventing,
        providerTurn,
        workspaceRefs,
        runWorkspaceMutationForSandbox,
        requireResolvedSandboxForMutation,
        stopLeaseHeartbeat,
        turnCompletionMemoryCollector,
      });
    }
  };
}
