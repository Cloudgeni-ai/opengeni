import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  getSessionEvent,
  getHumanInputResumeForEvent,
  getInteractionInterventionResumeForEvent,
  installOrReadTurnExecutionPolicyForAttempt,
  workspaceCodexSubscriptionActive,
  requireSession,
  type AppendEventInput,
  type ApiIntegrationRuntime,
  type CanonicalTurnStartupMilestoneReceipt,
  type SessionTurnForExecution,
  type SessionTurnRecordingSettlement,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced, publishDurableSessionEvents } from "@opengeni/events";
import { deleteRecordingArtifacts } from "@opengeni/runtime";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  resolveTurnExecutionPolicyV1,
  type Settings,
} from "@opengeni/config";
import {
  settingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithWorkspaceGatewayCredential,
  withXaiSubscriptionProvider,
} from "../capabilities";
import { validateIncidentTelemetrySystemUpdateAuthority } from "../incident-telemetry-authority";
import {
  assertSessionAllowsProductModel,
  resolveCodexAppsCredentialIdForRun,
} from "@opengeni/core";
import { TurnAttemptFencedError } from "../turn-attempt-fenced";
import { currentActivityContext, startActivityHeartbeat } from "../streaming";
import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";
import { makeTurnOpJournal, type TurnHeartbeatDetails } from "../../op-journal";
import {
  recordSessionEventAppendLatency,
  recordSessionEventPublishLatency,
  recordTurnStartupPhase,
  recordTurnStartupMilestone,
  turnLifecycleMetricsFor,
} from "../../observability-metrics";
import { prepareRecordingForSettlement, type ActiveRecording } from "../recording";
import { createTurnCredentialLeases } from "./credential-leases";
import { createTurnMediaArtifacts } from "./media-artifacts";
import { readTurnExecutionPolicyV1 } from "@opengeni/contracts";

import {
  credentialSubjectIdForTurnInitiator,
  turnExecutionPolicyBillingIdentity,
  legacyTurnExecutionPolicyInput,
  ensureRunAllowed,
} from "./admission";
import { providerRecoveryCountFromMetadata, isWorkerShutdownCancellation } from "./errors";
import { throwIfTurnOperationCancelled, waitForTurnOperation } from "./sandbox-provision";
import type { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import type {
  AttemptIdentityState,
  BillingState,
  EventingState,
  RecordingState,
  SandboxRuntimeState,
  TurnControlState,
} from "./turn-context";

type ClaimedResult = (
  result: Omit<
    Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
    "turnId" | "attemptId"
  >,
) => RunAgentTurnResult;

export type ClaimTurnDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  runtime: ActivityServices["runtime"];
  objectStorage: ActivityServices["objectStorage"];
  observability: ActivityServices["observability"];
  entitlements: ActivityServices["entitlements"];
  cancellationSignal: AbortSignal | undefined;
  activityContext: ReturnType<typeof currentActivityContext>;
  dispatchId: string;
  activityStarted: number;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  sandboxState: SandboxRuntimeState;
  recordingState: RecordingState;
  eventing: EventingState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  media: ReturnType<typeof createTurnMediaArtifacts>;
  claimedResult: ClaimedResult;
  acknowledgeLostAttemptOwnership: () => void;
  abandonActiveRecording: (reason: string, disposition?: "failed" | "discard") => Promise<void>;
};

export type ClaimTurnOk = {
  turn: SessionTurnForExecution;
  session: Awaited<ReturnType<typeof requireSession>>;
  installedApiIntegrations: readonly ApiIntegrationRuntime[];
  credentialSubjectId: string | undefined;
  fileAuthoritySubjectId: string | null;
  capabilitySettings: Settings;
  codexAppsCredentialId: string | null;
  turnExecutionPolicy: TurnExecutionPolicyV1;
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>;
  humanInputResume: Awaited<ReturnType<typeof getHumanInputResumeForEvent>>;
  interactionInterventionResume: Awaited<
    ReturnType<typeof getInteractionInterventionResumeForEvent>
  >;
  throwIfWorkerShuttingDown: () => void;
  throwIfTurnCancelled: () => void;
  opJournal: ReturnType<typeof makeTurnOpJournal>;
  modelUsageDispatchId: string;
  claimedModelUsageSourceKeys: Set<string>;
  emittedModelUsageSourceKeys: Set<string>;
};

export type ClaimTurnOutcome = { exit: RunAgentTurnResult } | { ok: ClaimTurnOk };

