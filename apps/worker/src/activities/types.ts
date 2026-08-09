import type { Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  DocumentAuthorityKind,
  EntitlementsPort,
  ScheduledTaskTriggerType,
  TurnInitiator,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { OpenGeniRuntime } from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";

// Signal (start-if-needed) a session's Temporal workflow so a queued turn it
// cannot otherwise observe gets claimed. Used to wake a PARENT session's
// workflow when a spawned worker completes: the parent may have idled and let
// its workflow run complete, so a plain signal would not start one — this must
// signalWithStart. Injected (not built from the worker's NativeConnection)
// because the worker package owns only the worker runtime, not a client; an
// missing signaler leaves the committed outbox revision for the global repair
// sweep; production workers always inject this dependency.
export type WakeSessionWorkflowSignal = (input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  wakeRevision: number;
  interruptionRequested?: boolean;
}) => Promise<void>;

export type SignalCodexCapacityWorkflow = (input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  wakeRevision: number;
}) => Promise<void>;

/** Start the versioned, per-box sandbox reaper from the history-stable legacy
 * activity. The legacy Schedule workflow must keep its exact historical
 * ScheduleActivity command across mixed-version worker pools. */
export type StartSandboxReaperWorkflow = () => Promise<"started" | "already_running">;

/** Exact activity-owned proof that the hard sandbox/tool fence physically
 * drained. This is delivery evidence only: the workflow still validates the
 * persisted attempt dispatch and commits the authoritative Postgres receipt. */
export type SessionAttemptQuiescenceProof = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  workflowId: string;
  workflowRunId: string;
  activityId: string;
};

export type SignalSessionAttemptQuiesced = (input: SessionAttemptQuiescenceProof) => Promise<void>;

export type InspectSessionAttemptActivity = (input: {
  workflowId: string;
  workflowRunId: string;
  activityId: string;
}) => Promise<"pending" | "settled">;

/** Services shared by both Temporal worker roles. Keep this graph free of the
 * agent runtime and document parser so each process can load only its role. */
export type SharedActivityServices = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  objectStorage: ObjectStorage | null;
  observability: Observability;
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
  /** Durable signalWithStart fallback used only after the activity's direct
   * physical-quiescence receipt write exhausts its bounded DB retries. */
  signalSessionAttemptQuiesced: SignalSessionAttemptQuiesced | null;
  /** Server-authoritative Temporal activity lease inspection used only to
   * recover a missing quiescence receipt after the original activity vanished. */
  inspectSessionAttemptActivity: InspectSessionAttemptActivity | null;
  /** Revision-carrying capacity nudge; generic outbox repair is also sufficient. */
  signalCodexCapacityWorkflow?: SignalCodexCapacityWorkflow | null;
  /** Production control workers inject this Temporal client edge. A null edge
   * deliberately retains the composite implementation for embedded/test hosts. */
  startSandboxReaperWorkflow?: StartSandboxReaperWorkflow | null;
  // §7.5 P3 — host-entitlements port, the WORKER half of the same seam the API
  // edge exposes on `AppDependencies`. When set, `ensureRunAllowed` (turn-entry
  // AND the mid-stream budget valve) delegates the funding decision to
  // `admitRun` instead of reading `getBillingBalance` locally. null/undefined
  // (standalone default) → today's local-ledger read runs unchanged.
  //
  // IDEMPOTENCY: the worker calls `admitRun` ONLY as an admission READ ("may
  // this run/continue?"), never to RECORD consumption. Usage is recorded
  // exactly once, by `recordUsageEvent` keyed on a deterministic idempotency
  // key the API already wrote at create-time — so a host PULL meter that also
  // observes that same recorded event is consulted without double-charging:
  // admission and metering are separate operations, and only metering carries
  // the idempotency key.
  entitlements?: EntitlementsPort | null;
  // §7.6 connection-credential provider — host connection-credential provider, the WORKER half of the
  // federated-connection boundary. When set, the run's per-run credential mint
  // delegates to the host instead of self-minting from `settings`:
  //   - `gitCredentials` REPLACES `createGitHubAppInstallationToken(settings,…)`
  //     in `sandboxEnvironmentForRun` (the GH_TOKEN / git-extraheader source).
  //   - `sandboxSecrets` REPLACES the `environmentsEncryptionKeyBytes(settings)`
  //     decrypt in `loadWorkspaceEnvironmentForRun`.
  // Each leg is independently optional; an unset leg falls through to today's
  // self-mint for THAT leg. null/undefined (standalone default) → both legs
  // self-mint byte-for-byte as today.
  //
  // workspace-scope cross-check CROSS-CHECK: a provider echoes the `workspaceId` it scoped the
  // credential to; the consuming activity ASSERTS agreement with the run's
  // workspace BEFORE injecting `GH_TOKEN` (or applying decrypted values). A host
  // mapping bug returning tenant B's creds for a tenant-A run is caught here.
  connectionCredentials?: ConnectionCredentialsPort | null;
};

