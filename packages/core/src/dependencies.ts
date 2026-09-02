import type { Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  Document,
  DocumentAuthorityKind,
  GitHubAppApiPort,
  ScheduledTask,
  ScheduledTaskTriggerType,
  SessionAuthorizationPort,
  TurnInitiator,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { createObjectStorage } from "@opengeni/storage";
import type { ManagedAuth } from "./managed-auth-type";
import type { ManagedAuthSessionAdapter } from "./managed-auth-session-sets";
import type { ApiSandboxClient, ResumeBoxByIdInput, ResumedSandboxSession } from "./sandbox-types";
import type { TranscriptionSegmenter, TranscriptionService } from "./transcription";
import type { EditableArtifactApplicationPort } from "./editable-artifact-live";
import type { ResolvedCatalogSettings } from "./model-catalog";
import type {
  EditableArtifactAgentApplication,
  EditableArtifactDurableExportService,
  EditableArtifactOfficeImportPort,
} from "./editable-artifacts";

export type SessionWorkflowClient = {
  triggerAutomationRun?: (input: {
    accountId: string;
    workspaceId: string;
    runId: string;
  }) => Promise<void>;
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
    agentRunUsageIdempotencyKey: string;
    triggerWorkflowId: string;
    initiator: TurnInitiator;
    triggerType?: Extract<
      ScheduledTaskTriggerType,
      "manual" | "initial" | "provider_event" | "retry" | "repair"
    >;
  }) => Promise<void>;
  startRigVerification: (input: {
    workspaceId: string;
    changeId?: string;
    versionId?: string;
    attemptId: string;
    workflowId?: string;
  }) => Promise<void>;
  check?: () => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
    authorityKind: DocumentAuthorityKind;
    authorityWorkspaceId: string | null;
    authoritySubjectId: string | null;
  }) => Promise<Document | void>;
};

export type ManagedEmailMessage = {
  kind: "email_verification" | "password_reset" | "organization_user_setup";
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

export type ManagedEmailDeliveryResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; errorClass: string }
  | { status: "outcome_unknown"; errorClass: string };

/** Provider-neutral, injectable boundary for every managed-auth email. */
export type ManagedEmailTransport = {
  /** Effective provider sender; frozen into any idempotent payload digest. */
  readonly sender: string;
  /**
   * Stable non-secret provider/account/policy namespace plus the provider's
   * guaranteed key-retention window. Both are durably fenced before I/O.
   */
  readonly idempotency: {
    readonly scope: string;
    readonly retentionSeconds: number;
  };
  send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult>;
};

export type AppDependencies = {
  settings: Settings;
  /**
   * Original deployment settings when `settings` is already overlaid with a
   * deployment/workspace catalog snapshot. Model-bearing request adapters set
   * this marker so core admission never feeds a synthetic reviewed provider
   * back through deployment validation.
   */
  catalogSourceSettings?: Settings;
  db: Database;
  /**
   * Host-composed editable artifact engine. Standalone startup binds the same
   * native kernel/DB/object-store implementation; embedded hosts may inject an
   * equivalent deployment-scoped composition.
   */
  editableArtifacts?: EditableArtifactApplicationPort;
  /** Durable immutable version/materialization API paired with editableArtifacts. */
  editableArtifactExports?: EditableArtifactDurableExportService;
  /** Canonical agent-facing artifact use cases shared by MCP and Codemode. */
  editableArtifactAgent?: EditableArtifactAgentApplication;
  /** Trusted Office-file to canonical sequence-zero import boundary. */
  editableArtifactOfficeImports?: EditableArtifactOfficeImportPort;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  /**
   * Injectable structural seam for replayable post-commit fanout and wake work.
   * The historical name is retained for host compatibility; every interactive
   * session command now uses this boundary, not only prompt submission.
   */
  schedulePromptPostCommit?: (task: () => Promise<void>) => void;
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
  /** Optional provider seam for the separately registered OpenGeni Lens App. */
  prReviewGithubAppApi?: GitHubAppApiPort;
  /**
   * Optional host-owned connection credential seam. API-side consumers use
   * the MCP leg for Codemode/Code Mode; worker consumers bind the same port
   * for model MCP, Git, and sandbox-secret resolution.
   */
  connectionCredentials?: ConnectionCredentialsPort | null;
  /**
   * Optional embedding-host session ACL. Unset preserves standalone workspace
   * authorization; once bound, every session-addressed surface fails closed on
   * an unavailable or invalid host decision.
   */
  sessionAuthorization?: SessionAuthorizationPort | null;
  managedAuth?: ManagedAuth | null;
  /** Provider-neutral browser login-slot adapter; required by dual/broker managed auth. */
  managedAuthSessionAdapter?: ManagedAuthSessionAdapter | null;
  /** Injectable managed-email transport; standalone API defaults to Resend or local capture. */
  managedEmailTransport?: ManagedEmailTransport;
  /** Injectable Codex HTTP transport for deterministic API/provider tests. */
  codexFetch?: typeof fetch;
  /** Injectable GitHub transport for deterministic personal-OAuth tests. */
  githubPersonalFetch?: typeof fetch;
  /** Injectable credential-free GitHub transport for public repository verification tests. */
  githubAnonymousFetch?: typeof fetch;
  /** Injectable xAI OAuth/subscription transport for deterministic API/provider tests. */
  xaiFetch?: typeof fetch;
  /** Injectable Slack Web API transport for deterministic bot-connection tests. */
  slackFetch?: typeof fetch;
  /** Injectable Google OAuth/Drive transport for deterministic connector tests. */
  googleDriveFetch?: typeof fetch;
  /** Injectable Fiken API transport for deterministic connector tests. */
  fikenFetch?: typeof fetch;
  /** Injectable Integration Definition OAuth/API transport for deterministic tests. */
  apiIntegrationOAuthFetch?: typeof fetch;
  atlassianFetch?: typeof fetch;
  /** Injectable MCP OAuth setup deadline for deterministic stalled-provider tests. */
  oauthStartDeadlineMs?: number;
  /** Injectable MCP OAuth callback deadline for deterministic stalled-provider tests. */
  oauthCallbackDeadlineMs?: number;
  /** Optional host-owned voice-input transcription service. */
  transcription?: TranscriptionService | null;
  /** Optional host-owned long-form audio normalization/segmentation service. */
  transcriptionSegmenter?: TranscriptionSegmenter | null;
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
  resolveCatalogSettings: () => Promise<ResolvedCatalogSettings>;
  managedEmailTransport: ManagedEmailTransport;
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
  | "settings"
  | "catalogSourceSettings"
  | "db"
  | "bus"
  | "sessionAuthorization"
  | "schedulePromptPostCommit"
> & {
  workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
  objectStorage: ObjectStorageDependency;
};
