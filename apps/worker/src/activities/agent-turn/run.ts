import {
  getScheduledVariableSetExpectedGenerationForAttempt,
  getSessionRootId,
  persistAttemptToolCatalog,
  selectXaiCredentialForUse,
  materializeXaiCredentialForRun,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  getXaiSessionAccountPin,
  setXaiSessionAccountPin,
  getWorkspaceGrant,
  countSessionHistoryItems,
  setSessionLastInputTokensForTurnAttempt,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  getWorkspaceVideoGenerationPolicy,
  loadWorkspaceVercelAiGatewayCredentialLease,
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  prepareConnectorActionApproval,
  withCodexAppsRequestAuthorization,
} from "@opengeni/db";
import { sandboxOperationMetricObserver } from "@opengeni/observability";
import {
  REMOTE_COMPACTION_V2_BETA_FEATURE,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  materializeSandboxFileDownloads,
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  refreshGitCredentialBindingTokenFiles,
  refreshCodemodeTokenFile,
  codemodeTokenFileFromEnvironment,
  sandboxFileDownloadFailureNote,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type OpenGeniRuntime,
  type BuildAgentOptions,
  type AttemptConnectorActionBinding,
  type ConnectorActionPolicyHooks,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
  type ConnectorAttachmentMaterializationRequest,
  createFirstPartyInteractionAttemptToolDefinitions,
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
  serviceTierForLatencyMode,
  environmentsEncryptionKeyBytes,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  codemodeWorkspaceUrl,
  resolveModelProvider,
} from "@opengeni/config";
import { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import { buildCodexTokenResolver } from "../codex-auth";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  codexRequestStorage,
  withCodexRequestOverrides,
  type CodexRequestContext,
} from "@opengeni/codex";
import { mergeResourceRefs } from "../common";
import { xaiSubscriptionRequestStorage } from "@opengeni/xai-subscription";
import { buildXaiTurnRequestAuthorization } from "../xai-auth";
import { executeXaiSubscriptionImageGeneration } from "../xai-image-generation";
import {
  defaultSessionMcpServerIds,
  loadRigDefaultVariableSetEnvironment,
  mergeRigDefaultVariableSetEnvironment,
  rigProviderImageContentHash,
  withFrozenPersonalConnectionDelegations,
  resolveSessionToolPolicy,
  videoGenerationCapabilitiesForPolicy,
} from "@opengeni/core";
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
import { startGitCredentialRenewalLoop } from "../git-credential-renewal";
import {
  RUN_CREDENTIAL_EXPIRY_LEAD_MS,
  startRunCredentialRenewalLoop,
} from "../run-credential-renewal";
import {
  CODEMODE_TOKEN_EXPIRY_LEAD_MS,
  startCodemodeTokenRenewalLoop,
} from "../codemode-token-renewal";
import {
  bindRunCredentialResolver,
  runCredentialAuthNeededPayloads,
  runCredentialModelNote,
} from "../run-credentials";
import { withFirstPartyTools } from "../goals";
import { rigProviderImageSourceImage } from "../packs";
import { currentActivityContext } from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { type ResumedTurnSandbox } from "../../sandbox-resume";
import { lazyProvisionEnabled } from "../../sandbox-routing";
import {
  makeMachineOpObserver,
  modelRequestLifecycleMetricsFor,
  recordModelRequestPhase,
  recordCompanyBrainContributions,
  recordTurnSandboxEstablishPolicy,
  recordTurnStartupPhase,
  runtimeMetricsHooksForObservability,
} from "../../observability-metrics";
import {
  modelVisibleCompanyBrainSkillActivations,
  summarizeCompanyBrainContributions,
} from "../../model-context-contributions";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { createTurnHistorySink } from "./history-sink";
import { executeGatewayImageGeneration } from "../gateway-image-generation";
import { executeCodexImageGeneration } from "../codex-image-generation";
import { resolveImageGenerationReferences } from "../image-generation-references";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { sandboxRunAs } from "@opengeni/runtime";
import { VideoGenerationRejectedResult, type ToolAuthNeededPayload } from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";

