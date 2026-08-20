import {
  getScheduledVariableSetExpectedGenerationForAttempt,
  advanceWorkspaceGeneration,
  verifyWorkspaceMutationSettlement,
  applySessionTurnSettlement,
  requestSessionTurnRecovery,
  claimSessionWorkForAttempt,
  materializeRigVersionForAttempt,
  getSandbox,
  readActiveSandbox,
  getSessionEvent,
  getSessionRootId,
  getSessionGoal,
  getHumanInputResumeForEvent,
  getInteractionInterventionResumeForEvent,
  getSessionHumanInputRequest,
  installOrReadTurnExecutionPolicyForAttempt,
  persistAttemptToolCatalog,
  workspaceCodexSubscriptionActive,
  acquireXaiCredentialLease,
  selectXaiCredentialForUse,
  materializeXaiCredentialForRun,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  releaseXaiCredentialLease,
  getXaiSessionAccountPin,
  setXaiSessionAccountPin,
  recordXaiSessionLastAccount,
  updateXaiQuotaMetadata,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  acquireCodexCredentialLease,
  armCodexCapacityWait,
  armXaiCapacityWait,
  reconcileXaiCapacityWait,
  releaseCodexCredentialLease,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  getCodexRotationSettings,
  getWorkspaceModelPolicy,
  getWorkspaceGrant,
  getWorkspace,
  listCodexAccountStatuses,
  getSessionCodexState,
  recordSessionActiveCodexCredential,
  setSessionCodexPinInTransaction,
  recordCodexAccountUsageWithWakeTargets,
  quarantineCodexCredentialForLease,
  setActiveCodexCredential,
  resolveCompanyBrainContextSelection,
  setCodexCredentialExhaustedWithWakeTargets,
  withSessionCodexCapacityMutation,
  countConsecutiveReactiveRotations,
  requireSession,
  recordUsageEvent,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  attachOpenSuffixToPendingToolCalls,
  clearDurablePendingSessionToolCalls,
  isSessionCompactionRequested,
  getActiveSessionHistoryItemsPaged,
  countSessionHistoryItems,
  nextSessionHistoryPosition,
  settleCodexCredentialLeaseLoss,
  settleCodexCredentialFailover,
  setSessionLastInputTokensForTurnAttempt,
  heartbeatLeaseHolder,
  readLease,
  accrueWarmSeconds,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  getGeneratedVideoArtifact,
  listSessionSystemUpdatesForTurn,
  getWorkspaceVideoGenerationPolicy,
  loadWorkspaceVercelAiGatewayCredentialLease,
  SandboxLeaseSupersededError,
  SandboxLeaseTransitionError,
  isSessionEventPersistenceError,
  getLiveEnrollmentConnection,
  assertPersonalMachineForAttempt,
  abandonRecordingForTurnAttempt,
  commitSessionAttemptQuiescence,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  PreferenceRegistryInitiatorError,
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  prepareConnectorActionApproval,
  withCodexAppsRequestAuthorization,
  resolveSessionAttemptPersonalResources,
  type AppendEventInput,
  type SandboxRecord,
  type CodexCredentialLeaseResult,
  type CodexCredentialLeaseSelectionContext,
  type ApplySessionTurnSettlementInput,
  type ApiIntegrationRuntime,
  type CanonicalTurnStartupMilestoneReceipt,
  type SessionAttemptQuiescenceCommit,
  type SessionTurnRecordingSettlement,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced, publishDurableSessionEvents } from "@opengeni/events";
import { sandboxLeaseTelemetryKey, sandboxOperationMetricObserver } from "@opengeni/observability";
import {
  maxTurnsExceededRunState,
  normalizeModelCallUsage,
  normalizeSdkEvent,
  extractOpenSuffixFromRunState,
  assertOpenSuffixResumable,
  interruptionKindForCallItem,
  releaseMcpResultCustomDataFromSdkEvent,
  projectHistoryForProvider,
  restoreGenericDispatchHistoryItems,
  projectModelInputForCapabilities,
  appendSessionInstructions,
  appendWorkspaceGovernance,
  appendWorkspaceMemory,
  composeAgentInstructions,
  hasActiveWorkspaceInstructionPolicy,
  renderWorkspaceGovernanceContext,
  requestRemoteCompactionV2,
  serializedToolsForRemoteCompaction,
  REMOTE_COMPACTION_V2_BETA_FEATURE,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  EmptyCompactionSummaryError,
  findCompactionNeededError,
  materializeSandboxFileDownloads,
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  withRunCredentialsSession,
  refreshGitCredentialBindingTokenFiles,
  refreshCodemodeTokenFile,
  codemodeTokenFileFromEnvironment,
  sandboxFileDownloadFailureNote,
  SUMMARY_BUFFER_TOKENS,
  runOwnedSandboxSetup,
  markModelPreparationFirstSandboxOperation,
  recordModelPreparationMeasurement,
  RoutingMutationOutcomeUnknownError,
  sdkBackendIdForSandboxBackend,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type OpenGeniRuntime,
  type ModelResponseUsage,
  type BuildAgentOptions,
  type AttemptConnectorActionBinding,
  type ConnectorActionPolicyHooks,
  type TurnToolCancellationFence,
  type EstablishedSandboxSession,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
  type ConnectorAttachmentMaterializationRequest,
  createFirstPartyInteractionAttemptToolDefinitions,
  deleteRecordingArtifacts,
  stopRecording as stopRecordingOnBox,
} from "@opengeni/runtime";
import {
  authorizeGoogleDrivePublicationAttempt,
  createGoogleDrivePublicationAttemptTool,
  googleDrivePublicationConnectorCall,
  resolveGoogleDrivePublicationTarget,
} from "../google-drive-publication";
import { connectionTokenResolverForTurn } from "../mcp-credentials";
import { buildApiIntegrationServersForTurn } from "../api-integrations";
import { materializeConnectorAttachmentsInChannel } from "../connector-attachments";
import {
  allowedFirstPartyMcpToolsForSession,
  assertTurnExecutionPolicyMatchesConfigV1,
  sandboxLifecycleTransitionWaitMs,
  sandboxWarmRateMicrosPerSecond,
  serviceTierForLatencyMode,
  environmentsEncryptionKeyBytes,
  settingsWithResolvedModelContext,
  resolveTurnExecutionPolicyV1,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  codemodeWorkspaceUrl,
  resolveModelProvider,
  type Settings,
} from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import {
  settingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithSessionMcpServersForRun,
  settingsWithWorkspaceGatewayCredential,
  withXaiSubscriptionProvider,
} from "../capabilities";
import { validateIncidentTelemetrySystemUpdateAuthority } from "../incident-telemetry-authority";
import {
  authoritativeCodexCapacityResetAt,
  chooseRotationActive,
  classifyCodexPin,
  computeIdleDelayMs,
  computeReactiveRotationResume,
  shardCredentialForSession,
  earliestCodexReset,
  isCodexCredentialEligible,
  selectCodexCredentialLeaseForTurn,
  type CodexRotationStrategy,
  type RotationDecision,
} from "../codex-rotation";
import {
  codexFleetShadowDecisionMetricLabelsV1,
  codexFleetShadowErrorMetricLabelsV1,
  publishCodexFleetShadowDecisionV1,
} from "../codex-fleet-shadow";
import { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import { buildCodexTokenResolver } from "../codex-auth";
import { signalCodexCapacityWakeTargets } from "../codex-capacity";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  classifyCodexEncryptedArtifactRejection,
  classifyCodexUsageLimitError,
  codexRequestStorage,
  isCodexTransportError,
  withCodexRequestOverrides,
  type CodexRequestContext,
  type CodexUsageHeaderSnapshot,
} from "@opengeni/codex";
import { mergeResourceRefs } from "../common";
import {
  fetchXaiSubscriptionQuota,
  xaiSubscriptionRequestStorage,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import { buildXaiTurnRequestAuthorization } from "../xai-auth";
import { executeXaiSubscriptionImageGeneration } from "../xai-image-generation";
import {
  assertSessionAllowsProductModel,
  defaultSessionMcpServerIds,
  loadRigDefaultVariableSetEnvironment,
  mergeRigDefaultVariableSetEnvironment,
  rigProviderImageContentHash,
  resolveRigProviderImageForRun,
  resolveCodexAppsCredentialIdForRun,
  withFrozenPersonalConnectionDelegations,
  resolveSessionToolPolicy,
  videoGenerationCapabilitiesForPolicy,
} from "@opengeni/core";
import { maybeCompactContext, settleFailedContextCompactionLandmark } from "../context-compaction";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import {
  admitVideoGenerationRequest,
  managedVideoGenerationCredentialLease,
  xaiVideoGenerationCredentialLease,
  type VideoGenerationCredentialLease,
} from "../video-generation-admission";
import { VideoReferenceInputError } from "../video-reference-staging";
import {
  assertGitCredentialRenewalTransportUnchanged,
  gitCredentialAuthorityForTurn,
  loadWorkspaceEnvironmentForRunWithCredentials,
  mintSandboxCodemodeToken,
  mintRunGitCredentials,
  mintRunGitCredentialBinding,
  sandboxEnvironmentForRun,
  type GitHubTokenMintAuthorization,
  type MintedRunGitCredentials,
} from "../environment";
import {
  startGitCredentialRenewalLoop,
  type GitCredentialRenewalController,
} from "../git-credential-renewal";
import {
  RUN_CREDENTIAL_EXPIRY_LEAD_MS,
  startRunCredentialRenewalLoop,
  type RunCredentialRenewalController,
} from "../run-credential-renewal";
import {
  CODEMODE_TOKEN_EXPIRY_LEAD_MS,
  startCodemodeTokenRenewalLoop,
  type CodemodeTokenRenewalController,
} from "../codemode-token-renewal";
import {
  bindRunCredentialResolver,
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
} from "../run-credentials";
import { withFirstPartyTools } from "../goals";
import {
  rigProviderImageSourceImage,
  resolveWorkspacePackRuntime,
  resolveWorkspaceInstalledSkillRuntime,
  settingsWithPackSandboxImage,
  settingsWithRigImage,
} from "../packs";
import { deliverFailedChildTurnToParent } from "../parent-wake";
import { createModelHistoryAttachmentProjector, turnInput } from "../run-input";
import {
  createRuntimeBatcher,
  currentActivityContext,
  nextStreamEvent,
  startActivityHeartbeat,
} from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
  SessionAttemptQuiescenceProof,
} from "../types";
import {
  resumeBoxForTurn,
  maybePersistWarmWorkspaceSnapshot,
  waitForWarmSnapshot,
  type ResumedTurnSandbox,
  type TurnSandboxLeaseHolderId,
} from "../../sandbox-resume";
import {
  wrapTurnBoxWithRouting,
  wrapLazyTurnBoxWithRouting,
  establishSelfhostedTurnSession,
  routingEnabled,
  lazyProvisionEnabled,
} from "../../sandbox-routing";
import { makeTurnOpJournal, type TurnHeartbeatDetails } from "../../op-journal";
import {
  makeMachineOpObserver,
  modelRequestLifecycleMetricsFor,
  modelCallAccountContext,
  recordBatchFlush,
  recordContextCompaction,
  recordCreditMicros,
  recordModelInputTokens,
  recordModelRequestPhase,
  recordSandboxLogicalProvision,
  recordSandboxProvisionAttempt,
  recordCompanyBrainContributions,
  recordSessionEventAppendLatency,
  recordSessionEventPublishLatency,
  recordTurnSandboxEstablishPolicy,
  recordTurnStartupPhase,
  recordTurnStartupMilestone,
  recordTurnWorkerPreparationTotal,
  runtimeMetricsHooksForObservability,
  StreamTimingMetrics,
  turnLifecycleMetricsFor,
  type TurnOutcome,
} from "../../observability-metrics";
import {
  buildCompanyBrainContributionReceipt,
  modelVisibleCompanyBrainSkillActivations,
  summarizeCompanyBrainContributions,
} from "../../model-context-contributions";
import {
  beginRecording,
  discardUnpublishedRecording,
  prepareRecordingForSettlement,
  type ActiveRecording,
} from "../recording";
import {
  compactRetainedScreenshotHistory,
  sdkEventContainsInlineImage,
  retainComputerScreenshot,
  typedScreenshotFromSdkEvent,
  unavailableRetainedSessionImage,
} from "../retained-screenshots";
import {
  collectGeneratedImageReceipts,
  compactGeneratedImageSdkEvent,
  generatedImageFromSdkEvent,
  isCompletedGeneratedImageSdkEvent,
  projectGeneratedImageHistoryForModel,
} from "../generated-images";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { createTurnHistorySink } from "./history-sink";
import { executeGatewayImageGeneration } from "../gateway-image-generation";
import { executeCodexImageGeneration } from "../codex-image-generation";
import { resolveImageGenerationReferences } from "../image-generation-references";
import {
  interruptionCallIdsFromPause,
  settleOpenSuffixResumeIfNeeded,
} from "../open-suffix-resume";
import { captureWorkspaceRevision, openFreshWorkspaceCaptureSession } from "../workspace-capture";
import {
  ChannelAPartialMutationError,
  SandboxChannelAService,
  type ChannelASession,
} from "@opengeni/runtime/sandbox";
import { retryWhileMissing } from "@opengeni/storage";
import { sandboxRunAs, WorkspaceModelPolicyBlockedError } from "@opengeni/runtime";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  evaluateWorkspaceModelPolicy,
  readTurnExecutionPolicyV1,
  resolveWorkspaceAgentHumanInputEnabled,
  VideoGenerationRejectedResult,
  type RetainedArtifactMetadata,
  type MediaGenerationResult,
  type ModelContextContributionSummary,
  type SessionEvent,
  type SessionStatus,
  type ToolAuthNeededPayload,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";

import {
  assertWorkspaceHumanInputAllowed,
  credentialSubjectIdForTurnInitiator,
  shouldPublishToolAuthNeededForTurn,
  turnExecutionPolicyBillingIdentity,
  legacyTurnExecutionPolicyInput,
  stableHumanInputRequestId,
  stableInteractionInterventionId,
  stableInteractionInterventionOperationId,
  BudgetExhaustedError,
  ensureRunAllowed,
} from "./admission";
import {
  codexWorkspaceMetricKey,
  acceptsPromptCacheKeyForTurn,
  refreshCappedCodexUsageRows,
} from "./codex";
import {
  providerRecoveryResult,
  providerRecoveryCountFromMetadata,
  providerRetryAfterMs,
  unavailableMcpOperationalContext,
  escapedMcpTimeoutRecoveryFailure,
  preClaimAdmissionFailure,
  isWorkerShutdownCancellation,
  compactionFailureReason,
  safeErrorDiagnostic,
  safeErrorForTelemetry,
  compactionFailureReasonFromError,
  isCompactionSummaryFailure,
  shouldRecoverCompactionProviderFailure,
  classifyContextWindowOverflowError,
  classifyXaiCredentialFailure,
  agentRunFailurePayload,
  codexCredentialCooldownUntil,
  classifyCodexCredentialFailure,
  codexUsageLimitFailurePayload,
  CODEX_USAGE_LIMIT_MAX_RESUME_MS,
} from "./errors";
import {
  filterUnmaterializedSandboxFileDownloads,
  runtimeResourcesForTurn,
  sandboxFileMaterializationOutcome,
  assertGitHubResourcesRemainAuthorized,
  assertFileResourcesRemainAuthorized,
  assertGitHubTokenMintSelectionAuthorized,
  sandboxFileDownloadsForRun,
  requiresSignedFileResourceDownloads,
  objectStorageForSandboxDownloads,
} from "./file-resources";
import {
  selectRejectedProviderArtifactHistoryIds,
  pendingToolCallFromSdkEvent,
  toolCallProducesRetainableSessionImage,
  completedToolCallFromSdkEvent,
} from "./history";
import {
  modelUsageSourceKey,
  recordCompletedModelCallBeforeOwnershipFences,
  TurnEventPublisher,
  createModelResponseEventState,
  createCompactionModelUsageEventState,
  modelResponseContextSignal,
  assertModelResponseLatencyMode,
  processModelResponseTerminalEvent,
  processCompactionModelUsageEvent,
  emitModelCallUsage,
  recordModelUsageAndDebitCredits,
  recordAuthoritativeModelCallFact,
} from "./model-usage";
import {
  shouldRunTurnEndWorkspacePersistence,
  shouldStartPeriodicWorkspaceSnapshot,
  assertPhysicalToolQuiescenceForCancellation,
  assertSessionAttemptQuiescenceRecoveryDurable,
  persistOrSignalSessionAttemptQuiescence,
  drainAttemptOwnedSandboxWriters,
  releaseTurnSandboxAfterWriterDrain,
  waitForTurnFinalizerStep,
  waitForTurnStreamCleanup,
  clearAttemptCredentialsWithSettledFence,
  turnFinalizerCancellationSignal,
  finalizeDurableTurnOpStreams,
} from "./quiescence";
import {
  TurnSandboxProvisioner,
  SandboxDeadlineRotationError,
  turnOperationCancellationFailure,
  throwIfTurnOperationCancelled,
  waitForTurnOperation,
  classifySandboxLogicalProvisionFailure,
  isLazySandboxProvisionRetryable,
  sandboxDeadlineRotationRecoveryDelayMs,
  createTurnSandboxProvisioner,
} from "./sandbox-provision";
import {
  resolveActiveSandboxBackend,
  managedSandboxOwnershipForTurn,
  shouldEstablishSandboxForTurn,
  sandboxEstablishPolicyDecision,
  shouldPrefetchManagedSandbox,
  reconcileActiveSandboxPointer,
  ensureTurnModalRegistryImage,
  sandboxArtifactRuntimeAdmission,
} from "./sandbox-route";
import {
  shouldStartOnTurnRecording,
  computerToolModeForTurn,
  structuredToolTransportForTurn,
  lazyToolTransportForTurn,
  shouldDeferNonEagerToolPreparation,
  hostedWebSearchForTurn,
  connectedSubscriptionImageGenerationAuthority,
  openAiHostedImageProviderBindingForTurn,
  modelAttachmentInputPolicyForTurn,
} from "./tool-policy";

