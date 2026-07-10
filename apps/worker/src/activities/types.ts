import type { Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  EntitlementsPort,
  ScheduledTaskTriggerType,
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
// undefined signaler degrades to "DB wake recorded, no workflow nudge" (the
// turn is still claimed on the parent's next natural wake).
export type WakeSessionWorkflowSignal = (input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
}) => Promise<void>;

export type SignalCodexCapacityWorkflow = (input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  wakeRevision: number;
}) => Promise<void>;

export type ActivityServices = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  runtime: OpenGeniRuntime;
  objectStorage: ObjectStorage | null;
  documentServices: DocumentServices;
  observability: Observability;
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
  /** Revision-carrying capacity nudge; queue wake remains the back-compat fallback. */
  signalCodexCapacityWorkflow?: SignalCodexCapacityWorkflow | null;
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
  // §7.6 P4a — host connection-credential provider, the WORKER half of the
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
  // FORK-7 CROSS-CHECK: a provider echoes the `workspaceId` it scoped the
  // credential to; the consuming activity ASSERTS agreement with the run's
  // workspace BEFORE injecting `GH_TOKEN` (or applying decrypted values). A host
  // mapping bug returning tenant B's creds for a tenant-A run is caught here.
  connectionCredentials?: ConnectionCredentialsPort | null;
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
  | { action: "resumed"; turnId: string }
  | { action: "superseded" | "stale" };

export type ActivityDependencies = Partial<ActivityServices>;

export type RunAgentTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
  turnId?: string;
};

export type RequeueTurnAfterWorkerDeathInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  // The trigger the dead attempt was actually running (for an approval rerun
  // this is the approval-decision event, not the turn row's original trigger).
  triggerEventId: string;
  workflowId: string;
  turnId: string;
};

export type RequeueTurnAfterWorkerDeathResult =
  // The turn is back on the queue; the session workflow's next claim
  // re-dispatches it on a healthy worker. `redispatches` is the total number
  // of worker-death re-dispatches this turn has now consumed.
  | { action: "requeued"; redispatches: number }
  // The turn is no longer running/requires_action: the timed-out attempt was
  // a zombie that actually settled the turn after the server gave up on its
  // heartbeats. Nothing to redo; the workflow just continues its loop.
  | { action: "stale" }
  // The per-turn crash-loop guard tripped; the workflow must fail the
  // session for real. `redispatches` is the count already consumed (== the
  // ceiling), so the failed attempt was worker death number redispatches + 1.
  | { action: "exceeded"; redispatches: number };

export type ClaimNextQueuedTurnInput = {
  workspaceId: string;
  sessionId: string;
  workflowId: string;
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

export type PauseGoalForInterruptInput = {
  workspaceId: string;
  sessionId: string;
  // The `user.interrupt` event that triggered the pause, when there is one.
  // A steer-tagged interrupt (reason "steer") must NOT pause the goal:
  // steering redirects the work, it does not stop it.
  triggerEventId?: string;
};

export type DispatchScheduledTaskRunInput = {
  workspaceId: string;
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
  /** Stable Temporal workflow identity; retries must reuse the same source row. */
  producerKey?: string;
  agentRunUsageIdempotencyKey?: string;
};

export type DispatchScheduledTaskRunResult = {
  action: "start" | "signal";
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
};

export type IndexDocumentInput = {
  accountId: string;
  workspaceId: string;
  documentId: string;
};

export type RunAgentTurnResult = {
  // "preempted": the worker hosting this turn shut down gracefully mid-turn;
  // the activity checkpointed conversation truth, re-queued the turn, and the
  // session workflow re-dispatches it on a healthy worker.
  status: "idle" | "requires_action" | "failed" | "cancelled" | "preempted";
  // Provider backpressure pacing: when set on an idle result, the session
  // workflow holds the loop this long before admitting the next turn (an
  // active goal's continuation would otherwise immediately re-hit the limit).
  continueDelayMs?: number;
  // Multi-account rotation all-capped idle: every connected Codex subscription is
  // rate-limited/cooling. This is a MANDATORY hold — session.ts must wait
  // continueDelayMs (floored to a minimum) and must NOT treat a 0/elapsed delay as
  // "continue now" (invariant 4: NO THRASH). Distinct from a normal continueDelayMs:0
  // which legitimately means "a rotation candidate is ready, re-dispatch immediately".
  idleUntilReset?: boolean;
  // Durable native zero-pool wait. Unlike continueDelayMs, this reference is
  // persisted in Postgres and reconstructed after workflow/worker restart.
  // The workflow must not call maybeContinueGoal while this waiter is active.
  capacityWait?: CodexCapacityWaitRef;
};
