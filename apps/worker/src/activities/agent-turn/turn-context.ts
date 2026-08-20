import type { Settings } from "@opengeni/config";
import type { CodexUsageHeaderSnapshot } from "@opengeni/codex";
import type { AppendEventInput, ApplySessionTurnSettlementInput } from "@opengeni/db";
import type { SessionStatus, XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";
import type {
  EstablishedSandboxSession,
  OpenGeniRuntime,
  RunCredentialCommandSession,
  TurnToolCancellationFence,
} from "@opengeni/runtime";
import type { XaiSubscriptionRequestContext } from "@opengeni/xai-subscription";
import type { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import type { CodemodeTokenRenewalController } from "../codemode-token-renewal";
import type { GitCredentialRenewalController } from "../git-credential-renewal";
import type { RunCredentialRenewalController } from "../run-credential-renewal";
import type { ActiveRecording } from "../recording";
import type { createRuntimeBatcher, startActivityHeartbeat } from "../streaming";
import type { RunAgentTurnResult } from "../types";
import type { TurnOutcome } from "../../observability-metrics";
import type { ResumedTurnSandbox, TurnSandboxLeaseHolderId } from "../../sandbox-resume";
import type { TurnEventPublisher } from "./model-usage";
import type { TurnSandboxProvisioner } from "./sandbox-provision";

export type TurnSettleFn = (input: {
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>;
  turnStatus: "queued" | "running" | "completed" | "failed" | "cancelled" | "requires_action";
  sessionStatus: SessionStatus;
  activeTurnId: string | null;
  consumeRequestedCompactionFailure?: boolean;
  runState?: ApplySessionTurnSettlementInput["runState"];
}) => Promise<boolean>;

export type TurnControlState = {
  cancellationRequestedAt: number | null;
  activityStatus: RunAgentTurnResult["status"] | "unknown";
  turnMetricOutcome: TurnOutcome | null;
  activityError: unknown;
  acknowledgeQuiescence: boolean;
};

export type AttemptIdentityState = {
  turnId: string | undefined;
  triggerEventId: string | undefined;
  executionGeneration: number;
  providerRecoveryCount: number;
  modelRequestStarted: boolean;
  redispatchesAtDispatch: number;
  triggerType: string | null;
};

export type BillingState = {
  isCodexTurn: boolean;
  isXaiTurn: boolean;
  isExternallyBilledTurn: boolean;
};

export type SandboxRuntimeState = {
  resolvedSandbox: ResumedTurnSandbox | null;
  attemptWritersDrained: boolean;
  lateSandboxesAwaitingWriterDrain: Set<ResumedTurnSandbox>;
  machinePrimarySession: import("@opengeni/runtime").SelfhostedSession | null;
  lazyOwnedSandbox: EstablishedSandboxSession | null;
  firstModelPreparationNestedSandboxMs: number;
  firstModelPreparationNestedSandboxPhases: Array<{
    phase: "admission" | "provider" | "settlement" | "snapshot_wait";
    outcome: "completed" | "failed";
    durationSeconds: number;
  }>;
  turnSandboxProvisioner: TurnSandboxProvisioner<ResumedTurnSandbox> | null;
  resumeManagedGroupBox: (() => Promise<ResumedTurnSandbox>) | null;
  prefetchedManagedBox: Promise<ResumedTurnSandbox> | null;
  prefetchedManagedBoxResult: ResumedTurnSandbox | null;
  setupBoxSession: unknown;
  sandboxHolderId: TurnSandboxLeaseHolderId | null;
  sandboxGroupId: string | null;
  leaseHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  rotationInFlight: Promise<void> | null;
  snapshotInFlight: Promise<void> | null;
  firstProviderRequestStarted: boolean;
  turnEndCaptureInProgress: boolean;
};

export type RenewalState = {
  gitCredentialRenewals: GitCredentialRenewalController[];
  gitCredentialRenewalClosed: boolean;
  runCredentialRenewal: RunCredentialRenewalController | null;
  runCredentialRenewalClosed: boolean;
  runCredentialSession: RunCredentialCommandSession | null;
  codemodeTokenRenewal: CodemodeTokenRenewalController | null;
  codemodeTokenRenewalClosed: boolean;
  publishedRunCredentialNotices: Set<string>;
};

export type RecordingState = {
  activeRecording: ActiveRecording | null;
  computerUseRecordingStart: Promise<void> | null;
  didComputerUse: boolean;
};

export type EventingState = {
  heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
  batcher: ReturnType<typeof createRuntimeBatcher> | null;
  preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null;
  toolPreparationReady: Promise<void> | null;
  toolPreparationClosing: boolean;
  codemodeDispatcher: CodemodeAttemptDispatcher | null;
  toolCancellationFenceRef: { current: TurnToolCancellationFence | null };
  publish: TurnEventPublisher | null;
  settle: TurnSettleFn | null;
  turnStartedPublished: boolean;
  stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
  modelRunSettings: Settings;
  firstModelRequestPreparationStartedAt: number | null;
  firstModelRequestPreparationRecorded: boolean;
  firstModelRequestCheckpointAt: number | null;
};

export type WorkspaceRefState = {
  variableSetId: string;
  rigId: string;
  rigVersionId: string;
};

export type ProviderTurnState = {
  effectiveCodexCredentialId: string | null;
  effectiveXaiCredentialId: string | null;
  xaiRotationEnabled: boolean;
  xaiAuthoritySnapshot: XaiProviderAccountAuthoritySnapshotV1 | null;
  xaiRequestContext: XaiSubscriptionRequestContext | null;
  xaiCredentialQuarantined: boolean;
  priorSessionCodexCredentialId: string | null;
  latestCodexUsage: CodexUsageHeaderSnapshot | null;
  lastCodexRequestOpaqueArtifacts: readonly string[];
};

export type TurnContext = {
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  sandboxState: SandboxRuntimeState;
  renewals: RenewalState;
  recordingState: RecordingState;
  eventing: EventingState;
  workspaceRefs: WorkspaceRefState;
  providerTurn: ProviderTurnState;
};

export function createTurnContext(input: {
  settings: Settings;
  cancellationRequestedAt: number | null;
}): TurnContext {
  return {
    control: {
      cancellationRequestedAt: input.cancellationRequestedAt,
      activityStatus: "unknown",
      turnMetricOutcome: null,
      activityError: undefined,
      acknowledgeQuiescence: false,
    },
    attempt: {
      turnId: undefined,
      triggerEventId: undefined,
      executionGeneration: 0,
      providerRecoveryCount: 0,
      modelRequestStarted: false,
      redispatchesAtDispatch: 0,
      triggerType: null,
    },
    billingState: {
      isCodexTurn: false,
      isXaiTurn: false,
      isExternallyBilledTurn: false,
    },
    sandboxState: {
      resolvedSandbox: null,
      attemptWritersDrained: false,
      lateSandboxesAwaitingWriterDrain: new Set(),
      machinePrimarySession: null,
      lazyOwnedSandbox: null,
      firstModelPreparationNestedSandboxMs: 0,
      firstModelPreparationNestedSandboxPhases: [],
      turnSandboxProvisioner: null,
      resumeManagedGroupBox: null,
      prefetchedManagedBox: null,
      prefetchedManagedBoxResult: null,
      setupBoxSession: null,
      sandboxHolderId: null,
      sandboxGroupId: null,
      leaseHeartbeatTimer: undefined,
      rotationInFlight: null,
      snapshotInFlight: null,
      firstProviderRequestStarted: false,
      turnEndCaptureInProgress: false,
    },
    renewals: {
      gitCredentialRenewals: [],
      gitCredentialRenewalClosed: false,
      runCredentialRenewal: null,
      runCredentialRenewalClosed: false,
      runCredentialSession: null,
      codemodeTokenRenewal: null,
      codemodeTokenRenewalClosed: false,
      publishedRunCredentialNotices: new Set(),
    },
    recordingState: {
      activeRecording: null,
      computerUseRecordingStart: null,
      didComputerUse: false,
    },
    eventing: {
      heartbeatTimer: undefined,
      batcher: null,
      preparedTools: null,
      toolPreparationReady: null,
      toolPreparationClosing: false,
      codemodeDispatcher: null,
      toolCancellationFenceRef: { current: null },
      publish: null,
      settle: null,
      turnStartedPublished: false,
      stream: undefined,
      modelRunSettings: input.settings,
      firstModelRequestPreparationStartedAt: null,
      firstModelRequestPreparationRecorded: false,
      firstModelRequestCheckpointAt: null,
    },
    workspaceRefs: {
      variableSetId: "",
      rigId: "",
      rigVersionId: "",
    },
    providerTurn: {
      effectiveCodexCredentialId: null,
      effectiveXaiCredentialId: null,
      xaiRotationEnabled: false,
      xaiAuthoritySnapshot: null,
      xaiRequestContext: null,
      xaiCredentialQuarantined: false,
      priorSessionCodexCredentialId: null,
      latestCodexUsage: null,
      lastCodexRequestOpaqueArtifacts: [],
    },
  };
}
