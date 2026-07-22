import type { Settings } from "@opengeni/config";
import type { Document, GitHubAppApiPort, ScheduledTask } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { createObjectStorage } from "@opengeni/storage";
import type { ManagedAuth } from "./managed-auth-type";
import type { ApiSandboxClient, ResumeBoxByIdInput, ResumedSandboxSession } from "./sandbox-types";

export type SessionWorkflowClient = {
  signalUserMessage: (input: {
    sessionId: string;
    eventId: string;
    workflowId: string;
  }) => Promise<void>;
  wakeSessionWorkflow: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    wakeRevision: number;
    interruptionRequested?: boolean;
  }) => Promise<void>;
  /** Trigger one bounded drain of already-committed workflow-wake revisions. */
  requestSessionWorkflowWakeDispatch: () => Promise<void>;
  // Dedicated, revision-carrying nudge for a durable Codex capacity waiter.
  // Optional for embedded/back-compat clients: callers may fall back to the
  // generic queueChanged wake because Postgres wakeRevision is authoritative.
  signalCodexCapacity?: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    wakeRevision: number;
    workflowWakeRevision: number;
  }) => Promise<void>;
  signalApprovalDecision: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    eventId: string;
    workflowId: string;
    workflowWakeRevision: number;
  }) => Promise<void>;
  syncScheduledTask: (input: { task: ScheduledTask }) => Promise<void>;
  deleteScheduledTaskSchedule: (input: { temporalScheduleId: string }) => Promise<void>;
  triggerScheduledTask: (input: {
    task: ScheduledTask;
    agentRunUsageIdempotencyKey?: string;
    triggerWorkflowId?: string;
  }) => Promise<void>;
  startRigVerification: (input: {
    workspaceId: string;
    changeId?: string;
    versionId?: string;
    attempt?: number;
    workflowId?: string;
  }) => Promise<void>;
  check?: () => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
  }) => Promise<Document | void>;
};

export type AppDependencies = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  /** Optional provider override for deterministic API/object-storage tests. */
  objectStorage?: ObjectStorageDependency;
  documentIndexer?: DocumentIndexClient;
  documentServices?: DocumentServices;
  observability?: Observability;
  readinessChecks?: Partial<Record<"db" | "nats" | "temporal", () => Promise<void> | void>>;
  githubStateSecret?: string;
  /**
   * Optional host-provided GitHub App API seam. Embedded hosts can authorize
   * users, inspect installations, and list repositories with their own GitHub
   * App credentials; standalone deployments fall back to @opengeni/github.
   */
  githubAppApi?: GitHubAppApiPort;
  managedAuth?: ManagedAuth | null;
  // The API process's OWN agent-loop-free sandbox client (constructed from
  // settings via @opengeni/runtime/sandbox). Undefined when sandboxBackend=none.
  // This is the foundation of the API-direct control plane: the API resumes
  // boxes by id in-process, no Temporal/worker for non-turn ops. Optional on
  // construction (createApp builds it from settings when absent) so existing
  // tests that pass a minimal deps bag keep working.
  sandboxClient?: ApiSandboxClient;
  /**
   * Resume a box by id from a serialized resume_state envelope (the lease's
   * `resume_state` + `resume_backend_id` from P1.1) and return a live session
   * for a single in-process op. resume → use → drop; the lease owns lifecycle,
   * the returned handle does NOT own the box. Throws SandboxResumeError on a
   * backend mismatch or a resume failure.
   */
  resumeBoxById?: (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession>;
};

export type ObjectStorageDependency = ReturnType<typeof createObjectStorage>;

export type ApiRouteDeps = AppDependencies & {
  objectStorage: ObjectStorageDependency;
  githubStateSecret: string;
  documentIndexer: DocumentIndexClient;
  getDocumentServices: () => DocumentServices;
  // Resolved by createApp from settings: routes always get a concrete
  // resumeBoxById (it throws SandboxResumeError when sandboxBackend=none).
  resumeBoxById: (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession>;
};

/**
 * The exact dependency slice used by `acceptSessionUserMessage`.
 *
 * Keeping this narrower than `ApiRouteDeps` lets control-plane callers reuse
 * the canonical admission path without constructing unrelated HTTP, document,
 * or sandbox services. The public API still passes its `ApiRouteDeps` superset.
 */
export type AcceptSessionUserMessageDependencies = Pick<
  AppDependencies,
  "settings" | "db" | "bus"
> & {
  workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
  objectStorage: ObjectStorageDependency;
};