export async function claimTurnAttempt(deps: ClaimTurnDeps): Promise<ClaimTurnOutcome> {
  const {
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
  } = deps;

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
    control.activityStatus = "unclaimed";
    return { exit: { status: "unclaimed", reason: claim.reason } };
  }
  const turn = claim.turn;
  attempt.turnId = turn.id;
  // Establish durable attempt ownership before any later read can fail.
  // Therefore every failure with no turnId came from the one atomic claim
  // transaction and can be classified without conflating ordinary runtime
  // or transport failures with admission failures.
  const session = await requireSession(db, input.workspaceId, input.sessionId);
  attempt.executionGeneration = turn.executionGeneration;
  attempt.providerRecoveryCount = providerRecoveryCountFromMetadata(turn.metadata);
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
    turnId: attempt.turnId,
    executionGeneration: attempt.executionGeneration,
    attemptId: input.attemptId,
    policyForAbsent,
  });
  if (!installedPolicy.accepted) {
    throw new TurnAttemptFencedError(`turn execution policy was fenced: ${installedPolicy.reason}`);
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
  billingState.isExternallyBilledTurn = billingIdentity.externallyBilled;
  billingState.isCodexTurn = billingIdentity.codexSubscription;
  billingState.isXaiTurn = billingIdentity.xaiSubscription;
  attempt.triggerEventId = turn.triggerEventId;
  const trigger = await getSessionEvent(db, input.workspaceId, attempt.triggerEventId);
  if (!trigger) {
    throw new Error(`Trigger event not found: ${attempt.triggerEventId}`);
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
  attempt.triggerType = trigger.type;
  attempt.redispatchesAtDispatch = Number(
    (turn.metadata as { workerDeathRedispatches?: number } | null)?.workerDeathRedispatches ?? 0,
  );
  turnLifecycleMetricsFor(observability).start(attempt.turnId);
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
      billingState.isExternallyBilledTurn,
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
    turnId: attempt.turnId,
    opAcks: {},
  };
  const opJournal = makeTurnOpJournal(activityContext, heartbeatDetails);
  eventing.heartbeatTimer = startActivityHeartbeat(activityContext, heartbeatDetails);
  let producerSeq = 0;
  // One producer per activity execution, not per turn: a turn can run
  // again on the same workflow (recovery, approval rerun), and
  // each execution restarts producerSeq at 1 — a shared producer id would
  // trip the per-producer uniqueness constraint on the event log. The
  // Temporal activity id is unique per scheduled execution.
  const producerId = `${input.workflowId}:${attempt.turnId}${activityContext ? `:${activityContext.info.activityId}` : ""}`;
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
  const recordCanonicalStartupMilestones = (
    receipts: CanonicalTurnStartupMilestoneReceipt[],
  ): void => {
    for (const receipt of receipts) {
      recordTurnStartupMilestone(observability, {
        milestone: receipt.milestone,
        provider: turnExecutionPolicy.providerId,
        backend: sandboxState.startupMilestoneBackend ?? turn.sandboxBackend,
        outcome: receipt.outcome,
        durationSeconds: receipt.durationMs / 1_000,
      });
    }
  };
  eventing.publish = async (
    events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
    immediate = false,
  ) => {
    const inputs = events.map((event) => ({
      ...event,
      payload: event.payload,
      turnId: attempt.turnId!,
      producerId,
      producerSeq: ++producerSeq,
    }));
    const appended = await appendAndPublishTurnEventsFenced(
      db,
      bus,
      input.workspaceId,
      input.sessionId,
      attempt.turnId!,
      attempt.executionGeneration,
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
      turnLifecycleMetricsFor(observability).progress(attempt.turnId!);
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
  eventing.settle = async (inputSettlement) => {
    const attemptClosing = ["completed", "failed", "cancelled", "requires_action"].includes(
      inputSettlement.turnStatus,
    );
    const recordingForSettlement =
      attemptClosing && recordingState.activeRecording && sandboxState.resolvedSandbox
        ? (recordingState.activeRecording as ActiveRecording)
        : null;
    const preparedRecording = recordingForSettlement
      ? await prepareRecordingForSettlement({
          settings,
          objectStorage,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          active: recordingForSettlement,
          session: sandboxState.resolvedSandbox!.established.session,
          didComputerUse: recordingState.didComputerUse,
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
      turnId: attempt.turnId!,
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
      turnId: attempt.turnId!,
      triggerEventId: attempt.triggerEventId!,
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
      control.activityStatus = "cancelled";
      control.turnMetricOutcome = "cancelled";
      return false;
    }
    recordCanonicalStartupMilestones(result.canonicalStartupMilestones);
    turnLifecycleMetricsFor(observability).progress(attempt.turnId!);
    if (recordingForSettlement && preparedRecording) {
      if (result.recordingMutationApplied) {
        recordingState.activeRecording = null;
        if (preparedRecording.deleteArtifactsAfterCommit) {
          await deleteRecordingArtifacts(
            sandboxState.resolvedSandbox!.established.session,
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
    !(await eventing.settle({
      events: [
        { type: "session.status.changed", payload: { status: "running" } },
        {
          type: "turn.started",
          payload: { triggerEventId: attempt.triggerEventId },
        },
      ],
      turnStatus: "running",
      sessionStatus: "running",
      activeTurnId: attempt.turnId,
    }))
  ) {
    return { exit: claimedResult({ status: "cancelled" }) };
  }
  recordTurnStartupPhase(observability, {
    phase: "turn_start_settlement",
    provider: turnExecutionPolicy.providerId,
    backend: turn.sandboxBackend,
    outcome: "completed",
    durationSeconds: (performance.now() - turnStartSettlementStartedAt) / 1_000,
    count: 2,
  });
  eventing.turnStartedPublished = true;

  return {
    ok: {
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
    },
  };
}