/** Control workers own short database and maintenance activities. Document
 * parsing is resolved lazily by the indexing activity itself. */
export type ControlActivityServices = SharedActivityServices;

/** Turn workers own the model loop and never construct document parsers. */
export type TurnActivityServices = SharedActivityServices & {
  runtime: OpenGeniRuntime;
  /** Provider-free test/profiling seam; production injects the real runtime summarizer. */
  summarizeContextForCompaction: typeof import("@opengeni/runtime").summarizeForCompaction;
};

/** Full test/embedded harness retained as a source-compatible superset. */
export type ActivityServices = ControlActivityServices &
  TurnActivityServices & {
    documentServices: DocumentServices;
  };

export type CodexCapacityWaitRef = {
  waiterId: string;
  generation: number;
  nextCheckAt: string;
  wakeRevision: number;
};

export type GetCodexCapacityWaitInput = {
  workspaceId: string;
  sessionId: string;
};

export type ReconcileCodexCapacityWaitInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  waiterId: string;
  generation: number;
  cause: "timer" | "signal" | "queue" | "recovery";
};

export type ReconcileCodexCapacityWaitResult =
  | ({ action: "waiting" } & CodexCapacityWaitRef)
  | { action: "resumed" | "paused" | "superseded" | "stale" };

export type ActivityDependencies = Partial<ActivityServices>;
export type ControlActivityDependencies = Partial<ControlActivityServices>;
export type TurnActivityDependencies = Partial<TurnActivityServices>;

export type RunAgentTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  workflowRunId: string;
  attemptId: string;
  trigger: { kind: "next" } | { kind: "approval"; triggerEventId: string };
};

export type SettleSessionInterruptionsInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  workflowId: string;
  /**
   * Replay-only compatibility for session workflow histories created before
   * the receipt-gated cancellation v2 patch. New histories never send this
   * phase; the exact activity writes the authoritative receipt itself.
   */
  phase?: "logical" | "attempt_quiesced";
};

export type PersistSessionAttemptQuiescenceInput = SessionAttemptQuiescenceProof;

export type ReconcileSessionAttemptQuiescenceInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  workflowId: string;
};

export type ReconcileSessionAttemptQuiescenceResult = {
  action: "quiesced" | "pending" | "stale";
};

export type FailSessionAttemptInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  error?: string;
};

export type RecoverDispatchInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START";
};

export type RecoverDispatchResult =
  // The same current inference is now recoverable. It never enters the prompt
  // queue; the next claim creates a new attempt for this exact turn.
  | { action: "unclaimed" }
  | { action: "recovering"; turnId: string; redispatches: number }
  // The turn is no longer running/requires_action: the timed-out attempt was
  // a zombie that actually settled the turn after the server gave up on its
  // heartbeats. Nothing to redo; the workflow just continues its loop.
  | { action: "stale" }
  // The per-turn crash-loop guard tripped; the workflow must fail the
  // session for real. `redispatches` is the count already consumed (== the
  // ceiling), so the failed attempt was worker death number redispatches + 1.
  | { action: "exceeded"; turnId: string; redispatches: number };

export const ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_TYPE = "EscapedMcpTimeoutRecoveryFailure";
export const ESCAPED_MCP_TIMEOUT_RECOVERY_FAILURE_MESSAGE =
  "MCP request timeout recovery checkpoint failed before model request";

export type EscapedMcpTimeoutRecoveryDetail = {
  turnId: string;
  triggerEventId: string;
  executionGeneration: number;
};

