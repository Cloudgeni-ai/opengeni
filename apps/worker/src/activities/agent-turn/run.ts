import {
  getScheduledVariableSetExpectedGenerationForAttempt,
  advanceWorkspaceGeneration,
  verifyWorkspaceMutationSettlement,
  getSandbox,
  readActiveSandbox,
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
  heartbeatLeaseHolder,
  readLease,
  accrueWarmSeconds,
  getMaterializedSandboxFileResources,
  markSandboxFileResourcesMaterialized,
  getWorkspaceVideoGenerationPolicy,
  loadWorkspaceVercelAiGatewayCredentialLease,
  getLiveEnrollmentConnection,
  assertPersonalMachineForAttempt,
  abandonRecordingForTurnAttempt,
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  prepareConnectorActionApproval,
  withCodexAppsRequestAuthorization,
  type SandboxRecord,
} from "@opengeni/db";
import { sandboxOperationMetricObserver } from "@opengeni/observability";
import {
  REMOTE_COMPACTION_V2_BETA_FEATURE,
  REMOTE_COMPACTION_V2_IMPLEMENTATION,
  materializeSandboxFileDownloads,
  materializeRunCredentials,
  clearRunCredentials,
  clearRunCredentialsForAttempt,
  withRunCredentialsSession,
  refreshGitCredentialBindingTokenFiles,
  refreshCodemodeTokenFile,
  codemodeTokenFileFromEnvironment,
  sandboxFileDownloadFailureNote,
  runOwnedSandboxSetup,
  markModelPreparationFirstSandboxOperation,
  recordModelPreparationMeasurement,
  RoutingMutationOutcomeUnknownError,
  sdkBackendIdForSandboxBackend,
  type SandboxFileDownload,
  type SandboxFileDownloadFailure,
  type OpenGeniRuntime,
  type BuildAgentOptions,
  type AttemptConnectorActionBinding,
  type ConnectorActionPolicyHooks,
  type EstablishedSandboxSession,
  type GitCredentialTokenWriterSession,
  type NormalizedRunCredentialMaterial,
  type RunCredentialCommandSession,
  type CodemodeTokenWriterSession,
  type ConnectorAttachmentMaterializationRequest,
  createFirstPartyInteractionAttemptToolDefinitions,
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
  sandboxLifecycleTransitionWaitMs,
  sandboxWarmRateMicrosPerSecond,
  serviceTierForLatencyMode,
  environmentsEncryptionKeyBytes,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  codemodeWorkspaceUrl,
  resolveModelProvider,
  type Settings,
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
import { createRuntimeBatcher, currentActivityContext } from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import {
  resumeBoxForTurn,
  maybePersistWarmWorkspaceSnapshot,
  waitForWarmSnapshot,
  type ResumedTurnSandbox,
} from "../../sandbox-resume";
import {
  wrapTurnBoxWithRouting,
  wrapLazyTurnBoxWithRouting,
  establishSelfhostedTurnSession,
  routingEnabled,
  lazyProvisionEnabled,
} from "../../sandbox-routing";
import {
  makeMachineOpObserver,
  modelRequestLifecycleMetricsFor,
  recordCreditMicros,
  recordModelRequestPhase,
  recordSandboxLogicalProvision,
  recordSandboxProvisionAttempt,
  recordCompanyBrainContributions,
  recordTurnSandboxEstablishPolicy,
  recordTurnStartupPhase,
  runtimeMetricsHooksForObservability,
} from "../../observability-metrics";
import {
  modelVisibleCompanyBrainSkillActivations,
  summarizeCompanyBrainContributions,
} from "../../model-context-contributions";
import { beginRecording, discardUnpublishedRecording, type ActiveRecording } from "../recording";
import { ToolResultSpill } from "./tool-result-spill";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { createTurnHistorySink } from "./history-sink";
import { executeGatewayImageGeneration } from "../gateway-image-generation";
import { executeCodexImageGeneration } from "../codex-image-generation";
import { resolveImageGenerationReferences } from "../image-generation-references";
import {
  ChannelAPartialMutationError,
  SandboxChannelAService,
  type ChannelASession,
} from "@opengeni/runtime/sandbox";
import { sandboxRunAs } from "@opengeni/runtime";
import { VideoGenerationRejectedResult, type ToolAuthNeededPayload } from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import { createModelCheckpointMemoryCollector } from "../../model-checkpoint-memory-collector";

import { shouldPublishToolAuthNeededForTurn } from "./admission";
import { codexWorkspaceMetricKey } from "./codex";
import { unavailableMcpOperationalContext, safeErrorDiagnostic } from "./errors";
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
import {
  shouldStartPeriodicWorkspaceSnapshot,
  releaseTurnSandboxAfterWriterDrain,
  finalizeDurableTurnOpStreams,
} from "./quiescence";
import {
  SandboxDeadlineRotationError,
  throwIfTurnOperationCancelled,
  waitForTurnOperation,
  classifySandboxLogicalProvisionFailure,
  isLazySandboxProvisionRetryable,
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

    // P1.2 ownership inversion: when sandboxOwnershipEnabled, the turn resolves
    // the one box by id from the group lease and injects it NON-OWNED into the
    // run. null when the flag is off (byte-for-byte the legacy build-and-discard
    // path) OR when the backend is "none". Released + dropped in `finally`.
    const releaseLateSandbox = async (sandbox: ResumedTurnSandbox): Promise<void> => {
      sandboxState.lateSandboxesAwaitingWriterDrain.add(sandbox);
      // Drop the holder/timer immediately, but keep its null-outcome admissions
      // fenced until the shared attempt writer drain completes. The staged
      // release serializes a later proof-bearing call behind this one.
      await sandbox.release().catch(() => undefined);
      if (!sandboxState.attemptWritersDrained) return;
      try {
        await releaseTurnSandboxAfterWriterDrain(sandbox);
        sandboxState.lateSandboxesAwaitingWriterDrain.delete(sandbox);
      } catch (error) {
        console.error(
          "late sandbox quiesced release failed (turn outcome unaffected)",
          safeErrorDiagnostic(error),
        );
      }
    };
    const requireResolvedSandboxForMutation = (message: string): ResumedTurnSandbox => {
      if (!sandboxState.resolvedSandbox) throw new Error(message);
      return sandboxState.resolvedSandbox;
    };
    // The machine-primary SelfhostedSession (the UNWRAPPED backend, not the
    // routing proxy). Kept as a fallback finalizer; the routing proxy normally
    // aggregates it together with every machine reached after a mid-turn swap.
    // The UN-PROXIED established box session, captured BEFORE wrapTurnBoxWithRouting.
    // Platform setup (beforeAgentStart hooks + file materialization) execs against
    // THIS handle so a mid-turn sandbox_swap can never re-route those execs onto a
    // connected machine (the user's real computer).
    const finalizeTurnOpStreamOps = async (): Promise<void> => {
      await finalizeDurableTurnOpStreams(
        [sandboxState.lazyOwnedSandbox?.session, sandboxState.resolvedSandbox?.established.session],
        sandboxState.machinePrimarySession,
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
      const current = sandboxState.resolvedSandbox;
      const previousSession = current?.established.session;
      const preserveRoutingProxy =
        current !== null && previousSession !== sandboxState.setupBoxSession;
      sandboxState.setupBoxSession = rebound.established.session;
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
      if (
        !sandboxState.sandboxGroupId ||
        !sandboxState.sandboxHolderId ||
        !attempt.turnId ||
        attempt.executionGeneration <= 0
      ) {
        throw new Error("Workspace mutation attempted before exact turn sandbox admission");
      }
      let admissionCaptureWaitMs = 0;
      const identity = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        executionGeneration: attempt.executionGeneration,
        attemptId: input.attemptId,
        holderId: sandboxState.sandboxHolderId,
        sandboxGroupId: sandboxState.sandboxGroupId,
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
    const stopLeaseHeartbeat = (): void => {
      if (!sandboxState.leaseHeartbeatTimer) return;
      clearInterval(sandboxState.leaseHeartbeatTimer);
      sandboxState.leaseHeartbeatTimer = undefined;
    };
    // credential-renewal policy: the worker, not the model, owns renewal of run-scoped Git
    // credentials for a multi-day turn. The controller is attached only after
    // the initial seed reached a real cloud box and is drained before capture.
    // Generic host-owned run material has its own attempt-scoped renewal and
    // write handle. It is always drained and wiped before workspace capture.
    // The delegated Codemode bearer has a one-hour TTL. Renewal is attempt-
    // owned and attaches only after the initial token file reached a real
    // sandbox session; finalization drains an in-flight replacement.
    // MID-SESSION snapshot single-flight guard: the heartbeat tick fires every
    // 10s but a Modal filesystem snapshot can take longer — never overlap two
    // captures on one box. The in-flight capture's promise is held so the
    // turn-end persist can await it (its capture predates the turn's final
    // writes; landing after the fresher turn-end capture started would make
    // the atomic DB throttle discard the fresher one). Interval throttling
    // itself lives in maybePersistWarmWorkspaceSnapshot / persistWarmSnapshot.
    // The heartbeat snapshot is mid-session durability, not first-request
    // preparation. Keep it off the startup critical path until a provider
    // request has actually reached its transport boundary.
    // Turn-end capture needs the lease heartbeat to keep its holder alive, but
    // must prevent that same timer from starting another periodic snapshot
    // while it reads. This gate separates those two responsibilities.
    // Computer-use-only recording. Ordinary shell/filesystem turns leave this
    // null; the first actual computer action starts it after :0 is ready.
    // P4.3 recording gate: flips true in `onComputerUseReady`, the runtime's
    // execution-time callback for the first real computer action. It must flip
    // BEFORE awaiting recording startup: the SDK tool-call stream item can arrive
    // before ffmpeg has finished starting. A plain text turn ("hey"/"continue")
    // never invokes the callback, so settlement performs no storage PUT.
    const abandonActiveRecording = async (
      reason: string,
      disposition: "failed" | "discard" = "failed",
    ): Promise<void> => {
      const recording = recordingState.activeRecording as ActiveRecording | null;
      if (!recording) return;
      recordingState.activeRecording = null;
      if (sandboxState.resolvedSandbox) {
        await stopRecordingOnBox(
          sandboxState.resolvedSandbox.established.session,
          recording.proc,
        ).catch(() => undefined);
      }
      if (!attempt.turnId || attempt.executionGeneration <= 0) return;
      await abandonRecordingForTurnAttempt(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: attempt.turnId,
        executionGeneration: attempt.executionGeneration,
        attemptId: input.attemptId,
        recordingId: recording.recordingId,
        disposition,
        reason,
      }).catch(() => undefined);
    };
    const flushRuntimeBatcher = async () => {
      const current = eventing.batcher as ReturnType<typeof createRuntimeBatcher> | null;
      await current?.flush().catch(() => undefined);
    };
    // Reconciliation is declared before provider routing so every turn-end path
    // can share one closure. It cannot run until `stream` exists, by which time
    // this value has been rebound to the turn's resolved model policy.
    const publishSandboxLifecycleEvents = async (sandbox: ResumedTurnSandbox): Promise<void> => {
      const established = sandbox.established;
      if (eventing.publish && established.origin && established.origin !== "resumed") {
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
        await eventing.publish(lifecycleEvents).catch(() => undefined);
      }
    };
    const publishSandboxLost = async (lostSandbox: { instanceId: string }): Promise<void> => {
      if (!eventing.publish) return;
      await eventing
        .publish([
          {
            type: "sandbox.box.lost",
            payload: { sandboxId: lostSandbox.instanceId },
          },
        ])
        .catch((publishError) => {
          // The lease transition is already authoritative. A fenced/failed audit
          // append must not prevent the same logical turn from recovering.
          console.error("sandbox box lost event publish failed", safeErrorDiagnostic(publishError));
        });
    };
    const startLeaseHeartbeat = (
      sandbox: ResumedTurnSandbox,
      warmBackend: Settings["sandboxBackend"] | undefined,
    ): void => {
      if (sandboxState.leaseHeartbeatTimer) return;
      if (!sandboxState.sandboxHolderId || !sandboxState.sandboxGroupId) {
        return;
      }
      // Refresh the lease TTL on the activity-heartbeat cadence (10s, well
      // inside the 90s lease TTL). EPOCH-FENCED: a superseded owner's refresh
      // is rejected (returns false) and we stop refreshing — the box rides the
      // provider idle-timeout and the next dispatch re-establishes it. Best-
      // effort: a transient DB error must never fail the turn.
      const heartbeatEpoch = sandbox.leaseEpoch;
      const heartbeatHolderId = sandboxState.sandboxHolderId;
      const heartbeatGroupId = sandboxState.sandboxGroupId;
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
      sandboxState.leaseHeartbeatTimer = setInterval(() => {
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
            if (alive || sandboxState.rotationInFlight || sandboxRotationController.signal.aborted)
              return;
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
            sandboxState.rotationInFlight = (async () => {
              // Rotation admission already fenced all new workspace mutations.
              // Wait for an earlier periodic capture, then produce the exact
              // generation-complete checkpoint that licenses aborting this run.
              if (sandboxState.snapshotInFlight) {
                await waitForWarmSnapshot(
                  sandboxState.snapshotInFlight,
                  settings.sandboxSnapshotTimeoutMs,
                  cancellationSignal,
                );
              }
              const snapshotSession = sandboxState.setupBoxSession;
              const snapshotTurnId = attempt.turnId;
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
                sandboxState.rotationInFlight = null;
              });
            await sandboxState.rotationInFlight;
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
        const snapshotSession = sandboxState.setupBoxSession;
        const snapshotTurnId = attempt.turnId;
        if (
          snapshotSession &&
          snapshotTurnId &&
          shouldStartPeriodicWorkspaceSnapshot({
            firstProviderRequestStarted: sandboxState.firstProviderRequestStarted,
            snapshotInFlight: Boolean(sandboxState.snapshotInFlight),
            turnEndCaptureInProgress: sandboxState.turnEndCaptureInProgress,
          })
        ) {
          sandboxState.snapshotInFlight = maybePersistWarmWorkspaceSnapshot(
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
              if (persisted && eventing.publish) {
                await eventing.publish([
                  {
                    type: "sandbox.box.snapshot",
                    payload: { trigger: "heartbeat" },
                  },
                ]);
              }
            })
            .catch(() => undefined)
            .finally(() => {
              sandboxState.snapshotInFlight = null;
            });
        }
      }, 10_000);
      if (
        "unref" in sandboxState.leaseHeartbeatTimer &&
        typeof sandboxState.leaseHeartbeatTimer.unref === "function"
      ) {
        sandboxState.leaseHeartbeatTimer.unref();
      }
    };
    const maybeStartOnTurnRecording = async (
      sandbox: ResumedTurnSandbox,
      effectiveBackend: Settings["sandboxBackend"] | undefined,
    ): Promise<void> => {
      if (recordingState.activeRecording) {
        return;
      }
      if (recordingState.computerUseRecordingStart) {
        await recordingState.computerUseRecordingStart;
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
        recordingState.computerUseRecordingStart = (async () => {
          let begun: Awaited<ReturnType<typeof beginRecording>> | null = null;
          try {
            begun = await beginRecording({
              settings,
              db,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: attempt.turnId!,
              recordingId: randomUUID(),
              mode: "on-turn",
              session: sandbox.established.session,
              runAs: sandboxRunAs(settings),
              reason: null,
            });
            if (!eventing.publish) {
              throw new Error("recording started before the turn event publisher was ready");
            }
            await eventing.publish([{ type: "recording.started", payload: begun.started }]);
            recordingState.activeRecording = begun.active;
          } catch (recordingError) {
            recordingState.activeRecording = null;
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
        await recordingState.computerUseRecordingStart;
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
      let startupMilestoneBackend = claimed.ok.startupMilestoneBackend;
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
          eventing.publish
            ? async (events) => {
                await eventing.publish!(events);
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
      if (machinePrimary && eventing.modelRunSettings.sandboxBackend === "none") {
        eventing.modelRunSettings = {
          ...eventing.modelRunSettings,
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
          sandboxState.sandboxHolderId = managedOwnership?.holderId ?? null;
          sandboxState.sandboxGroupId = managedOwnership?.sandboxGroupId ?? null;
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
                        executionGeneration: attempt.executionGeneration,
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
            sandboxState.machinePrimarySession =
              established.session as import("@opengeni/runtime").SelfhostedSession;
            sandboxState.setupBoxSession = established.session;
            sandboxState.resolvedSandbox = {
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
                          executionGeneration: attempt.executionGeneration,
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
                    executionGeneration: attempt.executionGeneration,
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
            if (sandboxState.sandboxHolderId && sandboxState.sandboxGroupId) {
              const lazyHolderId = sandboxState.sandboxHolderId;
              const lazyGroupId = sandboxState.sandboxGroupId;
              sandboxState.resumeManagedGroupBox = () =>
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
                  sandboxState.resumeManagedGroupBox(),
                  sandboxResumeSignal,
                  releaseLateSandbox,
                );
                const joined = started.catch((error) => {
                  if (isLazySandboxProvisionRetryable(error)) {
                    sandboxState.prefetchedManagedBox = null;
                  }
                  throw error;
                });
                sandboxState.prefetchedManagedBox = joined;
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
            await eventing.publish!(
              [
                {
                  type: "sandbox.operation.started",
                  payload: { name: "sandbox.provision" },
                },
              ],
              true,
            );
            try {
              sandboxState.resolvedSandbox = await waitForTurnOperation(
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
              await eventing.publish!(
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
            sandboxState.setupBoxSession = sandboxState.resolvedSandbox.established.session;
            // Durable box-lifecycle events (sandbox-file-persistence observability):
            // record every box transition in session_events so the NEXT box loss is
            // attributable from the DB alone — worker logs rotate within hours, which
            // left both 2026-07-06 incidents without a durable trace. Best-effort.
            await publishSandboxLifecycleEvents(sandboxState.resolvedSandbox);
            await eventing.publish!(
              [
                {
                  type: "sandbox.operation.completed",
                  payload: {
                    name: "sandbox.provision",
                    ...(sandboxState.resolvedSandbox.established.origin
                      ? { origin: sandboxState.resolvedSandbox.established.origin }
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
            sandboxState.resolvedSandbox = {
              ...sandboxState.resolvedSandbox,
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
                          executionGeneration: attempt.executionGeneration,
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
                    executionGeneration: attempt.executionGeneration,
                    attemptId: input.attemptId,
                  },
                  homeLease: {
                    accountId: input.accountId,
                    sandboxGroupId: session.sandboxGroupId,
                    leaseEpoch: sandboxState.resolvedSandbox.leaseEpoch,
                    instanceId: sandboxState.resolvedSandbox.established.instanceId,
                    backend: groupBoxBackend,
                  },
                },
                sandboxState.resolvedSandbox.established,
              ),
            };
          }
          if (sandboxState.resolvedSandbox) {
            startLeaseHeartbeat(
              sandboxState.resolvedSandbox,
              activeSandboxBackend ?? groupBoxBackend,
            );
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
      if (
        establishPolicy === "on-demand" &&
        sandboxState.sandboxHolderId &&
        sandboxState.sandboxGroupId
      ) {
        const agentDefaultManifest = (agent as { defaultManifest?: unknown }).defaultManifest;
        if (!agentDefaultManifest) {
          throw new Error("Lazy sandbox provisioning requires a SandboxAgent defaultManifest");
        }
        const lazyClient = {
          backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
        } as EstablishedSandboxSession["client"];
        let lazySandboxEstablishmentSettled = false;
        sandboxState.turnSandboxProvisioner = createTurnSandboxProvisioner<ResumedTurnSandbox>(
          async () => {
            throwIfWorkerShuttingDown();
            throwIfTurnCancelled();
            if (!sandboxState.resumeManagedGroupBox) {
              throw new Error("Lazy sandbox provisioning requires a managed group-box resume");
            }
            startRunGitCredentialsMint();
            const provisioned = await (sandboxState.prefetchedManagedBox ??
              sandboxState.resumeManagedGroupBox());
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
              await eventing.publish?.(
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
              sandboxState.setupBoxSession = provisioned.established.session;
              sandboxState.resolvedSandbox = provisioned;
              // This durable completion and its logical metric close at actual box
              // establishment. Credential, rig, repository, and file preparation below
              // must never be attributed to "Starting sandbox" or provision latency.
              await eventing.publish?.(
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
                        await eventing.publish?.(
                          [{ type: event.type, payload: event.payload }],
                          true,
                        );
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
                (measurement) => {
                  if (eventing.firstModelRequestPreparationRecorded) return;
                  sandboxState.firstModelPreparationNestedSandboxMs +=
                    measurement.durationSeconds * 1_000;
                  sandboxState.firstModelPreparationNestedSandboxPhases.push(measurement);
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
              await eventing.publish?.(
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
        sandboxState.lazyOwnedSandbox = wrapLazyTurnBoxWithRouting(
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
                    executionGeneration: attempt.executionGeneration,
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
              executionGeneration: attempt.executionGeneration,
              attemptId: input.attemptId,
            },
          },
          {
            client: lazyClient,
            backendId: sdkBackendIdForSandboxBackend(groupBoxBackend),
            agentDefaultManifest,
            provisioner: sandboxState.turnSandboxProvisioner,
            homeLeaseIdentity: {
              accountId: input.accountId,
              sandboxGroupId: session.sandboxGroupId,
              backend: groupBoxBackend,
            },
            onFirstOperation: (measurement) => {
              if (eventing.firstModelRequestPreparationRecorded) return;
              markModelPreparationFirstSandboxOperation(measurement.durationMs / 1_000);

              for (const nested of sandboxState.firstModelPreparationNestedSandboxPhases) {
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
                    Math.max(
                      0,
                      resolution.durationMs - sandboxState.firstModelPreparationNestedSandboxMs,
                    ) / 1_000,
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

              const nestedSnapshotPhases =
                sandboxState.firstModelPreparationNestedSandboxPhases.filter(
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