import { shouldPublishToolAuthNeededForTurn } from "./admission";
import { codexWorkspaceMetricKey } from "./codex";
import { unavailableMcpOperationalContext } from "./errors";
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
import { TurnEventPublisher } from "./model-usage";
import { throwIfTurnOperationCancelled, waitForTurnOperation } from "./sandbox-provision";
import {
  sandboxEstablishPolicyDecision,
  ensureTurnModalRegistryImage,
  sandboxArtifactRuntimeAdmission,
} from "./sandbox-route";
import {
  computerToolModeForTurn,
  structuredToolTransportForTurn,
  shouldDeferNonEagerToolPreparation,
  hostedWebSearchForTurn,
  connectedSubscriptionImageGenerationAuthority,
} from "./tool-policy";
import { createTurnContext } from "./turn-context";
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

    const {
      control,
      attempt,
      billingState,
      sandboxState,
      renewals,
      recordingState,
      eventing,
      workspaceRefs,
      providerTurn,
    } = createTurnContext({
      settings,
      cancellationRequestedAt: cancellationSignal?.aborted ? performance.now() : null,
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
      observability,
      cancellationSignal,
      activityContext,
      sandboxRotationController,
      sandboxState,
      recordingState,
      eventing,
      attempt,
    });
    const {
      requireResolvedSandboxForMutation,
      runWorkspaceMutationForSandbox,
      stopLeaseHeartbeat,
      abandonActiveRecording,
      flushRuntimeBatcher,
      maybeStartOnTurnRecording,
      finalizeTurnOpStreamOps,
    } = sandboxRuntime;

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

    // Rig telemetry (M3): set once the session loads; empty string for a rig-less
    // turn (mirrors variableSetId). Read by the activity span's finally block.
    // The Codex account this turn runs on (pin > workspace active), resolved once
    // a codex-billed turn is confirmed and threaded into the token resolver below.
    // The session's Codex credential BEFORE this turn resolved its own — captured
    // before recordSessionActiveCodexCredential overwrites the durable pointer, so
    // a per-call usage log can report whether the serving account CHANGED since the
    // session's previous call (the prompt-cache account-switch hypothesis).
    // The latest usage-header snapshot scraped for free
    // off this turn's `/codex/responses` responses (a turn issues many model calls;
    // latest wins). Flushed ONCE into the P2 usage cache for the serving account in
    // the `finally` — cheaper than a /wham/usage poll AND it self-heals P3 rotation
    // (the proactive + 429 rankers read these exact columns). null ⇒ nothing scraped.
    // Hoisted to activity scope so the finally flush (below) sees it. The sink is
    // wired into codexContext.onUsageHeaders inside the try.
    // Hoisted for same-turn recovery: an approval-decision rerun must
    // re-enter through the suffix/history resume path, never through a swapped trigger.
    try {
      const claimed = await claimTurnAttempt({
        input,
        settings,
        db,
        bus,
        runtime,
        objectStorage,
        observability,
        entitlements,
        cancellationSignal,
        activityContext,
        dispatchId,
        activityStarted,
        control,
        attempt,
        billingState,
        sandboxState,
        recordingState,
        eventing,
        leases,
        media,
        claimedResult,
        acknowledgeLostAttemptOwnership,
        abandonActiveRecording,
      });
      if ("exit" in claimed) return claimed.exit;
      if (!eventing.publish || !eventing.settle) {
        throw new Error("turn eventing was not wired during claim");
      }
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
        const capacityDeps = {
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
          eventing,
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
        } as CapacityPhaseDeps;
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
        settings,
        db,
        bus,
        observability,
        cancellationSignal,
        control,
        attempt,
        billingState,
        eventing: eventing as typeof eventing & {
          publish: NonNullable<(typeof eventing)["publish"]>;
          settle: NonNullable<(typeof eventing)["settle"]>;
        },
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
      } = compactionPrep.ok;

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
      workspaceRefs.variableSetId = workspaceVariableSet?.id ?? "";
      // Session set wins collisions with the rig defaults (explicit precedence).
      const sandboxWorkspaceEnvironmentValues = mergeRigDefaultVariableSetEnvironment(
        rigDefaultEnvironmentValues,
        workspaceVariableSet?.values ?? {},
      );
      const sandboxRoute = await resolveSandboxRoute({
        input,
        settings,
        db,
        eventing,
        media,
        fileAuthoritySubjectId,
        runSettings,
      });
      const {
        routingOn,
        activeSandboxBackend,
        machinePrimary,
        groupBoxBackend,
        sandboxCreationBackend,
        effectiveRunCredentialBackend,
      } = sandboxRoute;

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
          renewals.publishedRunCredentialNotices.add(JSON.stringify(payload));
          await eventing.publish!([{ type: "credential.auth_needed", payload }], true);
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
        const previous = renewals.gitCredentialRenewals;
        renewals.gitCredentialRenewals = [];
        await Promise.all(previous.map(async (controller) => await controller.stop()));
        if (renewals.gitCredentialRenewalClosed) return;

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
              const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
              if (!targetSandbox) {
                throw new Error("Git credential renewal has no exact sandbox lease target");
              }
              await runWorkspaceMutationForSandbox(
                targetSandbox,
                "gitCredentialRenewal",
                async () =>
                  await refreshGitCredentialBindingTokenFiles(tokenSession, [pendingBinding!], {
                    ...(runAs ? { runAs } : {}),
                    ...(eventing.toolCancellationFenceRef.current
                      ? {
                          commandRunner:
                            eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                              eventing.toolCancellationFenceRef.current,
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
                turnId: attempt.turnId,
                providers: failedProviders.join(","),
                errorClass,
                retryDelayMs,
              });
            },
          });
        });
        if (renewals.gitCredentialRenewalClosed) {
          await Promise.all(controllers.map(async (controller) => await controller.stop()));
          return;
        }
        renewals.gitCredentialRenewals = controllers;
      };

      const attachCodemodeTokenRenewal = async (
        tokenSession?: CodemodeTokenWriterSession,
        initialExpiresAt = sandboxCodemodeTokenExpiresAt,
        initialSandbox?: ResumedTurnSandbox,
      ): Promise<void> => {
        if (!codemodeTokenState || !initialExpiresAt) return;
        const previous = renewals.codemodeTokenRenewal;
        renewals.codemodeTokenRenewal = null;
        await previous?.stop();
        if (renewals.codemodeTokenRenewalClosed) return;

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
            const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
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
                  ...(eventing.toolCancellationFenceRef.current
                    ? {
                        commandRunner:
                          eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                            eventing.toolCancellationFenceRef.current,
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
              turnId: attempt.turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (renewals.codemodeTokenRenewalClosed) {
          await controller.stop();
          return;
        }
        renewals.codemodeTokenRenewal = controller;
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
        const previous = renewals.runCredentialRenewal;
        renewals.runCredentialRenewal = null;
        await previous?.stop();
        if (renewals.runCredentialRenewalClosed) return;
        renewals.runCredentialSession = credentialSession;

        const requireTargetSandbox = (): ResumedTurnSandbox => {
          const targetSandbox = sandboxState.resolvedSandbox ?? initialSandbox;
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
                eventing.toolCancellationFenceRef.current
                  ? eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                      eventing.toolCancellationFenceRef.current,
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
                  executionGeneration: attempt.executionGeneration,
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
                executionGeneration: attempt.executionGeneration,
                ...(pruneOtherAttempts ? { pruneOtherAttempts: true } : {}),
                ...(!pruneOtherAttempts ? { pruneSupersededGenerations: true } : {}),
                ...(material.authNeeded.length > 0 &&
                Object.keys(material.environment).length === 0 &&
                material.files.length === 0
                  ? { prunePreviousGenerations: true }
                  : {}),
                ...(eventing.toolCancellationFenceRef.current
                  ? {
                      commandRunner:
                        eventing.toolCancellationFenceRef.current.runSandboxCommand.bind(
                          eventing.toolCancellationFenceRef.current,
                        ),
                    }
                  : {}),
              }),
          );
          for (const payload of runCredentialAuthNeededPayloads(material)) {
            const key = JSON.stringify(payload);
            if (renewals.publishedRunCredentialNotices.has(key)) continue;
            renewals.publishedRunCredentialNotices.add(key);
            await eventing.publish!([{ type: "credential.auth_needed", payload }], true);
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
        if (renewals.runCredentialRenewalClosed) return;
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
              turnId: attempt.turnId,
              errorClass,
              retryDelayMs,
            });
          },
        });
        if (renewals.runCredentialRenewalClosed) {
          await controller.stop();
          return;
        }
        renewals.runCredentialRenewal = controller;
      };

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
        executionGeneration: attempt.executionGeneration,
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
        await eventing.publish!([{ type: "tool.auth_needed", payload }], true);
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
            executionGeneration: attempt.executionGeneration,
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
      await eventing.publish!([
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
        triggerType: trigger.type,
      });
      const materializeConnectorAttachments = async (
        request: ConnectorAttachmentMaterializationRequest,
      ) => {
        throwIfWorkerShuttingDown();
        throwIfTurnCancelled();
        let sandbox = sandboxState.resolvedSandbox;
        if (!sandbox && sandboxState.turnSandboxProvisioner) {
          sandbox = await sandboxState.turnSandboxProvisioner.get();
        }
        const sessionForImport = (sandboxState.lazyOwnedSandbox?.session ??
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
            await eventing.publish?.(events, true);
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
        eventing.preparedTools = await waitForTurnOperation(
          runtime.prepareTools(runSettings, turnTools, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            // Sign the calling turn into the first-party token so tools classify
            // the caller by its own identity (sacred-pause guard), not the racy
            // live active pointer.
            ...(attempt.turnId ? { turnId: attempt.turnId } : {}),
            attemptId: input.attemptId,
            executionGeneration: attempt.executionGeneration,
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
        await eventing.publish!([
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
          eventing.toolPreparationClosing ||
          !attempt.turnId ||
          !tools.attemptToolEnvironment ||
          eventing.codemodeDispatcher
        ) {
          return;
        }
        eventing.codemodeDispatcher = new CodemodeAttemptDispatcher(
          db,
          bus,
          tools.attemptToolEnvironment,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: attempt.turnId,
            attemptId: input.attemptId,
            executionGeneration: attempt.executionGeneration,
          },
          cancellationSignal,
        );
        eventing.codemodeDispatcher.start();
      };
      if (eventing.preparedTools.ready) {
        eventing.toolPreparationReady = eventing.preparedTools.ready.then((tools) => {
          activatePreparedToolEnvironment(tools);
        });
      } else {
        activatePreparedToolEnvironment(eventing.preparedTools);
      }
      // Genesis turn = the first user turn (no assistant history reconciled
      // yet). Durable Postgres state (countSessionHistoryItems includes
      // superseded rows after compaction), NOT a workflow counter (turnsThisRun
      // resets on continueAsNew). Drives the one-shot title hint appended to the
      // agent's instructions; later attempts and goal continuations never match.
      const isGenesisTurn =
        attempt.triggerType === "user.message" &&
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
            const imageReferenceSession = (sandboxState.setupBoxSession ??
              media.sdkOwnedSandboxSession) as ChannelASession | null;
            if (!imageReferenceSession) {
              throw new Error("Sandbox image reference is unavailable");
            }
            const relativePath = path.slice("/workspace/".length);
            const referenceRunAs = sandboxRunAs(eventing.modelRunSettings);
            const channel = new SandboxChannelAService({
              session: imageReferenceSession,
              workspaceRoot: "/workspace",
              leaseEpoch: sandboxState.resolvedSandbox?.leaseEpoch ?? 0,
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
            providerTurn.effectiveCodexCredentialId,
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
            providerTurn.xaiRequestContext,
            providerTurn.effectiveXaiCredentialId,
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
          videoGenerationCredential = managedVideoGenerationCredentialLease(
            eventing.modelRunSettings,
          );
        } else if (videoGenerationPolicy.fundingSource === "workspace_gateway") {
          const workspaceCredential = await loadWorkspaceVercelAiGatewayCredentialLease(
            db,
            eventing.modelRunSettings,
            input.workspaceId,
          );
          if (workspaceCredential) {
            videoGenerationCredential = {
              fundingSource: "workspace_gateway",
              ...workspaceCredential,
            };
          }
        } else if (videoGenerationPolicy.fundingSource === "supergrok_subscription") {
          const encryptionKey = environmentsEncryptionKeyBytes(eventing.modelRunSettings);
          const subjectId = leases.xai.subjectId ?? turn.initiatingHumanSubjectId;
          if (encryptionKey && subjectId) {
            const authoritySnapshot =
              providerTurn.xaiAuthoritySnapshot ??
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
            const selected = providerTurn.effectiveXaiCredentialId
              ? {
                  credentialId: providerTurn.effectiveXaiCredentialId,
                  rotationEnabled: providerTurn.xaiRotationEnabled,
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
                settings: eventing.modelRunSettings,
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
          eventing.modelRunSettings.sandboxBackend === "none" ||
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
                sandboxState.resolvedSandbox?.established.session ?? media.sdkOwnedSandboxSession;
              const fence = eventing.toolCancellationFenceRef.current;
              const runAs = sandboxRunAs(eventing.modelRunSettings);
              let accepted: Awaited<ReturnType<typeof admitVideoGenerationRequest>>;
              try {
                accepted = await admitVideoGenerationRequest({
                  db,
                  storage: objectStorage,
                  settings: eventing.modelRunSettings,
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
        eventing.modelRunSettings.sandboxBackend,
        runtimeSkillActivations,
      );
      try {
        eventing.companyBrainContextContributions = summarizeCompanyBrainContributions(
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
          return runtime.buildAgent(eventing.modelRunSettings, runtimeResources, {
            reasoningEffort: turn.reasoningEffort,
            latencyMode: turnExecutionPolicy.latencyMode,
            ...(serviceTier ? { serviceTier } : {}),
            ...(humanInputResume ? { humanInputResponse: humanInputResume } : {}),
            humanInputEnabled: agentHumanInputEnabled,
            genesisTitleHint: isGenesisTurn,
            sandboxEnvironment,
            ...(eventing.preparedTools.attemptToolCatalog
              ? { attemptToolCatalog: eventing.preparedTools.attemptToolCatalog }
              : {}),
            ...(sandboxArtifactRuntime.available ? { artifactRuntimeAvailable: true } : {}),
            ...(cancellationSignal ? { turnCancellationSignal: cancellationSignal } : {}),
            onToolCancellationFence: (fence) => {
              eventing.toolCancellationFenceRef.current = fence;
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
            mcpServers: eventing.preparedTools.mcpServers,
            resolvedMcpConnectionIds: eventing.preparedTools.resolvedMcpConnectionIds,
            connectorActionPolicy,
            attemptConnectorActionBindings: googleDriveConnectorBindings,
            // LIVE by-reference connector namespaces (fills during this turn's
            // codex_apps tools/list): the codex tool_search description reads it per
            // model call so the model sees the account's real connected sources.
            codexConnectorNamespaces: eventing.preparedTools.codexConnectorNamespaces,
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
            ...(eventing.toolPreparationReady
              ? { toolPreparationReady: eventing.toolPreparationReady }
              : {}),
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
              if (!sandboxState.resolvedSandbox) {
                throw new Error("Computer-use display became ready without a resolved sandbox");
              }
              // This callback is the authoritative execution boundary. Record the
              // action before async ffmpeg startup so transport-event ordering cannot
              // make settlement misclassify a real computer turn as unused.
              recordingState.didComputerUse = true;
              await maybeStartOnTurnRecording(sandboxState.resolvedSandbox, activeSandboxBackend);
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
      if (
        eventing.modelRunSettings.sandboxBackend !== "none" &&
        eventing.toolCancellationFenceRef.current === null
      ) {
        throw new Error(
          "Sandbox agent construction did not install the mandatory turn tool cancellation fence",
        );
      }
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
        settings,
        db,
        bus,
        observability,
        cancellationSignal,
        control,
        attempt,
        billingState,
        eventing: eventing as typeof eventing & {
          publish: NonNullable<(typeof eventing)["publish"]>;
          settle: NonNullable<(typeof eventing)["settle"]>;
        },
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
        eventing: eventing as typeof eventing & {
          publish: NonNullable<(typeof eventing)["publish"]>;
          settle: NonNullable<(typeof eventing)["settle"]>;
        },
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
        agent,
        resolvedModel,
        providerApi,
        runSettings,
        turnTools,
        compactSummarizer,
        compactionModelHistoryProjector,
        generatedImageHistoryProjector,
        modelHistoryProjector,
        compactionModeOptions,
        companyBrainContextContributions: eventing.companyBrainContextContributions,
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
        recordingState,
        eventing,
        providerTurn,
        workspaceRefs,
        runWorkspaceMutationForSandbox,
        requireResolvedSandboxForMutation,
        stopLeaseHeartbeat,
        abandonActiveRecording,
        turnCompletionMemoryCollector,
      });
    }
  };
}
