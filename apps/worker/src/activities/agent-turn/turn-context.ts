import type { Settings } from "@opengeni/config";
import type { CodexUsageHeaderSnapshot } from "@opengeni/codex";
import type { AppendEventInput, ApplySessionTurnSettlementInput } from "@opengeni/db";
import type {
  ModelContextContributionSummary,
  SessionStatus,
  XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import type {
  EstablishedSandboxSession,
  OpenGeniRuntime,
  RunCredentialCommandSession,
  SelfhostedSession,
  TurnToolCancellationFence,
} from "@opengeni/runtime";
import type { XaiSubscriptionRequestContext } from "@opengeni/xai-subscription";
import type { CodemodeAttemptDispatcher } from "../codemode-dispatcher";
import type { CodemodeTokenRenewalController } from "../codemode-token-renewal";
import type { GitCredentialRenewalController } from "../git-credential-renewal";
import type { RunCredentialRenewalController } from "../run-credential-renewal";
import type { createRuntimeBatcher, startActivityHeartbeat } from "../streaming";
import type { RunAgentTurnResult } from "../types";
import type { TurnOutcome } from "../../observability-metrics";
import type { ResumedTurnSandbox, TurnSandboxLeaseHolderId } from "../../sandbox-resume";
import type { TurnEventPublisher } from "./model-usage";
import type { TurnSandboxProvisioner } from "./sandbox-provision";

/** Stamps the claimed turn/attempt ids onto a phase's own outcome. */
export type ClaimedResult = (
  result: Omit<
    Extract<RunAgentTurnResult, { status: Exclude<RunAgentTurnResult["status"], "unclaimed"> }>,
    "turnId" | "attemptId"
  >,
) => RunAgentTurnResult;

export type TurnSettleFn = (input: {
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>;
  turnStatus:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "superseded"
    | "requires_action";
  sessionStatus: SessionStatus;
  activeTurnId: string | null;
  suppressGoalContinuation?: boolean;
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
  // Held for same-turn recovery: an approval-decision rerun must re-enter
  // through the suffix/history resume path, never through a swapped trigger.
  triggerType: string | null;
};

export type BillingState = {
  isCodexTurn: boolean;
  isXaiTurn: boolean;
  isExternallyBilledTurn: boolean;
  chargesOpenGeniCredits: boolean;
  countsTowardTokenCap: boolean;
};

export type SandboxRuntimeState = {
  resolvedSandbox: ResumedTurnSandbox | null;
  attemptWritersDrained: boolean;
  lateSandboxesAwaitingWriterDrain: Set<ResumedTurnSandbox>;
  machinePrimarySession: SelfhostedSession | null;
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
  rotationPreemptionInFlight: Promise<void> | null;
  deadlineRotationRequested: boolean;
  snapshotInFlight: Promise<void> | null;
  firstProviderRequestStarted: boolean;
  turnEndCaptureInProgress: boolean;
  // Backend label for canonical startup milestones. Null until the route
  // resolves, so milestones recorded before then fall back to the turn's own
  // recorded backend and later ones report the effective route.
  startupMilestoneBackend: Settings["sandboxBackend"] | null;
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
  companyBrainContextContributions: readonly ModelContextContributionSummary[] | null;
};

/** Rig telemetry (M3): set once the session loads; empty string for a rig-less
 * turn (mirrors variableSetId). Read by the activity span's finally block. */
export type WorkspaceRefState = {
  variableSetId: string;
  rigId: string;
  rigVersionId: string;
};

export type ProviderTurnState = {
  // The Codex account this turn runs on (pin > workspace active), resolved once
  // a codex-billed turn is confirmed and threaded into the token resolver.
  effectiveCodexCredentialId: string | null;
  effectiveXaiCredentialId: string | null;
  xaiRotationEnabled: boolean;
  xaiAuthoritySnapshot: XaiProviderAccountAuthoritySnapshotV1 | null;
  xaiRequestContext: XaiSubscriptionRequestContext | null;
  xaiCredentialQuarantined: boolean;
  // The session's Codex credential BEFORE this turn resolved its own — captured
  // before recordSessionActiveCodexCredential overwrites the durable pointer, so
  // a per-call usage log can report whether the serving account CHANGED since the
  // session's previous call (the prompt-cache account-switch hypothesis).
  priorSessionCodexCredentialId: string | null;
  // The latest usage-header snapshot scraped for free off this turn's
  // `/codex/responses` responses (a turn issues many model calls; latest wins).
  // Flushed ONCE into the P2 usage cache for the serving account in the turn
  // finalizer — cheaper than a /wham/usage poll AND it self-heals P3 rotation
  // (the proactive + 429 rankers read these exact columns). null ⇒ nothing
  // scraped. Lives on the turn context so the finalizer sees it; the sink is
  // wired into codexContext.onUsageHeaders by the orchestrator.
  latestCodexUsage: CodexUsageHeaderSnapshot | null;
  lastCodexRequestOpaqueArtifacts: readonly string[];
};

export type TurnContext = {
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  sandboxState: SandboxRuntimeState;
  renewals: RenewalState;
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
      chargesOpenGeniCredits: true,
      countsTowardTokenCap: true,
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
      rotationPreemptionInFlight: null,
      deadlineRotationRequested: false,
      snapshotInFlight: null,
      firstProviderRequestStarted: false,
      turnEndCaptureInProgress: false,
      startupMilestoneBackend: null,
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
      companyBrainContextContributions: null,
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