export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  const modelCheckpointMemoryCollector = createModelCheckpointMemoryCollector();
  // Keep a distinct cooldown for terminal collection. A collection at the
  // final model checkpoint happens while the activity still owns its complete
  // turn graph and must not suppress collection after that graph is released.
  const turnCompletionMemoryCollector = createModelCheckpointMemoryCollector();
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const {
      settings,
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
    let cancellationRequestedAt: number | null = cancellationSignal?.aborted
      ? performance.now()
      : null;
    const noteCancellationRequested = (): void => {
      cancellationRequestedAt ??= performance.now();
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
    let activityStatus: RunAgentTurnResult["status"] | "unknown" = "unknown";
    let turnMetricOutcome: TurnOutcome | null = null;
    let activityError: unknown;
    let acknowledgeQuiescence = false;
    const acknowledgeLostAttemptOwnership = (): void => {
      // A stale terminal/recovery settlement can lose either to a benign
      // successor or to Pause/Steer closing this exact attempt. Only the
      // receipt transaction can distinguish those cases after the hard tool
      // fence: allowUninterrupted makes the benign case an event-free no-op.
      acknowledgeQuiescence = true;
      noteCancellationRequested();
    };
    const acknowledgeRecoveryQuiescence = (): void => {
      // requestSessionTurnRecovery closed this exact attempt and durably
      // recorded the replacement cause. The activity still owns the physical
      // tool/credential boundary until finally drains it and publishes the
      // exact quiescence receipt; a workflow result alone is never that proof.
      acknowledgeQuiescence = true;
      noteCancellationRequested();
    };
    let turnId: string | undefined;
    let triggerEventId: string | undefined;
    const claimedResult = (
      result: Omit<
        Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
        "turnId" | "attemptId"
      >,
    ): RunAgentTurnResult => {
      if (!turnId) throw new Error("Claimed activity result produced before turn admission");
      return {
        ...result,
        turnId,
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
    let isCodexTurn = false;
    let isXaiTurn = false;
    let isExternallyBilledTurn = false;
    let executionGeneration = 0;
    let providerRecoveryCount = 0;
    let modelRequestStarted = false;
    // Still required by credential-loss/capacity settlements, whose own
    // recovery transactions fence against worker-death redispatches.
    let redispatchesAtDispatch = 0;
    const setLastInputTokensFenced = async (lastInputTokens: number | null): Promise<void> => {
      if (!turnId || executionGeneration <= 0) {
        throw new Error("Turn attempt was not initialized before token accounting");
      }
      if (
        !(await setSessionLastInputTokensForTurnAttempt(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          expectedExecutionGeneration: executionGeneration,
          expectedAttemptId: input.attemptId,
          lastInputTokens,
        }))
      ) {
        throw new TurnAttemptFencedError("turn attempt was fenced while recording input tokens");
      }
    };
    let heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
    const codexWorkspaceKey = codexWorkspaceMetricKey(input.workspaceId);
    const leases = createTurnCredentialLeases({
      db,
      observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      codexWorkspaceKey,
      getTurnId: () => turnId,
    });

    // P1.2 ownership inversion: when sandboxOwnershipEnabled, the turn resolves
    // the one box by id from the group lease and injects it NON-OWNED into the
    // run. null when the flag is off (byte-for-byte the legacy build-and-discard
    // path) OR when the backend is "none". Released + dropped in `finally`.
    let resolvedSandbox: ResumedTurnSandbox | null = null;
    let attemptWritersDrained = false;
    const lateSandboxesAwaitingWriterDrain = new Set<ResumedTurnSandbox>();
    const releaseLateSandbox = async (sandbox: ResumedTurnSandbox): Promise<void> => {
      lateSandboxesAwaitingWriterDrain.add(sandbox);
      // Drop the holder/timer immediately, but keep its null-outcome admissions
      // fenced until the shared attempt writer drain completes. The staged
      // release serializes a later proof-bearing call behind this one.
      await sandbox.release().catch(() => undefined);
      if (!attemptWritersDrained) return;
      try {
        await releaseTurnSandboxAfterWriterDrain(sandbox);
        lateSandboxesAwaitingWriterDrain.delete(sandbox);
      } catch (error) {
        console.error(
          "late sandbox quiesced release failed (turn outcome unaffected)",
          safeErrorDiagnostic(error),
        );
      }
    };
    const requireResolvedSandboxForMutation = (message: string): ResumedTurnSandbox => {
      if (!resolvedSandbox) throw new Error(message);
      return resolvedSandbox;
    };
    // The machine-primary SelfhostedSession (the UNWRAPPED backend, not the
    // routing proxy). Kept as a fallback finalizer; the routing proxy normally
    // aggregates it together with every machine reached after a mid-turn swap.
    let machinePrimarySession: import("@opengeni/runtime").SelfhostedSession | null = null;
    let lazyOwnedSandbox: EstablishedSandboxSession | null = null;
    let firstModelPreparationNestedSandboxMs = 0;
    const firstModelPreparationNestedSandboxPhases: Array<{
      phase: "admission" | "provider" | "settlement" | "snapshot_wait";
      outcome: "completed" | "failed";
      durationSeconds: number;
    }> = [];
    let turnSandboxProvisioner: TurnSandboxProvisioner<ResumedTurnSandbox> | null = null;
    let resumeManagedGroupBox: (() => Promise<ResumedTurnSandbox>) | null = null;
    let prefetchedManagedBox: Promise<ResumedTurnSandbox> | null = null;
    let prefetchedManagedBoxResult: ResumedTurnSandbox | null = null;
    // The UN-PROXIED established box session, captured BEFORE wrapTurnBoxWithRouting.
    // Platform setup (beforeAgentStart hooks + file materialization) execs against
    // THIS handle so a mid-turn sandbox_swap can never re-route those execs onto a
    // connected machine (the user's real computer).
    let setupBoxSession: unknown = null;
    const finalizeTurnOpStreamOps = async (): Promise<void> => {
      await finalizeDurableTurnOpStreams(
        [lazyOwnedSandbox?.session, resolvedSandbox?.established.session],
        machinePrimarySession,
      );
    };
    // A same-target API repair can replace the home provider while this turn is
    // alive. Keep setup/snapshot persistence on the rebound raw session while
    // preserving the SDK-owned routing proxy for eager turns. Lazy turns hold the
    // proxy separately, so their worker-side handle may replace its raw session.
    const onHomeSandboxRebound = (rebound: {
      established: EstablishedSandboxSession;
      leaseEpoch: number;
    }): void => {
      const current = resolvedSandbox;
      const previousSession = current?.established.session;
      const preserveRoutingProxy = current !== null && previousSession !== setupBoxSession;
      setupBoxSession = rebound.established.session;
      if (!current) return;
      current.leaseEpoch = rebound.leaseEpoch;
      current.established = preserveRoutingProxy
        ? {
            ...current.established,
            client: rebound.established.client,
            // Keep the stable SDK-facing proxy; only its resolver changes the
            // underlying backend. The worker's setupBoxSession above is raw.
            session: previousSession,
            sessionState: rebound.established.sessionState,
            instanceId: rebound.established.instanceId,
            backendId: rebound.established.backendId,
            ...(rebound.established.origin ? { origin: rebound.established.origin } : {}),
            ...(rebound.established.restoredArchive
              ? { restoredArchive: rebound.established.restoredArchive }
              : {}),
          }
        : rebound.established;
    };
    // The globally unique durable turn-attempt holder id + the group id,
    // captured so the lease heartbeat can refresh the lease TTL epoch-fenced
    // (a superseded owner self-evicts) and finally can release.
    let sandboxHolderId: TurnSandboxLeaseHolderId | null = null;
    let sandboxGroupId: string | null = null;
    const runWorkspaceMutationForSandbox = async <T>(
      sandbox: ResumedTurnSandbox,
      operation: string,
      mutation: () => Promise<T>,
      observePhase?: (measurement: {
        phase: "admission" | "provider" | "settlement" | "snapshot_wait";
        outcome: "completed" | "failed";
        durationSeconds: number;
      }) => void,
    ): Promise<T> => {
      const observeMutationPhase = (
        phase: "admission" | "provider" | "settlement" | "snapshot_wait",
        outcome: "completed" | "failed",
        durationMs: number,
      ): void => {
        try {
          observePhase?.({
            phase,
            outcome,
            durationSeconds: Math.max(0, durationMs) / 1_000,
          });
        } catch {
          // Diagnostics must never alter workspace mutation authority.
        }
      };
      // Connected machines are the user's own persistence and never dirty the
      // cloud home archive. Every persistable raw-session write batch is fenced
      // against the exact current lease/provider before the provider sees it.
      if (sandbox.established.backendId === "selfhosted") {
        const providerStartedAt = performance.now();
        let providerOutcome: "completed" | "failed" = "failed";
        try {
          const result = await mutation();
          providerOutcome = "completed";
          return result;
        } catch (error) {
          if (error instanceof ChannelAPartialMutationError) {
            throw new RoutingMutationOutcomeUnknownError(
              operation,
              `Connected Machine workspace mutation "${operation}" partially applied before a later batch item failed; the complete operation was not replayed`,
              { cause: error },
            );
          }
          throw error;
        } finally {
          observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
        }
      }
      if (!sandboxGroupId || !sandboxHolderId || !turnId || executionGeneration <= 0) {
        throw new Error("Workspace mutation attempted before exact turn sandbox admission");
      }
      let admissionCaptureWaitMs = 0;
      const identity = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId,
        executionGeneration,
        attemptId: input.attemptId,
        holderId: sandboxHolderId,
        sandboxGroupId,
        expectedEpoch: sandbox.leaseEpoch,
        expectedInstanceId: sandbox.established.instanceId,
        operation,
        captureWaitMs: sandboxLifecycleTransitionWaitMs(settings),
        ...(cancellationSignal ? { waitSignal: cancellationSignal } : {}),
        ...(observePhase
          ? {
              onCaptureWait: (observation: {
                durationMs: number;
                outcome: "completed" | "failed";
              }) => {
                admissionCaptureWaitMs += Math.max(0, observation.durationMs);
                observeMutationPhase("snapshot_wait", observation.outcome, observation.durationMs);
              },
            }
          : {}),
      };
      const admissionStartedAt = performance.now();
      let admissionOutcome: "completed" | "failed" = "failed";
      let admission: Awaited<ReturnType<typeof advanceWorkspaceGeneration>>;
      try {
        admission = await advanceWorkspaceGeneration(db, identity);
        admissionOutcome = "completed";
      } finally {
        observeMutationPhase(
          "admission",
          admissionOutcome,
          Math.max(0, performance.now() - admissionStartedAt - admissionCaptureWaitMs),
        );
      }
      const settleMutation = async (outcome: "resolved" | "rejected"): Promise<void> => {
        const settlementStartedAt = performance.now();
        let settlementOutcome: "completed" | "failed" = "failed";
        try {
          await verifyWorkspaceMutationSettlement(db, {
            ...identity,
            admission,
            outcome,
          });
          settlementOutcome = "completed";
        } finally {
          observeMutationPhase(
            "settlement",
            settlementOutcome,
            performance.now() - settlementStartedAt,
          );
        }
      };
      let result: T;
      const providerStartedAt = performance.now();
      let providerOutcome: "completed" | "failed" = "failed";
      try {
        result = await mutation();
        providerOutcome = "completed";
      } catch (providerError) {
        observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
        const partialMutation = providerError instanceof ChannelAPartialMutationError;
        try {
          await settleMutation(partialMutation ? "resolved" : "rejected");
        } catch (settlementError) {
          throw new RoutingMutationOutcomeUnknownError(
            operation,
            partialMutation
              ? `Platform workspace mutation "${operation}" partially applied at the provider but lost its durable physical settlement; its outcome is unknown and it was not replayed`
              : `Platform workspace mutation "${operation}" rejected at the provider but lost its durable physical settlement; its outcome is unknown and it was not replayed`,
            { cause: settlementError },
          );
        }
        if (partialMutation) {
          throw new RoutingMutationOutcomeUnknownError(
            operation,
            `Platform workspace mutation "${operation}" partially applied before a later batch item failed; the complete operation was not replayed`,
            { cause: providerError },
          );
        }
        throw providerError;
      }
      observeMutationPhase("provider", providerOutcome, performance.now() - providerStartedAt);
      try {
        await settleMutation("resolved");
      } catch (settlementError) {
        throw new RoutingMutationOutcomeUnknownError(
          operation,
          `Platform workspace mutation "${operation}" returned from the provider but lost its durable settlement fence; its outcome is unknown and it was not replayed`,
          { cause: settlementError },
        );
      }
      return result;
    };
    // Lease-TTL refresh timer (parallels the activity heartbeat): while the turn
    // runs it refreshes expires_at epoch-fenced so a legit multi-day turn is
    // never TTL-reaped. Cleared in finally. Only set when the flag resolved a box.
    let leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopLeaseHeartbeat = (): void => {
      if (!leaseHeartbeatTimer) return;
      clearInterval(leaseHeartbeatTimer);
      leaseHeartbeatTimer = undefined;
    };
    let rotationInFlight: Promise<void> | null = null;
    // credential-renewal policy: the worker, not the model, owns renewal of run-scoped Git
    // credentials for a multi-day turn. The controller is attached only after
    // the initial seed reached a real cloud box and is drained before capture.
    let gitCredentialRenewals: GitCredentialRenewalController[] = [];
    let gitCredentialRenewalClosed = false;
    // Generic host-owned run material has its own attempt-scoped renewal and
    // write handle. It is always drained and wiped before workspace capture.
    let runCredentialRenewal: RunCredentialRenewalController | null = null;
    let runCredentialRenewalClosed = false;
    let runCredentialSession: RunCredentialCommandSession | null = null;
    // The delegated Codemode bearer has a one-hour TTL. Renewal is attempt-
    // owned and attaches only after the initial token file reached a real
    // sandbox session; finalization drains an in-flight replacement.
    let codemodeTokenRenewal: CodemodeTokenRenewalController | null = null;
    let codemodeTokenRenewalClosed = false;
    // MID-SESSION snapshot single-flight guard: the heartbeat tick fires every
    // 10s but a Modal filesystem snapshot can take longer — never overlap two
    // captures on one box. The in-flight capture's promise is held so the
    // turn-end persist can await it (its capture predates the turn's final
    // writes; landing after the fresher turn-end capture started would make
    // the atomic DB throttle discard the fresher one). Interval throttling
    // itself lives in maybePersistWarmWorkspaceSnapshot / persistWarmSnapshot.
    let snapshotInFlight: Promise<void> | null = null;
    // The heartbeat snapshot is mid-session durability, not first-request
    // preparation. Keep it off the startup critical path until a provider
    // request has actually reached its transport boundary.
    let firstProviderRequestStarted = false;
    // Turn-end capture needs the lease heartbeat to keep its holder alive, but
    // must prevent that same timer from starting another periodic snapshot
    // while it reads. This gate separates those two responsibilities.
    let turnEndCaptureInProgress = false;
    // Computer-use-only recording. Ordinary shell/filesystem turns leave this
    // null; the first actual computer action starts it after :0 is ready.
    let activeRecording: ActiveRecording | null = null;
    let computerUseRecordingStart: Promise<void> | null = null;
    // P4.3 recording gate: flips true in `onComputerUseReady`, the runtime's
    // execution-time callback for the first real computer action. It must flip
    // BEFORE awaiting recording startup: the SDK tool-call stream item can arrive
    // before ffmpeg has finished starting. A plain text turn ("hey"/"continue")
    // never invokes the callback, so settlement performs no storage PUT.
    let didComputerUse = false;
    const abandonActiveRecording = async (
      reason: string,
      disposition: "failed" | "discard" = "failed",
    ): Promise<void> => {
      const recording = activeRecording as ActiveRecording | null;
      if (!recording) return;
      activeRecording = null;
      if (resolvedSandbox) {
        await stopRecordingOnBox(resolvedSandbox.established.session, recording.proc).catch(
          () => undefined,
        );
      }
      if (!turnId || executionGeneration <= 0) return;
      await abandonRecordingForTurnAttempt(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId,
        executionGeneration,
        attemptId: input.attemptId,
        recordingId: recording.recordingId,
        disposition,
        reason,
      }).catch(() => undefined);
    };
    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    const flushRuntimeBatcher = async () => {
      const current = batcher as ReturnType<typeof createRuntimeBatcher> | null;
      await current?.flush().catch(() => undefined);
    };
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    let toolPreparationReady: Promise<void> | null = null;
    let toolPreparationClosing = false;
    let codemodeDispatcher: CodemodeAttemptDispatcher | null = null;
    const toolCancellationFenceRef: {
      current: TurnToolCancellationFence | null;
    } = {
      current: null,
    };
    let publish: TurnEventPublisher | null = null;
    let settle:
      | ((input: {
          events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>;
          turnStatus:
            | "queued"
            | "running"
            | "completed"
            | "failed"
            | "cancelled"
            | "requires_action";
          sessionStatus: SessionStatus;
          activeTurnId: string | null;
          consumeRequestedCompactionFailure?: boolean;
          runState?: ApplySessionTurnSettlementInput["runState"];
        }) => Promise<boolean>)
      | null = null;
    let turnStartedPublished = false;
    let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
    // Reconciliation is declared before provider routing so every turn-end path
    // can share one closure. It cannot run until `stream` exists, by which time
    // this value has been rebound to the turn's resolved model policy.
    let modelRunSettings: Settings = settings;
    const publishSandboxLifecycleEvents = async (sandbox: ResumedTurnSandbox): Promise<void> => {
      const established = sandbox.established;
      if (publish && established.origin && established.origin !== "resumed") {
        const lifecycleEvents: Array<{
          type: "sandbox.box.lost" | "sandbox.box.created";
          payload: unknown;
        }> = [];
        if (established.lostInstanceId) {
          lifecycleEvents.push({
            type: "sandbox.box.lost",
            payload: { sandboxId: established.lostInstanceId },
          });
        }
        lifecycleEvents.push({
          type: "sandbox.box.created",
          payload: {
            sandboxId: established.instanceId,
            hydrated: established.origin === "restored" ? "archive" : "none",
          },
        });
        await publish(lifecycleEvents).catch(() => undefined);
      }
    };
    const publishSandboxLost = async (lostSandbox: { instanceId: string }): Promise<void> => {
      if (!publish) return;
      await publish([
        {
          type: "sandbox.box.lost",
          payload: { sandboxId: lostSandbox.instanceId },
        },
      ]).catch((publishError) => {
        // The lease transition is already authoritative. A fenced/failed audit
        // append must not prevent the same logical turn from recovering.
        console.error("sandbox box lost event publish failed", safeErrorDiagnostic(publishError));
      });
    };
    const startLeaseHeartbeat = (
      sandbox: ResumedTurnSandbox,
      warmBackend: Settings["sandboxBackend"] | undefined,
    ): void => {
      if (leaseHeartbeatTimer) return;
      if (!sandboxHolderId || !sandboxGroupId) {
        return;
      }
      // Refresh the lease TTL on the activity-heartbeat cadence (10s, well
      // inside the 90s lease TTL). EPOCH-FENCED: a superseded owner's refresh
      // is rejected (returns false) and we stop refreshing — the box rides the
      // provider idle-timeout and the next dispatch re-establishes it. Best-
      // effort: a transient DB error must never fail the turn.
      const heartbeatEpoch = sandbox.leaseEpoch;
      const heartbeatHolderId = sandboxHolderId;
      const heartbeatGroupId = sandboxGroupId;
      // P2.1 warm-meter (tick A): while a turn runs, the heartbeat is also the
      // warm-seconds tick. GROUP+epoch+tick keyed (one box = one stream, shared
      // box metered once); epoch-fenced (a stale tick no-ops). Warm-cost is
      // metered when a per-backend rate is configured. Best-effort: a metering
      // failure must never fail the turn.
      //
      // Keyed off the EFFECTIVE backend (Stage D): a machine-primary turn has NO
      // Modal box, so it must accrue ZERO cloud warm-seconds — `selfhosted` has no
      // configured warm rate (0). Keying off turn.sandboxBackend (modal) would bill
      // cloud seconds for a box that does not exist (a real money bug). Non-machine
      // turns fall back to groupBoxBackend (the REAL box that ran): for a machine-
      // home turn that degraded to the cloud group box (swap-away / flag-off), that
      // is the deployment default (modal), so the fallback box is warm-metered at
      // the cloud rate instead of selfhosted's rate-0 (which would under-bill).
      const warmRate = sandboxWarmRateMicrosPerSecond(
        settings,
        warmBackend ?? (sandbox.established.backendId as Settings["sandboxBackend"]),
      );
      leaseHeartbeatTimer = setInterval(() => {
        void heartbeatLeaseHolder(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: heartbeatGroupId,
          kind: "turn",
          holderId: heartbeatHolderId,
          leaseTtlMs: settings.sandboxLeaseTtlMs,
          expectedEpoch: heartbeatEpoch,
        })
          .then(async (alive) => {
            if (alive || rotationInFlight || sandboxRotationController.signal.aborted) return;
            const rotatingLease = await readLease(db, input.workspaceId, heartbeatGroupId).catch(
              () => null,
            );
            if (
              !rotatingLease ||
              rotatingLease.leaseEpoch !== heartbeatEpoch ||
              rotatingLease.instanceId !== sandbox.established.instanceId ||
              rotatingLease.rotationRequestedAt === null
            ) {
              // The holder was reaped, the exact attempt closed, the epoch was
              // superseded, or the lease began draining. Do not leave a dead
              // interval issuing DB writes and snapshot probes forever.
              stopLeaseHeartbeat();
              return;
            }
            rotationInFlight = (async () => {
              // Rotation admission already fenced all new workspace mutations.
              // Wait for an earlier periodic capture, then produce the exact
              // generation-complete checkpoint that licenses aborting this run.
              if (snapshotInFlight) {
                await waitForWarmSnapshot(
                  snapshotInFlight,
                  settings.sandboxSnapshotTimeoutMs,
                  cancellationSignal,
                );
              }
              const snapshotSession = setupBoxSession;
              const snapshotTurnId = turnId;
              if (snapshotSession && snapshotTurnId) {
                await maybePersistWarmWorkspaceSnapshot(
                  { db, settings },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sessionId: input.sessionId,
                    turnId: snapshotTurnId,
                    attemptId: input.attemptId,
                    sandboxGroupId: heartbeatGroupId,
                  },
                  snapshotSession,
                  heartbeatEpoch,
                  cancellationSignal,
                  true,
                );
              }
              const checkpointed = await readLease(db, input.workspaceId, heartbeatGroupId);
              if (
                checkpointed?.leaseEpoch === heartbeatEpoch &&
                checkpointed.rotationRequestedAt !== null &&
                checkpointed.archiveComplete &&
                !cancellationSignal?.aborted
              ) {
                sandboxRotationController.abort(
                  new SandboxDeadlineRotationError(heartbeatGroupId, heartbeatEpoch),
                );
              }
            })()
              .catch((error) => {
                observability.warn("sandbox deadline rotation checkpoint failed; retrying", {
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sandboxGroupId: heartbeatGroupId,
                  leaseEpoch: heartbeatEpoch,
                  ...safeErrorDiagnostic(error),
                });
              })
              .finally(() => {
                rotationInFlight = null;
              });
            await rotationInFlight;
          })
          .catch(() => undefined);
        void accrueWarmSeconds(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sandboxGroupId: heartbeatGroupId,
          expectedEpoch: heartbeatEpoch,
          warmRateMicrosPerSecond: warmRate,
          subjectId: input.sessionId,
        })
          .then((result) => recordCreditMicros(observability, "usage", result.costMicros))
          .catch(() => undefined);
        // MID-SESSION snapshot (sandbox-file-persistence): while the turn holds
        // the box, fold a fresh /workspace snapshot onto the lease every
        // sandboxSnapshotIntervalMs, so a box death the reaper never sees
        // (Modal hard timeout mid-busy, OOM, infra) costs at most one interval
        // of work — a legit multi-day turn is otherwise completely unprotected
        // (the reaper only drain-persists IDLE leases). Uses the UN-proxied box
        // session (setupBoxSession): the routing veneer could swap mid-op and a
        // selfhosted target has no persistWorkspace anyway. Best-effort +
        // single-flight; throttling lives in the helper.
        const snapshotSession = setupBoxSession;
        const snapshotTurnId = turnId;
        if (
          snapshotSession &&
          snapshotTurnId &&
          shouldStartPeriodicWorkspaceSnapshot({
            firstProviderRequestStarted,
            snapshotInFlight: Boolean(snapshotInFlight),
            turnEndCaptureInProgress,
          })
        ) {
          snapshotInFlight = maybePersistWarmWorkspaceSnapshot(
            { db, settings },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: snapshotTurnId,
              attemptId: input.attemptId,
              sandboxGroupId: heartbeatGroupId,
            },
            snapshotSession,
            heartbeatEpoch,
            activityContext?.cancellationSignal,
          )
            .then(async (persisted) => {
              if (persisted && publish) {
                await publish([
                  {
                    type: "sandbox.box.snapshot",
                    payload: { trigger: "heartbeat" },
                  },
                ]);
              }
            })
            .catch(() => undefined)
            .finally(() => {
              snapshotInFlight = null;
            });
        }
      }, 10_000);
      if ("unref" in leaseHeartbeatTimer && typeof leaseHeartbeatTimer.unref === "function") {
        leaseHeartbeatTimer.unref();
      }
    };
    const maybeStartOnTurnRecording = async (
      sandbox: ResumedTurnSandbox,
      effectiveBackend: Settings["sandboxBackend"] | undefined,
    ): Promise<void> => {
      if (activeRecording) {
        return;
      }
      if (computerUseRecordingStart) {
        await computerUseRecordingStart;
        return;
      }
      // Called only by the runtime's first-computer-action hook. Plain sandbox
      // operations never start ffmpeg and never boot a display merely to record
      // an unused desktop. Recording failure never fails the computer action.
      if (
        shouldStartOnTurnRecording({
          recordingEnabled: settings.recordingEnabled,
          desktopEnabled: settings.sandboxDesktopEnabled,
          establishedBackendId: sandbox.established.backendId,
          // EFFECTIVE (active) backend, not the session home: a machine-primary turn
          // resolves to "selfhosted" and skips; a swap back to the cloud group box
          // resolves to undefined and records as before.
          effectiveBackend,
        })
      ) {
        computerUseRecordingStart = (async () => {
          let begun: Awaited<ReturnType<typeof beginRecording>> | null = null;
          try {
            begun = await beginRecording({
              settings,
              db,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turnId!,
              recordingId: randomUUID(),
              mode: "on-turn",
              session: sandbox.established.session,
              runAs: sandboxRunAs(settings),
              reason: null,
            });
            if (!publish) {
              throw new Error("recording started before the turn event publisher was ready");
            }
            await publish([{ type: "recording.started", payload: begun.started }]);
            activeRecording = begun.active;
          } catch (recordingError) {
            activeRecording = null;
            if (begun) {
              await discardUnpublishedRecording({
                db,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                active: begun.active,
                session: sandbox.established.session,
              });
            }
            console.error(
              "computer-use recording start failed (action outcome unaffected)",
              safeErrorDiagnostic(recordingError),
            );
          }
        })();
        await computerUseRecordingStart;
      }
    };
    // Dual-write of conversation truth (issue #35): completed items are
    // reconciled into session_history_items after every model response and at
    // every turn-end path (idempotent on position), and the sandbox recovery
    // envelope is upserted alongside. Best-effort by design: persistence
    // problems must never fail the run.
    //
    // Orphaned-tool-output guard: `stream.state.history` is NOT a plain
    // append-only array — it is a computed getter
    // (`getTurnInput(originalInput, generatedItems)`) that runs the SDK's
    // `dropOrphanToolCalls` on every access, so a `function_call` with no
    // settling result yet is transiently ABSENT from history and a later
    // reconcile sees a DIFFERENT, shorter/reordered list. A blind length
    // watermark with onConflictDoNothing-on-position then freezes the first
    // shape of a position and can persist a `function_call_result` at a tail
    // position while its `function_call` was pruned away in an earlier slice
    // and never written — the orphan that bricks the session. We defend against
    // it at the stream boundary with the turn-scoped pending-tool ledger. A
    // partial parallel batch records raw results but does not call this
    // reconciler. Once every registered call has a result, the SDK history is
    // stable and this scalar append watermark is valid again. The sanitizer
    // remains the final call/result pairing guard for every other reconcile.
    const media = createTurnMediaArtifacts({
      db,
      objectStorage,
      observability,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      getTurnId: () => turnId,
      getModelRunSettings: () => modelRunSettings,
      getPublish: () => publish,
      toolCancellationFenceRef,
      getResolvedSandbox: () => resolvedSandbox,
      getSetupBoxSession: () => setupBoxSession,
      getSandboxGroupId: () => sandboxGroupId,
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
      getModelRunSettings: () => modelRunSettings,
      getSandboxFileDownloadBackend: () => media.sandboxFileDownloadBackend,
      getPublish: () => {
        const current = publish;
        if (!current) return null;
        return async (events, immediate) =>
          await current(events as Parameters<TurnEventPublisher>[0], immediate);
      },
      toolCancellationFenceRef,
      getResolvedSandbox: () => resolvedSandbox,
      getSetupBoxSession: () => setupBoxSession,
      getSdkOwnedSandboxSession: () => media.sdkOwnedSandboxSession,
      getSandboxGroupId: () => sandboxGroupId,
      runWorkspaceMutation: runWorkspaceMutationForSandbox,
    });
    const historySink = createTurnHistorySink({
      db,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      media,
      getTurnId: () => turnId,
      getStream: () => stream,
      getModelRunSettings: () => modelRunSettings,
      getExecutionGeneration: () => executionGeneration,
    });

    const publishedRunCredentialNotices = new Set<string>();

    let variableSetId = "";
    // Rig telemetry (M3): set once the session loads; empty string for a rig-less
    // turn (mirrors variableSetId). Read by the activity span's finally block.
    let rigId = "";
    let rigVersionId = "";
    // The Codex account this turn runs on (pin > workspace active), resolved once
    // a codex-billed turn is confirmed and threaded into the token resolver below.
    let effectiveCodexCredentialId: string | null = null;
    let effectiveXaiCredentialId: string | null = null;
    let xaiRotationEnabled = false;
    let xaiAuthoritySnapshot: XaiProviderAccountAuthoritySnapshotV1 | null = null;
    let xaiRequestContext: XaiSubscriptionRequestContext | null = null;
    let xaiCredentialQuarantined = false;
    // The session's Codex credential BEFORE this turn resolved its own — captured
    // before recordSessionActiveCodexCredential overwrites the durable pointer, so
    // a per-call usage log can report whether the serving account CHANGED since the
    // session's previous call (the prompt-cache account-switch hypothesis).
    let priorSessionCodexCredentialId: string | null = null;
    // The latest usage-header snapshot scraped for free
    // off this turn's `/codex/responses` responses (a turn issues many model calls;
    // latest wins). Flushed ONCE into the P2 usage cache for the serving account in
    // the `finally` — cheaper than a /wham/usage poll AND it self-heals P3 rotation
    // (the proactive + 429 rankers read these exact columns). null ⇒ nothing scraped.
    // Hoisted to activity scope so the finally flush (below) sees it. The sink is
    // wired into codexContext.onUsageHeaders inside the try.
    let latestCodexUsage: CodexUsageHeaderSnapshot | null = null;
    let lastCodexRequestOpaqueArtifacts: readonly string[] = [];
    // Hoisted for same-turn recovery: an approval-decision rerun must
    // re-enter through the suffix/history resume path, never through a swapped trigger.
    let triggerType: string | null = null;
    try {
      const claim = await claimSessionWorkForAttempt(db, input.workspaceId, {
        sessionId: input.sessionId,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        attemptId: input.attemptId,
        dispatchId,
        trigger: input.trigger,
        validatePendingSystemUpdateAuthority: async (tx, update) =>
          await validateIncidentTelemetrySystemUpdateAuthority({
            db: tx,
            settings,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            update,
          }),
      });
      if (claim.action === "unclaimed") {
        activityStatus = "unclaimed";
        return { status: "unclaimed", reason: claim.reason };
      }
      const turn = claim.turn;
      turnId = turn.id;
      // Establish durable attempt ownership before any later read can fail.
      // Therefore every failure with no turnId came from the one atomic claim
      // transaction and can be classified without conflating ordinary runtime
      // or transport failures with admission failures.
      const session = await requireSession(db, input.workspaceId, input.sessionId);
      executionGeneration = turn.executionGeneration;
      providerRecoveryCount = providerRecoveryCountFromMetadata(turn.metadata);
      let installedApiIntegrations: readonly ApiIntegrationRuntime[] = [];
      const credentialSubjectId = credentialSubjectIdForTurnInitiator(turn);
      const fileAuthoritySubjectId = turn.initiatingHumanSubjectId ?? null;
      const mcpSettings = await settingsWithEnabledCapabilityMcpServers(
        db,
        input.workspaceId,
        settings,
        {
          ...(credentialSubjectId
            ? { subjectId: credentialSubjectId }
            : {
                personalConnectionDelegations: turn.personalConnectionDelegations,
              }),
          onResolvedApiIntegrations: (integrations) => {
            installedApiIntegrations = integrations;
          },
        },
      );
      // Read the active-credential flag once for the runtime capability overlay.
      // Accepted billing/provider identity comes from the turn policy below,
      // never from this mutable health snapshot.
      const codexSubscriptionActive = await workspaceCodexSubscriptionActive(
        db,
        mcpSettings,
        input.workspaceId,
      );
      const codexSettings = await settingsWithCodexCredential(
        db,
        input.workspaceId,
        mcpSettings,
        codexSubscriptionActive,
      );
      const xaiSettings = codexSettings.supergrokSubscriptionEnabled
        ? withXaiSubscriptionProvider(codexSettings)
        : codexSettings;
      const capabilitySettings = await settingsWithWorkspaceGatewayCredential(
        db,
        input.workspaceId,
        xaiSettings,
      );
      const codexAppsCredentialId = capabilitySettings.codexConnectedAppsEnabled
        ? await resolveCodexAppsCredentialIdForRun(db, input.workspaceId)
        : null;
      runtime.configure(capabilitySettings);
      const claimedPolicy = readTurnExecutionPolicyV1(turn.metadata);
      const policyForAbsent =
        claimedPolicy.kind === "valid"
          ? claimedPolicy.policy
          : resolveTurnExecutionPolicyV1(capabilitySettings, legacyTurnExecutionPolicyInput(turn));
      const installedPolicy = await installOrReadTurnExecutionPolicyForAttempt(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId,
        executionGeneration,
        attemptId: input.attemptId,
        policyForAbsent,
      });
      if (!installedPolicy.accepted) {
        throw new TurnAttemptFencedError(
          `turn execution policy was fenced: ${installedPolicy.reason}`,
        );
      }
      const verifiedExecutionPolicy = assertTurnExecutionPolicyMatchesConfigV1(
        capabilitySettings,
        installedPolicy.policy,
        {
          modelId: turn.model,
          reasoningEffort: turn.reasoningEffort,
          latencyMode: turn.latencyMode,
        },
      );
      const turnExecutionPolicy = verifiedExecutionPolicy.policy;
      assertSessionAllowsProductModel(session, turnExecutionPolicy.productModelId);
      const billingIdentity = turnExecutionPolicyBillingIdentity(turnExecutionPolicy);
      isExternallyBilledTurn = billingIdentity.externallyBilled;
      isCodexTurn = billingIdentity.codexSubscription;
      isXaiTurn = billingIdentity.xaiSubscription;
      triggerEventId = turn.triggerEventId;
      const trigger = await getSessionEvent(db, input.workspaceId, triggerEventId);
      if (!trigger) {
        throw new Error(`Trigger event not found: ${triggerEventId}`);
      }
      const humanInputResume = await getHumanInputResumeForEvent(
        db,
        input.workspaceId,
        input.sessionId,
        trigger,
      );
      const interactionInterventionResume = await getInteractionInterventionResumeForEvent(
        db,
        input.workspaceId,
        input.sessionId,
        trigger,
      );
      triggerType = trigger.type;
      redispatchesAtDispatch = Number(
        (turn.metadata as { workerDeathRedispatches?: number } | null)?.workerDeathRedispatches ??
          0,
      );
      turnLifecycleMetricsFor(observability).start(turnId);
      // §7.5 P3 — pass the accepted billing attribution (externally funded turns
      // bypass OpenGeni credit/token gates)
      // AND the optional host `entitlements` port (when bound, its admitRun replaces
      // the local credit read). Unset port → today's local-ledger path.
      await waitForTurnOperation(
        ensureRunAllowed(
          settings,
          db,
          input.accountId,
          input.workspaceId,
          isExternallyBilledTurn,
          entitlements,
        ),
        cancellationSignal,
        undefined,
      );
      // Setup (variableSet load, MCP connects, sandbox restore) does not
      // stream and so never observes cancellation on its own; these explicit
      // checks let a graceful shutdown checkpoint the turn before the worker is
      // force-killed instead of riding the setup to a heartbeat timeout.
      const throwIfWorkerShuttingDown = () => {
        const reason = activityContext?.cancellationSignal.reason;
        if (isWorkerShutdownCancellation(reason)) {
          throw reason;
        }
      };
      const throwIfTurnCancelled = () => throwIfTurnOperationCancelled(cancellationSignal);
      // ONE shared details object for every heartbeat this activity sends (each
      // site spreads it + its own phase), so cross-site fields — the op-stream
      // settled roster in particular — survive last-write-wins instead of being
      // clobbered by whichever site heartbeated most recently.
      const heartbeatDetails: TurnHeartbeatDetails = {
        phase: "running",
        sessionId: input.sessionId,
        turnId,
        opAcks: {},
      };
      const opJournal = makeTurnOpJournal(activityContext, heartbeatDetails);
      heartbeatTimer = startActivityHeartbeat(activityContext, heartbeatDetails);
      let producerSeq = 0;
      // One producer per activity execution, not per turn: a turn can run
      // again on the same workflow (recovery, approval rerun), and
      // each execution restarts producerSeq at 1 — a shared producer id would
      // trip the per-producer uniqueness constraint on the event log. The
      // Temporal activity id is unique per scheduled execution.
      const producerId = `${input.workflowId}:${turnId}${activityContext ? `:${activityContext.info.activityId}` : ""}`;
      // Unique per scheduled activity execution (Temporal activityId). Folded
      // into positional usage source keys so a re-dispatch of this turn does
      // not collide its model-call charges with the prior dispatch's. A genuine
      // activity retry reuses the same activityId, so its re-emitted calls keep
      // deduping (no double charge).
      // Local/tests have no Temporal activity id; still generate an execution-
      // unique holder so a second dispatch of the same durable turn fences this
      // one exactly like production.
      leases.codex.holderId = dispatchId;
      const modelUsageDispatchId = activityContext?.info.activityId ?? dispatchId;
      const claimedModelUsageSourceKeys = new Set<string>();
      const emittedModelUsageSourceKeys = new Set<string>();
      let startupMilestoneBackend: Settings["sandboxBackend"] = turn.sandboxBackend;
      const recordCanonicalStartupMilestones = (
        receipts: CanonicalTurnStartupMilestoneReceipt[],
      ): void => {
        for (const receipt of receipts) {
          recordTurnStartupMilestone(observability, {
            milestone: receipt.milestone,
            provider: turnExecutionPolicy.providerId,
            backend: startupMilestoneBackend,
            outcome: receipt.outcome,
            durationSeconds: receipt.durationMs / 1_000,
          });
        }
      };
      publish = async (
        events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
        immediate = false,
      ) => {
        const inputs = events.map((event) => ({
          ...event,
          payload: event.payload,
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        const appended = await appendAndPublishTurnEventsFenced(
          db,
          bus,
          input.workspaceId,
          input.sessionId,
          turnId!,
          executionGeneration,
          input.attemptId,
          inputs,
          {
            onAppend: ({ durationSeconds }) =>
              recordSessionEventAppendLatency(observability, {
                durationSeconds,
              }),
            onPublish: ({ durationSeconds }) =>
              recordSessionEventPublishLatency(observability, {
                durationSeconds,
              }),
          },
        );
        if (inputs.length > 0 && !appended.accepted) {
          throw new TurnAttemptFencedError("turn execution generation was fenced");
        }
        recordCanonicalStartupMilestones(appended.canonicalStartupMilestones);
        if (inputs.length > 0) {
          turnLifecycleMetricsFor(observability).progress(turnId!);
        }
        activityContext?.heartbeat({
          ...heartbeatDetails,
          phase: "events_published",
          producerSeq,
        });
        if (immediate) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        return appended;
      };
      settle = async (inputSettlement) => {
        const attemptClosing = ["completed", "failed", "cancelled", "requires_action"].includes(
          inputSettlement.turnStatus,
        );
        const recordingForSettlement =
          attemptClosing && activeRecording && resolvedSandbox
            ? (activeRecording as ActiveRecording)
            : null;
        const preparedRecording = recordingForSettlement
          ? await prepareRecordingForSettlement({
              settings,
              objectStorage,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              active: recordingForSettlement,
              session: resolvedSandbox!.established.session,
              didComputerUse,
            })
          : null;
        let recordingMutation: SessionTurnRecordingSettlement | undefined;
        if (preparedRecording) {
          const mutation = preparedRecording.mutation;
          recordingMutation =
            mutation.action === "discard"
              ? mutation
              : {
                  ...mutation,
                  producerId,
                  producerSeq: ++producerSeq,
                };
        }
        const compactionRequestFailure = inputSettlement.consumeRequestedCompactionFailure
          ? {
              reason: "summarization_failed" as const,
              producerId,
              producerSeq: ++producerSeq,
            }
          : undefined;
        const inputs = inputSettlement.events.map((event) => ({
          ...event,
          payload: event.payload,
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        const runState = inputSettlement.runState
          ? {
              ...inputSettlement.runState,
              serializedRunState: media.compactMediaRunState(
                inputSettlement.runState.serializedRunState,
              ),
            }
          : undefined;
        const result = await applySessionTurnSettlement(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: turnId!,
          triggerEventId: triggerEventId!,
          attemptId: input.attemptId,
          turnStatus: inputSettlement.turnStatus,
          sessionStatus: inputSettlement.sessionStatus,
          activeTurnId: inputSettlement.activeTurnId,
          events: inputs,
          ...(runState ? { runState } : {}),
          ...(recordingMutation ? { recording: recordingMutation } : {}),
          ...(compactionRequestFailure ? { compactionRequestFailure } : {}),
        });
        if (result.action === "stale") {
          // The terminal write can lose to a control transaction before the
          // workflow delivers Temporal cancellation. That control may settle
          // the already-closed attempt as rejected_stale, so returning without
          // this flag would strand its replacement behind quiesced_at forever.
          // Enter the same hard tool-fence/receipt path as an explicit
          // TurnAttemptFencedError. If ownership was lost for an unrelated
          // reason, allowUninterrupted makes the receipt transaction a no-op.
          acknowledgeLostAttemptOwnership();
          if (recordingForSettlement) {
            await abandonActiveRecording(
              "recording settlement lost attempt ownership",
              preparedRecording?.mutation.action === "discard" ? "discard" : "failed",
            );
          }
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return false;
        }
        recordCanonicalStartupMilestones(result.canonicalStartupMilestones);
        turnLifecycleMetricsFor(observability).progress(turnId!);
        if (recordingForSettlement && preparedRecording) {
          if (result.recordingMutationApplied) {
            activeRecording = null;
            if (preparedRecording.deleteArtifactsAfterCommit) {
              await deleteRecordingArtifacts(
                resolvedSandbox!.established.session,
                recordingForSettlement.proc,
              );
            }
          } else {
            await abandonActiveRecording("recording row was unavailable during turn settlement");
          }
        }
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, result.events);
        activityContext?.heartbeat({
          ...heartbeatDetails,
          phase: "events_published",
          producerSeq,
        });
        return true;
      };
      activityContext?.heartbeat({
        ...heartbeatDetails,
        phase: "turn_started",
      });

      // A shutdown that landed during claim/billing setup stops before the turn
      // visibly starts: nothing ran yet, so the same inference starts cleanly
      // on a healthy worker.
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      recordTurnStartupPhase(observability, {
        phase: "claim_and_policy",
        provider: turnExecutionPolicy.providerId,
        backend: turn.sandboxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - activityStarted) / 1_000,
      });
      const turnStartSettlementStartedAt = performance.now();
      if (
        !(await settle({
          events: [
            { type: "session.status.changed", payload: { status: "running" } },
            {
              type: "turn.started",
              payload: { triggerEventId },
            },
          ],
          turnStatus: "running",
          sessionStatus: "running",
          activeTurnId: turnId,
        }))
      ) {
        return claimedResult({ status: "cancelled" });
      }
      recordTurnStartupPhase(observability, {
        phase: "turn_start_settlement",
        provider: turnExecutionPolicy.providerId,
        backend: turn.sandboxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - turnStartSettlementStartedAt) / 1_000,
        count: 2,
      });
      turnStartedPublished = true;
      const workerPreparationStartedAt = performance.now();

      // Multi-account (P1): resolve the effective Codex account for this turn
      // (session-pin > workspace active) and stamp it on the session so the
      // in-session "Running on:" indicator reflects reality. Emit a switch event
      // when it changed from the prior run's account so the pill flips live.
      // Gated on the codex-billed predicate — non-codex turns never touch this.
      if (isCodexTurn) {
        const credentialSelectionStartedAt = performance.now();
        let credentialSelectionOutcome: "completed" | "failed" = "completed";
        try {
          const sessionCodex = await getSessionCodexState(db, input.workspaceId, input.sessionId);
          const sessionPin = sessionCodex?.pinnedCredentialId ?? null;
          const sessionPinSource = sessionCodex?.pinSource ?? null;
          const selectForTurn = (context: CodexCredentialLeaseSelectionContext) =>
            selectCodexCredentialLeaseForTurn({
              context,
              leasingEnabled: settings.codexCredentialLeasingEnabled,
              sessionId: input.sessionId,
              sessionPinnedCredentialId: sessionPin,
              sessionPinSource,
              sessionLastCredentialId: sessionCodex?.lastCredentialId ?? null,
              now: new Date(),
            });

          // Rollout/rollback path is intentionally table-inert. With the flag off,
          // old and new workers both use legacy pin > active-pointer selection and
          // neither reads nor writes the additive lease/cursor schema.
          let leased: CodexCredentialLeaseResult<RotationDecision>;
          let leaseAcquisitionStartedAtMs: number | null = null;
          if (settings.codexCredentialLeasingEnabled) {
            leaseAcquisitionStartedAtMs = performance.now();
            leased = await acquireCodexCredentialLease(
              db,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                turnId,
                holderId: leases.codex.holderId,
                advanceActivePointer: sessionPin === null,
              },
              selectForTurn,
            );
          } else {
            const [rotation, accounts] = await Promise.all([
              getCodexRotationSettings(db, input.workspaceId),
              listCodexAccountStatuses(db, input.workspaceId),
            ]);
            const leaseAccounts = accounts.map((account) => ({
              ...account,
              activeLeaseCount: 0,
              selectionCount: 0,
              lastSelectedAt: null,
            }));
            const activeCredentialId = rotation?.activeCredentialId ?? null;
            const selected = selectForTurn({
              accounts: leaseAccounts,
              activeCredentialId,
              rotationEnabled: rotation?.rotationEnabled ?? false,
              leaseRotationEnabled: false,
              rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
              existingCredentialId: null,
              policyScope: null,
              unavailableDiagnostics: [],
            });
            leased = {
              ...selected,
              accounts: leaseAccounts,
              activeCredentialId,
              rotationEnabled: rotation?.rotationEnabled ?? false,
              rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
              reused: false,
              holderId: null,
              generation: null,
              leasedUntil: null,
              unavailableDiagnostics: [],
              advanceActivePointer: selected.advanceActivePointer !== false,
            };
          }
          if (leased.decision.kind === "allCapped") {
            // Bounded self-heal of stale usage cache, then ONE new atomic selection.
            await refreshCappedCodexUsageRows(db, settings, input.workspaceId, leased.accounts, {
              signalCodexCapacityWorkflow,
              wakeSessionWorkflow,
            });
            if (settings.codexCredentialLeasingEnabled) {
              leaseAcquisitionStartedAtMs = performance.now();
              leased = await acquireCodexCredentialLease(
                db,
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  turnId,
                  holderId: leases.codex.holderId,
                  advanceActivePointer: sessionPin === null,
                },
                selectForTurn,
              );
            } else {
              const [rotation, accounts] = await Promise.all([
                getCodexRotationSettings(db, input.workspaceId),
                listCodexAccountStatuses(db, input.workspaceId),
              ]);
              const leaseAccounts = accounts.map((account) => ({
                ...account,
                activeLeaseCount: 0,
                selectionCount: 0,
                lastSelectedAt: null,
              }));
              const selected = selectForTurn({
                accounts: leaseAccounts,
                activeCredentialId: rotation?.activeCredentialId ?? null,
                rotationEnabled: rotation?.rotationEnabled ?? false,
                leaseRotationEnabled: false,
                rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
                existingCredentialId: null,
                policyScope: null,
                unavailableDiagnostics: [],
              });
              leased = {
                ...selected,
                accounts: leaseAccounts,
                activeCredentialId: rotation?.activeCredentialId ?? null,
                rotationEnabled: rotation?.rotationEnabled ?? false,
                rotationStrategy: rotation?.rotationStrategy ?? "most_remaining",
                reused: false,
                holderId: null,
                generation: null,
                leasedUntil: null,
                unavailableDiagnostics: [],
                advanceActivePointer: selected.advanceActivePointer !== false,
              };
            }
          }
          const rotationDecision = leased.decision;
          const selectedPinDisposition = classifyCodexPin({
            pinnedCredentialId: sessionPin,
            pinSource: sessionPinSource,
            strategy: leased.rotationStrategy as CodexRotationStrategy,
            rotationEnabled: leased.rotationEnabled,
          });
          // pin policy pin persistence follows the atomic credential allocator selection. The selector
          // already ran exact-turn reuse before policy filtering and vetoed pointer
          // movement for manual/policy homes; this write only records the NEXT turn's
          // policy home (or clears a policy pin whose strategy is no longer active).
          if (
            selectedPinDisposition === "sharded" &&
            leased.credentialId !== null &&
            (sessionPinSource !== "policy" || sessionPin !== leased.credentialId)
          ) {
            const pinMutation = await withSessionCodexCapacityMutation(
              db,
              {
                workspaceId: input.workspaceId,
                reason: "codex_policy_pin_changed",
              },
              async (tx) => {
                const changed = await setSessionCodexPinInTransaction(
                  tx,
                  input.workspaceId,
                  input.sessionId,
                  leased.credentialId,
                  "policy",
                  {
                    expected: {
                      pinnedCredentialId: sessionPin,
                      pinSource: sessionPinSource,
                    },
                  },
                );
                return { result: changed, changed };
              },
            );
            await signalCodexCapacityWakeTargets(
              { signalCodexCapacityWorkflow, wakeSessionWorkflow },
              pinMutation.wakeTargets,
            );
          } else if (selectedPinDisposition === "clearStale") {
            const pinMutation = await withSessionCodexCapacityMutation(
              db,
              {
                workspaceId: input.workspaceId,
                reason: "codex_stale_policy_pin_cleared",
              },
              async (tx) => {
                const changed = await setSessionCodexPinInTransaction(
                  tx,
                  input.workspaceId,
                  input.sessionId,
                  null,
                  "policy",
                  {
                    expected: {
                      pinnedCredentialId: sessionPin,
                      pinSource: sessionPinSource,
                    },
                  },
                );
                return { result: changed, changed };
              },
            );
            await signalCodexCapacityWakeTargets(
              { signalCodexCapacityWorkflow, wakeSessionWorkflow },
              pinMutation.wakeTargets,
            );
          }
          if (
            !settings.codexCredentialLeasingEnabled &&
            leased.advanceActivePointer &&
            sessionPin === null &&
            rotationDecision.kind === "active" &&
            rotationDecision.moved
          ) {
            await setActiveCodexCredential(db, input.workspaceId, rotationDecision.credentialId);
          }
          effectiveCodexCredentialId = leased.credentialId;
          leases.codex.generation = leased.generation;
          leases.codex.confirmedUntilMs =
            leased.leasedUntil && leaseAcquisitionStartedAtMs !== null
              ? leaseAcquisitionStartedAtMs + CODEX_CREDENTIAL_LEASE_TTL_MS
              : null;
          leases.codex.held =
            effectiveCodexCredentialId !== null &&
            leased.holderId !== null &&
            leased.generation !== null &&
            leases.codex.confirmedUntilMs !== null;
          if (leases.codex.held) leases.codex.startHeartbeat();

          const actualOutcome = effectiveCodexCredentialId
            ? "selected"
            : rotationDecision.kind === "allCapped"
              ? "waiting"
              : "none";
          const actualReason = effectiveCodexCredentialId
            ? leased.reused
              ? "lease_reused"
              : sessionPin === effectiveCodexCredentialId
                ? "pin"
                : rotationDecision.kind === "active" && rotationDecision.moved
                  ? "rotation"
                  : "active"
            : rotationDecision.kind === "allCapped"
              ? "all_capped"
              : "none";
          const fencedInFlight = leased.reused;
          const shadowResult = await publishCodexFleetShadowDecisionV1({
            enabled: settings.codexFleetPolicyShadowEnabled,
            decision: {
              accounts: leased.accounts,
              actualCredentialId: effectiveCodexCredentialId,
              actualOutcome,
              actualReason,
              affinityCredentialId: fencedInFlight
                ? effectiveCodexCredentialId
                : (sessionPin ?? sessionCodex?.lastCredentialId ?? null),
              fencedInFlight,
              nearExhaustionPct: settings.codexRotationNearExhaustionPct,
              now: new Date(),
              aliasSeed: randomUUID(),
            },
            publish,
          });
          if (shadowResult.outcome === "published") {
            const shadowPayload = shadowResult.payload;
            observability.incrementCounter({
              name: "opengeni_codex_fleet_shadow_decisions_total",
              help: "Shadow decisions by bounded actual/shadow outcome and comparison.",
              labels: codexFleetShadowDecisionMetricLabelsV1(shadowPayload),
            });
            observability.info("Codex adaptive fleet shadow decision", {
              workspaceId: input.workspaceId,
              policyVersion: shadowPayload.replay.policyVersion,
              inputFingerprint: shadowPayload.replay.inputFingerprint,
              decisionFingerprint: shadowPayload.replay.decisionFingerprint,
              actualOutcome: shadowPayload.actual.outcome,
              shadowOutcome: shadowPayload.replay.decision.outcome,
              comparison: shadowPayload.comparison,
              candidateCount: shadowPayload.replay.input.candidates.length,
              truncatedCandidateCount: shadowPayload.replay.truncatedCandidateCount,
              payloadBytes: shadowResult.payloadBytes,
            });
          } else if (shadowResult.outcome === "failed") {
            // Shadow observability is explicitly non-authoritative. A malformed
            // snapshot or event-write fault must never change the authoritative lease,
            // capacity wait, failover, or the account serving this fenced turn.
            observability.incrementCounter({
              name: "opengeni_codex_fleet_shadow_errors_total",
              help: "Shadow decision build/publication failures.",
              labels: codexFleetShadowErrorMetricLabelsV1(shadowResult),
            });
            observability.warn("Codex adaptive fleet shadow decision failed open", {
              stage: shadowResult.stage,
              reason: shadowResult.reason,
              errorClass: "CodexFleetShadowOperationError",
              errorCode: "codex_fleet_shadow_failed",
              origin: "worker",
              payloadBytes: shadowResult.payloadBytes,
            });
          }

          const eligibleCount = leased.accounts.filter((account) =>
            isCodexCredentialEligible(account, new Date()),
          ).length;
          const poolDepth = eligibleCount === 0 ? "zero" : eligibleCount === 1 ? "one" : "many";
          observability.incrementCounter({
            name: "opengeni_codex_pool_observations_total",
            help: "Observed eligible Codex pool depth buckets at turn selection.",
            labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
          });
          if (eligibleCount <= 1) {
            observability.incrementCounter({
              name: "opengeni_codex_pool_low_total",
              help: "Alert signal emitted when the eligible Codex pool is zero or one.",
              labels: { workspace_key: codexWorkspaceKey, depth: poolDepth },
            });
            observability.warn("Codex eligible credential pool is low", {
              workspaceId: input.workspaceId,
              eligibleCount,
              connectedCount: leased.accounts.length,
              depth: poolDepth,
            });
          }

          if (
            effectiveCodexCredentialId === null &&
            leased.accounts.length > 0 &&
            leased.accounts.every((account) => !account.allocatorEnabled) &&
            turnId
          ) {
            if (turn.source === "compaction") {
              if (
                !(await settle!({
                  events: [
                    {
                      type: "turn.cancelled",
                      payload: {
                        maintenance: "context_compaction",
                        reason: "codex_allocator_disabled",
                        requestPreserved: true,
                      },
                    },
                    {
                      type: "session.status.changed",
                      payload: { status: "idle" },
                    },
                  ],
                  turnStatus: "cancelled",
                  sessionStatus: "idle",
                  activeTurnId: null,
                }))
              ) {
                return claimedResult({ status: "cancelled" });
              }
              turnMetricOutcome = "cancelled";
              activityStatus = "idle";
              return claimedResult({ status: "idle", deferredUntilWake: true });
            }
            const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(
              () => null,
            );
            const activeGoal = goal?.status === "active" ? goal : null;
            const armed = await armCodexCapacityWait(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              workflowId: input.workflowId,
              goalId: activeGoal?.id ?? null,
              goalVersion: activeGoal?.version ?? null,
              earliestResetAt: null,
              resetKind: "bounded_refresh",
              failurePayload: {
                error: "All connected Codex subscriptions are disabled for new allocations.",
                code: "codex_allocator_disabled",
                detail: "waiting for a credential to be re-enabled, reconnected, or added",
              },
            });
            if (armed.action === "waiting") {
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                armed.events,
              );
              turnMetricOutcome = "recovering";
              activityStatus = "waiting_capacity";
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
            if (
              !(await settle!({
                events: [
                  {
                    type: "turn.failed",
                    payload: {
                      error: "All connected Codex subscriptions are disabled for new allocations.",
                      code: "codex_allocator_disabled",
                      retryable: false,
                      recovery: "user_message",
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
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            return claimedResult({ status: "idle" });
          }

          if (rotationDecision.kind === "allCapped" && turnId) {
            if (turn.source === "compaction") {
              if (
                !(await settle!({
                  events: [
                    {
                      type: "turn.cancelled",
                      payload: {
                        maintenance: "context_compaction",
                        reason: "codex_capacity_unavailable",
                        requestPreserved: true,
                      },
                    },
                    {
                      type: "session.status.changed",
                      payload: { status: "idle" },
                    },
                  ],
                  turnStatus: "cancelled",
                  sessionStatus: "idle",
                  activeTurnId: null,
                }))
              ) {
                return claimedResult({ status: "cancelled" });
              }
              turnMetricOutcome = "cancelled";
              activityStatus = "idle";
              return claimedResult({ status: "idle", deferredUntilWake: true });
            }
            // Every eligible account is capped/cooling (and a usage refresh did NOT
            // surface a reset): idle the turn AT THE BOUNDARY (no wasted model/sandbox
            // build) until the EARLIEST reset across all accounts — the multi-account
            // generalization of #143's single-account idle-until-reset. No saveRunState:
            // no model ran, nothing to freeze.
            const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(
              () => null,
            );
            const goalActive = Boolean(goal && goal.status === "active");
            // BOUNDED + POSITIVE: clamp to [MIN_IDLE_MS, max] so a null/elapsed/unknown
            // reset can never yield a 0 (which session.ts would treat as "continue now",
            // re-entering this path in a tight CPU/DB-hammering loop).
            const resumeMs = computeIdleDelayMs(
              rotationDecision.earliestResetAt,
              new Date(),
              CODEX_USAGE_LIMIT_MAX_RESUME_MS,
            );
            const failurePayload = codexUsageLimitFailurePayload(
              { resetsInSeconds: Math.ceil(resumeMs / 1000) },
              "all connected Codex subscriptions are rate-limited",
              { allAccounts: true },
            );
            const authoritativeResetAt = authoritativeCodexCapacityResetAt(
              leased.accounts,
              new Date(),
            );
            const armed = await armCodexCapacityWait(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              workflowId: input.workflowId,
              goalId: goalActive && goal ? goal.id : null,
              goalVersion: goalActive && goal ? goal.version : null,
              earliestResetAt: authoritativeResetAt,
              resetKind: authoritativeResetAt ? "authoritative" : "bounded_refresh",
              failurePayload,
            });
            if (armed.action === "waiting") {
              await publishDurableSessionEvents(
                bus,
                input.workspaceId,
                input.sessionId,
                armed.events,
              );
              turnMetricOutcome = "recovering";
              activityStatus = "waiting_capacity";
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
            if (
              !(await settle!({
                events: [
                  // `rotated:true` (Finding 2): the proactive all-capped wait is the SAME
                  // rotation-wait state as the reactive all-capped path, so it must freeze
                  // autoContinuations identically (evaluateGoalContinuation reads this marker)
                  // — a goal waiting out a long reset must not burn its continuation budget on
                  // the proactive path while the reactive path spares it.
                  {
                    type: "turn.failed",
                    payload: {
                      ...failurePayload,
                      recovery: goalActive ? "goal_continuation" : "user_message",
                      rotated: true,
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
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            // idleUntilReset marks this a MANDATORY hold: session.ts must wait the full
            // resumeMs even if a future change made it 0 — never a tight re-dispatch.
            return claimedResult(
              goalActive
                ? {
                    status: "idle",
                    continueDelayMs: resumeMs,
                    idleUntilReset: true,
                  }
                : { status: "idle" },
            );
          }
          if (effectiveCodexCredentialId) {
            const priorAccountId = sessionCodex?.lastCredentialId ?? null;
            if (priorAccountId !== effectiveCodexCredentialId) {
              await recordSessionActiveCodexCredential(
                db,
                input.workspaceId,
                input.sessionId,
                effectiveCodexCredentialId,
              );
              const rotated = rotationDecision.kind === "active" && rotationDecision.moved;
              await publish([
                {
                  type: "codex.account.switched",
                  payload: {
                    fromAccountId: priorAccountId,
                    toAccountId: effectiveCodexCredentialId,
                    reason: rotated ? "rotation" : "manual",
                  },
                },
              ]);
            }

            const selectionReason = leased.reused
              ? "lease_reused"
              : sessionPin === effectiveCodexCredentialId
                ? "pin"
                : rotationDecision.kind === "active" && rotationDecision.moved
                  ? "rotation"
                  : "active";
            observability.incrementCounter({
              name: "opengeni_codex_credential_selections_total",
              help: "Codex credential selections by strategy and reason.",
              labels: {
                workspace_key: codexWorkspaceKey,
                strategy: leased.rotationStrategy,
                reason: selectionReason,
              },
            });
            await publish([
              {
                type: "codex.credential.selected",
                payload: {
                  credentialId: effectiveCodexCredentialId,
                  strategy: leased.rotationStrategy,
                  reason: selectionReason,
                  eligibleCount,
                  connectedCount: leased.accounts.length,
                  reused: leased.reused,
                },
              },
            ]);
          }
        } catch (error) {
          credentialSelectionOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "credential_selection",
            provider: "codex-subscription",
            backend: turn.sandboxBackend,
            outcome: credentialSelectionOutcome,
            durationSeconds: (performance.now() - credentialSelectionStartedAt) / 1_000,
          });
        }
      }

      if (isXaiTurn) {
        const authoritySnapshot = turn.xaiProviderAccountAuthoritySnapshot;
        xaiAuthoritySnapshot = authoritySnapshot;
        const subjectId =
          authoritySnapshot.scope === "user"
            ? turn.initiatingHumanSubjectId
            : "worker:xai-workspace";
        if (!subjectId) {
          throw new Error("User-scoped SuperGrok work has no frozen initiating human");
        }
        const sessionPin = await getXaiSessionAccountPin(db, {
          workspaceId: input.workspaceId,
          subjectId,
          sessionId: input.sessionId,
          authoritySnapshot,
        });
        const leaseStartedAtMs = performance.now();
        const leased = await acquireXaiCredentialLease(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId,
          sessionId: input.sessionId,
          turnId: turn.id,
          holderId: dispatchId,
          authoritySnapshot,
          pinnedCredentialId: sessionPin?.pinnedCredentialId ?? null,
          pinSource:
            sessionPin?.pinSource === "manual" || sessionPin?.pinSource === "policy"
              ? sessionPin.pinSource
              : null,
        });
        effectiveXaiCredentialId = leased.credentialId;
        xaiRotationEnabled = leased.rotationEnabled;
        leases.xai.subjectId = subjectId;
        leases.xai.holderId = leased.holderId;
        leases.xai.generation = leased.generation;
        leases.xai.confirmedUntilMs = leased.leasedUntil
          ? leaseStartedAtMs + XAI_CREDENTIAL_LEASE_TTL_MS
          : null;
        leases.xai.held =
          effectiveXaiCredentialId !== null &&
          leased.holderId !== null &&
          leased.generation !== null &&
          leases.xai.confirmedUntilMs !== null;
        if (!effectiveXaiCredentialId) {
          const connected = leased.accounts.length;
          const allocatorEnabled = leased.accounts.filter(
            (account) => account.allocatorEnabled,
          ).length;
          if (connected === 0) {
            throw Object.assign(
              new Error("No SuperGrok subscription account is connected for this authority scope"),
              { code: "xai_not_connected" },
            );
          }
          if (turn.source === "compaction") {
            if (
              !(await settle!({
                events: [
                  {
                    type: "turn.cancelled",
                    payload: {
                      maintenance: "context_compaction",
                      reason: "xai_capacity_unavailable",
                      requestPreserved: true,
                    },
                  },
                  {
                    type: "session.status.changed",
                    payload: { status: "idle" },
                  },
                ],
                turnStatus: "cancelled",
                sessionStatus: "idle",
                activeTurnId: null,
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "cancelled";
            activityStatus = "idle";
            return claimedResult({ status: "idle", deferredUntilWake: true });
          }
          const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(
            () => null,
          );
          const activeGoal = goal?.status === "active" ? goal : null;
          const now = new Date();
          const futureResets = leased.accounts
            .map((account) => account.exhaustedUntil)
            .filter((date): date is Date => date !== null && date > now);
          const earliestResetAt = futureResets.length
            ? new Date(Math.min(...futureResets.map((date) => date.getTime())))
            : null;
          const error =
            allocatorEnabled === 0
              ? "All connected SuperGrok subscription accounts are disabled for allocation"
              : "All connected SuperGrok subscription accounts are temporarily unavailable";
          const armed = await armXaiCapacityWait(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            workflowId: input.workflowId,
            authoritySnapshot,
            goalId: activeGoal?.id ?? null,
            goalVersion: activeGoal?.version ?? null,
            earliestResetAt,
            failurePayload: {
              error,
              code: allocatorEnabled === 0 ? "xai_allocator_disabled" : "xai_capacity_unavailable",
              detail: "waiting for an eligible account, reconnect, pin change, or quota reset",
            },
          });
          if (armed.action === "waiting") {
            await publishDurableSessionEvents(
              bus,
              input.workspaceId,
              input.sessionId,
              armed.events,
            );
            turnMetricOutcome = "recovering";
            activityStatus = "waiting_capacity";
            return claimedResult({
              status: "waiting_capacity",
              capacityWait: {
                provider: "xai",
                waiterId: armed.waiter.id,
                generation: armed.waiter.generation,
                nextCheckAt: armed.waiter.nextCheckAt.toISOString(),
                wakeRevision: armed.waiter.wakeRevision,
              },
            });
          }
          if (
            !(await settle!({
              events: [
                {
                  type: "turn.failed",
                  payload: {
                    error,
                    code: "xai_capacity_wait_stale",
                    retryable: false,
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
          turnMetricOutcome = "failed";
          activityStatus = "idle";
          return claimedResult({ status: "idle" });
        }
        if (leases.xai.held) leases.xai.startHeartbeat();
        if (
          leased.rotationEnabled &&
          sessionPin?.pinSource !== "manual" &&
          (sessionPin?.pinnedCredentialId !== effectiveXaiCredentialId ||
            sessionPin?.pinSource !== "policy")
        ) {
          await setXaiSessionAccountPin(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId,
            sessionId: input.sessionId,
            authoritySnapshot,
            credentialId: effectiveXaiCredentialId,
            pinSource: "policy",
            expectedVersion: sessionPin?.version ?? null,
          }).catch((error: unknown) => {
            if (error instanceof Error && error.message === "xAI session pin changed") return;
            throw error;
          });
        } else if (!leased.rotationEnabled && sessionPin?.pinSource === "policy") {
          await setXaiSessionAccountPin(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId,
            sessionId: input.sessionId,
            authoritySnapshot,
            credentialId: null,
            pinSource: null,
            expectedVersion: sessionPin.version,
          }).catch((error: unknown) => {
            if (error instanceof Error && error.message === "xAI session pin changed") return;
            throw error;
          });
        }
        await recordXaiSessionLastAccount(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId,
          sessionId: input.sessionId,
          authoritySnapshot,
          credentialId: effectiveXaiCredentialId,
        });
      }

      const runtimePreparationStartedAt = performance.now();

      // Personal Rig/Variable Set authority is revalidated immediately before
      // any direct resource read. The database function is a zero-row no-op for
      // sessions with no personal resources, preserving the legacy workspace path.
      await resolveSessionAttemptPersonalResources(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: fileAuthoritySubjectId,
        attemptId: input.attemptId,
      });

      const governanceClaims = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration: turn.executionGeneration,
      };
      // Independent workspace reads after the personal-resource fence. Pack,
      // installed skills, frozen rig, governance snapshots, and model policy do
      // not depend on each other. Company-brain selection still waits on the
      // snapshots below so its receipt stays exact.
      const [
        packRuntime,
        installedSkillRuntime,
        rigMaterialization,
        [workspace, companyProfileSnapshot, instructionPolicySnapshot, preferenceSnapshot],
        workspaceModelPolicy,
      ] = await Promise.all([
        resolveWorkspacePackRuntime(db, input.workspaceId),
        resolveWorkspaceInstalledSkillRuntime(db, input.workspaceId),
        session.rigId && session.rigVersionId
          ? (async () =>
              await materializeRigVersionForAttempt(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                subjectId: fileAuthoritySubjectId,
                sessionId: input.sessionId,
                turnId: turn.id,
                attemptId: input.attemptId,
                executionGeneration: turn.executionGeneration,
              }))()
          : Promise.resolve(null),
        Promise.all([
          getWorkspace(db, input.workspaceId),
          getOrCreateCompanyProfileSnapshot(db, governanceClaims),
          getOrCreateWorkspaceInstructionPolicySnapshot(db, governanceClaims),
          getOrCreatePreferenceRegistrySnapshot(db, governanceClaims).catch((error) => {
            if (error instanceof PreferenceRegistryInitiatorError) return null;
            throw error;
          }),
        ]),
        getWorkspaceModelPolicy(db, input.workspaceId),
      ]);
      const rigVersion = rigMaterialization?.version ?? null;
      // Rig display name for the doctrine block + setup events/errors (only on a
      // rig-bound turn; null-safe fallback keeps the turn alive if the rig row is
      // gone). Loaded once here alongside the version.
      const rigName = rigVersion ? (rigMaterialization?.rigName ?? "rig") : null;
      // Telemetry: stamp the frozen rig binding (empty for a rig-less turn).
      rigId = session.rigId ?? "";
      rigVersionId = session.rigVersionId ?? "";
      if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
      const agentHumanInputEnabled = resolveWorkspaceAgentHumanInputEnabled(workspace.settings);
      const contextSelection = await resolveCompanyBrainContextSelection(db, governanceClaims);
      const workspaceAgentInstructions = contextSelection.legacyWorkspaceInstructions;
      const memoryPromptMode = contextSelection.receipt.memoryPromptMode;
      assertWorkspaceHumanInputAllowed(agentHumanInputEnabled, "resume", humanInputResume !== null);
      const companyProfileIncluded = contextSelection.receipt.companyProfileIncluded;
      const workspaceGovernance = renderWorkspaceGovernanceContext(
        {
          companyProfile: companyProfileSnapshot,
          instructionPolicy: instructionPolicySnapshot,
          preferences: preferenceSnapshot,
        },
        {
          includeCompanyProfile: companyProfileIncluded,
        },
      );
      const structuredWorkspacePolicyActive =
        hasActiveWorkspaceInstructionPolicy(instructionPolicySnapshot);
      const workspaceMemory = contextSelection.workspaceMemory;
      const buildCompanyBrainContributionReceiptFor = (
        skillActivations: Parameters<
          typeof buildCompanyBrainContributionReceipt
        >[0]["skillActivations"],
      ) =>
        buildCompanyBrainContributionReceipt({
          contextSelectionReceiptId: contextSelection.receipt.id,
          attemptId: input.attemptId,
          turnId: turn.id,
          nestedAgentDepth: session.nestedAgentDepth,
          memoryPromptMode,
          instructionPolicy: instructionPolicySnapshot,
          workspaceAgentInstructions,
          preferences: preferenceSnapshot,
          companyProfile: companyProfileSnapshot,
          companyProfileIncluded,
          workspaceMemory,
          skillActivations,
        });
      let companyBrainContextContributions: readonly ModelContextContributionSummary[] | null =
        null;
      try {
        // Portable operator compaction runs before tool/skill preparation, so its
        // exact Company Brain prefix contains governance and standing memory but
        // no runtime skill catalog. Later compaction paths replace this summary
        // after the complete skill activation set is resolved.
        companyBrainContextContributions = summarizeCompanyBrainContributions(
          buildCompanyBrainContributionReceiptFor([]),
        );
      } catch {
        // Contribution telemetry must never change model execution semantics.
      }
      const logicalSandboxSettings = settingsWithRigImage(
        settingsWithPackSandboxImage(
          capabilitySettings,
          packRuntime.sandboxImage,
          packRuntime.sandboxProviderImages,
        ),
        rigVersion?.image ?? null,
      );
      const providerImageSelection = await resolveRigProviderImageForRun(
        logicalSandboxSettings,
        rigVersion,
        turn.sandboxBackend,
      );
      const providerImageSettings = providerImageSelection.settings;
      const verifiedRigProviderImageId =
        providerImageSelection.reason === "selected"
          ? (providerImageSelection.imageId ?? undefined)
          : undefined;
      const baseRunSettings = {
        // IMAGE PRECEDENCE: rig > pre-V2 Pack compatibility > deployment.
        // resolveWorkspacePackRuntime returns no image for V2 Pack rows, so
        // settingsWithRigImage runs outermost over only the intentionally
        // retained legacy fallback. A matching verified provider-native ID is
        // then applied only to fresh creation without changing the logical
        // lease image.
        ...providerImageSettings,
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const runSettings = await settingsWithSessionMcpServersForRun(
        db,
        input.workspaceId,
        input.sessionId,
        input.attemptId,
        baseRunSettings,
      );

      // Multi-provider per-turn routing → the provider gating (compaction mode,
      // hosted web search, encrypted reasoning, context window) the agent and
      // compaction summarizer must use; null falls back to the legacy global
      // client. Resolve against `capabilitySettings` (whose openaiModel is the
      // deployment default), NOT `runSettings`: runSettings.openaiModel is the
      // turn's model, so for a turn ON a registry model the built-in provider
      // would otherwise claim that id (configuredModels builds the built-in's
      // models from openaiModel) and shadow the registry entry — resolving the
      // turn to the built-in (Azure) gating while the global model router routes
      // the name to its registry provider. That mismatch attaches web_search to
      // a chat-only Fireworks model. Resolving against the default-model settings
      // keeps gating consistent with the router. Cost accounting covers registry
      // models via configuredModelPricing.
      const resolvedModel = runtime.resolveTurnModel(
        capabilitySettings,
        turnExecutionPolicy.productModelId,
      );
      const providerApi = resolvedModel?.provider.api ?? "responses";
      const nativeImageProviderBinding =
        providerApi === "responses"
          ? openAiHostedImageProviderBindingForTurn(capabilitySettings, resolvedModel)
          : null;
      const lazyToolTransport = lazyToolTransportForTurn(resolvedModel);
      const modelInputPolicy = modelAttachmentInputPolicyForTurn(resolvedModel);
      // Use the proven wire capability, not the catalogue modality alone. Chat
      // providers may advertise vision, but OpenGeni intentionally has no typed
      // image transport for that wire yet; exposing view_image there would turn
      // pixels into a multi-megabyte text/base64 function result.
      const supportsImageInput = modelInputPolicy.supportsImageInput;
      media.modelCanReceiveRetainedSessionImages = supportsImageInput;
      const attachmentProjector = createModelHistoryAttachmentProjector(
        modelInputPolicy,
        objectStorage
          ? async (file) => {
              const object = await retryWhileMissing(async () =>
                objectStorage.getObjectBytes(file.objectKey),
              );
              if (!object) throw new Error("attachment object is missing");
              return object.bytes;
            }
          : undefined,
      );
      const modelHistoryProjector = async (
        items: Array<Record<string, unknown>>,
        projectionOptions?: Parameters<typeof attachmentProjector>[1],
      ) =>
        projectModelInputForCapabilities(
          await attachmentProjector(items, projectionOptions),
          modelInputPolicy,
        );
      const generatedImageHistoryProjector = async (
        items: Array<Record<string, unknown>>,
      ): Promise<Array<Record<string, unknown>>> => {
        collectGeneratedImageReceipts(items, media.generatedImageReceiptsByProviderItemId);
        return projectGeneratedImageHistoryForModel(items);
      };
      const compactionModelHistoryProjector = async (items: Array<Record<string, unknown>>) =>
        await modelHistoryProjector(
          projectHistoryForProvider(
            await generatedImageHistoryProjector(restoreGenericDispatchHistoryItems(items)),
            providerApi,
          ),
        );
      // Bind the provider/model catalog's context policy to every model-facing
      // path for this turn. In particular, Codex subscription turns must not
      // inherit the deployment's OpenAI/Azure mode or 1.05M context defaults:
      // raw window, effective ceiling, and auto-compact limit are distinct live
      // catalog values and must reach pre-turn compaction, history guards, and
      // every model call together.
      modelRunSettings = resolvedModel
        ? settingsWithResolvedModelContext(runSettings, resolvedModel.configured)
        : runSettings;
      // WORKSPACE MODEL POLICY — the authoritative hard gate. Runs immediately
      // after resolution and BEFORE any model call (the compaction summarizer
      // and the main run both come later in this scope), so a blocked
      // provider/model can never be reached through ANY stamp path: explicit
      // turn model, inherited session default, goal-continuation inheritance,
      // or the legacy null-resolution fallback. The frozen execution policy is
      // the attribution source even if an injected test runtime returns no
      // concrete resolved model. Fail-loud, never a silent remap.
      {
        if (workspaceModelPolicy) {
          const verdict = evaluateWorkspaceModelPolicy(workspaceModelPolicy, {
            providerId: turnExecutionPolicy.providerId,
            modelId: turnExecutionPolicy.productModelId,
          });
          if (!verdict.allowed) {
            throw new WorkspaceModelPolicyBlockedError(
              turnExecutionPolicy.productModelId,
              turnExecutionPolicy.providerId,
              verdict.reason,
            );
          }
        }
      }
      // A recovered asynchronous video completion is model-visible only after
      // its durable File is present at the exact sandbox path carried by the
      // receipt. Resolve and verify the claimed update before sandbox policy is
      // chosen so this turn cannot remain lazy and expose an absent path.
      for (const update of await listSessionSystemUpdatesForTurn(
        db,
        input.workspaceId,
        input.sessionId,
        turn.id,
      )) {
        const payload = update.payload as MediaGenerationResult;
        if (payload.type !== "media_generation_result" || payload.status !== "ready") continue;
        const retained = await getGeneratedVideoArtifact(
          db,
          input.workspaceId,
          payload.receipt.artifact.artifactId,
        );
        if (
          !retained ||
          retained.artifact.deletedAt ||
          retained.file.status !== "ready" ||
          retained.file.contentType !== "video/mp4" ||
          retained.file.sizeBytes !== payload.receipt.artifact.originalBytes ||
          retained.file.sha256 !== payload.receipt.artifact.sha256 ||
          retained.artifact.sandboxFilename !== `generated-video-${retained.artifact.id}.mp4`
        ) {
          throw new Error("Generated video completion does not match its retained File");
        }
        requiredGeneratedVideoFiles.push({
          operationId: payload.operationId,
          artifactId: retained.artifact.id,
          fileId: retained.file.id,
          objectKey: retained.file.objectKey,
          sizeBytes: retained.file.sizeBytes,
          sha256: retained.file.sha256,
          filename: retained.artifact.sandboxFilename,
        });
      }
      // A codex-subscription turn resolves the bearer for THIS turn's effective
      // codex account (effectiveCodexCredentialId; pin > workspace-active) at
      // model-call time — multi-account P1 means a workspace can hold N accounts,
      // so the bearer is per-account, not per-workspace. codexSubscriptionFetch
      // (on the provider's OpenAI client) reads this AsyncLocalStorage context.
      // Build it once and wrap BOTH the compaction summarizer (a separate model
      // call on the same codex client) and the main run; otherwise the summarizer
      // would hit the codex backend unauthenticated.
      let codexModelRequestSequence = 0;
      let firstModelRequestPreparationStartedAt: number | null = null;
      let firstModelRequestPreparationRecorded = false;
      let firstModelRequestAuditRecorded = false;
      let firstModelRequestCheckpointAt: number | null = null;
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
                effectiveCodexCredentialId ?? "",
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
                  latestCodexUsage = snapshot;
                }, // latest wins; flushed once in finally
                onRequestPreparationDiagnostic: (phase) => {
                  if (
                    firstModelRequestCheckpointAt === null ||
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
                    durationSeconds: (now - firstModelRequestCheckpointAt) / 1_000,
                    count: turnTools.length,
                  });
                  firstModelRequestCheckpointAt = now;
                },
                onRequestOpaqueArtifacts: ({ fingerprints }) => {
                  lastCodexRequestOpaqueArtifacts = fingerprints;
                },
                onModelRequestDiagnostic: (event) => {
                  if (event.phase === "started") firstProviderRequestStarted = true;
                  if (
                    event.phase === "started" &&
                    firstModelRequestPreparationStartedAt !== null &&
                    !firstModelRequestPreparationRecorded
                  ) {
                    firstModelRequestPreparationRecorded = true;
                    recordTurnStartupPhase(observability, {
                      phase: "model_request_preparation",
                      provider: turnExecutionPolicy.providerId,
                      backend: activeSandboxBackend ?? groupBoxBackend,
                      outcome: "completed",
                      durationSeconds:
                        (performance.now() - firstModelRequestPreparationStartedAt) / 1_000,
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
                  if (!publish || !turnId) {
                    throw new Error("Codex model request started before the turn event producer");
                  }
                  const shouldRecordStartedAudit =
                    event.phase === "started" && !firstModelRequestAuditRecorded;
                  if (shouldRecordStartedAudit) {
                    firstModelRequestAuditRecorded = true;
                  }
                  const auditStartedAt = shouldRecordStartedAudit ? performance.now() : null;
                  let auditOutcome: "completed" | "failed" = "completed";
                  try {
                    await publish([
                      ...(shouldRecordStartedAudit && firstModelRequestPreparationStartedAt !== null
                        ? [
                            {
                              type: "turn.startup.phase.completed" as const,
                              payload: {
                                phase: "model_preparation",
                                durationMs: Math.max(
                                  0,
                                  Math.round(
                                    performance.now() - firstModelRequestPreparationStartedAt,
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
                          turnId,
                          attemptId: input.attemptId,
                          dispatchId,
                          executionGeneration,
                        },
                      },
                    ]);
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
        if (!effectiveXaiCredentialId || !leases.xai.subjectId) {
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
          credentialId: effectiveXaiCredentialId,
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
              firstProviderRequestStarted = true;
              modelRequestLifecycleMetricsFor(observability).start(
                requestKey,
                "supergrok-subscription",
              );
              if (
                firstModelRequestPreparationStartedAt !== null &&
                !firstModelRequestPreparationRecorded
              ) {
                firstModelRequestPreparationRecorded = true;
                recordTurnStartupPhase(observability, {
                  phase: "model_request_preparation",
                  provider: turnExecutionPolicy.providerId,
                  backend: activeSandboxBackend ?? groupBoxBackend,
                  outcome: "completed",
                  durationSeconds:
                    (performance.now() - firstModelRequestPreparationStartedAt) / 1_000,
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
            if (!publish || !turnId) {
              throw new Error("SuperGrok model request started before the turn event producer");
            }
            const shouldRecordStartedAudit =
              event.phase === "started" && !firstModelRequestAuditRecorded;
            if (shouldRecordStartedAudit) firstModelRequestAuditRecorded = true;
            const auditStartedAt = shouldRecordStartedAudit ? performance.now() : null;
            let auditOutcome: "completed" | "failed" = "completed";
            try {
              await publish([
                ...(shouldRecordStartedAudit && firstModelRequestPreparationStartedAt !== null
                  ? [
                      {
                        type: "turn.startup.phase.completed" as const,
                        payload: {
                          phase: "model_preparation",
                          durationMs: Math.max(
                            0,
                            Math.round(performance.now() - firstModelRequestPreparationStartedAt),
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
                    turnId,
                    attemptId: input.attemptId,
                    dispatchId,
                    executionGeneration,
                  },
                },
              ]);
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
        xaiRequestContext = authorization.context;
      }
      const withCodex = <T>(fn: () => Promise<T>): Promise<T> =>
        codexContext ? codexRequestStorage.run(codexContext, fn) : fn();
      const withProviderRequestContext = <T>(fn: () => Promise<T>): Promise<T> =>
        xaiRequestContext
          ? xaiSubscriptionRequestStorage.run(xaiRequestContext, fn)
          : withCodex(fn);
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
      const promptCacheKey = acceptsPromptCacheKeyForTurn(resolvedModel)
        ? input.sessionId
        : undefined;
      const compactionUsageState = createCompactionModelUsageEventState(
        claimedModelUsageSourceKeys,
      );
      const recordCompactionUsage = async (usage: ModelResponseUsage) => {
        await processCompactionModelUsageEvent({
          usage,
          state: compactionUsageState,
          dispatchId: modelUsageDispatchId,
          settings,
          db,
          observability,
          publish,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
          provider: resolvedModel?.provider.id ?? settings.openaiProvider,
          providerApi: resolvedModel?.provider.api ?? "responses",
          model: resolvedModel?.configured.id ?? turn.model,
          externallyBilled: isExternallyBilledTurn,
          turnAttemptId: input.attemptId,
          servingCredentialId: effectiveCodexCredentialId,
          priorSessionCredentialId: priorSessionCodexCredentialId,
          emittedSourceKeys: emittedModelUsageSourceKeys,
          renewLease: () => leases.renewServing("model_usage"),
          leaseLost: leases.servingLost,
          leaseLostMessage: "Provider credential lease expired during context compaction",
          contextContributions: companyBrainContextContributions,
        });
      };
      const compactionSummarizerFor = (systemInstructions?: string) =>
        resolvedModel
          ? (s: Settings, m: Array<Record<string, unknown>>) =>
              withProviderRequestContext(() =>
                summarizeContextForCompaction(s, m, {
                  client: resolvedModel.client,
                  provider: resolvedModel.provider,
                  api: resolvedModel.provider.api,
                  model: turnExecutionPolicy.upstreamModelId,
                  maxOutputTokens: SUMMARY_BUFFER_TOKENS,
                  onUsage: recordCompactionUsage,
                  ...(systemInstructions ? { systemInstructions } : {}),
                  ...(promptCacheKey ? { promptCacheKey } : {}),
                }),
              )
          : (s: Settings, m: Array<Record<string, unknown>>) =>
              summarizeContextForCompaction(s, m, {
                model: turnExecutionPolicy.upstreamModelId,
                maxOutputTokens: SUMMARY_BUFFER_TOKENS,
                onUsage: recordCompactionUsage,
                ...(systemInstructions ? { systemInstructions } : {}),
                ...(promptCacheKey ? { promptCacheKey } : {}),
              });
      // Prompt-cache prefix for remote_v2 MUST match ordinary turns:
      // tools → instructions → history. Filled after buildAgent for every
      // compact path (including operator /compact, which now builds the agent
      // first so it does not send empty tools/instructions).
      let remoteCompactionTools: Awaited<ReturnType<typeof serializedToolsForRemoteCompaction>> =
        [];
      let remoteCompactionInstructions = "";
      let remoteCompactionToolsReady = false;
      let remoteCompactionAgent: Parameters<typeof serializedToolsForRemoteCompaction>[0] | null =
        null;
      const remoteCompactionRequester =
        resolvedModel && isCodexTurn
          ? (s: Settings, m: Array<Record<string, unknown>>) =>
              withCodexRemoteCompaction(async () => {
                // Lazily serialize tools here so EmptyCompactionSummaryError is
                // thrown inside the compaction try/settlement handlers, not as a
                // raw activity failure before maybeCompactContext runs.
                if (!remoteCompactionInstructions.trim()) {
                  throw new EmptyCompactionSummaryError({
                    stage: "remote_v2_instructions",
                    reason: "agent_missing_system_instructions",
                  });
                }
                if (!remoteCompactionToolsReady) {
                  if (!remoteCompactionAgent) {
                    throw new EmptyCompactionSummaryError({
                      stage: "remote_v2_tools",
                      reason: "agent_missing_for_tools",
                    });
                  }
                  try {
                    remoteCompactionTools =
                      await serializedToolsForRemoteCompaction(remoteCompactionAgent);
                  } catch (error) {
                    // Tool schemas sit before instructions in the cache prefix.
                    // Failing open to [] would reintroduce a massive pre-compact
                    // cache bust — fail closed so we never send a tools mismatch
                    // on purpose.
                    throw new EmptyCompactionSummaryError({
                      stage: "remote_v2_tools",
                      reason: "serialize_tools_failed",
                      error: String(error),
                    });
                  }
                  remoteCompactionToolsReady = true;
                }
                return requestRemoteCompactionV2(s, m, {
                  client: resolvedModel.client,
                  provider: resolvedModel.provider,
                  model: turnExecutionPolicy.upstreamModelId,
                  systemInstructions: remoteCompactionInstructions,
                  onUsage: recordCompactionUsage,
                  tools: remoteCompactionTools,
                  ...(promptCacheKey ? { promptCacheKey } : {}),
                });
              })
          : undefined;
      const publishCompactionLiveEvents = async (events: SessionEvent[]) => {
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
      };
      const publishCompactionOutcomeEvents = async (events: SessionEvent[]) => {
        // `compaction.started` was already fanout via publishCompactionLiveEvents.
        await publishDurableSessionEvents(
          bus,
          input.workspaceId,
          input.sessionId,
          events.filter((event) => event.type !== "session.context.compaction.started"),
        );
      };
      const compactionModeOptions = {
        codexCompactionMode: session.codexCompactionMode,
        isCodexSubscriptionTurn: isCodexTurn,
        publishLiveEvents: publishCompactionLiveEvents,
        ...(remoteCompactionRequester
          ? { requestRemoteCompactionV2: remoteCompactionRequester }
          : {}),
      } as const;

      // Operator /compact:
      // - portable (incl. Codex portable): early maintenance path — no
      //   prepareTools/sandbox; summarizer only needs composed instructions.
      // - remote_v2: fall through to prepareTools/buildAgent so the compact
      //   request reuses the ordinary tools→instructions cache prefix, then
      //   settle without inference. (Requester is also wired for Codex portable
      //   turns but unused there — gate on the frozen session mode.)
      const compactionOnlyTurn = turn.source === "compaction";
      const remoteV2CompactionNeedsAgentPrefix =
        Boolean(remoteCompactionRequester) && session.codexCompactionMode === "remote_v2";
      if (compactionOnlyTurn && !remoteV2CompactionNeedsAgentPrefix) {
        const compactionInstructions = appendWorkspaceMemory(
          appendSessionInstructions(
            appendWorkspaceGovernance(
              composeAgentInstructions(
                structuredWorkspacePolicyActive
                  ? modelRunSettings.agentInstructionsTemplate
                  : (workspaceAgentInstructions ?? modelRunSettings.agentInstructionsTemplate),
                undefined,
                rigVersion && rigName ? { name: rigName, version: rigVersion.version } : undefined,
              ),
              workspaceGovernance ?? undefined,
            ),
            session.instructions ?? undefined,
          ),
          workspaceMemory ?? undefined,
        );
        const requested = await isSessionCompactionRequested(
          db,
          input.workspaceId,
          input.sessionId,
        );
        let outcome: Awaited<ReturnType<typeof maybeCompactContext>> | null = null;
        if (requested) {
          try {
            outcome = await waitForTurnOperation(
              maybeCompactContext(
                db,
                modelRunSettings,
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  executionGeneration,
                  attemptId: input.attemptId,
                },
                session.lastInputTokens,
                compactionSummarizerFor(compactionInstructions),
                {
                  force: true,
                  clearRequestedCompaction: true,
                  trigger: "operator",
                  materializeHistory: media.materializeScreenshotHistory,
                  projectModelInput: compactionModelHistoryProjector,
                  ...compactionModeOptions,
                },
              ),
              cancellationSignal,
              undefined,
            );
          } catch (error) {
            // Codex retries retryable checkpoint-provider failures rather than
            // treating them as a semantic compaction result. Keep the operator
            // request pending and let the ordinary same-turn provider/capacity
            // recovery path re-dispatch this exact maintenance execution.
            if (shouldRecoverCompactionProviderFailure(error)) throw error;
            if (error instanceof TurnAttemptFencedError) throw error;
            // `compaction.started` may already be live — settle skipped before
            // failing the turn so the timeline cannot stick on Compacting…
            const landmark = await settleFailedContextCompactionLandmark(
              db,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: turn.id,
                executionGeneration,
                attemptId: input.attemptId,
              },
              {
                clearRequestedCompaction: true,
                publishLiveEvents: publishCompactionLiveEvents,
              },
            );
            if (!isCompactionSummaryFailure(error)) throw error;
            const errorMessage = String(compactionFailureReasonFromError(error));
            if (
              !(await settle!({
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
                ...(landmark.requestConsumed ? {} : { consumeRequestedCompactionFailure: true }),
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = error;
            return claimedResult({ status: "idle" });
          }
          if (outcome.events.length > 0) {
            if (outcome.compacted) {
              recordContextCompaction(observability, "operator");
            }
            await publishCompactionOutcomeEvents(outcome.events);
          }
        }
        if (
          !(await settle!({
            events: [
              {
                type: "turn.completed",
                payload: {
                  maintenance: "context_compaction",
                  result: outcome?.compacted ? "compacted" : (outcome?.reason ?? "already_applied"),
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
        turnMetricOutcome = "completed";
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      }

      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      // Repositories remain durable workspace inputs. File attachments do not:
      // only files attached to this exact turn enter the sandbox manifest and
      // eager materialization path. Historical file ids remain in canonical
      // history/session metadata and are recoverable through the Files MCP.
      const runtimeResources = runtimeResourcesForTurn(session.resources, turn.resources);
      // Attach the first-party MCP server to EVERY turn, regardless of how/when
      // the session was created (API, scheduled task, or a pre-existing session
      // whose stored tools predate this). The server registration is then
      // narrowed by the session's exact firstPartyMcpTools selection and
      // authorization. Idempotent: mergeToolRefs dedupes if already present.
      // Resolve the durable policy at the turn boundary. Workspace-default
      // sessions follow the current configured MCP set,
      // while explicit, inherited-fixed, and legacy sessions remain narrowed
      // to their stored materialized allow-list.
      const scheduledEffectiveMcpServerIds = (() => {
        const value =
          turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
            ? (turn.metadata as Record<string, unknown>).scheduledEffectiveMcpServerIds
            : null;
        return Array.isArray(value) && value.every((id) => typeof id === "string")
          ? [...new Set(value)].sort()
          : null;
      })();
      const currentMcpServerIds = new Set(runSettings.mcpServers.map((server) => server.id));
      const resolvedToolPolicy = resolveSessionToolPolicy({
        toolPolicy: session.toolPolicy,
        sessionTools: scheduledEffectiveMcpServerIds ? turn.tools : session.tools,
        availableMcpServerIds: scheduledEffectiveMcpServerIds
          ? scheduledEffectiveMcpServerIds.filter((id) => currentMcpServerIds.has(id))
          : [...currentMcpServerIds],
        defaultMcpServerIds:
          scheduledEffectiveMcpServerIds ??
          defaultSessionMcpServerIds(capabilitySettings.mcpServers),
      });
      const mcpAvailabilityNote = unavailableMcpOperationalContext({
        droppedIds: resolvedToolPolicy.effectivePolicy.droppedIds,
        droppedCount: resolvedToolPolicy.effectivePolicy.counts.dropped,
      });
      const effectivePolicyTools = resolvedToolPolicy.toolRefs;
      const turnTools = withFirstPartyTools(runSettings, effectivePolicyTools);
      // §7.6 connection-credential provider — load (and decrypt) selected Variable Sets via the
      // host `sandboxSecrets` provider when bound; unset → today's local decrypt. Preserve the
      // legacy null-attachment fast path: turns with neither a session set nor rig defaults perform
      // no Variable Set work. Organization/workspace sets use the exact turn actor; personal sets
      // additionally require the causal human frozen into the admitted turn.
      const connectionScope = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      };
      const rigDefaultVariableSetIds = rigVersion?.defaultVariableSetIds ?? [];
      let workspaceVariableSet: Awaited<
        ReturnType<typeof loadWorkspaceEnvironmentForRunWithCredentials>
      > = null;
      const rigDefaultEnvironmentValues: Record<string, string> = {};
      if (session.variableSetId !== null || rigDefaultVariableSetIds.length > 0) {
        const variableSetAuthority = {
          sessionId: input.sessionId,
          turnId: turn.id,
          attemptId: input.attemptId,
          executionGeneration: turn.executionGeneration,
          initiator: turn.initiator,
          initiatingHumanSubjectId: fileAuthoritySubjectId,
        };
        // A scheduled attempt may materialize only the exact generation frozen
        // on its accepted occurrence; ordinary turns resolve to null.
        const expectedVariableSetGeneration = async (
          candidateVariableSetId: string,
        ): Promise<number | null> =>
          await getScheduledVariableSetExpectedGenerationForAttempt(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: fileAuthoritySubjectId ?? turn.initiator.subjectId,
            initiatingHumanSubjectId: fileAuthoritySubjectId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            executionGeneration: turn.executionGeneration,
            variableSetId: candidateVariableSetId,
          });
        workspaceVariableSet = await waitForTurnOperation(
          (async () =>
            loadWorkspaceEnvironmentForRunWithCredentials(
              db,
              runSettings,
              connectionScope,
              session.variableSetId,
              variableSetAuthority,
              connectionCredentials?.sandboxSecrets,
              session.variableSetId && connectionCredentials?.sandboxSecrets
                ? { expectedGeneration: await expectedVariableSetGeneration(session.variableSetId) }
                : {},
            ))(),
          cancellationSignal,
          undefined,
        );
        // RIG DEFAULT VARIABLE SETS (M3): decrypt the frozen rig version's default
        // variable sets and layer them BELOW the session's own set — the session's
        // values WIN on any key collision. Loaded through the SAME host-secrets
        // provider path as the session set (embedded-topology parity). Precedence
        // WITHIN the rig defaults is listed order (a later set overrides an earlier
        // one), then the session set overrides all. STABLE-ENV INVARIANT: the rig
        // VERSION is frozen per session, so the SET of default variable sets is
        // fixed for the session's life — the merged manifest env is therefore stable
        // across the session's turns (the same guarantee the session's own variable
        // set already relies on), keeping validateNoEnvironmentDelta empty.
        Object.assign(
          rigDefaultEnvironmentValues,
          await loadRigDefaultVariableSetEnvironment(
            rigDefaultVariableSetIds,
            async (rigDefaultVariableSetId) =>
              await waitForTurnOperation(
                (async () =>
                  loadWorkspaceEnvironmentForRunWithCredentials(
                    db,
                    runSettings,
                    connectionScope,
                    rigDefaultVariableSetId,
                    variableSetAuthority,
                    connectionCredentials?.sandboxSecrets,
                    connectionCredentials?.sandboxSecrets
                      ? {
                          expectedGeneration:
                            await expectedVariableSetGeneration(rigDefaultVariableSetId),
                        }
                      : {},
                  ))(),
                cancellationSignal,
                undefined,
              ),
          ),
        );
      }
      variableSetId = workspaceVariableSet?.id ?? "";
      // Session set wins collisions with the rig defaults (explicit precedence).
      const sandboxWorkspaceEnvironmentValues = mergeRigDefaultVariableSetEnvironment(
        rigDefaultEnvironmentValues,
        workspaceVariableSet?.values ?? {},
      );
      // EFFECTIVE compute backend, resolved ONCE at turn start (Case B + Stage D
      // D1-lite) and reused for EVERY downstream decision: the env mint (skip
      // inert platform git tokens for a machine turn), the establish path (no phantom Modal
      // home box for a machine-primary turn), buildAgent (skip the repository clone
      // hook so a private repo is never `git clone`d onto the user's real disk), and
      // the warm-rate (a machine accrues ZERO cloud warm-seconds). The active pointer
      // + its sandbox row are loaded ONCE here (best-effort, never throwing) and the
      // SAME values feed resolveActiveSandboxBackend (the tested gate) AND the
      // machine-primary establish branch (enrollmentId/epoch/workingDir) below — no
      // double read, no read-skew between the gate decision and the establish. With
      // routing OFF this is byte-for-byte the legacy path: no reads, undefined backend.
      const routingOn = routingEnabled(settings);
      let activeSandboxPointer = routingOn
        ? await readActiveSandbox(db, input.workspaceId, input.sessionId).catch(() => null)
        : null;
      // TURN-START RECONCILE (issue #341 invariant B / Shapes 1+2): a persisted
      // pointer whose target is STRUCTURALLY unestablishable at turn start would strand
      // EVERY op of this turn — reset it to the session HOME under the epoch fence +
      // emit a visible event, honoring a concurrent higher-epoch swap. The sandbox row
      // is loaded HERE, inside reconcile, via a NON-swallowing lookup: a null decision
      // then means the row is genuinely absent, never a suppressed transient DB error
      // (which would wrongly clear a healthy user-chosen pointer). On a lookup throw the
      // reconcile fails open — pointer untouched, record null (machinePrimary:false),
      // no event — and the establish branch below reads the returned values.
      let activeSandboxRecord: SandboxRecord | null = null;
      if (routingOn) {
        const reconciled = await reconcileActiveSandboxPointer(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
          },
          activeSandboxPointer,
          (sandboxId) =>
            getSandbox(
              db,
              fileAuthoritySubjectId
                ? {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    subjectId: fileAuthoritySubjectId,
                  }
                : input.workspaceId,
              sandboxId,
            ),
          publish
            ? async (events) => {
                await publish!(events);
              }
            : undefined,
        );
        activeSandboxPointer = reconciled.pointer;
        activeSandboxRecord = reconciled.record;
      }
      const activeSandboxBackend = await resolveActiveSandboxBackend(
        routingOn,
        async () => activeSandboxPointer,
        async () => activeSandboxRecord?.kind ?? null,
      );
      // A machine-primary turn = the effective backend is selfhosted AND we have the
      // machine's enrollment (agent id) + a non-null pointer to bind it. Anything
      // missing (should not happen — the DB enforces selfhosted⇒enrollmentId) falls
      // back to the cloud establish path (a correct, if phantom, box) rather than
      // crashing the turn.
      const machinePrimary =
        activeSandboxBackend === "selfhosted" &&
        Boolean(activeSandboxPointer?.activeSandboxId) &&
        Boolean(activeSandboxRecord?.enrollmentId);
      // `none` describes the durable home, not an explicit per-turn route. Give
      // the runtime the effective backend so it builds a SandboxAgent for the
      // attached Connected Machine without mutating the session or turn record.
      if (machinePrimary && modelRunSettings.sandboxBackend === "none") {
        modelRunSettings = {
          ...modelRunSettings,
          sandboxBackend: "selfhosted",
        };
      }
      // The backend that can actually create a sandbox for this turn. In the
      // common path this is runSettings.sandboxBackend. A selfhosted home turn
      // that is NOT machine-primary falls back to the deployment cloud backend
      // so swap-away / flag-off degrade to a real group box.
      const groupBoxBackend: Settings["sandboxBackend"] =
        runSettings.sandboxBackend === "selfhosted" && !machinePrimary
          ? settings.sandboxBackend
          : runSettings.sandboxBackend;
      startupMilestoneBackend = activeSandboxBackend ?? groupBoxBackend;
      media.sandboxFileDownloadBackend = startupMilestoneBackend;
      const groupBoxImage = rigProviderImageSourceImage(runSettings, groupBoxBackend);
      const sandboxCreationBackend: Settings["sandboxBackend"] =
        settings.sandboxOwnershipEnabled && runSettings.sandboxBackend !== "none"
          ? groupBoxBackend
          : runSettings.sandboxBackend;
      const effectiveRunCredentialBackend = activeSandboxBackend ?? groupBoxBackend;
      const runCredentialResolver =
        effectiveRunCredentialBackend === "none"
          ? null
          : await waitForTurnOperation(
              bindRunCredentialResolver({
                db,
                connectionCredentials: connectionCredentials ?? null,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                session,
                turn,
                attemptId: input.attemptId,
                effectiveSandboxBackend: effectiveRunCredentialBackend,
                variableSet: workspaceVariableSet
                  ? {
                      id: workspaceVariableSet.id,
                      name: workspaceVariableSet.name,
                    }
                  : null,
              }),
              cancellationSignal,
              undefined,
            );
      const establishDecision = sandboxEstablishPolicyDecision({
        lazyEnabled: lazyProvisionEnabled(settings),
        machinePrimary,
        sandboxBackend: runSettings.sandboxBackend,
        hasRunCredentialResolver: runCredentialResolver !== null,
        generatedVideoFileCount: requiredGeneratedVideoFiles.length,
        hasSignedFileResources:
          requiresSignedFileResourceDownloads(
            runSettings,
            activeSandboxBackend ?? groupBoxBackend,
          ) && turn.resources.some((resource) => resource.kind === "file"),
      });
      const establishPolicy = establishDecision.policy;
      recordTurnSandboxEstablishPolicy(observability, {
        policy: establishDecision.policy,
        reason: establishDecision.reason,
        backend: machinePrimary ? "selfhosted" : groupBoxBackend,
      });
      // Resolve once before model preparation so partial/auth-needed host state
      // is available as bounded model context and reconnect UI even when an
      // on-demand turn never provisions a box. Resolution alone performs no
      // sandbox write or renewal; both paths reuse this exact material and the
      // lazy path materializes it only inside its first-operation single-flight.
      const initialRunCredentialMaterial = runCredentialResolver
        ? await waitForTurnOperation(
            runCredentialResolver.resolve({
              purpose: "provision",
              forceRefresh: false,
            }),
            cancellationSignal,
            undefined,
          )
        : null;
      if (initialRunCredentialMaterial) {
        for (const payload of runCredentialAuthNeededPayloads(initialRunCredentialMaterial)) {
          publishedRunCredentialNotices.add(JSON.stringify(payload));
          await publish!([{ type: "credential.auth_needed", payload }], true);
        }
      }
      const runCredentialsNote = initialRunCredentialMaterial
        ? runCredentialModelNote(initialRunCredentialMaterial)
        : undefined;
      throwIfTurnOperationCancelled(cancellationSignal);
      await Promise.all([
        waitForTurnOperation(
          ensureTurnModalRegistryImage(runSettings, sandboxCreationBackend),
          cancellationSignal,
          undefined,
        ),
        activeSandboxBackend !== "selfhosted"
          ? assertGitHubResourcesRemainAuthorized(db, input.workspaceId, turnResources)
          : Promise.resolve(),
        assertFileResourcesRemainAuthorized(
          db,
          input.accountId,
          input.workspaceId,
          fileAuthoritySubjectId,
          turn.resources,
        ),
      ]);
      // Computed exactly ONCE per turn and reused for BOTH the box manifest
      // (resumeBoxForTurn -> establishSandboxSessionFromEnvelope, below) AND the
      // agent (runtime.buildAgent, below). sandboxEnvironmentForRun mints a FRESH
      // run-scoped git provider tokens on every call, so a second call would
      // yield DIFFERENT token values and re-introduce the manifest-env delta the
      // SDK's provided-session guard throws on — the box and the agent MUST share
      // this same object. A machine-primary turn skips the (inert) token mint entirely
      // (the machine uses its own git creds); the SAME base env still feeds the box +
      // the agent, so env-parity holds.
      // TOKEN-BROKER (B1): sandboxEnvironmentForRun now returns the STABLE manifest
      // env (no rotating GH_TOKEN/GITHUB_TOKEN/GIT_CONFIG_* extraheader) PLUS the
      // run-scoped git tokens minted ONCE per turn as provider seeds, with `gitToken`
      // retained as the GitHub alias. The env feeds BOTH the box manifest AND the
      // agent (env-parity, as before); tokens are threaded OFF-MANIFEST as
      // clone-seeds to buildAgent (below) so the box never carries rotating values
      // on its manifest. When a platform token IS minted, the host `gitCredentials`
      // provider may supply it; unset still self-mints GitHub from settings.
      // gitToken/gitTokens are undefined on the selfhosted skip path (the machine
      // uses its own git creds).
      const authorizeGitHubTokenMint: GitHubTokenMintAuthorization = async (selection) => {
        await assertGitHubTokenMintSelectionAuthorized(
          db,
          input.workspaceId,
          selection.installationId,
          selection.repositoryIds,
        );
      };
      // Git and MCP credentials share one lineage snapshot for this turn. A
      // host that supplies both ports must never see two independently resolved
      // roots for the same execution merely because the call sites are far apart.
      const needsHostCredentialRoot = Boolean(
        connectionCredentials?.gitCredentials || connectionCredentials?.mcpCredentials,
      );
      const hostCredentialRootSessionId = needsHostCredentialRoot
        ? await getSessionRootId(db, input.workspaceId, input.sessionId)
        : null;
      if (needsHostCredentialRoot && !hostCredentialRootSessionId) {
        throw new Error(`cannot resolve host credentials for missing session ${input.sessionId}`);
      }
      const gitCredentialAuthority =
        connectionCredentials?.gitCredentials && hostCredentialRootSessionId
          ? gitCredentialAuthorityForTurn({
              sessionId: input.sessionId,
              rootSessionId: hostCredentialRootSessionId,
              attemptId: input.attemptId,
              turn,
            })
          : undefined;
      const codemodeAuthority = {
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration: turn.executionGeneration,
      };
      const sandboxArtifactRuntime = sandboxArtifactRuntimeAdmission(
        settings,
        runSettings,
        activeSandboxBackend ?? groupBoxBackend,
      );
      const {
        environment: baseSandboxEnvironment,
        gitToken: sandboxGitToken,
        gitTokens: sandboxGitTokens,
        gitTokenExpiresAt: sandboxGitTokenExpiresAt,
        gitCredentialBindings: sandboxGitCredentialBindings,
        codemodeToken: sandboxCodemodeToken,
        codemodeTokenExpiresAt: sandboxCodemodeTokenExpiresAt,
      } = await waitForTurnOperation(
        sandboxEnvironmentForRun(
          runSettings,
          turnResources,
          // Rig default sets merged BELOW the session set (session wins); rig-less
          // turns pass exactly workspaceVariableSet?.values (byte-for-byte today).
          sandboxWorkspaceEnvironmentValues,
          {
            skipGitHubToken: activeSandboxBackend === "selfhosted",
            codemodeDelivery:
              activeSandboxBackend === "selfhosted" ? "transient_exec" : "managed_file",
            deferGitHubToken:
              activeSandboxBackend !== "selfhosted" && establishPolicy === "on-demand",
            scope: connectionScope,
            ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
            gitCredentials: connectionCredentials?.gitCredentials,
            authorizeGitHubTokenMint,
            codemodeAuthority,
          },
        ),
        cancellationSignal,
        undefined,
      );
      // Reserved, image-owned paths win over workspace/session variables. The
      // exact same merged object feeds both box manifest and agent declaration,
      // preserving the no-environment-delta invariant.
      const sandboxEnvironment = sandboxArtifactRuntime.available
        ? { ...baseSandboxEnvironment, ...sandboxArtifactRuntime.environment }
        : baseSandboxEnvironment;

      // One mutable in-memory bearer cell serves every Connected Machine route
      // in this attempt. SelfhostedSession snapshots it into each exact exec
      // request; it never enters the manifest, argv, filesystem, RunState, or
      // serialized session state. Managed renewal updates the same cell so a
      // later mid-turn swap sees the fresh bearer too.
      const codemodeTokenState = sandboxCodemodeToken ? { token: sandboxCodemodeToken } : undefined;
      const transientCodemodeEnvironment = codemodeTokenState
        ? (): Readonly<Record<string, string>> => ({
            OPENGENI_CODEMODE_URL: codemodeWorkspaceUrl(runSettings, input.workspaceId),
            OPENGENI_CODEMODE_TOKEN: codemodeTokenState.token,
            ...(runSettings.ogtoolPackageSpec
              ? { OPENGENI_OGTOOL_PACKAGE_SPEC: runSettings.ogtoolPackageSpec }
              : {}),
          })
        : undefined;

      const sandboxCodemodeTokenFile = sandboxCodemodeToken
        ? codemodeTokenFileFromEnvironment(sandboxEnvironment, input.sessionId)
        : undefined;

      const initialGitCredentials: MintedRunGitCredentials | undefined =
        sandboxGitCredentialBindings
          ? {
              bindings: sandboxGitCredentialBindings,
              gitTokens: sandboxGitTokens ?? {},
              expiresAt: sandboxGitTokenExpiresAt ?? {},
            }
          : undefined;
      // Lazy cloud provision mints the run-scoped git token while Modal create
      // runs. Chat-only turns never call get(), so this stays unstarted there.
      let runGitCredentialsMint: Promise<MintedRunGitCredentials | undefined> | undefined;
      const startRunGitCredentialsMint = (): Promise<MintedRunGitCredentials | undefined> => {
        if (activeSandboxBackend === "selfhosted") {
          return Promise.resolve(undefined);
        }
        runGitCredentialsMint ??= waitForTurnOperation(
          mintRunGitCredentials(runSettings, turnResources, {
            scope: connectionScope,
            ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
            gitCredentials: connectionCredentials?.gitCredentials,
            authorizeGitHubTokenMint,
          }),
          cancellationSignal,
          undefined,
        );
        return runGitCredentialsMint;
      };
      const attachGitCredentialRenewal = async (
        tokenSession: GitCredentialTokenWriterSession,
        initial: MintedRunGitCredentials | undefined,
        initialSandbox?: ResumedTurnSandbox,
      ): Promise<void> => {
        if (!initial || initial.bindings.length === 0) return;
        const previous = gitCredentialRenewals;
        gitCredentialRenewals = [];
        await Promise.all(previous.map(async (controller) => await controller.stop()));
        if (gitCredentialRenewalClosed) return;

        const controllers = initial.bindings.map((initialBinding) => {
          let pendingBinding: typeof initialBinding | undefined;
          return startGitCredentialRenewalLoop({
            expectedProviders: [initialBinding.provider],
            initialExpiresAt: initialBinding.expiresAt
              ? { [initialBinding.provider]: initialBinding.expiresAt }
              : {},
            mint: async () => {
              const binding = await mintRunGitCredentialBinding(
                runSettings,
                turnResources,
                initialBinding.provider,
                initialBinding.credentialBindingId,
                {
                  scope: connectionScope,
                  ...(gitCredentialAuthority ? { authority: gitCredentialAuthority } : {}),
                  gitCredentials: connectionCredentials?.gitCredentials,
                  authorizeGitHubTokenMint,
                },
              );
              if (binding) {
                assertGitCredentialRenewalTransportUnchanged(initialBinding, binding);
              }
              pendingBinding = binding;
              return binding
                ? {
                    bindings: [binding],
                    gitTokens: { [binding.provider]: binding.token },
                    expiresAt: binding.expiresAt ? { [binding.provider]: binding.expiresAt } : {},
                  }
                : undefined;
            },
            write: async () => {
              if (!pendingBinding) {
                throw new Error("credential renewal produced no binding token");
              }
              const runAs = sandboxRunAs(runSettings);
              const targetSandbox = resolvedSandbox ?? initialSandbox;
              if (!targetSandbox) {
                throw new Error("Git credential renewal has no exact sandbox lease target");
              }
              await runWorkspaceMutationForSandbox(
                targetSandbox,
                "gitCredentialRenewal",
                async () =>
                  await refreshGitCredentialBindingTokenFiles(tokenSession, [pendingBinding!], {
                    ...(runAs ? { runAs } : {}),
                    ...(toolCancellationFenceRef.current
                      ? {
                          commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                            toolCancellationFenceRef.current,
                          ),
                        }
                      : {}),
                  }),
              );
            },
            onSuccess: ({ providers: renewedProviders }) => {
              for (const provider of renewedProviders) {
                observability.incrementCounter({
                  name: "opengeni_git_credential_renewals_total",
                  help: "Host-managed Git credential renewal attempts by provider and outcome.",
                  labels: { provider, outcome: "completed" },
                });
              }
            },
            onFailure: ({ providers: failedProviders, retryDelayMs, errorClass }) => {
              for (const provider of failedProviders) {
                observability.incrementCounter({
                  name: "opengeni_git_credential_renewals_total",
                  help: "Host-managed Git credential renewal attempts by provider and outcome.",
                  labels: { provider, outcome: "error" },
                });
              }
              observability.warn("Sandbox Git credential renewal failed; retry scheduled", {
                sessionId: input.sessionId,
                turnId,
                providers: failedProviders.join(","),
                errorClass,
                retryDelayMs,
              });
            },
          });
        });
        if (gitCredentialRenewalClosed) {
          await Promise.all(controllers.map(async (controller) => await controller.stop()));
          return;
        }
        gitCredentialRenewals = controllers;
      };

      const attachCodemodeTokenRenewal = async (
        tokenSession?: CodemodeTokenWriterSession,
        initialExpiresAt = sandboxCodemodeTokenExpiresAt,
        initialSandbox?: ResumedTurnSandbox,
      ): Promise<void> => {
        if (!codemodeTokenState || !initialExpiresAt) return;
        const previous = codemodeTokenRenewal;
        codemodeTokenRenewal = null;
        await previous?.stop();
        if (codemodeTokenRenewalClosed) return;

        const mint = async () => {
          const material = await mintSandboxCodemodeToken(
            runSettings,
            connectionScope,
            codemodeAuthority,
          );
          return material;
        };
        const write = async (material: NonNullable<Awaited<ReturnType<typeof mint>>>) => {
          if (tokenSession) {
            const runAs = sandboxRunAs(runSettings);
            const targetSandbox = resolvedSandbox ?? initialSandbox;
            if (!targetSandbox) {
              throw new Error("Codemode token renewal has no exact sandbox lease target");
            }
            await runWorkspaceMutationForSandbox(
              targetSandbox,
              "codemodeTokenRenewal",
              async () =>
                await refreshCodemodeTokenFile(tokenSession, material.token, {
                  ...(runAs ? { runAs } : {}),
                  ...(sandboxCodemodeTokenFile
                    ? {
                        tokenFile: sandboxCodemodeTokenFile,
                        legacyTokenFile: sandboxEnvironment.OPENGENI_CODEMODE_TOKEN_FILE!,
                      }
                    : {}),
                  ...(toolCancellationFenceRef.current
                    ? {
                        commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                          toolCancellationFenceRef.current,
                        ),
                      }
                    : {}),
                }),
            );
          }
          codemodeTokenState.token = material.token;
        };
        let renewalExpiresAt = initialExpiresAt;
        if (renewalExpiresAt.getTime() <= Date.now() + CODEMODE_TOKEN_EXPIRY_LEAD_MS) {
          const fresh = await mint();
          if (!fresh) {
            throw new Error("Codemode token mint became unavailable during sandbox setup");
          }
          await write(fresh);
          renewalExpiresAt = fresh.expiresAt;
        }
        const controller = startCodemodeTokenRenewalLoop({
          initialExpiresAt: renewalExpiresAt,
          mint,
          write,
          onSuccess: () => {
            observability.incrementCounter({
              name: "opengeni_codemode_token_renewals_total",
              help: "Sandbox Codemode token renewal attempts by outcome.",
              labels: { outcome: "completed" },
            });
          },
          onFailure: ({ retryDelayMs, errorClass }) => {
            observability.incrementCounter({
              name: "opengeni_codemode_token_renewals_total",
              help: "Sandbox Codemode token renewal attempts by outcome.",
              labels: { outcome: "error" },
            });
            observability.warn("Sandbox Codemode token renewal failed; retry scheduled", {
              sessionId: input.sessionId,
              turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (codemodeTokenRenewalClosed) {
          await controller.stop();
          return;
        }
        codemodeTokenRenewal = controller;
      };

      // A Connected Machine needs renewal, but renewal is purely worker-local:
      // starting this loop performs no control-plane or machine operation.
      if (activeSandboxBackend === "selfhosted") {
        await attachCodemodeTokenRenewal();
      }

      const attachRunCredentialRenewal = async (
        credentialSession: RunCredentialCommandSession,
        initialMaterial: NormalizedRunCredentialMaterial | null,
        initialSandbox?: ResumedTurnSandbox,
      ): Promise<void> => {
        if (!runCredentialResolver) return;
        const previous = runCredentialRenewal;
        runCredentialRenewal = null;
        await previous?.stop();
        if (runCredentialRenewalClosed) return;
        runCredentialSession = credentialSession;

        const requireTargetSandbox = (): ResumedTurnSandbox => {
          const targetSandbox = resolvedSandbox ?? initialSandbox;
          if (!targetSandbox) {
            throw new Error("Run credential mutation has no exact sandbox lease target");
          }
          return targetSandbox;
        };

        if (!initialMaterial) {
          await runWorkspaceMutationForSandbox(
            requireTargetSandbox(),
            "runCredentialClear",
            async () =>
              await clearRunCredentials(
                credentialSession,
                input.sessionId,
                toolCancellationFenceRef.current
                  ? toolCancellationFenceRef.current.runSandboxCommand.bind(
                      toolCancellationFenceRef.current,
                    )
                  : undefined,
              ),
          );
          return;
        }

        const write = async (
          material: NormalizedRunCredentialMaterial | null,
          pruneOtherAttempts = false,
        ): Promise<void> => {
          if (!material) {
            await runWorkspaceMutationForSandbox(
              requireTargetSandbox(),
              "runCredentialAttemptClear",
              async () =>
                await clearRunCredentialsForAttempt(credentialSession, {
                  sessionId: input.sessionId,
                  attemptId: input.attemptId,
                  executionGeneration,
                }),
            );
            return;
          }

          await runWorkspaceMutationForSandbox(
            requireTargetSandbox(),
            "runCredentialMaterialization",
            async () =>
              await materializeRunCredentials(credentialSession, material, {
                sessionId: input.sessionId,
                attemptId: input.attemptId,
                executionGeneration,
                ...(pruneOtherAttempts ? { pruneOtherAttempts: true } : {}),
                ...(!pruneOtherAttempts ? { pruneSupersededGenerations: true } : {}),
                ...(material.authNeeded.length > 0 &&
                Object.keys(material.environment).length === 0 &&
                material.files.length === 0
                  ? { prunePreviousGenerations: true }
                  : {}),
                ...(toolCancellationFenceRef.current
                  ? {
                      commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                        toolCancellationFenceRef.current,
                      ),
                    }
                  : {}),
              }),
          );
          for (const payload of runCredentialAuthNeededPayloads(material)) {
            const key = JSON.stringify(payload);
            if (publishedRunCredentialNotices.has(key)) continue;
            publishedRunCredentialNotices.add(key);
            await publish!([{ type: "credential.auth_needed", payload }], true);
          }
        };

        const initialExpiryMs = initialMaterial.expiresAt?.getTime() ?? null;
        const seed =
          initialExpiryMs !== null && initialExpiryMs <= Date.now() + RUN_CREDENTIAL_EXPIRY_LEAD_MS
            ? await runCredentialResolver.resolve({
                purpose: "provision",
                forceRefresh: true,
              })
            : initialMaterial;
        await write(seed, true);
        if (runCredentialRenewalClosed) return;
        const controller = startRunCredentialRenewalLoop({
          initialExpiresAt: seed?.expiresAt ?? null,
          resolve: async () =>
            await runCredentialResolver.resolve({
              purpose: "renewal",
              forceRefresh: true,
            }),
          write: async (material) => await write(material),
          onSuccess: ({ authNeeded }) => {
            observability.incrementCounter({
              name: "opengeni_run_credential_renewals_total",
              help: "Host-managed run credential renewal attempts by outcome.",
              labels: { outcome: authNeeded ? "auth_needed" : "completed" },
            });
          },
          onFailure: ({ retryDelayMs, errorClass }) => {
            observability.incrementCounter({
              name: "opengeni_run_credential_renewals_total",
              help: "Host-managed run credential renewal attempts by outcome.",
              labels: { outcome: "error" },
            });
            observability.warn("Host run credential renewal failed; retry scheduled", {
              sessionId: input.sessionId,
              turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (runCredentialRenewalClosed) {
          await controller.stop();
          return;
        }
        runCredentialRenewal = controller;
      };

      // P1.2 ownership inversion (gated, default OFF). With the flag off this
      // block is skipped entirely: resolvedSandbox stays null and runStream
      // takes the legacy per-run build-and-discard path — byte-for-byte today.
      // With it on, acquire the group lease (holder = the durable attempt id),
      // resume the one box by id, and inject it NON-OWNED into the run. The box
      // backend is "none" -> never resolve (no box to touch).
      //
      // Established AFTER sandboxEnvironment is computed (not before) so the box's
      // manifest is created with the SAME variableSet the agent declares — the SDK
      // applies the agent's manifest to this provided session and throws on ANY
      // variableSet delta (validateNoEnvironmentDelta). Passing sandboxEnvironment
      // here makes current==target so the delta is empty.
      recordTurnStartupPhase(observability, {
        phase: "runtime_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - runtimePreparationStartedAt) / 1_000,
      });
      if (
        shouldEstablishSandboxForTurn(
          settings.sandboxOwnershipEnabled,
          turn.sandboxBackend,
          machinePrimary,
        )
      ) {
        const sandboxEstablishStartedAt = performance.now();
        let sandboxEstablishOutcome: "completed" | "failed" = "completed";
        try {
          const managedOwnership = managedSandboxOwnershipForTurn(
            machinePrimary,
            input.attemptId,
            session.sandboxGroupId,
          );
          sandboxHolderId = managedOwnership?.holderId ?? null;
          sandboxGroupId = managedOwnership?.sandboxGroupId ?? null;
          // STAGE D honest-label guard: a machine-home session carries
          // turn.sandboxBackend "selfhosted", but a turn is only machine-PRIMARY
          // when a live machine pointer resolves (activeSandboxBackend==='selfhosted'
          // + enrollmentId). When it is NOT primary — the agent swapped back to the
          // group box (sandbox_swap 'session'/'default'/groupId clears the pointer) or
          // selfhosted routing is flag-OFF (the pointer is ignored) — the else-branch
          // must resume a REAL cloud group box, not a "selfhosted" one: the registry
          // SelfhostedSandboxClient has no bound agentId and throws. Fall the group-box
          // backend back to the deployment default cloud backend so swap-away / flag-off
          // degrade to a genuine cloud box exactly like today (home=modal did).
          if (machinePrimary) {
            if (activeSandboxRecord!.scope === "user") {
              if (!fileAuthoritySubjectId) {
                throw new Error("personal machine use requires an initiating human subject");
              }
              const authorized = await assertPersonalMachineForAttempt(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                subjectId: fileAuthoritySubjectId,
                sessionId: input.sessionId,
                turnId: turn.id,
                attemptId: input.attemptId,
                executionGeneration: turn.executionGeneration,
                enrollmentId: activeSandboxRecord!.enrollmentId!,
              });
              if (!authorized) {
                throw new Error("personal Connected Machine use was not admitted for this turn");
              }
            }
            // STAGE D D1-lite: the active sandbox is a connected machine, so DO NOT
            // establish OR lease the managed home box. The active-sandbox pointer is
            // the machine route's own epoch fence; the managed-home lease separately
            // owns cloud recovery, snapshots, billing, and reaping. Mixing those two
            // ownership domains lets an unrelated degraded cloud archive block a
            // healthy explicitly selected machine.
            // Whether the machine's latest Hello advertised the op-stream engine
            // (refreshed on every connect). Read only when the server flag is on —
            // one indexed lookup, and the flag off keeps this path byte-identical.
            const machineEnrollment = await getLiveEnrollmentConnection(
              db,
              activeSandboxRecord!.workspaceId,
              activeSandboxRecord!.enrollmentId!,
            );
            const machineOpStream =
              settings.agentOpStreamEnabled === true && machineEnrollment?.opStream === true;
            const established = await establishSelfhostedTurnSession(
              {
                db,
                settings,
                bus,
                onOp: machineOpObserver.observer,
                onSandboxOperation: sandboxOperationObserver,
                opJournal,
              },
              {
                workspaceId: input.workspaceId,
                controlWorkspaceId: activeSandboxRecord!.workspaceId,
                agentId: activeSandboxRecord!.enrollmentId!,
                // An offline machine must not fail turn admission. Bind an
                // intentionally unserved token so the model receives the normal
                // typed agent_offline tool result; a later turn resolves a fresh
                // claimed process instance.
                connectionInstanceId: machineEnrollment?.connectionInstanceId ?? "unavailable",
                opStream: machineOpStream,
                operationResourcePolicy: machineEnrollment?.operationPolicy ?? {
                  memoryMaxBytes: null,
                  memoryHighBytes: null,
                  cpuMaxMillicores: null,
                  revision: 0,
                  updatedAt: null,
                },
                operationResourcePolicySupported:
                  machineEnrollment?.agentCapabilities.operationResourcePolicy === true,
                operationCpuQuotaSupported:
                  machineEnrollment?.agentCapabilities.operationCpuQuota === true,
                ...(activeSandboxRecord!.scope === "user" && fileAuthoritySubjectId
                  ? {
                      personalMachineAttempt: {
                        accountId: input.accountId,
                        subjectId: fileAuthoritySubjectId,
                        sessionId: input.sessionId,
                        turnId: turn.id,
                        attemptId: input.attemptId,
                        executionGeneration,
                      },
                    }
                  : {}),
                epoch: activeSandboxPointer!.activeEpoch,
                environment: sandboxEnvironment,
                ...(transientCodemodeEnvironment
                  ? { transientExecEnvironment: transientCodemodeEnvironment }
                  : {}),
                workingDir: activeSandboxPointer!.workingDir,
              },
            );
            // The machine-primary establish narrows `session` to SelfhostedSession
            // (buildSelfhostedBackendSession); EstablishedSandboxSession widens it.
            machinePrimarySession =
              established.session as import("@opengeni/runtime").SelfhostedSession;
            setupBoxSession = established.session;
            resolvedSandbox = {
              // Wrap in the SAME routing proxy so a mid-turn swap (to another machine
              // or back to the group box) still re-routes per op. PIN this established
              // SelfhostedSession for the machine pointer so the turn-start manifest
              // write (via the proxy's `state` getter) and the per-op reads hit ONE
              // instance — no two-instance manifest divergence.
              established: wrapTurnBoxWithRouting(
                {
                  db,
                  settings,
                  bus,
                  opJournal,
                  onOp: machineOpObserver.observer,
                  onSandboxOperation: sandboxOperationObserver,
                  onHomeSandboxRebound,
                  ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
                },
                {
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  resourceAccountId: input.accountId,
                  ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
                  ...(fileAuthoritySubjectId
                    ? {
                        personalMachineAttempt: {
                          accountId: input.accountId,
                          subjectId: fileAuthoritySubjectId,
                          turnId: turn.id,
                          attemptId: input.attemptId,
                          executionGeneration,
                        },
                      }
                    : {}),
                  environment: sandboxEnvironment,
                  ...(transientCodemodeEnvironment
                    ? { transientExecEnvironment: transientCodemodeEnvironment }
                    : {}),
                  workspaceMutationFence: {
                    accountId: input.accountId,
                    turnId: turn.id,
                    executionGeneration,
                    attemptId: input.attemptId,
                  },
                  pinnedSelfhosted: {
                    sandboxId: activeSandboxPointer!.activeSandboxId!,
                    epoch: activeSandboxPointer!.activeEpoch,
                  },
                  // HOME semantics for a mid-turn clear-to-null: only a genuine
                  // machine-HOME session (its home IS this machine, session.sandboxBackend
                  // === "selfhosted") resolves null back to the pinned machine. A Modal-HOME
                  // session merely PINNED to a machine this turn never established its group
                  // box, so defaultIsHome:false makes a clear-to-null fail typed
                  // (`home_unavailable_this_turn`) rather than silently serving the machine;
                  // the detach takes effect next turn. (Lazy home-box establishment on such a
                  // clear is a deferred follow-up; issue #341.)
                  defaultIsHome: session.sandboxBackend === "selfhosted",
                },
                established,
              ),
              // For a machine route this is the active-pointer epoch, not a cloud
              // lease epoch. Cloud-only heartbeat/snapshot/capture paths require
              // sandboxGroupId and remain disabled for this branch.
              leaseEpoch: activeSandboxPointer!.activeEpoch,
              release: async () => undefined,
            };
          } else if (establishPolicy === "on-demand") {
            // Lazy sandbox provisioning: holder/group ids are fixed at turn start,
            // but the lease acquire + box establish + setup move behind the routing
            // proxy's first default-pointer op. A chat-only turn never calls it, so
            // no lease row, no provider box, no warm-meter interval.
            //
            // A repository still forces that first default-pointer op before HTTP
            // (workspace-skill catalog in Agent.instructions). Start create now and
            // join it at get(); do not await here or we serialize Modal before tools.
            if (sandboxHolderId && sandboxGroupId) {
              const lazyHolderId = sandboxHolderId;
              const lazyGroupId = sandboxGroupId;
              resumeManagedGroupBox = () =>
                resumeBoxForTurn(
                  {
                    db,
                    settings: runSettings,
                    logicalFallbackSettings: logicalSandboxSettings,
                    cancellationSignal: sandboxResumeSignal,
                    sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                    onSandboxLost: publishSandboxLost,
                  },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sandboxGroupId: lazyGroupId,
                    sessionId: input.sessionId,
                    backend: groupBoxBackend,
                    os: session.sandboxOs,
                    environment: sandboxEnvironment,
                    ...(groupBoxImage
                      ? {
                          image: groupBoxImage,
                        }
                      : {}),
                    // The lazy acquire must enforce the same frozen rig authority
                    // as the eager acquire; otherwise a warm box for another rig
                    // can bypass the shared-state conflict/rotation fence.
                    ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
                  },
                  "turn",
                  lazyHolderId,
                );
              if (
                shouldPrefetchManagedSandbox({
                  establishPolicy,
                  machinePrimary,
                  groupBoxBackend,
                  hasRepositoryResources: turnResources.some(
                    (resource) => resource.kind === "repository",
                  ),
                })
              ) {
                startRunGitCredentialsMint();
                const started = waitForTurnOperation(
                  resumeManagedGroupBox(),
                  sandboxResumeSignal,
                  releaseLateSandbox,
                );
                const joined = started.catch((error) => {
                  if (isLazySandboxProvisionRetryable(error)) {
                    prefetchedManagedBox = null;
                  }
                  throw error;
                });
                prefetchedManagedBox = joined;
                void joined.then(
                  (box) => {
                    if (sandboxResumeSignal.aborted) return;
                    startLeaseHeartbeat(box, activeSandboxBackend ?? groupBoxBackend);
                  },
                  () => undefined,
                );
              }
            }
          } else {
            await publish!(
              [
                {
                  type: "sandbox.operation.started",
                  payload: { name: "sandbox.provision" },
                },
              ],
              true,
            );
            try {
              resolvedSandbox = await waitForTurnOperation(
                resumeBoxForTurn(
                  {
                    db,
                    settings: runSettings,
                    logicalFallbackSettings: logicalSandboxSettings,
                    cancellationSignal: sandboxResumeSignal,
                    sandboxMetrics: runtimeMetricsHooksForObservability(observability),
                    onSandboxLost: publishSandboxLost,
                  },
                  {
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    sandboxGroupId: session.sandboxGroupId,
                    sessionId: input.sessionId,
                    // groupBoxBackend, not turn.sandboxBackend: a machine-home turn that
                    // is not machine-primary resumes a real cloud group box (the
                    // deployment default), never a "selfhosted" box (which would throw
                    // for lack of a bound agentId).
                    backend: groupBoxBackend,
                    os: session.sandboxOs,
                    environment: sandboxEnvironment,
                    // IMAGE IS SHARED STATE (B3): the container image
                    // this run resolves. The lease stamps it + conflicts on a live shared box
                    // running a DIFFERENT image (solo → durable rotation; N-holders →
                    // SandboxImageConflictError surfaced as an actionable turn error). Select
                    // the image for the actual group-box backend; a configured Modal image must
                    // never override a Docker run. The selfhosted branch
                    // (establishSelfhostedTurnSession) NEVER passes
                    // an image — B3 lives only on this managed-box branch.
                    ...(groupBoxImage
                      ? {
                          image: groupBoxImage,
                        }
                      : {}),
                    // RIG IS SHARED STATE (M3): stamp the frozen rig version so the lease
                    // conflicts on a live shared box set up under a different rig (solo
                    // durable rotation / N-holders SandboxRigConflictError). Omitted for a
                    // rig-less turn -> never stamped or enforced (shares exactly as today).
                    ...(rigVersion ? { rigVersionId: rigVersion.id } : {}),
                  },
                  "turn",
                  managedOwnership!.holderId,
                ),
                sandboxResumeSignal,
                releaseLateSandbox,
              );
            } catch (error) {
              await publish!(
                [
                  {
                    type: "sandbox.operation.failed",
                    payload: {
                      name: "sandbox.provision",
                      error: error instanceof Error ? error.message : String(error),
                    },
                  },
                ],
                true,
              );
              throw error;
            }
            setupBoxSession = resolvedSandbox.established.session;
            // Durable box-lifecycle events (sandbox-file-persistence observability):
            // record every box transition in session_events so the NEXT box loss is
            // attributable from the DB alone — worker logs rotate within hours, which
            // left both 2026-07-06 incidents without a durable trace. Best-effort.
            await publishSandboxLifecycleEvents(resolvedSandbox);
            await publish!(
              [
                {
                  type: "sandbox.operation.completed",
                  payload: {
                    name: "sandbox.provision",
                    ...(resolvedSandbox.established.origin
                      ? { origin: resolvedSandbox.established.origin }
                      : {}),
                  },
                },
              ],
              true,
            );
            // M7 hot-swap: when the selfhosted feature is on, wrap the established
            // group box in the STABLE routing proxy before it is injected NON-OWNED
            // into the run. The SDK binds to this ONE object once and calls its
            // methods per tool call; the proxy re-reads (active_sandbox_id,
            // active_epoch) per op and dispatches to the currently-active backend, so
            // a sandbox_swap mid-turn lands the NEXT tool call on the new box. With
            // the flag off the established group box is injected unchanged (today's
            // path). The lease still owns the group box lifecycle — the proxy is a
            // routing veneer, not an owner.
            resolvedSandbox = {
              ...resolvedSandbox,
              established: wrapTurnBoxWithRouting(
                {
                  db,
                  settings,
                  bus,
                  opJournal,
                  onSandboxOperation: sandboxOperationObserver,
                  onHomeSandboxLost: publishSandboxLost,
                  onHomeSandboxRebound,
                  ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
                },
                // Thread the SAME declared environment the group box was created with
                // (resumeBoxForTurn, above) so a selfhosted swap target's manifest
                // carries it too — the SDK's per-turn manifest-env delta stays empty
                // (no "cannot change manifest environment variables" throw).
                {
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  resourceAccountId: input.accountId,
                  ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
                  ...(fileAuthoritySubjectId
                    ? {
                        personalMachineAttempt: {
                          accountId: input.accountId,
                          subjectId: fileAuthoritySubjectId,
                          turnId: turn.id,
                          attemptId: input.attemptId,
                          executionGeneration,
                        },
                      }
                    : {}),
                  environment: sandboxEnvironment,
                  ...(transientCodemodeEnvironment
                    ? { transientExecEnvironment: transientCodemodeEnvironment }
                    : {}),
                  workspaceMutationFence: {
                    accountId: input.accountId,
                    turnId: turn.id,
                    executionGeneration,
                    attemptId: input.attemptId,
                  },
                  homeLease: {
                    accountId: input.accountId,
                    sandboxGroupId: session.sandboxGroupId,
                    leaseEpoch: resolvedSandbox.leaseEpoch,
                    instanceId: resolvedSandbox.established.instanceId,
                    backend: groupBoxBackend,
                  },
                },
                resolvedSandbox.established,
              ),
            };
          }
          if (resolvedSandbox) {
            startLeaseHeartbeat(resolvedSandbox, activeSandboxBackend ?? groupBoxBackend);
          }
        } catch (error) {
          sandboxEstablishOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "sandbox_establish",
            provider: turnExecutionPolicy.providerId,
            backend: machinePrimary ? "selfhosted" : groupBoxBackend,
            outcome: sandboxEstablishOutcome,
            durationSeconds: (performance.now() - sandboxEstablishStartedAt) / 1_000,
          });
        }
      }

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
          modelRunSettings,
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
      const toolContextPreparationStartedAt = performance.now();
      throwIfWorkerShuttingDown();
      throwIfTurnCancelled();
      const mcpCredentialRootSessionId =
        connectionCredentials?.mcpCredentials && hostCredentialRootSessionId
          ? hostCredentialRootSessionId
          : input.sessionId;
      // Connection credentials and the optional Apps credential are resolved
      // independently. Inference auth is never an Apps fallback.
      const rawResolveCredential = connectionTokenResolverForTurn({
        db,
        settings: runSettings,
        connectionCredentials: connectionCredentials ?? null,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        rootSessionId: mcpCredentialRootSessionId,
        attemptId: input.attemptId,
        turn,
        observability,
      });
      const personalConnectionDelegations = turn.personalConnectionDelegations;
      const delegatedMembershipChecks = new Map<string, Promise<boolean>>();
      const delegatedOwnerHasMembership = async (subjectId: string): Promise<boolean> => {
        const existing = delegatedMembershipChecks.get(subjectId);
        if (existing) return await existing;
        const check = getWorkspaceGrant(db, subjectId, input.workspaceId).then(Boolean);
        delegatedMembershipChecks.set(subjectId, check);
        return await check;
      };
      const resolveFrozenCredential = withFrozenPersonalConnectionDelegations({
        resolveCredential: rawResolveCredential,
        settings: runSettings,
        personalConnectionDelegations,
        ownerHasWorkspaceMembership: delegatedOwnerHasMembership,
      });
      const resolveCredential: typeof rawResolveCredential = async (request) => {
        const result = await resolveFrozenCredential(request);
        if (result.status === "ok") {
        }
        return result;
      };
      const connectorActionIdentity = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: turn.id,
        attemptId: input.attemptId,
        executionGeneration,
        initiator: {
          kind: turn.initiator.kind,
          subjectId: turn.initiator.subjectId,
        },
      } as const;
      const googleDrivePublicationTarget = objectStorage
        ? await resolveGoogleDrivePublicationTarget(
            db,
            input.workspaceId,
            personalConnectionDelegations,
          )
        : null;
      const googleDrivePublicationTool =
        objectStorage && googleDrivePublicationTarget
          ? createGoogleDrivePublicationAttemptTool({
              db,
              objectStorage,
              identity: connectorActionIdentity,
              subjectId: googleDrivePublicationTarget.ownerSubjectId,
              target: googleDrivePublicationTarget,
              resolveCredential,
              ...(runtimeCancellationSignal ? { signal: runtimeCancellationSignal } : {}),
            })
          : null;
      const publishToolAuthNeeded = async (payload: ToolAuthNeededPayload): Promise<void> => {
        if (!shouldPublishToolAuthNeededForTurn(payload, trigger, turn)) {
          return;
        }
        await publish!([{ type: "tool.auth_needed", payload }], true);
      };
      const selectedApiIntegrationServerIds = new Set(turnTools.map((tool) => tool.id));
      const localMcpServers = buildApiIntegrationServersForTurn({
        settings: runSettings,
        integrations: installedApiIntegrations.filter((integration) =>
          selectedApiIntegrationServerIds.has(integration.serverId),
        ),
        authority: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          rootSessionId: session.rootSessionId,
          turnId: turn.id,
          attemptId: input.attemptId,
          ...(credentialSubjectId ? { initiatingSubjectId: credentialSubjectId } : {}),
        },
        resolveCredential,
        onAuthNeeded: publishToolAuthNeeded,
      });
      const codexAppsAuth = codexAppsCredentialId
        ? (() => {
            const resolver = buildCodexTokenResolver(
              db,
              runSettings,
              input.workspaceId,
              codexAppsCredentialId,
            );
            return {
              clientVersion: CODEX_CLIENT_VERSION,
              withAuthorization: async <T>(
                use: (token: {
                  accessToken: string;
                  chatgptAccountId: string | null;
                }) => Promise<T>,
              ): Promise<T> => {
                const snapshot = await resolver.getToken();

                return await withCodexAppsRequestAuthorization(
                  db,
                  {
                    workspaceId: input.workspaceId,
                    credentialId: codexAppsCredentialId,
                  },
                  async () => await use(snapshot),
                );
              },
            };
          })()
        : undefined;
      const selectedFirstPartyMcpTools = allowedFirstPartyMcpToolsForSession(
        runSettings,
        session.firstPartyMcpTools,
      );
      const googleDrivePublicationAllowed =
        selectedFirstPartyMcpTools.includes("editable_artifact_export") &&
        selectedFirstPartyMcpTools.includes("editable_artifact_export_status") &&
        (!session.firstPartyMcpPermissions?.length ||
          (session.firstPartyMcpPermissions.includes("artifacts:read") &&
            session.firstPartyMcpPermissions.includes("artifacts:publish")));
      const googleDriveConnectorBindings: readonly AttemptConnectorActionBinding[] =
        googleDrivePublicationTool && googleDrivePublicationTarget && googleDrivePublicationAllowed
          ? [
              {
                modelName: googleDrivePublicationTool.modelName,
                call: (approvalId, arguments_) =>
                  googleDrivePublicationConnectorCall(
                    googleDrivePublicationTarget,
                    arguments_,
                    approvalId,
                  ),
              },
            ]
          : [];
      const attemptToolDefinitions = [
        ...createFirstPartyInteractionAttemptToolDefinitions({
          settings: runSettings,
          scope: {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
            executionGeneration,
          },
          ...(session.firstPartyMcpPermissions?.length
            ? { permissions: session.firstPartyMcpPermissions }
            : {}),
          selectedTools: selectedFirstPartyMcpTools,
          subjectId: "worker:first-party-mcp",
          subjectLabel: "OpenGeni worker",
          ...(interactionInterventionResume
            ? { interventionResume: interactionInterventionResume }
            : {}),
        }),
        ...(googleDrivePublicationTool && googleDrivePublicationAllowed
          ? [googleDrivePublicationTool]
          : []),
      ];
      recordTurnStartupPhase(observability, {
        phase: "tool_context_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - toolContextPreparationStartedAt) / 1_000,
        count: turnTools.length,
      });
      await publish!([
        {
          type: "turn.startup.phase.started",
          payload: { phase: "tools" },
        },
      ]);
      const toolPreparationStartedAt = performance.now();
      let toolPreparationOutcome: "completed" | "failed" = "completed";
      const progressiveDisclosureEnabled =
        lazyToolTransport === "codex_native"
          ? runSettings.codexToolSearchEnabled
          : runSettings.lazyToolSearchEnabled;
      const deferNonEagerToolPreparation = shouldDeferNonEagerToolPreparation({
        lazyToolTransport,
        progressiveDisclosureEnabled,
        artifactRuntimeAvailable: sandboxArtifactRuntime.available,
        triggerKind: input.trigger.kind,
        triggerType,
      });
      const materializeConnectorAttachments = async (
        request: ConnectorAttachmentMaterializationRequest,
      ) => {
        throwIfWorkerShuttingDown();
        throwIfTurnCancelled();
        let sandbox = resolvedSandbox;
        if (!sandbox && turnSandboxProvisioner) {
          sandbox = await turnSandboxProvisioner.get();
        }
        const sessionForImport = (lazyOwnedSandbox?.session ??
          sandbox?.established.session ??
          media.sdkOwnedSandboxSession) as ChannelASession | null;
        if (!sessionForImport) {
          throw new Error("Connector attachment sandbox is unavailable");
        }
        const runAs = sandboxRunAs(runSettings);
        const channel = new SandboxChannelAService({
          session: sessionForImport,
          workspaceRoot: "/workspace",
          leaseEpoch: sandbox?.leaseEpoch ?? 0,
          emit: async (events) => {
            await publish?.(events, true);
          },
          ...(runAs ? { runAs } : {}),
        });
        return await materializeConnectorAttachmentsInChannel(channel, request, {
          runMutation: async (mutation) => {
            if (sandbox && !routingOn) {
              return await runWorkspaceMutationForSandbox(
                sandbox,
                "connectorAttachmentMaterialization",
                mutation,
              );
            }
            return await mutation();
          },
        });
      };
      try {
        preparedTools = await waitForTurnOperation(
          runtime.prepareTools(runSettings, turnTools, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            // Sign the calling turn into the first-party token so tools classify
            // the caller by its own identity (sacred-pause guard), not the racy
            // live active pointer.
            ...(turnId ? { turnId } : {}),
            attemptId: input.attemptId,
            executionGeneration,
            subjectId: "worker:first-party-mcp",
            subjectLabel: "OpenGeni worker",
            ...(credentialSubjectId ? { credentialSubjectId } : {}),
            ...(codexAppsAuth ? { codexAppsAuth } : {}),
            resolveCredential,
            onAuthNeeded: publishToolAuthNeeded,
            materializeConnectorAttachments,
            spillOversizedModelToolResult: async ({ operationId, result }) =>
              await toolResultSpill.spill({ operationId, result }),
            localMcpServers,
            ...(deferNonEagerToolPreparation ? { deferNonEagerUntilToolDemand: true } : {}),
            onPreparationPhase: (measurement) => {
              recordTurnStartupPhase(observability, {
                phase: `tool_${measurement.phase}`,
                provider: turnExecutionPolicy.providerId,
                backend: activeSandboxBackend ?? groupBoxBackend,
                outcome: measurement.outcome,
                durationSeconds: measurement.durationSeconds,
                count: turnTools.length,
              });
            },
            onAttemptToolCatalog: async (catalog) => {
              await persistAttemptToolCatalog(db, catalog);
            },
            // Manager-style sessions carry a creation-validated permission set
            // for their first-party MCP token; null keeps the fixed default.
            ...(session.firstPartyMcpPermissions?.length
              ? { firstPartyPermissions: session.firstPartyMcpPermissions }
              : {}),
            firstPartyTools: selectedFirstPartyMcpTools,
            nestedAgentDepth: session.nestedAgentDepth,
            effectiveMaxNestedAgentDepth: session.effectiveMaxNestedAgentDepth,
            attemptToolDefinitions,
            ...(googleDrivePublicationTarget && googleDrivePublicationAllowed
              ? {
                  attemptToolAuthorize: async ({ call }) => {
                    if (
                      call.caller.kind !== "codemode" ||
                      call.identity.serverId !== "google-drive-publishing" ||
                      call.identity.toolName !== "google_drive_publish_file"
                    ) {
                      return;
                    }
                    await authorizeGoogleDrivePublicationAttempt({
                      db,
                      identity: connectorActionIdentity,
                      target: googleDrivePublicationTarget,
                      approvalId: call.operationId,
                      arguments: call.arguments,
                    });
                  },
                }
              : {}),
          }),
          cancellationSignal,
          async (latePreparedTools) => await latePreparedTools.close().catch(() => undefined),
        );
      } catch (error) {
        toolPreparationOutcome = "failed";
        throw error;
      } finally {
        const toolPreparationDurationMs = performance.now() - toolPreparationStartedAt;
        recordTurnStartupPhase(observability, {
          phase: "tool_preparation",
          provider: turnExecutionPolicy.providerId,
          backend: activeSandboxBackend ?? groupBoxBackend,
          outcome: toolPreparationOutcome,
          durationSeconds: toolPreparationDurationMs / 1_000,
          count: turnTools.length,
        });
        await publish!([
          {
            type:
              toolPreparationOutcome === "completed"
                ? "turn.startup.phase.completed"
                : "turn.startup.phase.failed",
            payload: {
              phase: "tools",
              durationMs: Math.max(0, Math.round(toolPreparationDurationMs)),
            },
          },
        ]);
      }
      const postToolPreparationStartedAt = performance.now();
      const activatePreparedToolEnvironment = (
        tools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>>,
      ): void => {
        if (
          toolPreparationClosing ||
          !turnId ||
          !tools.attemptToolEnvironment ||
          codemodeDispatcher
        ) {
          return;
        }
        codemodeDispatcher = new CodemodeAttemptDispatcher(
          db,
          bus,
          tools.attemptToolEnvironment,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            attemptId: input.attemptId,
            executionGeneration,
          },
          cancellationSignal,
        );
        codemodeDispatcher.start();
      };
      if (preparedTools.ready) {
        toolPreparationReady = preparedTools.ready.then((tools) => {
          activatePreparedToolEnvironment(tools);
        });
      } else {
        activatePreparedToolEnvironment(preparedTools);
      }
      // Genesis turn = the first user turn (no assistant history reconciled
      // yet). Durable Postgres state (countSessionHistoryItems includes
      // superseded rows after compaction), NOT a workflow counter (turnsThisRun
      // resets on continueAsNew). Drives the one-shot title hint appended to the
      // agent's instructions; later attempts and goal continuations never match.
      const isGenesisTurn =
        triggerType === "user.message" &&
        (await countSessionHistoryItems(db, input.workspaceId, input.sessionId)) === 0;
      // Clone-onto-real-disk hazard (Case B). A session keeps its CLOUD HOME
      // backend (runSettings.sandboxBackend, e.g. "modal") but its ACTIVE sandbox
      // may have been swapped to a connected machine (active_sandbox_id → a
      // selfhosted lease). buildAgent's repository-clone lifecycle hook keys off
      // the EFFECTIVE backend; if we let it default to the home backend it would
      // `git clone` a private GitHub-App repo onto the user's REAL disk. So pass
      // "selfhosted" through when the active sandbox is a connected machine;
      // otherwise leave it undefined so buildAgent defaults to the home backend
      // (byte-for-byte unchanged cloud behavior). `activeSandboxBackend` was
      // resolved ONCE at turn start (above) via resolveActiveSandboxBackend (the
      // tested gate) and is reused here — resolving once is correct because the
      // clone hook runs at beforeAgentStart, so a mid-turn swap can't affect it.
      // buildAgent's option key is `workspaceEnvironment` (internal runtime
      // symbol; the product concept is a variable set). Built as a TYPED const —
      // a direct literal assignment to Pick<BuildAgentOptions,...> IS excess-
      // property-checked, so a wrong key fails tsc. A bare conditional spread
      // inside the options literal is NOT checked, which is exactly how the M1
      // key regression (workspaceVariableSet vs workspaceEnvironment) slipped
      // through and silently dropped the variable-set instructions block.
      const workspaceEnvironmentOption: Pick<BuildAgentOptions, "workspaceEnvironment"> =
        workspaceVariableSet
          ? {
              workspaceEnvironment: {
                name: workspaceVariableSet.name,
                description: workspaceVariableSet.description,
                variableNames: Object.keys(workspaceVariableSet.values),
              },
            }
          : {};
      const hostedWebSearch = hostedWebSearchForTurn(resolvedModel, runSettings.webSearchEnabled);
      const resolveImageReferences = async (
        references: Parameters<typeof resolveImageGenerationReferences>[0]["references"],
      ) =>
        await resolveImageGenerationReferences({
          db,
          objectStorage: objectStorage!,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: fileAuthoritySubjectId,
          references,
          readSandboxFile: async (path, maxBytes) => {
            const imageReferenceSession = (setupBoxSession ??
              media.sdkOwnedSandboxSession) as ChannelASession | null;
            if (!imageReferenceSession) {
              throw new Error("Sandbox image reference is unavailable");
            }
            const relativePath = path.slice("/workspace/".length);
            const referenceRunAs = sandboxRunAs(modelRunSettings);
            const channel = new SandboxChannelAService({
              session: imageReferenceSession,
              workspaceRoot: "/workspace",
              leaseEpoch: resolvedSandbox?.leaseEpoch ?? 0,
              ...(referenceRunAs ? { runAs: referenceRunAs } : {}),
            });
            const read = await channel.fsRead({
              path: relativePath,
              encoding: "base64",
              maxBytes,
            });
            if (read.truncated) throw new Error("Sandbox image reference exceeds the byte limit");
            return Uint8Array.from(Buffer.from(read.content, "base64"));
          },
        });
      const imageGenerationOption: Pick<BuildAgentOptions, "imageGeneration"> = (() => {
        // Never expose a paid image operation unless its permanent artifact can
        // be committed. Failing after provider execution would leave an
        // unrecoverable outcome-unknown operation with no user-visible image.
        if (!objectStorage) return {};
        if (nativeImageProviderBinding) {
          media.nativeImageGenerationRetention = {
            ...nativeImageProviderBinding,
            sessionId: input.sessionId,
            turnId: turn.id,
            attemptId: input.attemptId,
          };
          return { imageGeneration: { kind: "native_hosted" } };
        }

        if (resolvedModel?.provider.kind === "codex-subscription") {
          const imageAuthority = connectedSubscriptionImageGenerationAuthority(
            codexContext,
            effectiveCodexCredentialId,
          );
          if (!imageAuthority) return {};
          return {
            imageGeneration: {
              kind: "provider_adapter",
              execute: async ({ prompt, references }, { toolCallId }) => {
                const resolvedReferences = await resolveImageReferences(references);
                const receipt = await executeCodexImageGeneration({
                  db,
                  objectStorage,
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  attemptId: input.attemptId,
                  toolCallId,
                  prompt,
                  references: resolvedReferences,
                  credentialId: imageAuthority.credentialId,
                  codexContext: imageAuthority.credentialContext,
                  ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
                });
                media.rememberGeneratedImageCreatedThisTurn(receipt);
                await media.materializeGeneratedImage(receipt);
                return receipt;
              },
            },
          };
        }

        if (resolvedModel?.provider.kind === "xai-subscription") {
          const imageAuthority = connectedSubscriptionImageGenerationAuthority(
            xaiRequestContext,
            effectiveXaiCredentialId,
          );
          if (!imageAuthority) return {};
          return {
            imageGeneration: {
              kind: "provider_adapter",
              execute: async ({ prompt, references }, { toolCallId }) => {
                const resolvedReferences = await resolveImageReferences(references);
                const receipt = await executeXaiSubscriptionImageGeneration({
                  db,
                  objectStorage,
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  attemptId: input.attemptId,
                  toolCallId,
                  prompt,
                  references: resolvedReferences,
                  credentialId: imageAuthority.credentialId,
                  xaiContext: imageAuthority.credentialContext,
                  ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
                });
                media.rememberGeneratedImageCreatedThisTurn(receipt);
                await media.materializeGeneratedImage(receipt);
                return receipt;
              },
            },
          };
        }

        const gatewayResolution = resolveModelProvider(
          capabilitySettings,
          WORKSPACE_GATEWAY_PROVIDER_ID,
        );
        const gateway = gatewayResolution?.provider;
        if (gateway?.kind !== "vercel-gateway-workspace" || !gateway.apiKey) return {};
        const gatewayApiKey = gateway.apiKey;
        return {
          imageGeneration: {
            kind: "provider_adapter",
            execute: async ({ prompt, references }, { toolCallId }) => {
              const resolvedReferences = await resolveImageReferences(references);
              const receipt = await executeGatewayImageGeneration({
                db,
                objectStorage,
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: turn.id,
                attemptId: input.attemptId,
                apiKey: gatewayApiKey,
                modelId: capabilitySettings.imageGenerationModel,
                prompt,
                references: resolvedReferences,
                toolCallId,
                ...(runtimeCancellationSignal ? { abortSignal: runtimeCancellationSignal } : {}),
              });
              media.rememberGeneratedImageCreatedThisTurn(receipt);
              await media.materializeGeneratedImage(receipt);
              return receipt;
            },
          },
        };
      })();
      const videoGenerationPolicy = await getWorkspaceVideoGenerationPolicy(db, input.workspaceId);
      const videoGenerationEnabled =
        videoGenerationPolicy.defaultModelId !== null &&
        videoGenerationPolicy.enabledModelIds.length > 0;
      let videoGenerationCredential: VideoGenerationCredentialLease | null = null;
      if (objectStorage && videoGenerationEnabled) {
        if (videoGenerationPolicy.fundingSource === "opengeni_credits") {
          videoGenerationCredential = managedVideoGenerationCredentialLease(modelRunSettings);
        } else if (videoGenerationPolicy.fundingSource === "workspace_gateway") {
          const workspaceCredential = await loadWorkspaceVercelAiGatewayCredentialLease(
            db,
            modelRunSettings,
            input.workspaceId,
          );
          if (workspaceCredential) {
            videoGenerationCredential = {
              fundingSource: "workspace_gateway",
              ...workspaceCredential,
            };
          }
        } else if (videoGenerationPolicy.fundingSource === "supergrok_subscription") {
          const encryptionKey = environmentsEncryptionKeyBytes(modelRunSettings);
          const subjectId = leases.xai.subjectId ?? turn.initiatingHumanSubjectId;
          if (encryptionKey && subjectId) {
            const authoritySnapshot =
              xaiAuthoritySnapshot ??
              (await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(db, {
                workspaceId: input.workspaceId,
                subjectId,
              }));
            const pin = await getXaiSessionAccountPin(db, {
              workspaceId: input.workspaceId,
              subjectId,
              sessionId: input.sessionId,
              authoritySnapshot,
            });
            const selected = effectiveXaiCredentialId
              ? {
                  credentialId: effectiveXaiCredentialId,
                  rotationEnabled: xaiRotationEnabled,
                }
              : await selectXaiCredentialForUse(db, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  subjectId,
                  authoritySnapshot,
                  shardKey: input.sessionId,
                  pinnedCredentialId: pin?.pinnedCredentialId ?? null,
                  pinSource:
                    pin?.pinSource === "manual" || pin?.pinSource === "policy"
                      ? pin.pinSource
                      : null,
                });
            if (selected.credentialId) {
              if (
                selected.rotationEnabled &&
                pin?.pinSource !== "manual" &&
                pin?.pinnedCredentialId !== selected.credentialId
              ) {
                await setXaiSessionAccountPin(db, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  subjectId,
                  sessionId: input.sessionId,
                  authoritySnapshot,
                  credentialId: selected.credentialId,
                  pinSource: "policy",
                  expectedVersion: pin?.version ?? null,
                }).catch((error: unknown) => {
                  if (error instanceof Error && error.message === "xAI session pin changed") return;
                  throw error;
                });
              }
              const credential = await materializeXaiCredentialForRun(db, {
                workspaceId: input.workspaceId,
                subjectId,
                credentialId: selected.credentialId,
                authoritySnapshot,
                encryptionKey,
              });
              videoGenerationCredential = xaiVideoGenerationCredentialLease({
                settings: modelRunSettings,
                credential,
                subjectId,
                authoritySnapshot,
              });
            }
          }
        }
      }
      const videoGenerationOption: Pick<BuildAgentOptions, "videoGeneration"> = (() => {
        if (
          !objectStorage ||
          modelRunSettings.sandboxBackend === "none" ||
          !videoGenerationCredential ||
          !videoGenerationEnabled
        ) {
          return {};
        }
        // Parse the frozen capability snapshot before advertising either tool.
        // Invalid or unsupported workspace policy therefore fails closed before
        // it can perturb the model's tool list.
        const capabilities = videoGenerationCapabilitiesForPolicy({
          policy: videoGenerationPolicy,
          credentialVersion: videoGenerationCredential.version,
        });
        return {
          videoGeneration: {
            capabilities: async () => capabilities,
            execute: async (toolInput, { toolCallId }) => {
              const sessionForReference =
                resolvedSandbox?.established.session ?? media.sdkOwnedSandboxSession;
              const fence = toolCancellationFenceRef.current;
              const runAs = sandboxRunAs(modelRunSettings);
              let accepted: Awaited<ReturnType<typeof admitVideoGenerationRequest>>;
              try {
                accepted = await admitVideoGenerationRequest({
                  db,
                  storage: objectStorage,
                  settings: modelRunSettings,
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  attemptId: input.attemptId,
                  toolCallId,
                  toolInput,
                  policy: videoGenerationPolicy,
                  credential: videoGenerationCredential,
                  ...(sessionForReference && fence
                    ? {
                        runCommand: async (command) =>
                          await fence.runSandboxCommandStructured(
                            sessionForReference as import("@opengeni/runtime").TurnSandboxCommandSession,
                            {
                              ...command,
                              ...(runAs ? { runAs } : {}),
                            },
                          ),
                      }
                    : {}),
                  ...(runtimeCancellationSignal ? { signal: runtimeCancellationSignal } : {}),
                });
              } catch (error) {
                if (error instanceof VideoReferenceInputError) {
                  return VideoGenerationRejectedResult.parse({
                    schemaVersion: 1,
                    status: "rejected",
                    code: error.code,
                    message: error.message,
                    operationCreated: false,
                  });
                }
                throw error;
              }
              videoGenerationAcceptancesByCallId.set(toolCallId, {
                operationId: accepted.operationId,
                requestDigest: accepted.requestDigest,
              });
              return accepted.receipt;
            },
          },
        };
      })();
      const serviceTier = serviceTierForLatencyMode(
        turnExecutionPolicy.providerId,
        turnExecutionPolicy.latencyMode,
      );
      const connectorActionPolicy: ConnectorActionPolicyHooks = {
        prepare: async (call) =>
          await prepareConnectorActionApproval(db, connectorActionIdentity, call),
        begin: async (call) =>
          await beginConnectorActionExecution(db, connectorActionIdentity, call),
        complete: async ({ requestId, outcome }) =>
          await completeConnectorActionExecution(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            requestId,
            attemptId: input.attemptId,
            outcome,
          }),
      };
      const runtimeSkillActivations = [
        ...installedSkillRuntime.activations,
        ...packRuntime.skillActivations,
        ...session.skills.map((skill) => ({
          source: "session" as const,
          id: `session:${session.id}:${skill.name}`,
          artifact: {
            name: skill.name,
            description: skill.description ?? null,
            files: skill.files.map((file) => ({
              path: file.path,
              content: file.content,
            })),
          },
          reason: "attached to session",
        })),
      ];
      const modelVisibleRuntimeSkillActivations = modelVisibleCompanyBrainSkillActivations(
        modelRunSettings.sandboxBackend,
        runtimeSkillActivations,
      );
      try {
        companyBrainContextContributions = summarizeCompanyBrainContributions(
          buildCompanyBrainContributionReceiptFor(modelVisibleRuntimeSkillActivations),
        );
      } catch {
        // Contribution telemetry must never change model execution semantics.
      }
      recordTurnStartupPhase(observability, {
        phase: "post_tool_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - postToolPreparationStartedAt) / 1_000,
      });
      const agent = (() => {
        const agentConstructionStartedAt = performance.now();
        let agentConstructionOutcome: "completed" | "failed" = "completed";
        try {
          return runtime.buildAgent(modelRunSettings, runtimeResources, {
            reasoningEffort: turn.reasoningEffort,
            latencyMode: turnExecutionPolicy.latencyMode,
            ...(serviceTier ? { serviceTier } : {}),
            ...(humanInputResume ? { humanInputResponse: humanInputResume } : {}),
            humanInputEnabled: agentHumanInputEnabled,
            genesisTitleHint: isGenesisTurn,
            sandboxEnvironment,
            ...(preparedTools.attemptToolCatalog
              ? { attemptToolCatalog: preparedTools.attemptToolCatalog }
              : {}),
            ...(sandboxArtifactRuntime.available ? { artifactRuntimeAvailable: true } : {}),
            ...(cancellationSignal ? { turnCancellationSignal: cancellationSignal } : {}),
            onToolCancellationFence: (fence) => {
              toolCancellationFenceRef.current = fence;
            },
            // TOKEN-BROKER (B1): forward the per-turn git token OFF-MANIFEST as the clone
            // seed. ONLY when the effective backend is NOT selfhosted (the connected
            // machine uses its own git creds — mirrors the skipGitHubToken gate above)
            // AND the mint actually produced a token (repo resources present). The runtime
            // seeds it to the box's token file before the repository-clone runs; it never
            // touches the box/agent manifest env.
            ...(activeSandboxBackend !== "selfhosted" && sandboxGitTokens
              ? { gitTokenSeeds: sandboxGitTokens }
              : {}),
            ...(activeSandboxBackend !== "selfhosted" && sandboxGitCredentialBindings
              ? { gitCredentialBindings: sandboxGitCredentialBindings }
              : {}),
            ...(activeSandboxBackend !== "selfhosted" && !sandboxGitTokens && sandboxGitToken
              ? { gitTokenSeed: sandboxGitToken }
              : {}),
            ...(sandboxCodemodeToken ? { codemodeAvailable: true } : {}),
            // Managed boxes receive the bearer through their protected per-session
            // token file. Connected Machines use transient per-exec delivery above,
            // so they must not run the file-seeding lifecycle hook.
            ...(activeSandboxBackend !== "selfhosted" && sandboxCodemodeToken
              ? {
                  codemodeTokenSeed: sandboxCodemodeToken,
                  codemodeTokenSessionId: input.sessionId,
                }
              : {}),
            ...(activeSandboxBackend ? { activeSandboxBackend } : {}),
            fileResourceDownloads,
            mcpServers: preparedTools.mcpServers,
            resolvedMcpConnectionIds: preparedTools.resolvedMcpConnectionIds,
            connectorActionPolicy,
            attemptConnectorActionBindings: googleDriveConnectorBindings,
            // LIVE by-reference connector namespaces (fills during this turn's
            // codex_apps tools/list): the codex tool_search description reads it per
            // model call so the model sees the account's real connected sources.
            codexConnectorNamespaces: preparedTools.codexConnectorNamespaces,
            // Resolved-model routing + gating (legacy defaults when null). The model
            // is passed as the model *string* (agent.model = runSettings.openaiModel),
            // NOT a Model instance: an instance only survives the in-process
            // ("none") run, whereas the SandboxAgent/Modal path drops it and
            // re-resolves the model *name* through the global MultiProviderModelProvider
            // configureOpenAI installed — so registry models (Fireworks GLM) route to
            // their own client instead of 404ing against the built-in Azure/OpenAI
            // client. The gating still comes from the resolved provider: server-side
            // store/compaction follow the provider's compaction mode (registry
            // providers resolve to "client"); encrypted reasoning is only
            // round-tripped on the Responses wire API; hosted web search is attached
            // whenever the provider declares it runnable and is independent of the
            // session's MCP allow-list; the effective context window drives the
            // compaction threshold.
            hostedWebSearch,
            ...imageGenerationOption,
            ...videoGenerationOption,
            lazyToolTransport,
            ...(toolPreparationReady ? { toolPreparationReady } : {}),
            supportsImageInput,
            inputFileMediaTypes: modelInputPolicy.inputFileMediaTypes,
            ...(resolvedModel
              ? {
                  encryptedReasoning:
                    resolvedModel.provider.api === "responses" &&
                    runSettings.openaiReasoningEncryptedContent,
                  contextWindowTokens:
                    resolvedModel.configured.contextWindowTokens ?? runSettings.contextWindowTokens,
                  // The ChatGPT/Codex backend rejects the SDK's HOSTED apply_patch
                  // tool. Gateway Responses routes likewise expose ordinary function
                  // tools, not OpenAI-hosted sandbox tools. Tell buildAgent to use
                  // function apply_patch and wrap successful view_image results as
                  // typed input_image content. Chat wires have no proven typed image
                  // result transport and therefore receive no view_image tool.
                  structuredToolTransport: structuredToolTransportForTurn(resolvedModel),
                  // EXPLICIT computer-use tool transport. See {@link computerToolModeForTurn}.
                  computerToolMode: computerToolModeForTurn(resolvedModel),
                  ...(promptCacheKey ? { promptCacheKey } : {}),
                }
              : // LEGACY global-client fallback (resolveTurnModel returned null → the model
                // is not in the registry, served by the built-in OpenAI/Azure Responses
                // client). Pin computerToolMode to function-image EXPLICITLY rather than
                // leaving the runtime to sniff the instance.
                {
                  computerToolMode: computerToolModeForTurn(null),
                  promptCacheKey: input.sessionId,
                }),
            // Lazy computer-use seam: runtime first brings up :0 only after the model
            // selects a computer tool, then this hook begins the optional proof
            // recording. Shell/filesystem turns never invoke either operation.
            onComputerUseReady: async () => {
              if (!resolvedSandbox) {
                throw new Error("Computer-use display became ready without a resolved sandbox");
              }
              // This callback is the authoritative execution boundary. Record the
              // action before async ffmpeg startup so transport-event ordering cannot
              // make settlement misclassify a real computer turn as unused.
              didComputerUse = true;
              await maybeStartOnTurnRecording(resolvedSandbox, activeSandboxBackend);
            },
            onRetainableSessionImageOutput: media.retainSessionImageAtToolBoundary,
            ...(runtimeSkillActivations.length > 0
              ? { skillActivations: runtimeSkillActivations }
              : {}),
            ...(!structuredWorkspacePolicyActive && workspaceAgentInstructions
              ? { instructionsTemplate: workspaceAgentInstructions }
              : {}),
            ...(workspaceGovernance ? { workspaceGovernance } : {}),
            ...(workspaceMemory ? { workspaceMemory } : {}),
            // Per-session persona tier (session > workspace > deployment default).
            // Composed system-level AFTER the workspace persona so it refines it for
            // this one session; absent ⇒ byte-identical to today's composition.
            ...(session.instructions ? { sessionInstructions: session.instructions } : {}),
            ...workspaceEnvironmentOption,
            // RIG RUNTIME (M3): the doctrine block, the setup-script hook (only when
            // the frozen version carries a non-empty script), and the rig credential
            // hooks. All absent for a rig-less turn (byte-for-byte today).
            ...(rigVersion && rigName
              ? {
                  rig: { name: rigName, version: rigVersion.version },
                  ...(rigVersion.setupScript && rigVersion.setupScript.trim().length > 0
                    ? {
                        rigSetup: {
                          rigId: session.rigId!,
                          versionId: rigVersion.id,
                          rigName,
                          script: rigVersion.setupScript,
                          timeoutMs: runSettings.rigSetupTimeoutMs,
                          contentHash: rigProviderImageContentHash({
                            backend: turn.sandboxBackend,
                            sourceImage: rigProviderImageSourceImage(
                              logicalSandboxSettings,
                              turn.sandboxBackend,
                            ),
                            definition: rigVersion,
                          }),
                          ...(verifiedRigProviderImageId
                            ? { verifiedProviderImageId: verifiedRigProviderImageId }
                            : {}),
                        },
                      }
                    : {}),
                  ...(rigVersion.credentialHooks.length > 0
                    ? { rigCredentialHookIds: rigVersion.credentialHooks }
                    : {}),
                }
              : {}),
          });
        } catch (error) {
          agentConstructionOutcome = "failed";
          throw error;
        } finally {
          recordTurnStartupPhase(observability, {
            phase: "agent_construction",
            provider: turnExecutionPolicy.providerId,
            backend: activeSandboxBackend ?? groupBoxBackend,
            outcome: agentConstructionOutcome,
            durationSeconds: (performance.now() - agentConstructionStartedAt) / 1_000,
          });
        }
      })();
      const postAgentPreparationStartedAt = performance.now();
      if (modelRunSettings.sandboxBackend !== "none" && toolCancellationFenceRef.current === null) {
        throw new Error(
          "Sandbox agent construction did not install the mandatory turn tool cancellation fence",
        );
      }
      if (establishPolicy === "on-demand" && sandboxHolderId && sandboxGroupId) {
        const agentDefaultManifest = (agent as { defaultManifest?: unknown }).defaultManifest;
        if (!agentDefaultManifest) {
          throw new Error("Lazy sandbox provisioning requires a SandboxAgent defaultManifest");
        }
        const lazyClient = {
          backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
        } as EstablishedSandboxSession["client"];
        let lazySandboxEstablishmentSettled = false;
        turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>(
          async () => {
            throwIfWorkerShuttingDown();
            throwIfTurnCancelled();
            if (!resumeManagedGroupBox) {
              throw new Error("Lazy sandbox provisioning requires a managed group-box resume");
            }
            startRunGitCredentialsMint();
            const provisioned = await (prefetchedManagedBox ?? resumeManagedGroupBox());
            await publishSandboxLifecycleEvents(provisioned);
            // Return the REAL established box (NOT a copy whose session is the routing
            // proxy). resolveActiveBackend dispatches ops to `provisioned.established.session`;
            // if that were the proxy itself, proxy.exec -> dispatch -> resolve ->
            // provisioner.get() -> proxy.exec -> ... loops forever (an async infinite
            // recursion that HANGS the turn — caught live on staging 2026-07-08). The SDK
            // already holds the proxy directly (injected as lazyOwnedSandbox.session), so it
            // gets per-op routing; the worker-side handle (resolvedSandbox: release,
            // heartbeat, computer-use recording) wants the real box, unproxied.
            return provisioned;
          },
          {
            signal: sandboxResumeSignal,
            onStarted: async ({ provisionId }) => {
              await publish?.(
                [
                  {
                    type: "sandbox.operation.started",
                    payload: { name: "sandbox.provision", provisionId },
                  },
                ],
                true,
              );
            },
            onAttemptSettled: ({ result, error, outcome, durationMs }) => {
              const successStage =
                result?.established.origin === "created"
                  ? "create"
                  : result?.established.origin === "resumed"
                    ? "resume"
                    : result?.established.origin === "restored"
                      ? "archive_recovery"
                      : "unknown";
              const failure = error
                ? classifySandboxLogicalProvisionFailure(groupBoxBackend, error)
                : null;
              recordSandboxProvisionAttempt(observability, {
                backend: groupBoxBackend,
                stage: failure?.stage ?? successStage,
                category: failure?.category ?? successStage,
                outcome,
                durationSeconds: durationMs / 1_000,
              });
            },
            beforeCompleted: async (provisioned, settlement) => {
              throwIfTurnOperationCancelled(sandboxResumeSignal);
              startLeaseHeartbeat(provisioned, activeSandboxBackend ?? groupBoxBackend);
              setupBoxSession = provisioned.established.session;
              resolvedSandbox = provisioned;
              // This durable completion and its logical metric close at actual box
              // establishment. Credential, rig, repository, and file preparation below
              // must never be attributed to "Starting sandbox" or provision latency.
              await publish?.(
                [
                  {
                    type: "sandbox.operation.completed",
                    payload: {
                      name: "sandbox.provision",
                      ...(provisioned.established.origin
                        ? { origin: provisioned.established.origin }
                        : {}),
                      provisionId: settlement.provisionId,
                      internalAttempts: settlement.internalAttempts,
                    },
                  },
                ],
                true,
              );
              const successStage =
                provisioned.established.origin === "created"
                  ? "create"
                  : provisioned.established.origin === "resumed"
                    ? "resume"
                    : provisioned.established.origin === "restored"
                      ? "archive_recovery"
                      : "unknown";
              recordSandboxLogicalProvision(observability, {
                backend: groupBoxBackend,
                stage: successStage,
                category: "none",
                outcome: "completed",
                expected: false,
                internalAttempts: settlement.internalAttempts,
                durationSeconds: settlement.durationMs / 1_000,
              });
              lazySandboxEstablishmentSettled = true;

              const lazyGitCredentials =
                activeSandboxBackend === "selfhosted"
                  ? undefined
                  : await startRunGitCredentialsMint();
              const lazyGitTokens = lazyGitCredentials?.gitTokens;
              const lazyCodemodeToken = sandboxCodemodeToken
                ? await mintSandboxCodemodeToken(runSettings, connectionScope, codemodeAuthority)
                : undefined;
              await attachRunCredentialRenewal(
                provisioned.established.session as RunCredentialCommandSession,
                initialRunCredentialMaterial,
                provisioned,
              );
              const provisionedSetupSession = initialRunCredentialMaterial
                ? withRunCredentialsSession(
                    provisioned.established.session as object,
                    input.sessionId,
                  )
                : provisioned.established.session;
              await runWorkspaceMutationForSandbox(
                provisioned,
                "lazyOwnedSandboxSetup",
                async () =>
                  await runOwnedSandboxSetup(
                    agent,
                    provisioned.established.session as never,
                    provisionedSetupSession as never,
                    {
                      settings: runSettings,
                      environment: sandboxEnvironment,
                      onRuntimeEvent: async (event) => {
                        await publish?.([{ type: event.type, payload: event.payload }], true);
                      },
                      ...(lazyGitTokens ? { gitTokenSeedsOverride: lazyGitTokens } : {}),
                      ...(lazyGitCredentials?.bindings
                        ? {
                            gitCredentialBindingsOverride: lazyGitCredentials.bindings,
                          }
                        : {}),
                      ...(lazyCodemodeToken
                        ? {
                            codemodeTokenSeedOverride: lazyCodemodeToken.token,
                          }
                        : {}),
                      ...(toolCancellationFenceRef.current
                        ? {
                            commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                              toolCancellationFenceRef.current,
                            ),
                          }
                        : {}),
                    },
                  ),
                (measurement) => {
                  if (firstModelRequestPreparationRecorded) return;
                  firstModelPreparationNestedSandboxMs += measurement.durationSeconds * 1_000;
                  firstModelPreparationNestedSandboxPhases.push(measurement);
                },
              );
              await attachCodemodeTokenRenewal(
                provisioned.established.session as CodemodeTokenWriterSession,
                lazyCodemodeToken?.expiresAt,
                provisioned,
              );
              await attachGitCredentialRenewal(
                provisioned.established.session as GitCredentialTokenWriterSession,
                lazyGitCredentials,
                provisioned,
              );
              // `get()` does not release the first routed sandbox operation
              // until this hook returns. Only images created during this exact
              // turn can require deferred delivery here; historical images stay
              // as durable receipts and are restored explicitly when requested.
              for (const receipt of media.generatedImageReceiptsCreatedThisTurn.values()) {
                await media.materializeGeneratedImageInSandbox(
                  receipt,
                  provisioned,
                  provisioned.established.session,
                );
              }
              await toolResultSpill.materializeDeferred();
              throwIfTurnOperationCancelled(sandboxResumeSignal);
            },
            onFailed: async (error, settlement) => {
              if (lazySandboxEstablishmentSettled) return;
              const failure = classifySandboxLogicalProvisionFailure(groupBoxBackend, error);
              await publish?.(
                [
                  {
                    type: "sandbox.operation.failed",
                    payload: {
                      name: "sandbox.provision",
                      error: error instanceof Error ? error.message : String(error),
                      provisionId: settlement.provisionId,
                      internalAttempts: settlement.internalAttempts,
                      failureCategory: failure.category,
                      failureStage: failure.stage,
                      failureCode: failure.code,
                      expectedTransition: failure.expected,
                      retryable: failure.retryable,
                    },
                  },
                ],
                true,
              );
              recordSandboxLogicalProvision(observability, {
                backend: groupBoxBackend,
                stage: failure.stage,
                category: failure.category,
                outcome: failure.expected ? "expected_transition" : "failed",
                expected: failure.expected,
                internalAttempts: settlement.internalAttempts,
                durationSeconds: settlement.durationMs / 1_000,
              });
            },
            disposeResult: async (provisioned) => {
              await releaseLateSandbox(provisioned);
            },
          },
        );
        lazyOwnedSandbox = wrapLazyTurnBoxWithRouting(
          {
            db,
            settings,
            bus,
            opJournal,
            onOp: machineOpObserver.observer,
            onSandboxOperation: sandboxOperationObserver,
            onHomeSandboxLost: publishSandboxLost,
            onHomeSandboxRebound,
            ...(runtimeCancellationSignal ? { waitSignal: runtimeCancellationSignal } : {}),
          },
          {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            resourceAccountId: input.accountId,
            ...(fileAuthoritySubjectId ? { resourceSubjectId: fileAuthoritySubjectId } : {}),
            ...(fileAuthoritySubjectId
              ? {
                  personalMachineAttempt: {
                    accountId: input.accountId,
                    subjectId: fileAuthoritySubjectId,
                    turnId: turn.id,
                    attemptId: input.attemptId,
                    executionGeneration,
                  },
                }
              : {}),
            environment: sandboxEnvironment,
            ...(transientCodemodeEnvironment
              ? { transientExecEnvironment: transientCodemodeEnvironment }
              : {}),
            workspaceMutationFence: {
              accountId: input.accountId,
              turnId: turn.id,
              executionGeneration,
              attemptId: input.attemptId,
            },
          },
          {
            client: lazyClient,
            backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
            agentDefaultManifest,
            provisioner: turnSandboxProvisioner,
            homeLeaseIdentity: {
              accountId: input.accountId,
              sandboxGroupId: session.sandboxGroupId,
              backend: groupBoxBackend,
            },
            onFirstOperation: (measurement) => {
              if (firstModelRequestPreparationRecorded) return;
              markModelPreparationFirstSandboxOperation(measurement.durationMs / 1_000);

              for (const nested of firstModelPreparationNestedSandboxPhases) {
                if (nested.phase === "snapshot_wait") continue;
                recordModelPreparationMeasurement({
                  phase:
                    nested.phase === "admission"
                      ? "sandbox_workspace_mutation_admission"
                      : nested.phase === "provider"
                        ? "sandbox_workspace_mutation_provider"
                        : "sandbox_workspace_mutation_settlement",
                  outcome: nested.outcome,
                  durationSeconds: nested.durationSeconds,
                });
              }

              const resolution = measurement.phases.resolution;
              if (resolution) {
                recordModelPreparationMeasurement({
                  phase: "sandbox_first_routed_resolution_other",
                  outcome: resolution.outcome,
                  durationSeconds:
                    Math.max(0, resolution.durationMs - firstModelPreparationNestedSandboxMs) /
                    1_000,
                });
              }

              const routedPhaseNames = [
                ["mutationAdmission", "sandbox_first_routed_mutation_admission"],
                ["providerOperation", "sandbox_first_routed_provider_operation"],
                ["mutationSettlement", "sandbox_first_routed_mutation_settlement"],
              ] as const;
              for (const [phaseName, metricPhase] of routedPhaseNames) {
                const phase = measurement.phases[phaseName];
                if (!phase) continue;
                recordModelPreparationMeasurement({
                  phase: metricPhase,
                  outcome: phase.outcome,
                  durationSeconds: phase.durationMs / 1_000,
                });
              }

              const nestedSnapshotPhases = firstModelPreparationNestedSandboxPhases.filter(
                (phase) => phase.phase === "snapshot_wait",
              );
              const routedSnapshot = measurement.phases.snapshotWait;
              const snapshotWaitMs =
                nestedSnapshotPhases.reduce(
                  (total, phase) => total + phase.durationSeconds * 1_000,
                  0,
                ) + (routedSnapshot?.durationMs ?? 0);
              if (snapshotWaitMs > 0) {
                recordModelPreparationMeasurement({
                  phase: "sandbox_snapshot_wait",
                  outcome:
                    routedSnapshot?.outcome === "failed" ||
                    nestedSnapshotPhases.some((phase) => phase.outcome === "failed")
                      ? "failed"
                      : "completed",
                  durationSeconds: snapshotWaitMs / 1_000,
                });
              }

              const routedMeasuredMs = Object.values(measurement.phases).reduce(
                (total, phase) => total + (phase?.durationMs ?? 0),
                0,
              );
              const routedOtherMs = Math.max(0, measurement.durationMs - routedMeasuredMs);
              if (routedOtherMs > 0) {
                recordModelPreparationMeasurement({
                  phase: "sandbox_first_routed_other",
                  outcome: measurement.outcome,
                  durationSeconds: routedOtherMs / 1_000,
                });
              }
            },
          },
        );
      }
      let companyBrainContributionReceiptRecorded = false;
      const recordCompanyBrainContributionReceiptOnce = (): void => {
        if (companyBrainContributionReceiptRecorded) return;
        companyBrainContributionReceiptRecorded = true;
        try {
          const companyBrainContributionReceipt = buildCompanyBrainContributionReceiptFor(
            modelVisibleRuntimeSkillActivations,
          );
          companyBrainContextContributions = summarizeCompanyBrainContributions(
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
      const agentInstructions = typeof agent.instructions === "string" ? agent.instructions : "";
      const compactSummarizer = compactionSummarizerFor(
        agentInstructions.trim() ? agentInstructions : undefined,
      );
      if (remoteCompactionRequester) {
        // Exact byte match with the ordinary turn prefix (CLI base_instructions).
        // Tools serialize lazily inside the requester so setup failures settle as
        // compaction failures rather than raw activity crashes.
        remoteCompactionInstructions = agentInstructions;
        remoteCompactionAgent = agent;
      }

      if (compactionOnlyTurn) {
        const requested = await isSessionCompactionRequested(
          db,
          input.workspaceId,
          input.sessionId,
        );
        let outcome: Awaited<ReturnType<typeof maybeCompactContext>> | null = null;
        if (requested) {
          try {
            outcome = await waitForTurnOperation(
              maybeCompactContext(
                db,
                modelRunSettings,
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  turnId: turn.id,
                  executionGeneration,
                  attemptId: input.attemptId,
                },
                session.lastInputTokens,
                compactSummarizer,
                {
                  force: true,
                  clearRequestedCompaction: true,
                  trigger: "operator",
                  projectModelInput: compactionModelHistoryProjector,
                  ...compactionModeOptions,
                },
              ),
              cancellationSignal,
              undefined,
            );
          } catch (error) {
            // Codex retries retryable checkpoint-provider failures rather than
            // treating them as a semantic compaction result. Keep the operator
            // request pending and let the ordinary same-turn provider/capacity
            // recovery path re-dispatch this exact maintenance execution.
            if (shouldRecoverCompactionProviderFailure(error)) throw error;
            if (error instanceof TurnAttemptFencedError) throw error;
            const landmark = await settleFailedContextCompactionLandmark(
              db,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: turn.id,
                executionGeneration,
                attemptId: input.attemptId,
              },
              {
                clearRequestedCompaction: true,
                publishLiveEvents: publishCompactionLiveEvents,
              },
            );
            if (!isCompactionSummaryFailure(error)) throw error;
            const errorMessage = String(compactionFailureReasonFromError(error));
            if (
              !(await settle!({
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
                ...(landmark.requestConsumed ? {} : { consumeRequestedCompactionFailure: true }),
              }))
            ) {
              return claimedResult({ status: "cancelled" });
            }
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = error;
            return claimedResult({ status: "idle" });
          }
          if (outcome.events.length > 0) {
            if (outcome.compacted) {
              recordContextCompaction(observability, "operator");
            }
            await publishCompactionOutcomeEvents(outcome.events);
          }
        }
        if (
          !(await settle!({
            events: [
              {
                type: "turn.completed",
                payload: {
                  maintenance: "context_compaction",
                  result: outcome?.compacted ? "compacted" : (outcome?.reason ?? "already_applied"),
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
        turnMetricOutcome = "completed";
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      }

      // Pre-turn durable context compaction. When the single Codex-parity
      // threshold is crossed, this summarizes active history and rebuilds active
      // history as [user messages..., summary] BEFORE the model input is read.
      // Summarizer context overflows drop one oldest summarizer-input item and
      // retry, exactly like Codex. Other failures end this turn honestly.
      // Run before every fresh inference. Approval resumes replay their frozen
      // RunState verbatim and recovering attempts already compacted, if needed,
      // before the first attempt's model boundary.
      if (triggerType === "user.message" || triggerType === "system.update.delivered") {
        let forced = false;
        try {
          // Operator /compact (the slash command) sets a durable request flag;
          // observe it without consuming it so a failed/stale attempt cannot
          // lose the request. The replacement transaction clears it on success.
          forced = await isSessionCompactionRequested(db, input.workspaceId, input.sessionId);
          const outcome = await waitForTurnOperation(
            maybeCompactContext(
              db,
              modelRunSettings,
              {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: turnId!,
                executionGeneration,
                attemptId: input.attemptId,
              },
              session.lastInputTokens,
              // Provider-aware summarizer: when the turn's model resolved to a
              // registry provider, summarize on THAT provider's client + wire API
              // (a chat provider can't summarize through OpenAI/Azure). Null
              // resolution uses the built-in Responses summarizer with the same
              // session prompt-cache key as the main model calls.
              compactSummarizer,
              forced
                ? {
                    force: true,
                    clearRequestedCompaction: true,
                    trigger: "operator",
                    materializeHistory: media.materializeScreenshotHistory,
                    projectModelInput: compactionModelHistoryProjector,
                    ...compactionModeOptions,
                  }
                : {
                    trigger: "auto",
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
              const compactionTrigger = forced ? "operator" : undefined;
              recordContextCompaction(observability, compactionTrigger ?? "auto");
            }
            await publishCompactionOutcomeEvents(outcome.events);
          }
        } catch (compactError) {
          if (shouldRecoverCompactionProviderFailure(compactError)) throw compactError;
          if (compactError instanceof TurnAttemptFencedError) throw compactError;
          const landmark = await settleFailedContextCompactionLandmark(
            db,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: turnId!,
              executionGeneration,
              attemptId: input.attemptId,
            },
            {
              clearRequestedCompaction: forced,
              publishLiveEvents: publishCompactionLiveEvents,
            },
          );
          if (!isCompactionSummaryFailure(compactError)) throw compactError;
          const errorMessage = String(compactionFailureReasonFromError(compactError));
          observability.error("context compaction failed", {
            sessionId: input.sessionId,
            turnId,
            ...safeErrorDiagnostic(compactError),
          });
          if (
            !(await settle!({
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
                { type: "session.status.changed", payload: { status: "idle" } },
              ],
              turnStatus: "failed",
              sessionStatus: "idle",
              activeTurnId: null,
              ...(forced && !landmark.requestConsumed
                ? { consumeRequestedCompactionFailure: true }
                : {}),
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          turnMetricOutcome = "failed";
          activityStatus = "idle";
          activityError = compactError;
          return claimedResult({ status: "idle" });
        }
      }
      recordTurnStartupPhase(observability, {
        phase: "post_agent_preparation",
        provider: turnExecutionPolicy.providerId,
        backend: activeSandboxBackend ?? groupBoxBackend,
        outcome: "completed",
        durationSeconds: (performance.now() - postAgentPreparationStartedAt) / 1_000,
      });
      let fileMaterializationFailures: SandboxFileDownloadFailure[] = [];
      let fileDownloadsMaterializedForRun = false;
      if (resolvedSandbox && setupBoxSession && fileResourceDownloads.length > 0) {
        const fileMaterializationStartedAt = performance.now();
        let fileMaterializationOutcome: "completed" | "failed" = "completed";
        let fileMaterializationCache: "hit" | "miss" = "miss";
        try {
          const boxInstanceId = resolvedSandbox.established.instanceId;
          // A successful transfer is durable for this exact filesystem instance.
          // Do not turn later model startup into an integrity scan. If an owner or
          // agent removes the file, it can be restored explicitly through the
          // existing Files MCP using the durable file id carried in model history.
          const alreadyMaterialized = await getMaterializedSandboxFileResources(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sandboxGroupId: session.sandboxGroupId,
            expectedEpoch: resolvedSandbox.leaseEpoch,
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
              resolvedSandbox,
              "fileMaterialization",
              async () =>
                await materializeSandboxFileDownloads(
                  setupBoxSession as CodemodeTokenWriterSession,
                  downloadsToMaterialize,
                  {
                    onRuntimeEvent: async (event) => {
                      await publish!([{ type: event.type, payload: event.payload }], true);
                    },
                    ...(runAs ? { runAs } : {}),
                    ...(toolCancellationFenceRef.current
                      ? {
                          commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                            toolCancellationFenceRef.current,
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
                expectedEpoch: resolvedSandbox.leaseEpoch,
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
      // Build one attempt from canonical history. The provider adapter creates
      // only the temporary wire view required by this turn's selected API;
      // subscription identity never edits or filters durable history.
      const activeTurnId = turnId;
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
            modelRunSettings,
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: activeTurnId,
              executionGeneration,
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
      const runStreamAttempt = async (): Promise<RunAgentTurnResult> => {
        if (!runInput) {
          throw new Error("Run input was not prepared");
        }
        stream = undefined;
        batcher = null;
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
        const recordFallbackProviderDispatchAtWire = async (): Promise<void> => {
          if (
            providerPublishesNativeRequestEvents ||
            firstModelRequestPreparationRecorded ||
            firstModelRequestPreparationStartedAt === null
          ) {
            return;
          }
          firstProviderRequestStarted = true;
          firstModelRequestPreparationRecorded = true;
          const preparationDurationMs = Math.max(
            0,
            performance.now() - firstModelRequestPreparationStartedAt,
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
            await publish!([
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
                  executionGeneration,
                },
              },
            ]);
            fallbackProviderRequestStartedAt = performance.now();
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
        const ownedEstablished = resolvedSandbox?.established ?? lazyOwnedSandbox;
        const runStreamOnce = async (): ReturnType<OpenGeniRuntime["runStream"]> => {
          // Eager owned sessions must settle the exact platform-setup provider
          // promise before the long model stream starts; otherwise one admission
          // would remain in flight for the entire turn and suppress every
          // heartbeat capture. Lazy setup already runs under the same wrapper in
          // its first-operation provisioner above.
          if (resolvedSandbox && !lazyOwnedSandbox && ownedEstablished) {
            const ownedSandboxSetupStartedAt = performance.now();
            let ownedSandboxSetupOutcome: "completed" | "failed" = "completed";
            try {
              const eagerSetupSession = setupBoxSession ?? ownedEstablished.session;
              // `deferredSetup: true` below tells the runtime that the worker owns
              // platform setup, so the runtime intentionally skips its credential
              // session callback. Materialize host-managed run credentials here
              // before any setup command (including provider login hooks), then
              // decorate setup commands so they source the active generation.
              await attachRunCredentialRenewal(
                eagerSetupSession as RunCredentialCommandSession,
                initialRunCredentialMaterial,
                resolvedSandbox,
              );
              const eagerCredentialSetupSession = initialRunCredentialMaterial
                ? withRunCredentialsSession(eagerSetupSession as object, input.sessionId)
                : eagerSetupSession;
              await runWorkspaceMutationForSandbox(
                resolvedSandbox,
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
                      ...(fileDownloadsMaterializedForRun
                        ? { fileDownloadsMaterialized: true }
                        : {}),
                      onRuntimeEvent: async (event) => {
                        await leases.renewServing("runtime_event");
                        if (leases.servingLost()) {
                          throw new Error("Provider credential lease expired during sandbox setup");
                        }
                        await publish!([{ type: event.type, payload: event.payload }], true);
                      },
                      ...(toolCancellationFenceRef.current
                        ? {
                            commandRunner: toolCancellationFenceRef.current.runSandboxCommand.bind(
                              toolCancellationFenceRef.current,
                            ),
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
          if (!firstModelRequestPreparationRecorded) {
            await publish!([
              {
                type: "turn.startup.phase.started",
                payload: { phase: "model_preparation" },
              },
            ]);
            firstModelRequestPreparationStartedAt = performance.now();
            firstModelRequestCheckpointAt = firstModelRequestPreparationStartedAt;
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
            modelRequestStarted = true;
            return await runtime.runStream(agent, runInput!, modelRunSettings, {
              signal: runtimeCancellationSignal,
              sandboxEnvironment,
              onRuntimeEvent: async (event) => {
                await leases.renewServing("runtime_event");
                if (leases.servingLost()) {
                  throw new Error("Provider credential lease expired during the active turn");
                }
                await publish!([{ type: event.type, payload: event.payload }], true);
              },
              // P1.2: inject the resumed box NON-OWNED (the SDK never reaps it — the
              // keystone). Absent when the flag is off -> legacy build-and-discard.
              ...(ownedEstablished
                ? {
                    ownedSandbox: {
                      client: ownedEstablished.client,
                      session: ownedEstablished.session,
                      ...(resolvedSandbox?.established.sessionState
                        ? {
                            sessionState: resolvedSandbox.established.sessionState,
                          }
                        : {}),
                      // Pin platform setup (hooks + file materialization) to the un-proxied
                      // established box — never through the routing proxy, which would
                      // re-route those execs onto a machine swapped in mid-turn.
                      ...(setupBoxSession ? { setupSession: setupBoxSession } : {}),
                      ...(fileDownloadsMaterializedForRun
                        ? { fileDownloadsMaterialized: true }
                        : {}),
                      // Both owned paths execute setup outside runStream: eager just
                      // above under its exact admission, lazy in the provisioner.
                      deferredSetup: true,
                    },
                  }
                : {}),
              ...(activeSandboxBackend !== "selfhosted" &&
              sandboxCodemodeToken &&
              sandboxCodemodeTokenExpiresAt &&
              !lazyOwnedSandbox
                ? {
                    onCodemodeTokenSessionReady: async (
                      tokenSession: CodemodeTokenWriterSession,
                    ) => {
                      const renewalSession =
                        (setupBoxSession as CodemodeTokenWriterSession | null) ?? tokenSession;
                      await attachCodemodeTokenRenewal(renewalSession);
                    },
                  }
                : {}),
              ...(runCredentialResolver
                ? {
                    runCredentialSessionId: input.sessionId,
                    ...(!lazyOwnedSandbox
                      ? {
                          onRunCredentialSessionReady: async (
                            credentialSession: RunCredentialCommandSession,
                          ) => {
                            const pinnedCredentialSession = setupBoxSession
                              ? (setupBoxSession as RunCredentialCommandSession)
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
              ...(modelRunSettings.sandboxBackend !== "none"
                ? {
                    onSandboxSessionReady: async (sandboxSession: CodemodeTokenWriterSession) => {
                      media.sdkOwnedSandboxSession = sandboxSession;
                      for (const receipt of media.generatedImageReceiptsCreatedThisTurn.values()) {
                        await media.materializeGeneratedImageInOwnedSdkSession(
                          receipt,
                          sandboxSession,
                        );
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
              ...(toolCancellationFenceRef.current
                ? {
                    turnToolCancellationFence: toolCancellationFenceRef.current,
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
        stream = await withProviderRequestContext(runStreamOnce);
        // Bounded provider label for the streaming SLIs — the resolved registry
        // provider id (or the built-in OpenAI/Azure provider), never a raw
        // user-supplied model string.
        const streamTiming = new StreamTimingMetrics(observability, {
          provider: streamProvider,
        });
        batcher = createRuntimeBatcher(
          async (events) => {
            await publish!(events);
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
          await publish!([
            {
              type: "agent.model.request",
              payload: {
                phase: "first_byte",
                provider: streamProvider,
                durationMs: Math.round(durationMs),
                turnId: activeTurnId,
                attemptId: input.attemptId,
                dispatchId,
                executionGeneration,
              },
            },
          ]);
        };
        const iterator = stream.toStream()[Symbol.asyncIterator]();
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
              publish,
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
              externallyBilled: isExternallyBilledTurn,
              servingCredentialId: effectiveCodexCredentialId,
              priorSessionCredentialId: priorSessionCodexCredentialId,
              emittedSourceKeys: emittedModelUsageSourceKeys,
              renewLease: () => leases.renewServing("model_usage"),
              leaseLost: leases.servingLost,
              leaseLostMessage: "Provider credential lease expired during the active turn",
              setLastInputTokens: setLastInputTokensFenced,
              contextContributions: companyBrainContextContributions,
            });
            assertModelResponseLatencyMode({
              event: next.value,
              requested: turnExecutionPolicy.latencyMode,
              model: turn.model,
              ...(resolvedModel?.provider.id ? { providerId: resolvedModel.provider.id } : {}),
            });
            if (responseResult.status === "processed") {
              const rawStreamHistory = (stream.state as { history?: unknown[] }).history;
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
              turnLifecycleMetricsFor(observability).progress(turnId!);
              modelCheckpointMemoryCollector.schedule(observability);
              try {
                await ensureRunAllowed(
                  settings,
                  db,
                  input.accountId,
                  input.workspaceId,
                  isExternallyBilledTurn,
                  entitlements,
                );
              } catch (limitError) {
                // Capture the run state at the boundary so the budget valve in
                // the outer catch can end this segment gracefully with full
                // conversation context preserved for the post-top-up resume.
                let serializedRunState: string | null = null;
                try {
                  serializedRunState = media.compactMediaRunState(String(stream.state.toString()));
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
                executionGeneration,
                attemptId: input.attemptId,
                modelToolOutputTruncationTokens: modelRunSettings.modelToolOutputTruncationTokens,
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
                executionGeneration,
                attemptId: input.attemptId,
                callId: completedToolCall.callId,
                modelToolOutputTruncationTokens: modelRunSettings.modelToolOutputTruncationTokens,
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
              const videoAcceptance = videoGenerationAcceptancesByCallId.get(
                completedToolCall.callId,
              );
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
              await batcher.push(event);
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
                executionGeneration,
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
          if (fallbackProviderRequestStartedAt !== null) {
            const durationMs = Math.max(0, performance.now() - fallbackProviderRequestStartedAt);
            fallbackProviderRequestStartedAt = null;
            await publish!([
              {
                type: "agent.model.request",
                payload: {
                  phase: "failed",
                  provider: streamProvider,
                  durationMs: Math.round(durationMs),
                  turnId: activeTurnId,
                  attemptId: input.attemptId,
                  dispatchId,
                  executionGeneration,
                },
              },
            ]);
          }
          if (
            !firstModelRequestPreparationRecorded &&
            firstModelRequestPreparationStartedAt !== null
          ) {
            firstModelRequestPreparationRecorded = true;
            const durationMs = Math.max(
              0,
              performance.now() - firstModelRequestPreparationStartedAt,
            );
            recordTurnStartupPhase(observability, {
              phase: "model_request_preparation",
              provider: turnExecutionPolicy.providerId,
              backend: activeSandboxBackend ?? groupBoxBackend,
              outcome: "failed",
              durationSeconds: durationMs / 1_000,
              count: turnTools.length,
            });
            await publish!([
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
        await waitForTurnStreamCleanup(
          batcher.flush(),
          stream.completed.catch(() => undefined),
          cancellationSignal,
        );
        if (!streamSawPerResponseUsage) {
          const aggregateUsage = stream.state.usage;
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
              servingCredentialId: effectiveCodexCredentialId,
              priorSessionCredentialId: priorSessionCodexCredentialId,
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
                  externallyBilled: isExternallyBilledTurn,
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
                  publish,
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
                    contextContributions: companyBrainContextContributions,
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
        if (stream.interruptions.length > 0) {
          await historySink.reconcileConversationTruth({ requireDurable: true });
          const approvals = runtime.serializeApprovals(stream.interruptions);
          const humanInputInterruptions =
            runtime.serializeHumanInputRequests?.(stream.interruptions) ?? [];
          const interactionInterventionInterruptions =
            runtime.serializeInteractionInterventionRequests?.(stream.interruptions) ?? [];
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
          const suffixMembers = extractOpenSuffixFromRunState(stream.state);
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
            executionGeneration,
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
            !(await settle!({
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
                humanInputRequests: humanInputRequests.map(
                  ({ isNew: _isNew, ...request }) => request,
                ),
                interactionInterventionRequests,
              },
            }))
          ) {
            return claimedResult({ status: "cancelled" });
          }
          // The interruption and its preceding tool results are now durable.
          await finalizeTurnOpStreamOps();
          activityStatus = "requires_action";
          return claimedResult({ status: "requires_action" });
        }

        const finalOutput = String(stream.finalOutput ?? "");
        await historySink.reconcileConversationTruth({ requireDurable: true });
        // Op-stream durability fence: the tool outputs are now durably in the
        // history store (a redispatch would NOT re-execute them), so this
        // turn's settled ops may advance their acked frontier — journal persist
        // then wire final ack (licensing the runner to GC its retained
        // frames). Best-effort: a miss leaves the runner's retention TTL to
        // reap, never fails a completed turn.
        await finalizeTurnOpStreamOps();
        if (
          !(await settle!({
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
        turnMetricOutcome = "completed";
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
        activityStatus = "idle";
        return claimedResult({ status: "idle" });
      };

      const openSuffixResume = await settleOpenSuffixResumeIfNeeded({
        db,
        agent,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: activeTurnId,
        executionGeneration,
        attemptId: input.attemptId,
        trigger,
        humanInputResume,
        modelToolOutputTruncationTokens: modelRunSettings.modelToolOutputTruncationTokens,
        settle: settle!,
        publish,
      });
      if (openSuffixResume.action === "cancelled") {
        return claimedResult({ status: "cancelled" });
      }
      if (openSuffixResume.action === "requires_action") {
        activityStatus = "requires_action";
        return claimedResult({ status: "requires_action" });
      }

      await prepareRunAttemptInput();
      let retriedAfterCompaction = false;
      while (true) {
        try {
          const result = await runStreamAttempt();
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
          if (!recoveryKind || !publish || !turnStartedPublished) {
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
                executionGeneration,
                attemptId: input.attemptId,
              },
              {
                clearRequestedCompaction: recoveryKind === "operator",
                publishLiveEvents: publishCompactionLiveEvents,
              },
            );
            compactionRequestCleared = landmark.requestConsumed;
            if (!isCompactionSummaryFailure(compactError)) throw compactError;
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
              !(await settle!({
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
            turnMetricOutcome = "failed";
            activityStatus = "idle";
            activityError = attemptError;
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
    } catch (error) {
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
      const recoveryTurnId = turnId;
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
            triggerEventId: triggerEventId!,
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
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          activityStatus = "recovering";
          turnMetricOutcome = "recovering";
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
            triggerEventId: triggerEventId!,
            attemptId: input.attemptId,
            reason: "sandbox_deadline_rotation",
            detail: {
              sandboxGroupId: rotation.sandboxGroupId,
              leaseEpoch: rotation.leaseEpoch,
            },
          });
          if (recovery.action === "stale") {
            acknowledgeLostAttemptOwnership();
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          activityStatus = "recovering";
          turnMetricOutcome = "recovering";
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
      if (
        cancellationFailure &&
        isWorkerShutdownCancellation(cancellationFailure) &&
        recoveryTurnId
      ) {
        try {
          await flushRuntimeBatcher();
          await historySink.reconcileConversationTruth();
          // An approval-decision rerun always replays its original trigger:
          // the decision is applied through the approval resume path reading
          // the frozen RunState blob (the only representation of a turn
          // paused mid-flight), so swapping the trigger for a resume notice
          // could drop the user's decision. Re-applying an already-consumed
          // approval re-enters at most the single approved step. Every
          // approval-gated MCP action crosses the durable execution admission
          // fence before its provider invocation, so a consumed step resumes
          // as already-executed or outcome-unknown rather than calling MCP again.
          const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
            sessionId: input.sessionId,
            turnId: recoveryTurnId,
            triggerEventId: triggerEventId!,
            attemptId: input.attemptId,
            reason: "worker_shutdown",
          });
          if (recovery.action === "stale") {
            acknowledgeLostAttemptOwnership();
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          activityStatus = "recovering";
          turnMetricOutcome = "recovering";
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
        activityStatus = "cancelled";
        activityError = error;
        acknowledgeQuiescence = true;
        noteCancellationRequested();
        await waitForTurnFinalizerStep(
          flushRuntimeBatcher(),
          turnFinalizerCancellationSignal(cancellationSignal, activityStatus),
        );
        // Ownership already moved to a newer attempt or an authoritative
        // control transaction. Surface the exact transport cancellation rather
        // than a normal result. Temporal terminalization remains diagnostic
        // only; replacement admission waits for the activity-owned durable
        // quiescence receipt written from the hard tool fence below.
        turnMetricOutcome = "cancelled";
        throw new CancelledFailure("TURN_ATTEMPT_FENCED", [], error);
      }
      if (cancellationFailure) {
        activityStatus = "cancelled";
        activityError = error;
        acknowledgeQuiescence = true;
        noteCancellationRequested();
        await waitForTurnFinalizerStep(
          flushRuntimeBatcher(),
          turnFinalizerCancellationSignal(cancellationSignal, activityStatus),
        );
        // The workflow owns cancellation settlement: Pause/Steer controls use
        // settleSessionControl, and heartbeat timeouts use worker-death
        // recovery. A dying activity must never append a
        // competing cancellation or mutate the turn/session on its own.
        turnMetricOutcome = "cancelled";
        throw cancellationFailure;
      }
      // The SDK's per-segment turn cap is a pacing valve, not a failure: end
      // the turn gracefully and idle the session so an active goal continues
      // via a synthesized continuation turn (or a user message resumes work).
      // The run state captured at the cap keeps full conversation context for
      // that resumption.
      const maxTurns = maxTurnsExceededRunState(error);
      if (maxTurns && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        // The SDK attaches the run state at the throw site; persisting it lets
        // the continuation resume with this segment's full context. If capture
        // ever fails, the continuation falls back to the previous snapshot --
        // degraded context, flagged on the event, but still strictly better
        // than a terminal failed session: the sandbox filesystem state
        // persists independently and the agent re-derives from it.
        await historySink.reconcileConversationTruth();
        if (
          !(await settle!({
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
        turnMetricOutcome = "completed";
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          sessionId: input.sessionId,
          turnId,
          turnAttemptId: input.attemptId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
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
          expectedRedispatches: redispatchesAtDispatch,
          checkpointDurable,
          recoveryPayload: {
            triggerEventId: triggerEventId!,
            reason: "codex_lease_lost",
            credentialId: effectiveCodexCredentialId,
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
        await publishDurableSessionEvents(
          bus,
          input.workspaceId,
          input.sessionId,
          settlement.events,
        );
        activityError = error;
        if (settlement.action === "failed") {
          activityStatus = "failed";
          turnMetricOutcome = "failed";
          await deliverFailedChildTurnToParent(
            { db, bus, settings, observability, wakeSessionWorkflow },
            input.workspaceId,
            input.sessionId,
            lostTurnId,
          );
          return claimedResult({ status: "failed" });
        }
        activityStatus = "recovering";
        turnMetricOutcome = "recovering";
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
        isCodexTurn &&
        publish &&
        turnId &&
        turnStartedPublished &&
        leases.codex.holderId &&
        leases.codex.generation !== null
      ) {
        return await settleLostCodexAttempt(turnId, leases.codex.holderId, leases.codex.generation);
      }
      if (leases.xai.lost && isXaiTurn && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        await historySink.reconcileConversationTruth({ requireDurable: true });
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId,
          triggerEventId: triggerEventId!,
          attemptId: input.attemptId,
          reason: "xai_lease_lost",
          detail: { provider: "supergrok-subscription" },
        });
        if (recovery.action === "stale") {
          acknowledgeLostAttemptOwnership();
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        acknowledgeRecoveryQuiescence();
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
        activityStatus = "recovering";
        turnMetricOutcome = "recovering";
        return claimedResult({ status: "recovering" });
      }
      // Definitive Codex credential/account refusals are the only provider
      // errors that may walk the pool. This is an explicit checkpoint + SAME
      // turn recovery, never an SDK/Temporal blind retry. A network break,
      // malformed/partial 200 stream, invalid content, prompt 4xx, or provider
      // 5xx does not classify here and therefore cannot consume another
      // subscription or duplicate a side effect.
      const codexCredentialFailure =
        settings.codexCredentialLeasingEnabled && isCodexTurn && effectiveCodexCredentialId
          ? classifyCodexCredentialFailure(error)
          : null;
      if (
        codexCredentialFailure &&
        effectiveCodexCredentialId &&
        publish &&
        turnId &&
        turnStartedPublished
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
          const servingCached = before.find((account) => account.id === effectiveCodexCredentialId);
          const usageSnapshot = latestCodexUsage as CodexUsageHeaderSnapshot | null;
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
                  turnId,
                  credentialId: effectiveCodexCredentialId,
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
              turnId,
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
                priorCredentialId: effectiveCodexCredentialId,
                accounts,
                now: new Date(),
              })
            : ({ kind: "none" } as const);
          const candidateAvailable =
            statePersisted &&
            Boolean(rotation?.rotationEnabled && rotation?.leaseRotationEnabled) &&
            decision.kind === "active" &&
            decision.credentialId !== effectiveCodexCredentialId;

          if (candidateAvailable && leases.codex.holderId && leases.codex.generation !== null) {
            const settlement = await settleCodexCredentialFailover(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              attemptId: input.attemptId,
              holderId: leases.codex.holderId,
              generation: leases.codex.generation,
              expectedRedispatches: redispatchesAtDispatch,
              maxFailovers: Math.max(1, accounts.length),
              recoveryPayload: {
                triggerEventId: triggerEventId!,
                reason: "codex_credential_failover",
                credentialId: effectiveCodexCredentialId,
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
              activityStatus = "recovering";
              turnMetricOutcome = "recovering";
              return claimedResult({ status: "recovering" });
            }
            if (settlement.action === "stale") {
              // One transaction proves both exact-holder recovery (including a
              // just-expired or reaped lease row) and successor/control-gate
              // rejection. Cross the hard tool fence so a control-gate loss can
              // write its quiescence receipt; a successor-only loss is a no-op.
              acknowledgeLostAttemptOwnership();
              activityStatus = "cancelled";
              turnMetricOutcome = "cancelled";
              return claimedResult({ status: "recovering" });
            }
          }
        }
      }
      const xaiCredentialFailure =
        isXaiTurn && effectiveXaiCredentialId ? classifyXaiCredentialFailure(error) : null;
      if (
        xaiCredentialFailure &&
        effectiveXaiCredentialId &&
        xaiAuthoritySnapshot &&
        leases.xai.subjectId &&
        leases.xai.holderId &&
        leases.xai.generation !== null &&
        publish &&
        turnId &&
        turnStartedPublished
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
          turnId,
          attemptId: input.attemptId,
          workflowId: input.workflowId,
          authoritySnapshot: xaiAuthoritySnapshot,
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
          xaiCredentialQuarantined = true;
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
          activityError = error;
          if (evaluated.action === "resumed") {
            activityStatus = "recovering";
            turnMetricOutcome = "recovering";
            return claimedResult({ status: "recovering" });
          }
          if (evaluated.action === "waiting") {
            activityStatus = "waiting_capacity";
            turnMetricOutcome = "recovering";
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
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }

        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId,
          triggerEventId: triggerEventId!,
          attemptId: input.attemptId,
          reason: "xai_credential_recheck",
          detail: failurePayload,
        });
        if (recovery.action === "stale") {
          acknowledgeLostAttemptOwnership();
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        acknowledgeRecoveryQuiescence();
        await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, recovery.events);
        activityStatus = "recovering";
        turnMetricOutcome = "recovering";
        activityError = error;
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
      if (usageLimit && publish && turnId && turnStartedPublished) {
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
        if (effectiveCodexCredentialId) {
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
            const serving = accounts.find((a) => a.id === effectiveCodexCredentialId) ?? null;
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
              effectiveCodexCredentialId,
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
              a.id === effectiveCodexCredentialId ? { ...a, exhaustedUntil: until } : a,
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
                priorCredentialId: effectiveCodexCredentialId,
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
                resetsInSeconds: Math.ceil(
                  Math.max(0, allCappedResetAt.getTime() - Date.now()) / 1000,
                ),
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
            turnId,
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
                  expectedRedispatches: redispatchesAtDispatch,
                }
              : {}),
          });
          if (armed.action === "waiting") {
            await publishDurableSessionEvents(
              bus,
              input.workspaceId,
              input.sessionId,
              armed.events,
            );
            turnMetricOutcome = "recovering";
            activityStatus = "waiting_capacity";
            activityError = error;
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
          !(await settle!({
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
        turnMetricOutcome = "failed";
        activityStatus = "idle";
        activityError = error;
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
              ? Math.min(
                  Math.ceil(usageLimit.resetsInSeconds) * 1000,
                  CODEX_USAGE_LIMIT_MAX_RESUME_MS,
                )
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
      if (error instanceof BudgetExhaustedError && publish && turnId && turnStartedPublished) {
        await flushRuntimeBatcher();
        await historySink.reconcileConversationTruth();
        if (
          !(await settle!({
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
        turnMetricOutcome = "completed";
        await recordUsageEvent(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "agent_run.completed",
          quantity: 1,
          unit: "run",
          sourceResourceType: "session_turn",
          sourceResourceId: turnId,
          sessionId: input.sessionId,
          turnId,
          turnAttemptId: input.attemptId,
          idempotencyKey: `usage:agent_run.completed:${turnId}`,
        });
        activityStatus = "idle";
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
        isCodexTurn && effectiveCodexCredentialId
          ? classifyCodexEncryptedArtifactRejection(error)
          : null;
      if (
        encryptedArtifactRejection &&
        effectiveCodexCredentialId &&
        publish &&
        turnId &&
        turnStartedPublished
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
          lastCodexRequestOpaqueArtifacts,
        );
        const rejectedRunStateId =
          historySink.providerArtifactCandidates.runStateId &&
          lastCodexRequestOpaqueArtifacts.length > 0
            ? historySink.providerArtifactCandidates.runStateId
            : undefined;
        const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId,
          triggerEventId: triggerEventId!,
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
          activityStatus = "cancelled";
          turnMetricOutcome = "cancelled";
          return claimedResult({ status: "cancelled" });
        }
        if (recovery.action === "recovering") {
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          turnMetricOutcome = "recovering";
          activityStatus = "recovering";
          activityError = error;
          return claimedResult({ status: "recovering" });
        }
      }
      // A retryable provider/MCP failure is transient external backpressure,
      // not a session or goal failure. The in-client retry budget is already
      // exhausted by the time the error reaches here. Checkpoint conversation
      // truth, recover this SAME accepted turn, then let the workflow re-claim
      // it after a pacing delay. This is independent of goal state and never
      // relies on a synthetic continuation prompt.
      const failure = agentRunFailurePayload(error, {
        isCodexTurn,
      }) as ReturnType<typeof agentRunFailurePayload>;
      if (isSessionEventPersistenceError(error)) {
        // Preserve the exact source message in the internal runtime diagnostic;
        // SQLSTATE/catalog facts remain separate classification attributes.
        observability.error("session event persistence failed", {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
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
      if (failure.retryable && publish && turnId && turnStartedPublished) {
        try {
          const nextProviderRecoveryCount = providerRecoveryCount + 1;
          const recoveryResult = providerRecoveryResult({
            failureCode: failure.code,
            attemptNumber: nextProviderRecoveryCount,
            retryAfterMs: providerRetryAfterMs(error),
          });
          await flushRuntimeBatcher();
          await historySink.reconcileConversationTruth({ requireDurable: true });
          const recovery = await requestSessionTurnRecovery(db, input.workspaceId, {
            sessionId: input.sessionId,
            turnId,
            triggerEventId: triggerEventId!,
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
            activityStatus = "cancelled";
            turnMetricOutcome = "cancelled";
            return claimedResult({ status: "cancelled" });
          }
          acknowledgeRecoveryQuiescence();
          await publishDurableSessionEvents(
            bus,
            input.workspaceId,
            input.sessionId,
            recovery.events,
          );
          turnMetricOutcome = "recovering";
          activityStatus = "recovering";
          activityError = error;
          return claimedResult(recoveryResult);
        } catch (recoveryError) {
          const escaped = escapedMcpTimeoutRecoveryFailure({
            failureCode: failure.code,
            modelRequestStarted,
            detail: {
              turnId,
              triggerEventId: triggerEventId!,
              executionGeneration,
            },
          });
          if (escaped) {
            activityStatus = "recovering";
            turnMetricOutcome = "recovering";
            activityError = error;
            throw escaped;
          }
          throw recoveryError;
        }
      }
      activityStatus = "failed";
      activityError = error;
      if (!turnId) {
        throw preClaimAdmissionFailure(error);
      }
      if (!publish || !turnStartedPublished) {
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
        !(await settle!({
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
      turnMetricOutcome = "failed";
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
        turnId,
      );
      return claimedResult({ status: "failed" });
    } finally {
      // This is the logical ownership boundary. Abort before any fallible
      // housekeeping so a still-pending provider establish releases its private
      // holder/timer even when Temporal itself never delivered cancellation.
      if (resolvedSandbox === null && !sandboxResumeController.signal.aborted) {
        sandboxResumeController.abort(
          cancellationSignal?.reason ?? new Error("TURN_ATTEMPT_FINALIZED"),
        );
      }
      const finalizationStarted = performance.now();
      let finalizationError: unknown;
      let physicalToolQuiescenceConfirmed = !acknowledgeQuiescence;
      let quiescenceReceiptOrProofDurable = !acknowledgeQuiescence;
      const finalizerSignal = turnFinalizerCancellationSignal(cancellationSignal, activityStatus);
      try {
        const toolCancellationFence = toolCancellationFenceRef.current;
        // Every renewal controller is an attempt-owned sandbox writer. Capture
        // and close all of them before the tool/run-writer drain and before the
        // quiescence receipt; none may start another admitted write afterward.
        gitCredentialRenewalClosed = true;
        const gitRenewalsToStop = gitCredentialRenewals;
        gitCredentialRenewals = [];
        codemodeTokenRenewalClosed = true;
        const codemodeRenewalToStop = codemodeTokenRenewal as CodemodeTokenRenewalController | null;
        codemodeTokenRenewal = null;
        runCredentialRenewalClosed = true;
        const runRenewalToStop = runCredentialRenewal as RunCredentialRenewalController | null;
        runCredentialRenewal = null;

        // Attempt-qualified credential deletion is also a real workspace write.
        // Perform it under the same admission fence before publishing physical
        // quiescence; a failure deliberately keeps the receipt closed.
        const credentialSessionToClear = runCredentialSession;
        runCredentialSession = null;
        if (credentialSessionToClear) {
          const clearAttemptCredentials = async (): Promise<void> =>
            await clearRunCredentialsForAttempt(credentialSessionToClear, {
              sessionId: input.sessionId,
              attemptId: input.attemptId,
              executionGeneration,
            });
          await clearAttemptCredentialsWithSettledFence({
            activityStatus,
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
                "opengeni.turn_id": turnId ?? "",
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
        attemptWritersDrained = true;
        if (acknowledgeQuiescence) {
          // A cancellation before sandbox-backed capabilities exist still has
          // no tool controller to drain. Sandbox agent construction fails closed
          // when a backend exists but no controller was installed. Renewal
          // writers, when present, were drained above in either case.
          physicalToolQuiescenceConfirmed = true;
        }
        if (acknowledgeQuiescence && physicalToolQuiescenceConfirmed) {
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
            heartbeat: (attempt, retryMs) => {
              activityContext?.heartbeat({
                phase: "quiescence-proof-delivery",
                sessionId: input.sessionId,
                attemptId: input.attemptId,
                deliveryAttempt: attempt,
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
              console.error(
                "agent turn quiescence event fanout failed",
                safeErrorDiagnostic(error),
              );
            },
            onSignalFailure: (error, attempt, retryMs) => {
              console.error("agent turn quiescence proof signal failed; retrying", {
                error: safeErrorDiagnostic(error),
                attempt,
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
        if (machineOpEvents.length > 0 && turnId && executionGeneration > 0) {
          await waitForTurnFinalizerStep(
            appendAndPublishTurnEventsFenced(
              db,
              bus,
              input.workspaceId,
              input.sessionId,
              turnId,
              executionGeneration,
              input.attemptId,
              machineOpEvents.map((event) => ({
                ...event,
                turnId: turnId ?? null,
              })),
            ).catch(() => undefined),
            finalizerSignal,
          );
        }
        // Multi-account P4: flush the serving account's free per-turn caches ONCE,
        // best-effort (same discipline as today's usage write). Both writers skip
        // version/updatedAt, so neither can race the token-refresh CAS.
        if (effectiveCodexCredentialId) {
          // Part A: the latest scraped usage-header snapshot → the P2 usage cache. A
          // full both-windows snapshot (parseCodexUsageHeaders gates on both), so this
          // is byte-identical to the /wham/usage write — no partial-window clobber.
          if (latestCodexUsage) {
            const usageMutation = await waitForTurnFinalizerStep(
              recordCodexAccountUsageWithWakeTargets(
                db,
                input.workspaceId,
                effectiveCodexCredentialId,
                latestCodexUsage,
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
          turnId &&
          leases.codex.holderId &&
          leases.codex.generation !== null
        ) {
          await waitForTurnFinalizerStep(
            releaseCodexCredentialLease(
              db,
              input.accountId,
              input.workspaceId,
              turnId,
              leases.codex.holderId,
              leases.codex.generation,
            ).catch(() => undefined),
            finalizerSignal,
          );
          leases.codex.held = false;
        }
        if (
          effectiveXaiCredentialId &&
          leases.xai.subjectId &&
          xaiRequestContext &&
          !xaiCredentialQuarantined
        ) {
          const quota = await waitForTurnFinalizerStep(
            fetchXaiSubscriptionQuota({ context: xaiRequestContext }).catch(() => null),
            finalizerSignal,
          );
          if (quota) {
            await waitForTurnFinalizerStep(
              updateXaiQuotaMetadata(db, {
                workspaceId: input.workspaceId,
                subjectId: leases.xai.subjectId,
                credentialId: effectiveXaiCredentialId,
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
          turnId &&
          leases.xai.subjectId &&
          leases.xai.holderId &&
          leases.xai.generation !== null
        ) {
          await waitForTurnFinalizerStep(
            releaseXaiCredentialLease(db, {
              workspaceId: input.workspaceId,
              subjectId: leases.xai.subjectId,
              turnId,
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
            `[sandbox-e2e] capture preflight ownership=${settings.sandboxOwnershipEnabled} enabled=${settings.workspaceCaptureEnabled} resolved=${Boolean(resolvedSandbox)} session=${Boolean(setupBoxSession)} group=${Boolean(sandboxGroupId)} storage=${Boolean(objectStorage)}`,
          );
        }
        const runTurnEndPersistence = shouldRunTurnEndWorkspacePersistence({
          activityStatus,
          cancellationRequested: finalizerSignal?.aborted === true,
        });
        if (
          runTurnEndPersistence &&
          turnId &&
          resolvedSandbox &&
          setupBoxSession &&
          sandboxGroupId
        ) {
          // Block new periodic snapshots, then drain any one already in flight.
          // Keep the lease heartbeat itself running: capture may legitimately
          // exceed the 90s holder TTL, and the reaper must remain unable to drain
          // the exact box while this holder still reads it.
          turnEndCaptureInProgress = true;
          if (snapshotInFlight) {
            await waitForWarmSnapshot(
              snapshotInFlight,
              settings.sandboxSnapshotTimeoutMs,
              finalizerSignal,
            );
          }
          const captureEstablished = resolvedSandbox.established;
          await captureWorkspaceRevision({
            db,
            objectStorage,
            settings,
            publish: async (events) => {
              await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
            },
            session: setupBoxSession as ChannelASession,
            openReadSession: async () =>
              await openFreshWorkspaceCaptureSession({
                backendId: captureEstablished.backendId,
                client: captureEstablished.client,
                session: setupBoxSession as ChannelASession,
                expectedInstanceId: captureEstablished.instanceId,
              }),
            leaseEpoch: resolvedSandbox.leaseEpoch,
            sandboxGroupId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            attemptId: input.attemptId,
            observability,
            ...(finalizerSignal ? { signal: finalizerSignal } : {}),
          });
        }
        toolPreparationClosing = true;
        if (toolPreparationReady) {
          await waitForTurnFinalizerStep(
            toolPreparationReady.catch(() => undefined),
            finalizerSignal,
          );
        }
        if (codemodeDispatcher) {
          await waitForTurnFinalizerStep(
            codemodeDispatcher.close().catch(() => undefined),
            finalizerSignal,
          );
          codemodeDispatcher = null;
        }
        if (preparedTools) {
          await waitForTurnFinalizerStep(
            preparedTools.close().catch(() => undefined),
            finalizerSignal,
          );
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (turnSandboxProvisioner?.hasStarted()) {
          await waitForTurnFinalizerStep(
            turnSandboxProvisioner.waitForSettled(30_000),
            finalizerSignal,
          );
        } else if (prefetchedManagedBox) {
          // Create finished (or was aborted) before get()/setup. Join so a
          // successful prefetch cannot leak a holder after this attempt ends.
          await waitForTurnFinalizerStep(
            prefetchedManagedBox.then(
              (box) => {
                prefetchedManagedBoxResult = box;
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
        if (leaseHeartbeatTimer) {
          stopLeaseHeartbeat();
        }
        if (rotationInFlight) {
          await waitForTurnFinalizerStep(rotationInFlight, finalizerSignal).catch(() => undefined);
        }
        // A recording normally closes inside the attempt-fenced turn settlement.
        // Reaching finally with one still active means settlement threw, never ran,
        // or lost ownership. Stop ffmpeg and mark only this exact attempt-owned row
        // failed; publish no event and leave the artifact recoverable on the box.
        await waitForTurnFinalizerStep(
          abandonActiveRecording(
            "activity ended without recording settlement",
            didComputerUse ? "failed" : "discard",
          ),
          finalizerSignal,
        );
        if (resolvedSandbox) {
          // TURN-END mid-session snapshot (sandbox-file-persistence): fold the
          // turn's finished /workspace onto the lease before releasing the holder,
          // so the work this turn just produced survives any unclean box death in
          // the idle window ahead. Throttled by the same interval as the heartbeat
          // tick (a short turn right after a snapshot skips — bounded-loss contract
          // is the interval, not per-turn). Best-effort and time-capped by the
          // helper's own failure discipline; never delays release on failure.
          const settledTurnId = turnId;
          if (runTurnEndPersistence && setupBoxSession && sandboxGroupId && settledTurnId) {
            // Single-flight vs the heartbeat capture: the timer is already cleared
            // above, but a capture it launched may still be in flight — and that
            // capture predates the turn's final writes. Wait for it, but only up
            // to the snapshot timeout: release must never depend on an unbounded
            // provider capture.
            if (snapshotInFlight) {
              await waitForWarmSnapshot(
                snapshotInFlight,
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
                sandboxGroupId,
              },
              setupBoxSession,
              resolvedSandbox.leaseEpoch,
              finalizerSignal,
            );
            if (persisted && publish) {
              await publish([
                {
                  type: "sandbox.box.snapshot",
                  payload: { trigger: "turn-end" },
                },
              ]).catch(() => undefined);
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
        const sandboxReleaseTargets = new Set(lateSandboxesAwaitingWriterDrain);
        lateSandboxesAwaitingWriterDrain.clear();
        if (resolvedSandbox) {
          sandboxReleaseTargets.add(resolvedSandbox);
          resolvedSandbox = null;
        } else if (prefetchedManagedBoxResult) {
          sandboxReleaseTargets.add(prefetchedManagedBoxResult);
        }
        prefetchedManagedBoxResult = null;
        if (attemptWritersDrained) {
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
            cancellation_requested: String(cancellationRequestedAt !== null),
          },
          value: finalizationDurationSeconds,
        });
        if (cancellationRequestedAt !== null) {
          const physicalCancellationDurationSeconds =
            (completedAt - cancellationRequestedAt) / 1000;
          observability.observeHistogram({
            name: "opengeni_turn_physical_cancellation_duration_seconds",
            help: "Time from Temporal cancellation delivery until the activity physically stops.",
            value: physicalCancellationDurationSeconds,
          });
          observability.info("agent turn physical cancellation completed", {
            durationMs: Math.round(physicalCancellationDurationSeconds * 1000),
            ...(sandboxGroupId
              ? {
                  sandboxLeaseKey: sandboxLeaseTelemetryKey(input.workspaceId, sandboxGroupId),
                }
              : {}),
          });
        }
        observability.recordWorkerActivity({
          activity: "runAgentTurn",
          status: finalizationError ? "cleanup_failed" : activityStatus,
          durationSeconds,
        });
        if (turnId && activityStatus !== "unknown") {
          turnLifecycleMetricsFor(observability).finish(turnId, turnMetricOutcome, durationSeconds);
        }
        activitySpan.end({
          attributes: {
            "opengeni.turn_id": turnId ?? "",
            "opengeni.status": activityStatus,
            "opengeni.variable_set_id": variableSetId,
            "opengeni.rig_id": rigId,
            "opengeni.rig_version_id": rigVersionId,
            "opengeni.codex_credential_id": effectiveCodexCredentialId ?? "",
            "opengeni.duration_ms": Math.round(durationSeconds * 1000),
            "opengeni.finalization_duration_ms": Math.round(finalizationDurationSeconds * 1000),
          },
          error:
            finalizationError || activityError
              ? safeErrorForTelemetry(finalizationError ?? activityError)
              : undefined,
        });
        // This timer runs only after the activity promise and its full turn
        // stack unwind. Checkpoint collection alone cannot reclaim objects that
        // remain strongly reachable until this terminal boundary.
        turnCompletionMemoryCollector.schedule(observability);
        assertPhysicalToolQuiescenceForCancellation({
          acknowledgeQuiescence,
          physicalToolQuiescenceConfirmed,
          failure: finalizationError,
        });
        assertSessionAttemptQuiescenceRecoveryDurable({
          acknowledgeQuiescence,
          physicalToolQuiescenceConfirmed,
          receiptOrProofDurable: quiescenceReceiptOrProofDurable,
          failure: finalizationError,
        });
      }
    }
  };
}
