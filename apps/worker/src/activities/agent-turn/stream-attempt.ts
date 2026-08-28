import {
  getSessionEvent,
  getHumanInputResumeForEvent,
  getSessionHumanInputRequest,
  getWorkspace,
  recordUsageEvent,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  attachOpenSuffixToPendingToolCalls,
  clearDurablePendingSessionToolCalls,
  isSessionCompactionRequested,
  nextSessionHistoryPosition,
} from "@opengeni/db";
import {
  normalizeModelCallUsage,
  normalizeSdkEvent,
  extractOpenSuffixFromRunState,
  assertOpenSuffixResumable,
  interruptionKindForCallItem,
  releaseMcpResultCustomDataFromSdkEvent,
  findCompactionNeededError,
  withRunCredentialsSession,
  runOwnedSandboxSetup,
  type SandboxFileDownload,
  type OpenGeniRuntime,
  type HistoryProviderApi,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
} from "@opengeni/runtime";
import { type Settings } from "@opengeni/config";
import { maybeCompactContext, settleFailedContextCompactionLandmark } from "../context-compaction";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { type MintedRunGitCredentials } from "../environment";
import { withFirstPartyTools } from "../goals";
import { turnInput } from "../run-input";
import { createRuntimeBatcher, currentActivityContext, nextStreamEvent } from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { type ResumedTurnSandbox } from "../../sandbox-resume";
import {
  modelCallAccountContext,
  recordBatchFlush,
  recordContextCompaction,
  recordModelInputTokens,
  recordTurnStartupPhase,
  recordTurnWorkerPreparationTotal,
  recordSandboxSharedPreparation,
  StreamTimingMetrics,
  turnLifecycleMetricsFor,
} from "../../observability-metrics";
import {
  compactRetainedScreenshotHistory,
  sdkEventContainsInlineImage,
  retainComputerScreenshot,
  typedScreenshotFromSdkEvent,
  unavailableRetainedSessionImage,
} from "../retained-screenshots";
import {
  compactGeneratedImageSdkEvent,
  generatedImageFromSdkEvent,
  isCompletedGeneratedImageSdkEvent,
} from "../generated-images";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { createTurnHistorySink } from "./history-sink";
import {
  interruptionCallIdsFromPause,
  settleOpenSuffixResumeIfNeeded,
} from "../open-suffix-resume";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  resolveWorkspaceAgentHumanInputEnabled,
  type RetainedArtifactMetadata,
  type SessionEvent,
} from "@opengeni/contracts";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";

import {
  assertWorkspaceHumanInputAllowed,
  stableHumanInputRequestId,
  stableInteractionInterventionId,
  stableInteractionInterventionOperationId,
  BudgetExhaustedError,
  ensureRunAllowed,
} from "./admission";
import {
  compactionFailureReason,
  safeErrorDiagnostic,
  compactionFailureReasonFromError,
  isCompactionSummaryFailure,
  PostCompactionContinuationEmptyError,
  shouldRecoverCompactionProviderFailure,
  classifyContextWindowOverflowError,
} from "./errors";
import {
  pendingToolCallFromSdkEvent,
  toolCallProducesRetainableSessionImage,
  completedToolCallFromSdkEvent,
} from "./history";
import { checkpointHistoryBeforeProviderDispatch } from "./provider-dispatch-barrier";
import {
  modelUsageSourceKey,
  recordCompletedModelCallBeforeOwnershipFences,
  TurnEventPublisher,
  createModelResponseEventState,
  modelResponseContextSignal,
  assertModelResponseLatencyMode,
  processModelResponseTerminalEvent,
  emitModelCallUsage,
  recordModelUsageAndDebitCredits,
  recordAuthoritativeModelCallFact,
} from "./model-usage";
import {
  assertAgentStreamNotCancelled,
  assertSuccessfulAgentStreamCompletion,
  requireAgentStreamFinalOutput,
} from "./quiescence";
import { waitForTurnOperation } from "./sandbox-provision";
import { createSharedRigSetupCoordinator } from "./sandbox-shared-preparation";