export type RecoverEscapedMcpTimeoutInput = EscapedMcpTimeoutRecoveryDetail & {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
};

export type RecoverEscapedMcpTimeoutResult = {
  action: "recovering" | "stale" | "ineligible";
};

export type PeekSessionWorkInput = {
  workspaceId: string;
  sessionId: string;
};

export type ExpireSessionHumanInputInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  requestId: string;
};

export type ExpireSessionHumanInputResult = {
  action: "expired" | "stale" | "not_found";
};

export type MarkSessionIdleInput = {
  workspaceId: string;
  sessionId: string;
};

export type MaybeContinueGoalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
};

export type MaybeContinueGoalResult = {
  action: "none" | "queue" | "continue" | "paused";
};

export type DispatchScheduledTaskRunInput = {
  workspaceId: string;
  taskId: string;
  /** Stable Temporal workflow identity; retries must reuse the same source row. */
  producerKey?: string;
} & (
  | {
      triggerType: Extract<ScheduledTaskTriggerType, "scheduled">;
      agentRunUsageIdempotencyKey?: never;
      initiator?: never;
    }
  | {
      triggerType: Extract<ScheduledTaskTriggerType, "manual">;
      agentRunUsageIdempotencyKey: string;
      /** Exact identity used by the API-side charge for this same trigger. */
      initiator: TurnInitiator;
    }
);

export type DispatchScheduledTaskRunResult =
  | { action: "deleted" }
  | {
      action: "blocked";
      reason:
        | "insufficient_credits"
        | "monthly_model_cost_limit"
        | "monthly_agent_run_limit"
        | "malformed_manual_trigger";
    }
  | {
      action: "start" | "signal";
      accountId: string;
      workspaceId: string;
      sessionId: string;
      triggerEventId: string;
      workflowId: string;
      workflowWakeRevision: number | null;
    };

type DocumentIndexIdentity = {
  accountId: string;
  workspaceId: string;
  documentId: string;
};

type CurrentDocumentIndexAuthority = {
  authorityKind: DocumentAuthorityKind;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
};

type HistoricalDocumentIndexAuthority = {
  authorityKind?: never;
  authorityWorkspaceId?: never;
  authoritySubjectId?: never;
};

export type IndexDocumentInput = DocumentIndexIdentity &
  (CurrentDocumentIndexAuthority | HistoricalDocumentIndexAuthority);

type ClaimedRunAgentTurnResult = {
  // "recovering": this attempt ended after durably preserving the same current
  // inference for a new attempt. Recovery is not prompt queue work.
  status: "idle" | "requires_action" | "failed" | "cancelled" | "recovering" | "waiting_capacity";
  turnId: string;
  attemptId: string;
  // Provider backpressure pacing: when set on an idle or recovering result, the
  // session workflow holds the loop this long before admitting the next attempt.
  continueDelayMs?: number;
  // Multi-account rotation all-capped idle: every connected Codex subscription is
  // rate-limited/cooling. This is a MANDATORY hold — session.ts must wait
  // continueDelayMs (floored to a minimum) and must NOT treat a 0/elapsed delay as
  // "continue now" (invariant 4: NO THRASH). Distinct from a normal continueDelayMs:0
  // which legitimately means "a rotation candidate is ready, re-dispatch immediately".
  idleUntilReset?: boolean;
  // Durable native zero-pool wait for this same nonterminal logical turn.
  // Unlike continueDelayMs, this reference is persisted in Postgres and
  // reconstructed after workflow/worker restart. The workflow must not call
  // maybeContinueGoal or manufacture queue/input work while it is active.
  capacityWait?: CodexCapacityWaitRef;
  // This execution reached a durable terminal-for-now boundary (for example,
  // maintenance could not run or same-turn context recovery failed). End this
  // workflow run without synthesizing another goal continuation from unchanged
  // state. A later prompt/control/new-update wake may retry through normal claim
  // ordering.
  deferredUntilWake?: boolean;
};

export type RunAgentTurnResult =
  | ClaimedRunAgentTurnResult
  | {
      status: "unclaimed";
      reason: "gate-closed" | "no-work" | "stale-approval" | "control-pending";
    };