import type { CompactionSummarizer } from "../context-compaction";
import type { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import type { BoundRunCredentialResolver } from "../run-credentials";
import type { ModelHistoryAttachmentProjector } from "../run-input";
import type {
  AttemptIdentityState,
  BillingState,
  ClaimedResult,
  EventingState,
  ProviderTurnState,
  SandboxRuntimeState,
  TurnControlState,
} from "./turn-context";

export type TurnStreamAttemptDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  entitlements: ActivityServices["entitlements"];
  startVideoGenerationWorkflow: ActivityServices["startVideoGenerationWorkflow"];
  cancellationSignal: AbortSignal | undefined;
  runtimeCancellationSignal: AbortSignal;
  activityContext: ReturnType<typeof currentActivityContext>;
  dispatchId: string;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  sandboxState: SandboxRuntimeState;
  eventing: EventingState & {
    publish: TurnEventPublisher;
    settle: NonNullable<EventingState["settle"]>;
  };
  providerTurn: ProviderTurnState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  historySink: ReturnType<typeof createTurnHistorySink>;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  toolResultSpill: ToolResultSpill;
  claimedResult: ClaimedResult;
  flushRuntimeBatcher: () => Promise<void>;
  finalizeTurnOpStreamOps: () => Promise<void>;
  runWorkspaceMutationForSandbox: <T>(
    sandbox: ResumedTurnSandbox,
    operation: string,
    mutation: () => Promise<T>,
    observePhase?: (measurement: {
      phase: "admission" | "provider" | "settlement" | "snapshot_wait";
      outcome: "completed" | "failed";
      durationSeconds: number;
    }) => void,
  ) => Promise<T>;
  throwIfWorkerShuttingDown: () => void;
  throwIfTurnCancelled: () => void;
  setLastInputTokensFenced: (lastInputTokens: number | null) => Promise<void>;
  attachGitCredentialRenewal: (
    tokenSession: GitCredentialTokenWriterSession,
    initial: MintedRunGitCredentials | undefined,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  attachCodemodeTokenRenewal: (
    tokenSession?: CodemodeTokenWriterSession,
    initialExpiresAt?: Date,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  attachRunCredentialRenewal: (
    credentialSession: RunCredentialCommandSession,
    initialMaterial: NormalizedRunCredentialMaterial | null,
    initialSandbox?: ResumedTurnSandbox,
  ) => Promise<void>;
  withProviderRequestContext: <T>(fn: () => Promise<T>) => Promise<T>;
  publishCompactionLiveEvents: (events: SessionEvent[]) => Promise<void>;
  publishCompactionOutcomeEvents: (events: SessionEvent[]) => Promise<void>;
  recordCompanyBrainContributionReceiptOnce: () => void;
  modelCheckpointMemoryCollector: ReturnType<typeof createModelCheckpointMemoryCollector>;
  claimedModelUsageSourceKeys: Set<string>;
  emittedModelUsageSourceKeys: Set<string>;
  modelUsageDispatchId: string;
  workerPreparationStartedAt: number;
  fileDownloadsMaterializedForRun: boolean;
  unavailableSandboxFilesNote: string | undefined;
  runCredentialsNote: string | undefined;
  mcpAvailabilityNote: string | undefined;
  fileAuthoritySubjectId: string | null;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  groupBoxBackend: Settings["sandboxBackend"];
  turnExecutionPolicy: TurnExecutionPolicyV1;
  turn: { executionGeneration: number; model: string };
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>;
  humanInputResume: Awaited<ReturnType<typeof getHumanInputResumeForEvent>>;
  attachPendingUpdatesAfterOpenSuffix: () => Promise<boolean>;
  agent: ReturnType<ActivityServices["runtime"]["buildAgent"]>;
  resolvedModel: ReturnType<ActivityServices["runtime"]["resolveTurnModel"]>;
  providerApi: HistoryProviderApi;
  runSettings: Settings;
  turnTools: ReturnType<typeof withFirstPartyTools>;
  compactSummarizer: CompactionSummarizer;
  settleDeferredSteerAfterCompaction: () => Promise<RunAgentTurnResult | null>;
  compactionModelHistoryProjector: (
    items: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
  generatedImageHistoryProjector: (
    items: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
  modelHistoryProjector: ModelHistoryAttachmentProjector;
  compactionModeOptions: NonNullable<Parameters<typeof maybeCompactContext>[5]>;
  initialRunCredentialMaterial: NormalizedRunCredentialMaterial | null;
  initialGitCredentials: MintedRunGitCredentials | undefined;
  sandboxEnvironment: Record<string, string>;
  sandboxCodemodeToken: string | undefined;
  sandboxCodemodeTokenExpiresAt: Date | string | number | null | undefined;
  fileResourceDownloads: SandboxFileDownload[];
  runCredentialResolver: BoundRunCredentialResolver | null;
  videoGenerationAcceptancesByCallId: Map<string, { operationId: string; requestDigest: string }>;
};

export async function attachPendingUpdatesBeforePreparingModelInput(input: {
  shouldAttach: boolean;
  attachPendingUpdates: () => Promise<boolean>;
  prepareModelInput: () => Promise<void>;
}): Promise<boolean> {
  if (input.shouldAttach && !(await input.attachPendingUpdates())) return false;
  await input.prepareModelInput();
  return true;
}

export async function runTurnStreamAttempt(
  deps: TurnStreamAttemptDeps,
): Promise<RunAgentTurnResult> {
  const {
    input,
    settings,
    db,
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
    eventing,
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
  } = deps;

  // Build one attempt from canonical history. The provider adapter creates
  // only the temporary wire view required by this turn's selected API;
  // subscription identity never edits or filters durable history.
  const activeTurnId = attempt.turnId;
  if (!activeTurnId) {
    throw new Error("Turn id was not initialized");
  }
  let runInput: Awaited<ReturnType<typeof turnInput>>["input"] | null = null;
  const prepareRunAttemptInput = async () => {
    const historyPreparationStartedAt = performance.now();
    let historyPreparationOutcome: "completed" | "failed" = "completed";
    let preparedHistoryCount: number | null = null;
    try {
      const prepared = await turnInput(db, runtime, agent, trigger, {
        turnId: activeTurnId,
        fileAuthority: {
          accountId: input.accountId,
          subjectId: fileAuthoritySubjectId,
        },
        recovering: turn.executionGeneration > 1,
        ...(unavailableSandboxFilesNote ? { unavailableSandboxFilesNote } : {}),
        ...(runCredentialsNote ? { runCredentialsNote } : {}),
        ...(mcpAvailabilityNote ? { mcpAvailabilityNote } : {}),
        providerApi,
        projectCanonicalHistory: generatedImageHistoryProjector,
        materializeModelHistory: media.materializeScreenshotHistory,
        projectModelHistory: modelHistoryProjector,
        onPreparationPhase: (measurement) => {
          recordTurnStartupPhase(observability, {
            phase: `history_${measurement.phase}`,
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: measurement.outcome,
            durationSeconds: measurement.durationSeconds,
          });
        },
      });
      runInput = prepared.input;
      historySink.providerArtifactCandidates = prepared.providerArtifactCandidates;
      // Slice index = the length of the model-facing (active) history this turn
      // is seeded from; new items beyond it (the trigger message + this turn's
      // generated items) are the ones to persist. After a compaction this is the
      // short [summary, ...tail] active set, NOT the total row count. The
      // absolute write position is tracked separately (next whole number past
      // the max existing position) because the fractional summary row means
      // total rows no longer equal max(position)+1. Pre-compaction both reduce to
      // the old total-count value, so the common path is unchanged.
      //
      // CRITICAL: seed from the structurally repaired active-row length, not the raw active
      // count. `prepareRunInput` builds `state.history` from
      // `sanitizeHistoryItemsForModel(activeRows)`, so when sanitization drops K
      // rows (a legacy orphan/dangling pair), the in-memory history this turn
      // starts from is K shorter than the raw row count. The reconcile slices the
      // repaired `state.history` off `historySink.persistedHistoryCount`; seeding it from
      // the raw count (K too high) skips K genuinely-new items, and a
      // `function_call` left in that skipped region can later have its
      // `function_call_result` persisted alone — the orphan that 400s on replay
      // and bricks the session (issue-61). The repaired seed is already
      // orphan-free, so it is a stable prefix of the re-sanitized history and the
      // slice begins exactly at the first genuinely-new item.
      // prepareInput already sanitized the exact durable prefix represented
      // by state.history. Carry its count forward instead of loading and
      // retaining the full active transcript a second time beside runInput.
      historySink.persistedHistoryCount = prepared.persistedHistoryCount;
      preparedHistoryCount = prepared.persistedHistoryCount;
      const historyPositionStartedAt = performance.now();
      let historyPositionOutcome: "completed" | "failed" = "completed";
      try {
        historySink.nextHistoryPosition = await nextSessionHistoryPosition(
          db,
          input.workspaceId,
          input.sessionId,
        );
      } catch (error) {
        historyPositionOutcome = "failed";
        throw error;
      } finally {
        recordTurnStartupPhase(observability, {
          phase: "history_position_load",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: historyPositionOutcome,
          durationSeconds: (performance.now() - historyPositionStartedAt) / 1_000,
        });
      }
    } catch (error) {
      historyPreparationOutcome = "failed";
      throw error;
    } finally {
      recordTurnStartupPhase(observability, {
        phase: "history_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: historyPreparationOutcome,
        durationSeconds: (performance.now() - historyPreparationStartedAt) / 1_000,
        count: preparedHistoryCount,
      });
    }
  };

  const forceContextCompaction = async (
    triggerLabel: "overflow" | "proactive" | "operator",
    recoverySignalTokens: number | null,
  ) => {
    const outcome = await waitForTurnOperation(
      maybeCompactContext(
        db,
        eventing.modelRunSettings,
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: activeTurnId,
          executionGeneration: attempt.executionGeneration,
          attemptId: input.attemptId,
        },
        // Never reuse the persisted prior-turn signal for recovery. Proactive
        // guards provide their exact current provider-based signal; provider
        // overflows do not, so their diagnostic signal stays unknown/zero.
        // Forced recovery proves progress separately by comparing the
        // replacement with the current active-history estimate.
        recoverySignalTokens,
        compactSummarizer,
        {
          force: true,
          ...(triggerLabel === "operator" ? { clearRequestedCompaction: true } : {}),
          trigger: triggerLabel,
          materializeHistory: media.materializeScreenshotHistory,
          projectModelInput: compactionModelHistoryProjector,
          ...compactionModeOptions,
        },
      ),
      cancellationSignal,
      undefined,
    );
    if (outcome.events.length > 0) {
      if (outcome.compacted) {
        recordContextCompaction(observability, triggerLabel);
      }
      await publishCompactionOutcomeEvents(outcome.events);
    }
    return outcome;
  };

  // Keep response identity across every stream attempt in this
  // activity. Context compaction retries the same logical dispatch by
  // calling runStreamAttempt again; resetting this state there would reuse
  // the first no-response-ID fallback key and suppress a real model call.
  const modelResponseState = createModelResponseEventState(claimedModelUsageSourceKeys);
  let workerPreparationTotalRecorded = false;
  const runStreamAttempt = async (options: {
    requireTerminalModelResponse: boolean;
  }): Promise<RunAgentTurnResult> => {
    if (!runInput) {
      throw new Error("Run input was not prepared");
    }
    const responseCountBeforeStream = modelResponseState.responseCount;
    eventing.stream = undefined;
    eventing.batcher = null;
    // The SDK emits every processed call item for one model response before
    // it emits any result for that response. Keep that response-local batch
    // in memory so an orphan from an older response cannot pin later stable
    // calls. Durable recovery remains call/result based and needs no batch
    // schema or compatibility state.
    let currentToolBatchCallIds = new Set<string>();
    let currentToolBatchCompletedCallIds = new Set<string>();
    let streamSawPerResponseUsage = false;
    // Actual input tokens of the most recent model response this turn; the
    // pre-read trigger for the NEXT turn. Persisted at every turn-end path.
    throwIfWorkerShuttingDown();
    throwIfTurnCancelled();
    const streamProvider = resolvedModel?.provider.id ?? settings.openaiProvider ?? "openai";
    const providerPublishesNativeRequestEvents =
      resolvedModel?.provider.kind === "codex-subscription" ||
      resolvedModel?.provider.kind === "xai-subscription";
    let fallbackProviderRequestStartedAt: number | null = null;
    let fallbackProviderRequestLifecycleStartedAt: number | null = null;
    const recordFallbackProviderDispatchAtWire = async (): Promise<void> => {
      await checkpointHistoryBeforeProviderDispatch(historySink);
      if (
        providerPublishesNativeRequestEvents ||
        eventing.firstModelRequestPreparationRecorded ||
        eventing.firstModelRequestPreparationStartedAt === null
      ) {
        return;
      }
      sandboxState.firstProviderRequestStarted = true;
      eventing.firstModelRequestPreparationRecorded = true;
      const preparationDurationMs = Math.max(
        0,
        performance.now() - eventing.firstModelRequestPreparationStartedAt,
      );
      recordTurnStartupPhase(observability, {
        phase: "model_request_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: preparationDurationMs / 1_000,
        count: turnTools.length,
      });
      const auditStartedAt = performance.now();
      let auditOutcome: "completed" | "failed" = "completed";
      try {
        await eventing.publish!([
          {
            type: "turn.startup.phase.completed",
            payload: {
              phase: "model_preparation",
              durationMs: Math.round(preparationDurationMs),
            },
          },
          {
            type: "agent.model.request",
            payload: {
              phase: "started",
              provider: streamProvider,
              turnId: activeTurnId,
              attemptId: input.attemptId,
              dispatchId,
              executionGeneration: attempt.executionGeneration,
            },
          },
        ]);
        fallbackProviderRequestStartedAt = performance.now();
        fallbackProviderRequestLifecycleStartedAt = fallbackProviderRequestStartedAt;
      } catch (error) {
        auditOutcome = "failed";
        throw error;
      } finally {
        recordTurnStartupPhase(observability, {
          phase: "model_request_audit",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: auditOutcome,
          durationSeconds: (performance.now() - auditStartedAt) / 1_000,
          count: turnTools.length,
        });
      }
    };
    const ownedEstablished =
      sandboxState.resolvedSandbox?.established ?? sandboxState.lazyOwnedSandbox;
    const runStreamOnce = async (): ReturnType<OpenGeniRuntime["runStream"]> => {
      const eagerResolvedSandbox = sandboxState.resolvedSandbox;
      // Eager owned sessions must settle the exact platform-setup provider
      // promise before the long model stream starts; otherwise one admission
      // would remain in flight for the entire turn and suppress every
      // heartbeat capture. Lazy setup already runs under the same wrapper in
      // its first-operation provisioner above.
      if (eagerResolvedSandbox && !sandboxState.lazyOwnedSandbox && ownedEstablished) {
        const ownedSandboxSetupStartedAt = performance.now();
        let ownedSandboxSetupOutcome: "completed" | "failed" = "completed";
        try {
          const eagerSetupSession = sandboxState.setupBoxSession ?? ownedEstablished.session;
          // `deferredSetup: true` below tells the runtime that the worker owns
          // platform setup, so the runtime intentionally skips its credential
          // session callback. Materialize host-managed run credentials here
          // before any setup command (including provider login hooks), then
          // decorate setup commands so they source the active generation.
          await attachRunCredentialRenewal(
            eagerSetupSession as RunCredentialCommandSession,
            initialRunCredentialMaterial,
            eagerResolvedSandbox,
          );
          const eagerCredentialSetupSession = initialRunCredentialMaterial
            ? withRunCredentialsSession(eagerSetupSession as object, input.sessionId)
            : eagerSetupSession;
          await runWorkspaceMutationForSandbox(
            eagerResolvedSandbox,
            "eagerOwnedSandboxSetup",
            async () =>
              await runOwnedSandboxSetup(
                agent,
                ownedEstablished.session as never,
                eagerCredentialSetupSession as never,
                {
                  settings: runSettings,
                  environment: sandboxEnvironment,
                  preparedInput: runInput!,
                  ...(fileDownloadsMaterializedForRun ? { fileDownloadsMaterialized: true } : {}),
                  onRuntimeEvent: async (event) => {
                    await leases.renewServing("runtime_event");
                    if (leases.servingLost()) {
                      throw new Error("Provider credential lease expired during sandbox setup");
                    }
                    await eventing.publish!([{ type: event.type, payload: event.payload }], true);
                  },
                  ...(eventing.toolCancellationFenceRef.current
                    ? {
                        commandRunner:
                          eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                            eventing.toolCancellationFenceRef.current,
                          ),
                      }
                    : {}),
                  ...(sandboxState.sandboxGroupId && sandboxState.sandboxHolderId
                    ? {
                        coordinateSharedRigSetup: createSharedRigSetupCoordinator({
                          db,
                          accountId: input.accountId,
                          workspaceId: input.workspaceId,
                          sandboxGroupId: sandboxState.sandboxGroupId,
                          attemptId: input.attemptId,
                          holderId: sandboxState.sandboxHolderId,
                          sandbox: eagerResolvedSandbox,
                          ...(runtimeCancellationSignal
                            ? { signal: runtimeCancellationSignal }
                            : {}),
                          observe: (measurement) =>
                            recordSandboxSharedPreparation(observability, measurement),
                        }),
                      }
                    : {}),
                },
              ),
          );
          await attachGitCredentialRenewal(
            eagerSetupSession as GitCredentialTokenWriterSession,
            initialGitCredentials,
          );
        } catch (error) {
          ownedSandboxSetupOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "owned_sandbox_setup",
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: ownedSandboxSetupOutcome,
            durationSeconds: (performance.now() - ownedSandboxSetupStartedAt) / 1_000,
            count: fileResourceDownloads.length,
          });
        }
      }
      // Conservative request boundary: once control enters runStream, the
      // provider may have accepted work even if no response/event follows.
      // Escaped MCP setup timeouts are automatically recoverable only
      // before this line.
      recordCompanyBrainContributionReceiptOnce();
      if (!eventing.firstModelRequestPreparationRecorded) {
        await eventing.publish!([
          {
            type: "turn.startup.phase.started",
            payload: { phase: "model_preparation" },
          },
        ]);
        eventing.firstModelRequestPreparationStartedAt = performance.now();
        eventing.firstModelRequestCheckpointAt = eventing.firstModelRequestPreparationStartedAt;
      }
      const providerDispatchStartedAt = performance.now();
      let providerDispatchOutcome: "completed" | "failed" = "completed";
      try {
        // This histogram describes worker preparation until the first entry
        // into the runtime. Lazy SDK request preparation and the durable
        // model-request audit happen after this boundary and have their own
        // phase metrics. Context-compaction recovery re-enters
        // runStreamAttempt; recording again would fold the prior request and
        // compaction into a bogus second startup sample.
        if (!workerPreparationTotalRecorded) {
          workerPreparationTotalRecorded = true;
          recordTurnWorkerPreparationTotal(observability, {
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: "completed",
            durationSeconds: (performance.now() - workerPreparationStartedAt) / 1_000,
          });
        }
        attempt.modelRequestStarted = true;
        return await runtime.runStream(agent, runInput!, eventing.modelRunSettings, {
          signal: runtimeCancellationSignal,
          sandboxEnvironment,
          onRuntimeEvent: async (event) => {
            await leases.renewServing("runtime_event");
            if (leases.servingLost()) {
              throw new Error("Provider credential lease expired during the active turn");
            }
            await eventing.publish!([{ type: event.type, payload: event.payload }], true);
          },
          // P1.2: inject the resumed box NON-OWNED (the SDK never reaps it — the
          // keystone). Absent when the flag is off -> legacy build-and-discard.
          ...(ownedEstablished
            ? {
                ownedSandbox: {
                  client: ownedEstablished.client,
                  session: ownedEstablished.session,
                  ...(sandboxState.resolvedSandbox?.established.sessionState
                    ? {
                        sessionState: sandboxState.resolvedSandbox.established.sessionState,
                      }
                    : {}),
                  // Pin platform setup (hooks + file materialization) to the un-proxied
                  // established box — never through the routing proxy, which would
                  // re-route those execs onto a machine swapped in mid-turn.
                  ...(sandboxState.setupBoxSession
                    ? { setupSession: sandboxState.setupBoxSession }
                    : {}),
                  ...(fileDownloadsMaterializedForRun ? { fileDownloadsMaterialized: true } : {}),
                  // Both owned paths execute setup outside runStream: eager just
                  // above under its exact admission, lazy in the provisioner.
                  deferredSetup: true,
                },
              }
            : {}),
          ...(activeSandboxBackend !== "selfhosted" &&
          sandboxCodemodeToken &&
          sandboxCodemodeTokenExpiresAt &&
          !sandboxState.lazyOwnedSandbox
            ? {
                onCodemodeTokenSessionReady: async (tokenSession: CodemodeTokenWriterSession) => {
                  const renewalSession =
                    (sandboxState.setupBoxSession as CodemodeTokenWriterSession | null) ??
                    tokenSession;
                  await attachCodemodeTokenRenewal(renewalSession);
                },
              }
            : {}),
          ...(runCredentialResolver
            ? {
                runCredentialSessionId: input.sessionId,
                ...(!sandboxState.lazyOwnedSandbox
                  ? {
                      onRunCredentialSessionReady: async (
                        credentialSession: RunCredentialCommandSession,
                      ) => {
                        const pinnedCredentialSession = sandboxState.setupBoxSession
                          ? (sandboxState.setupBoxSession as RunCredentialCommandSession)
                          : credentialSession;
                        await attachRunCredentialRenewal(
                          pinnedCredentialSession,
                          initialRunCredentialMaterial,
                        );
                      },
                    }
                  : {}),
              }
            : {}),
          ...(eventing.modelRunSettings.sandboxBackend !== "none"
            ? {
                onSandboxSessionReady: async (sandboxSession: CodemodeTokenWriterSession) => {
                  media.sdkOwnedSandboxSession = sandboxSession;
                  for (const receipt of media.generatedImageReceiptsCreatedThisTurn.values()) {
                    await media.materializeGeneratedImageInOwnedSdkSession(receipt, sandboxSession);
                  }
                  await toolResultSpill.materializeDeferred();
                },
              }
            : {}),
          contextCompactionSignal: () => modelResponseContextSignal(modelResponseState),
          contextCompactionRequested: () =>
            isSessionCompactionRequested(db, input.workspaceId, input.sessionId),
          onModelPreparationPhase: (measurement) => {
            recordTurnStartupPhase(observability, {
              phase: `model_prepare_${measurement.phase}`,
              provider: turnExecutionPolicy.providerId,
              backend: activeSandboxBackend ?? groupBoxBackend,
              outcome: measurement.outcome,
              durationSeconds: measurement.durationSeconds,
              ...(measurement.count === undefined ? {} : { count: measurement.count }),
            });
          },
          ...(!providerPublishesNativeRequestEvents
            ? {
                onModelTransportStarted: recordFallbackProviderDispatchAtWire,
              }
            : {}),
          ...(eventing.toolCancellationFenceRef.current
            ? {
                turnToolCancellationFence: eventing.toolCancellationFenceRef.current,
              }
            : {}),
        });
      } catch (error) {
        providerDispatchOutcome = "failed";
        throw error;
      } finally {
        recordTurnStartupPhase(observability, {
          phase: "provider_dispatch",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: providerDispatchOutcome,
          durationSeconds: (performance.now() - providerDispatchStartedAt) / 1_000,
        });
      }
    };
    if (leases.codex.lost) {
      throw new Error("Codex credential lease expired before the model run");
    }
    if (leases.xai.lost) {
      throw new Error("xAI credential lease expired before the model run");
    }
    eventing.stream = await withProviderRequestContext(runStreamOnce);
    // Bounded provider label for the streaming SLIs — the resolved registry
    // provider id (or the built-in OpenAI/Azure provider), never a raw
    // user-supplied model string.
    const streamTiming = new StreamTimingMetrics(observability, {
      provider: streamProvider,
    });
    eventing.batcher = createRuntimeBatcher(
      async (events) => {
        await eventing.publish!(events);
      },
      {
        onFlush: ({ events, durationSeconds }) =>
          recordBatchFlush(observability, { events, durationSeconds }),
      },
    );

    const streamBootstrapStartedAt = performance.now();
    let streamBootstrapRecorded = false;
    const recordStreamBootstrap = (): void => {
      if (streamBootstrapRecorded) return;
      streamBootstrapRecorded = true;
      recordTurnStartupPhase(observability, {
        phase: "stream_bootstrap",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - streamBootstrapStartedAt) / 1_000,
        count: turnTools.length,
      });
    };
    const settleFallbackProviderFirstByte = async (): Promise<void> => {
      if (fallbackProviderRequestStartedAt === null) return;
      const durationMs = Math.max(0, performance.now() - fallbackProviderRequestStartedAt);
      fallbackProviderRequestStartedAt = null;
      await eventing.publish!([
        {
          type: "agent.model.request",
          payload: {
            phase: "first_byte",
            provider: streamProvider,
            durationMs: Math.round(durationMs),
            turnId: activeTurnId,
            attemptId: input.attemptId,
            dispatchId,
            executionGeneration: attempt.executionGeneration,
          },
        },
      ]);
    };
    const iterator = eventing.stream.toStream()[Symbol.asyncIterator]();
    let streamDone = false;
    try {
      while (true) {
        const next = await nextStreamEvent(iterator, activityContext);
        recordStreamBootstrap();
        if (next.done) {
          streamDone = true;
          break;
        }
        await settleFallbackProviderFirstByte();
        let stableToolCallIdsToClear: string[] | null = null;
        let completedCurrentToolBatch = false;
        let retainedScreenshotMetadata: RetainedArtifactMetadata | null = null;
        let normalizedSdkEvents: ReturnType<typeof normalizeSdkEvent> | null = null;
        const generatedImage = generatedImageFromSdkEvent(next.value);
        if (isCompletedGeneratedImageSdkEvent(next.value) && !generatedImage) {
          throw new Error(
            "Completed native image item could not cross the retained-artifact boundary",
          );
        }
        const generatedImageReceipt = generatedImage
          ? await media.retainNativeGeneratedImage(generatedImage)
          : null;
        const responseResult = await processModelResponseTerminalEvent({
          event: next.value,
          state: modelResponseState,
          dispatchId: modelUsageDispatchId,
          settings,
          db,
          observability,
          publish: eventing.publish,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: activeTurnId,
          turnAttemptId: input.attemptId,
          provider: resolvedModel?.provider.id ?? settings.openaiProvider,
          providerApi: resolvedModel?.provider.api ?? "responses",
          model: turn.model,
          latencyMode: turnExecutionPolicy.latencyMode,
          metricProvider: streamProvider,
          externallyBilled: billingState.isExternallyBilledTurn,
          chargesOpenGeniCredits: billingState.chargesOpenGeniCredits,
          countsTowardTokenCap: billingState.countsTowardTokenCap,
          servingCredentialId: providerTurn.effectiveCodexCredentialId,
          priorSessionCredentialId: providerTurn.priorSessionCodexCredentialId,
          emittedSourceKeys: emittedModelUsageSourceKeys,
          renewLease: () => leases.renewServing("model_usage"),
          leaseLost: leases.servingLost,
          leaseLostMessage: "Provider credential lease expired during the active turn",
          setLastInputTokens: setLastInputTokensFenced,
          contextContributions: eventing.companyBrainContextContributions,
        });
        assertModelResponseLatencyMode({
          event: next.value,
          requested: turnExecutionPolicy.latencyMode,
          model: turn.model,
          ...(resolvedModel?.provider.id ? { providerId: resolvedModel.provider.id } : {}),
        });
        if (responseResult.status === "processed") {
          if (
            !providerPublishesNativeRequestEvents &&
            fallbackProviderRequestLifecycleStartedAt !== null
          ) {
            const durationMs = Math.max(
              0,
              performance.now() - fallbackProviderRequestLifecycleStartedAt,
            );
            fallbackProviderRequestLifecycleStartedAt = null;
            await eventing.publish!([
              {
                type: "agent.model.request",
                payload: {
                  phase: "completed",
                  provider: streamProvider,
                  durationMs: Math.round(durationMs),
                  turnId: activeTurnId,
                  attemptId: input.attemptId,
                  dispatchId,
                  executionGeneration: attempt.executionGeneration,
                },
              },
            ]);
            attempt.providerRecoveryCount = 0;
          }
          const rawStreamHistory = (eventing.stream.state as { history?: unknown[] }).history;
          if (Array.isArray(rawStreamHistory)) {
            // The completed image item is normally retained from its own
            // run-item event above. Scan once at the terminal response as
            // a compatibility backstop before reconciliation can persist
            // provider bytes. Never rescan history for every token delta.
            await media.retainNativeGeneratedImagesFromHistory(
              rawStreamHistory as Array<Record<string, unknown>>,
            );
          }
          streamSawPerResponseUsage ||= responseResult.usageReported;
          currentToolBatchCallIds = new Set<string>();
          currentToolBatchCompletedCallIds = new Set<string>();
          await historySink.reconcileConversationTruth();
          turnLifecycleMetricsFor(observability).progress(attempt.turnId!);
          modelCheckpointMemoryCollector.schedule(observability);
          try {
            await ensureRunAllowed(
              settings,
              db,
              input.accountId,
              input.workspaceId,
              billingState.isExternallyBilledTurn,
              entitlements,
              billingState.chargesOpenGeniCredits,
              billingState.countsTowardTokenCap,
            );
          } catch (limitError) {
            // Capture the run state at the boundary so the budget valve in
            // the outer catch can end this segment gracefully with full
            // conversation context preserved for the post-top-up resume.
            let serializedRunState: string | null = null;
            try {
              serializedRunState = media.compactMediaRunState(
                String(eventing.stream.state.toString()),
              );
            } catch {
              serializedRunState = null;
            }
            throw new BudgetExhaustedError(
              limitError instanceof Error ? limitError.message : String(limitError),
              serializedRunState,
            );
          }
        }
        const durableSdkEvent = generatedImageReceipt
          ? compactGeneratedImageSdkEvent(next.value, generatedImageReceipt)
          : next.value;
        const pendingToolCall = pendingToolCallFromSdkEvent(durableSdkEvent);
        if (pendingToolCall) {
          const registered = await registerPendingSessionToolCall(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
            modelToolOutputTruncationTokens:
              eventing.modelRunSettings.modelToolOutputTruncationTokens,
            callId: pendingToolCall.callId,
            callType: pendingToolCall.callType,
            callItem: pendingToolCall.callItem as Record<string, unknown>,
          });
          if (!registered.accepted) {
            throw new TurnAttemptFencedError(
              "turn attempt ended while recording an in-flight tool call",
            );
          }
          currentToolBatchCallIds.add(pendingToolCall.callId);
          if (toolCallProducesRetainableSessionImage(pendingToolCall.callName)) {
            media.retainedSessionImageCallIds.add(pendingToolCall.callId);
          }
        }
        const completedToolCall = completedToolCallFromSdkEvent(durableSdkEvent);
        if (completedToolCall) {
          retainedScreenshotMetadata =
            media.retainedScreenshotReceiptsByCallId.get(completedToolCall.callId) ?? null;
          const typedScreenshot = retainedScreenshotMetadata
            ? null
            : typedScreenshotFromSdkEvent(durableSdkEvent);
          if (
            !retainedScreenshotMetadata &&
            media.retainedSessionImageCallIds.has(completedToolCall.callId) &&
            sdkEventContainsInlineImage(durableSdkEvent) &&
            !typedScreenshot
          ) {
            retainedScreenshotMetadata = unavailableRetainedSessionImage({
              sessionId: input.sessionId,
              turnId: activeTurnId,
              attemptId: input.attemptId,
              toolCallId: completedToolCall.callId,
              toolOutputId: completedToolCall.callId,
              reason: "unsupported",
            });
            media.retainedScreenshotReceiptsByCallId.set(
              completedToolCall.callId,
              retainedScreenshotMetadata,
            );
          }
          if (
            !retainedScreenshotMetadata &&
            typedScreenshot &&
            typedScreenshot.callId === completedToolCall.callId &&
            media.retainedSessionImageCallIds.has(completedToolCall.callId)
          ) {
            // Install a compact deterministic fallback before database or
            // object-storage I/O. Unexpected retention failure can then
            // reconcile/serialize without leaking inline bytes.
            retainedScreenshotMetadata = unavailableRetainedSessionImage({
              sessionId: input.sessionId,
              turnId: activeTurnId,
              attemptId: input.attemptId,
              toolCallId: typedScreenshot.callId,
              toolOutputId: typedScreenshot.toolOutputId,
              reason: "pending",
            });
            media.retainedScreenshotReceiptsByCallId.set(
              completedToolCall.callId,
              retainedScreenshotMetadata,
            );
            retainedScreenshotMetadata = await retainComputerScreenshot({
              db,
              objectStorage,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: activeTurnId,
              attemptId: input.attemptId,
              output: typedScreenshot,
            });
            media.retainedScreenshotReceiptsByCallId.set(
              completedToolCall.callId,
              retainedScreenshotMetadata,
            );
          }
          normalizedSdkEvents = normalizeSdkEvent(
            durableSdkEvent as typeof next.value,
            retainedScreenshotMetadata
              ? {
                  toolOutputOverride: retainedScreenshotMetadata,
                  retainedOutputEvidence: retainedScreenshotMetadata.available
                    ? retainedScreenshotMetadata
                    : {
                        available: false,
                        reason: retainedScreenshotMetadata.reason,
                      },
                }
              : {},
          );
          const normalizedToolOutput = normalizedSdkEvents.find(
            (event) =>
              event.type === "agent.toolCall.output" &&
              (event.payload as { id?: unknown }).id === completedToolCall.callId,
          )?.payload as { output?: unknown } | undefined;
          if (!normalizedToolOutput || !Object.hasOwn(normalizedToolOutput, "output")) {
            throw new Error(
              `Completed SDK tool call ${completedToolCall.callId} produced no durable output projection`,
            );
          }
          const durableResultItem = retainedScreenshotMetadata
            ? (compactRetainedScreenshotHistory(
                [completedToolCall.resultItem],
                media.retainedScreenshotReceiptsByCallId,
              )[0] ?? completedToolCall.resultItem)
            : completedToolCall.resultItem;
          // Keep every parallel result in the attempt ledger until the full
          // call batch has settled. The SDK's computed history is
          // non-monotonic while parallel calls complete (a later call may
          // appear before an earlier persisted pair), so reconciling a
          // partial batch through a scalar watermark can create an orphan.
          const recorded = await recordPendingSessionToolCallResult(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
            callId: completedToolCall.callId,
            modelToolOutputTruncationTokens:
              eventing.modelRunSettings.modelToolOutputTruncationTokens,
            resultItem: durableResultItem as Record<string, unknown>,
            eventOutput: normalizedToolOutput.output,
            ...(videoGenerationAcceptancesByCallId.has(completedToolCall.callId)
              ? {
                  videoGenerationAcceptance: videoGenerationAcceptancesByCallId.get(
                    completedToolCall.callId,
                  )!,
                }
              : {}),
          });
          if (!recorded.accepted) {
            throw new TurnAttemptFencedError(
              "turn attempt ended while recording a tool-call result",
            );
          }
          const videoAcceptance = videoGenerationAcceptancesByCallId.get(completedToolCall.callId);
          if (videoAcceptance && startVideoGenerationWorkflow) {
            try {
              await startVideoGenerationWorkflow({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                operationId: videoAcceptance.operationId,
              });
            } catch (error) {
              // The accepted operation is durable. The recovery sweep starts
              // the same deterministic workflow ID if this nudge fails.
              observability.warn("Video generation workflow start deferred", {
                operationId: videoAcceptance.operationId,
                errorClass: error instanceof Error ? error.name : "UnknownError",
              });
            }
          }
          const belongsToCurrentBatch = currentToolBatchCallIds.has(completedToolCall.callId);
          if (belongsToCurrentBatch) {
            currentToolBatchCompletedCallIds.add(completedToolCall.callId);
          }
          const currentBatchIsStable =
            belongsToCurrentBatch &&
            currentToolBatchCallIds.size > 0 &&
            currentToolBatchCompletedCallIds.size === currentToolBatchCallIds.size;
          const standaloneStableResult =
            !belongsToCurrentBatch && currentToolBatchCallIds.size === 0;
          if (currentBatchIsStable || standaloneStableResult) {
            // Persist the SDK's now-stable complete call/result batch. Keep
            // the receipts until the normalized tool-output event below is
            // durably flushed: recovery then covers every crash boundary
            // without either losing or duplicating the UI projection.
            await historySink.reconcileConversationTruth({ requireDurable: true });
            stableToolCallIdsToClear = currentBatchIsStable
              ? [...currentToolBatchCallIds]
              : [completedToolCall.callId];
            completedCurrentToolBatch = currentBatchIsStable;
          }
        }
        const normalized =
          normalizedSdkEvents ??
          normalizeSdkEvent(
            durableSdkEvent as typeof next.value,
            retainedScreenshotMetadata
              ? {
                  toolOutputOverride: retainedScreenshotMetadata,
                  retainedOutputEvidence: retainedScreenshotMetadata.available
                    ? retainedScreenshotMetadata
                    : {
                        available: false,
                        reason: retainedScreenshotMetadata.reason,
                      },
                }
              : {},
          );
        for (const event of normalized) {
          streamTiming.onEvent(event.type);
          await eventing.batcher.push(event);
        }
        // Structural tool-output events await their durable append before
        // push returns. The complete result is now retained in the event
        // row and pending-call recovery receipt, so release only our
        // duplicate live SDK marker before a long turn accumulates it.
        releaseMcpResultCustomDataFromSdkEvent(durableSdkEvent);
        if (stableToolCallIdsToClear) {
          const cleared = await clearDurablePendingSessionToolCalls(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
            callIds: stableToolCallIdsToClear,
          });
          if (!cleared.accepted) {
            throw new TurnAttemptFencedError(
              "turn attempt ended while finalizing tool-call results",
            );
          }
          if (completedCurrentToolBatch) {
            currentToolBatchCallIds = new Set<string>();
            currentToolBatchCompletedCallIds = new Set<string>();
          }
          for (const callId of stableToolCallIdsToClear) {
            media.retainedSessionImageCallIds.delete(callId);
          }
        }
      }
    } catch (error) {
      if (fallbackProviderRequestLifecycleStartedAt !== null) {
        const durationMs = Math.max(
          0,
          performance.now() - fallbackProviderRequestLifecycleStartedAt,
        );
        fallbackProviderRequestStartedAt = null;
        fallbackProviderRequestLifecycleStartedAt = null;
        await eventing.publish!([
          {
            type: "agent.model.request",
            payload: {
              phase: "failed",
              provider: streamProvider,
              durationMs: Math.round(durationMs),
              turnId: activeTurnId,
              attemptId: input.attemptId,
              dispatchId,
              executionGeneration: attempt.executionGeneration,
            },
          },
        ]);
      }
      if (
        !eventing.firstModelRequestPreparationRecorded &&
        eventing.firstModelRequestPreparationStartedAt !== null
      ) {
        eventing.firstModelRequestPreparationRecorded = true;
        const durationMs = Math.max(
          0,
          performance.now() - eventing.firstModelRequestPreparationStartedAt,
        );
        recordTurnStartupPhase(observability, {
          phase: "model_request_preparation",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: "failed",
          durationSeconds: durationMs / 1_000,
          count: turnTools.length,
        });
        await eventing.publish!([
          {
            type: "turn.startup.phase.failed",
            payload: {
              phase: "model_preparation",
              durationMs: Math.round(durationMs),
            },
          },
        ]);
      }
      throw error;
    } finally {
      if (!streamDone) {
        // ReadableStream cancellation synchronously trips the Agents SDK's
        // abort controller, but its returned promise may wait for an
        // uncooperative provider producer. Once this attempt is fenced,
        // awaiting that provider-side cleanup pins the Temporal activity
        // (and therefore Pause) even though every late write is already
        // rejected. Start cancellation and detach only its cleanup wait;
        // the SDK abort signal stops the producer and the durable attempt
        // fence remains the authority for every callback that arrives late.
        void iterator.return?.().catch(() => undefined);
      }
    }
    await assertSuccessfulAgentStreamCompletion({
      batcherFlush: eventing.batcher.flush(),
      stream: eventing.stream,
      temporalCancellationSignal: cancellationSignal,
      runtimeCancellationSignal,
    });
    if (
      options.requireTerminalModelResponse &&
      eventing.stream.interruptions.length === 0 &&
      modelResponseState.responseCount === responseCountBeforeStream
    ) {
      // A fresh post-compaction stream may be returned already cancelled by
      // the SDK/runtime without yielding an event or terminal response. That
      // is not a completed logical turn: accepting finalOutput's undefined ->
      // empty-string fallback would release the queue and start newer user
      // work. Cancellation retains priority; otherwise checkpoint and recover
      // this exact turn from the durable compacted history.
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      throw new PostCompactionContinuationEmptyError();
    }
    assertAgentStreamNotCancelled(eventing.stream.cancelled);
    if (!streamSawPerResponseUsage) {
      const aggregateUsage = eventing.stream.state.usage;
      const normalizedAggregateUsage = normalizeModelCallUsage(aggregateUsage);
      const aggregateInput = normalizedAggregateUsage.telemetry.inputTokens;
      const aggregateSourceKey = modelUsageSourceKey({
        responseId: null,
        dispatchId: modelUsageDispatchId,
        positionalKey: "aggregate",
      });
      if (!claimedModelUsageSourceKeys.has(aggregateSourceKey)) {
        claimedModelUsageSourceKeys.add(aggregateSourceKey);
        // The aggregate frame is only a billing fallback when no terminal
        // response exposed usage. It is not final-request context authority.
        const aggregateAccountCtx = modelCallAccountContext({
          servingCredentialId: providerTurn.effectiveCodexCredentialId,
          priorSessionCredentialId: providerTurn.priorSessionCodexCredentialId,
          isFirstCallOfTurn: true,
        });
        let aggregateAuthoritative = false;
        await recordCompletedModelCallBeforeOwnershipFences({
          renewLease: () => leases.renewServing("model_usage"),
          leaseLost: leases.servingLost,
          leaseLostMessage: "Provider credential lease expired during the active turn",
          recordUsage: async () => {
            const billing = await recordModelUsageAndDebitCredits(settings, db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: activeTurnId,
              turnAttemptId: input.attemptId,
              model: turn.model,
              externallyBilled: billingState.isExternallyBilledTurn,
              chargesOpenGeniCredits: billingState.chargesOpenGeniCredits,
              countsTowardTokenCap: billingState.countsTowardTokenCap,
              usage: aggregateUsage,
              normalizedUsage: normalizedAggregateUsage,
              sourceKey: aggregateSourceKey,
              latencyMode: turnExecutionPolicy.latencyMode,
              observability,
            });
            const aggregateProvider = resolvedModel?.provider.id ?? settings.openaiProvider;
            const aggregateProviderApi = resolvedModel?.provider.api ?? "responses";
            aggregateAuthoritative = await emitModelCallUsage({
              observability,
              publish: eventing.publish,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: activeTurnId,
              provider: aggregateProvider,
              providerApi: aggregateProviderApi,
              model: turn.model,
              sourceKey: aggregateSourceKey,
              usage: { usage: aggregateUsage },
              normalizedUsage: normalizedAggregateUsage,
              servingAccountHash: aggregateAccountCtx.servingAccountHash,
              accountChangedFromPrevCall: aggregateAccountCtx.accountChangedFromPrevCall,
              emittedSourceKeys: emittedModelUsageSourceKeys,
            });
            if (aggregateAuthoritative && billing) {
              await recordAuthoritativeModelCallFact({
                db,
                observability,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: activeTurnId,
                turnAttemptId: input.attemptId,
                sourceKey: aggregateSourceKey,
                provider: aggregateProvider,
                providerApi: aggregateProviderApi,
                model: turn.model,
                billing,
                contextContributions: eventing.companyBrainContextContributions,
              });
            }
            if (aggregateAuthoritative && aggregateInput !== null && aggregateInput > 0) {
              recordModelInputTokens(observability, streamProvider, aggregateInput);
            }
          },
          recordAttemptSignals: async () => {
            if (!aggregateAuthoritative) return;
            // Stream aggregates can cover multiple requests and therefore
            // cannot identify the final request that compaction must bind.
            // They remain billing/telemetry fallback data only.
            modelResponseState.contextSignal = null;
            await setLastInputTokensFenced(null);
          },
        });
      }
    }
    if (eventing.stream.interruptions.length > 0) {
      await historySink.reconcileConversationTruth({ requireDurable: true });
      const approvals = runtime.serializeApprovals(eventing.stream.interruptions);
      const humanInputInterruptions =
        runtime.serializeHumanInputRequests?.(eventing.stream.interruptions) ?? [];
      const interactionInterventionInterruptions =
        runtime.serializeInteractionInterventionRequests?.(eventing.stream.interruptions) ?? [];
      const latestWorkspace = await getWorkspace(db, input.workspaceId);
      if (!latestWorkspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
      assertWorkspaceHumanInputAllowed(
        resolveWorkspaceAgentHumanInputEnabled(latestWorkspace.settings),
        "interruption",
        humanInputInterruptions.length > 0,
      );
      const humanInputRequests = await Promise.all(
        humanInputInterruptions.map(async (interruption) => {
          const id = stableHumanInputRequestId(
            input.sessionId,
            activeTurnId,
            interruption.toolCallId,
          );
          const existing = await getSessionHumanInputRequest(
            db,
            input.workspaceId,
            input.sessionId,
            id,
          );
          if (existing && existing.status !== "pending") {
            throw new Error(`Settled human-input request ${id} reappeared as an interruption`);
          }
          const expiresAt = existing?.expiresAt
            ? new Date(existing.expiresAt)
            : interruption.input.expiresInSeconds
              ? new Date(Date.now() + interruption.input.expiresInSeconds * 1000)
              : null;
          return {
            id,
            toolCallId: interruption.toolCallId,
            questions: interruption.input.questions,
            allowSkip: interruption.input.allowSkip,
            expiresAt,
            isNew: existing === null,
          };
        }),
      );
      const requestEvents = humanInputRequests
        .filter((request) => request.isNew)
        .map((request) => ({
          type: "session.humanInput.requested" as const,
          payload: {
            request: {
              id: request.id,
              questions: request.questions,
              allowSkip: request.allowSkip,
              expiresAt: request.expiresAt?.toISOString() ?? null,
            },
          },
        }));
      const interactionInterventionRequests = interactionInterventionInterruptions.map(
        (interruption) => ({
          id: stableInteractionInterventionId(
            input.sessionId,
            activeTurnId,
            interruption.toolCallId,
          ),
          operationId: stableInteractionInterventionOperationId(
            input.sessionId,
            activeTurnId,
            interruption.toolCallId,
          ),
          toolCallId: interruption.toolCallId,
          input: interruption.input,
        }),
      );
      const pendingApprovals = [
        ...approvals,
        ...interactionInterventionInterruptions.map((interruption) => interruption.approval),
      ];
      const suffixMembers = extractOpenSuffixFromRunState(eventing.stream.state);
      const interruptionCallIds = interruptionCallIdsFromPause({
        humanInputRequests,
        interactionInterventionRequests,
        pendingApprovals,
      });
      assertOpenSuffixResumable(suffixMembers, interruptionCallIds);
      const suffixByCallId = new Map(suffixMembers.map((member) => [member.callId, member]));
      const attached = await attachOpenSuffixToPendingToolCalls(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: activeTurnId,
        executionGeneration: attempt.executionGeneration,
        attemptId: input.attemptId,
        members: interruptionCallIds.map((callId) => {
          const member = suffixByCallId.get(callId)!;
          return {
            callId,
            interruptionKind: interruptionKindForCallItem(
              member.callItem as Record<string, unknown>,
            ),
            reasoningItems: member.reasoningItems as Array<Record<string, unknown>>,
          };
        }),
      });
      if (!attached.accepted) {
        return claimedResult({ status: "cancelled" });
      }
      if (
        !(await eventing.settle!({
          events: [
            ...requestEvents,
            ...(approvals.length > 0
              ? [
                  {
                    type: "session.requiresAction" as const,
                    payload: { approvals },
                  },
                ]
              : []),
            {
              type: "session.status.changed",
              payload: { status: "requires_action" },
            },
          ],
          turnStatus: "requires_action",
          sessionStatus: "requires_action",
          activeTurnId,
          runState: {
            serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
            pendingApprovals,
            humanInputRequests: humanInputRequests.map(({ isNew: _isNew, ...request }) => request),
            interactionInterventionRequests,
          },
        }))
      ) {
        return claimedResult({ status: "cancelled" });
      }
      // The interruption and its preceding tool results are now durable.
      await finalizeTurnOpStreamOps();
      control.activityStatus = "requires_action";
      return claimedResult({ status: "requires_action" });
    }

    const finalOutput = String(requireAgentStreamFinalOutput(eventing.stream.finalOutput));
    await historySink.reconcileConversationTruth({ requireDurable: true });
    // Op-stream durability fence: the tool outputs are now durably in the
    // history store (a redispatch would NOT re-execute them), so this
    // turn's settled ops may advance their acked frontier — journal persist
    // then wire final ack (licensing the runner to GC its retained
    // frames). Best-effort: a miss leaves the runner's retention TTL to
    // reap, never fails a completed turn.
    await finalizeTurnOpStreamOps();
    if (
      !(await eventing.settle!({
        events: [
          {
            type: "agent.message.completed",
            payload: { text: finalOutput },
          },
          { type: "turn.completed", payload: { output: finalOutput } },
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
      sourceResourceId: activeTurnId,
      sessionId: input.sessionId,
      turnId: activeTurnId,
      turnAttemptId: input.attemptId,
      idempotencyKey: `usage:agent_run.completed:${activeTurnId}`,
    });
    control.activityStatus = "idle";
    return claimedResult({ status: "idle" });
  };

  const openSuffixResume = await settleOpenSuffixResumeIfNeeded({
    db,
    agent,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: activeTurnId,
    executionGeneration: attempt.executionGeneration,
    attemptId: input.attemptId,
    trigger,
    humanInputResume,
    modelToolOutputTruncationTokens: eventing.modelRunSettings.modelToolOutputTruncationTokens,
    settle: eventing.settle!,
    publish: eventing.publish,
  });
  if (openSuffixResume.action === "cancelled") {
    return claimedResult({ status: "cancelled" });
  }
  if (openSuffixResume.action === "requires_action") {
    control.activityStatus = "requires_action";
    return claimedResult({ status: "requires_action" });
  }
  if (
    !(await attachPendingUpdatesBeforePreparingModelInput({
      shouldAttach:
        trigger.type === "user.approvalDecision" || trigger.type === "user.humanInputResponse",
      attachPendingUpdates: attachPendingUpdatesAfterOpenSuffix,
      prepareModelInput: prepareRunAttemptInput,
    }))
  ) {
    return claimedResult({ status: "cancelled" });
  }
  let retriedAfterCompaction = false;
  while (true) {
    try {
      const result = await runStreamAttempt({
        requireTerminalModelResponse: retriedAfterCompaction,
      });
      if (retriedAfterCompaction) {
        observability.info("context compaction recovery succeeded after in-activity retry", {
          sessionId: input.sessionId,
          turnId: activeTurnId,
        });
      }
      return result;
    } catch (attemptError) {
      const overflow = classifyContextWindowOverflowError(attemptError);
      const compactionNeeded = findCompactionNeededError(attemptError);
      const recoveryKind = compactionNeeded
        ? compactionNeeded.trigger === "operator"
          ? "operator"
          : "proactive"
        : overflow
          ? "overflow"
          : null;
      if (!recoveryKind || !eventing.publish || !eventing.turnStartedPublished) {
        throw attemptError;
      }
      await flushRuntimeBatcher();
      await historySink.reconcileConversationTruth({ skipInputOnlyRows: true });
      observability.warn("context compaction recovery attempted", {
        sessionId: input.sessionId,
        turnId: activeTurnId,
        reason: recoveryKind,
        ...safeErrorDiagnostic(attemptError),
        signalTokens: compactionNeeded?.signalTokens,
        thresholdTokens: compactionNeeded?.thresholdTokens,
      });
      let compacted = false;
      let compactionHandled = false;
      let compactionFailureMessage: string | null = null;
      let compactionRequestCleared = false;
      try {
        const outcome = await forceContextCompaction(
          recoveryKind,
          compactionNeeded?.signalTokens ?? null,
        );
        compacted = outcome.compacted;
        if (outcome.compacted) {
          compactionHandled = true;
        } else {
          compactionHandled = recoveryKind === "operator" && outcome.requestConsumed;
          if (!compactionHandled) {
            compactionFailureMessage = compactionFailureReason(outcome.reason);
          }
        }
      } catch (compactError) {
        // Transient checkpoint-provider failures recover this same accepted
        // turn through the normal provider/capacity path. They are not an
        // empty summary and must not create a new goal continuation.
        if (shouldRecoverCompactionProviderFailure(compactError)) throw compactError;
        if (compactError instanceof TurnAttemptFencedError) throw compactError;
        const landmark = await settleFailedContextCompactionLandmark(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: activeTurnId!,
            executionGeneration: attempt.executionGeneration,
            attemptId: input.attemptId,
          },
          {
            clearRequestedCompaction: recoveryKind === "operator",
            publishLiveEvents: publishCompactionLiveEvents,
          },
        );
        compactionRequestCleared = landmark.requestConsumed;
        if (!isCompactionSummaryFailure(compactError)) throw compactError;
        const deferredSteer = await settleDeferredSteerAfterCompaction();
        if (deferredSteer) return deferredSteer;
        compactionFailureMessage = String(compactionFailureReasonFromError(compactError));
        observability.warn("context compaction recovery compaction failed", {
          sessionId: input.sessionId,
          turnId: activeTurnId,
          ...safeErrorDiagnostic(compactError),
        });
      }
      if (!compactionHandled) {
        const errorMessage =
          compactionFailureMessage ??
          "compaction summarization failed: compaction produced no replacement history";
        if (
          !(await eventing.settle!({
            events: [
              {
                type: "turn.failed",
                payload: {
                  error: errorMessage,
                  code: "context_compaction_failed",
                  retryable: false,
                  recovery: "user_message",
                  compacted: false,
                },
              },
              {
                type: "session.status.changed",
                payload: { status: "idle" },
              },
            ],
            turnStatus: "failed",
            sessionStatus: "idle",
            activeTurnId: null,
            ...(recoveryKind === "operator" && !compactionRequestCleared
              ? { consumeRequestedCompactionFailure: true }
              : {}),
          }))
        ) {
          return claimedResult({ status: "cancelled" });
        }
        control.turnMetricOutcome = "failed";
        control.activityStatus = "idle";
        control.activityError = attemptError;
        // The failed turn settlement already defers ordinary internal
        // updates and makes the delivered goal-continuation receipt
        // terminal. End this workflow run as well: returning plain idle
        // would immediately synthesize another goal continuation against
        // the unchanged active history and repeat the same failed
        // compaction. A new human/API prompt, Steer, or explicitly requested
        // Compact remains a durable explicit wake and may retry; ordinary
        // machine updates stay pending for that actionable wake.
        return claimedResult({ status: "idle", deferredUntilWake: true });
      }
      const deferredSteer = await settleDeferredSteerAfterCompaction();
      if (deferredSteer) return deferredSteer;
      // Codex parity: compaction remains inside the same logical turn and
      // the same activity. Rebuild the model-visible history from the
      // durable replacement and continue the sampling loop; do not create
      // a recovery event, a queue row, a fake user message, or a sandbox.
      retriedAfterCompaction = true;
      observability.info("context compaction recovery retrying turn after compaction", {
        sessionId: input.sessionId,
        turnId: activeTurnId,
        reason: recoveryKind,
        compacted,
      });
      await prepareRunAttemptInput();
    }
  }
}
