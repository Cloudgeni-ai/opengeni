// Hand-written mirrors of the public wire shapes in `@opengeni/contracts`.
// The SDK keeps zero runtime dependencies so it stays framework-agnostic and
// publishable on its own; `test/contract-parity.test.ts` pins these types to
// the contracts package so drift fails the gate instead of shipping.

export type SessionStatus =
  | "queued"
  | "running"
  | "idle"
  | "requires_action"
  | "failed"
  | "cancelled";

// Mirror of `@opengeni/contracts` SandboxBackend (10 values; existing four keep
// position). 3-way enum parity is pinned by `test/contract-parity.test.ts`.
export type SandboxBackend =
  | "docker"
  | "modal"
  | "local"
  | "none"
  | "daytona"
  | "runloop"
  | "e2b"
  | "blaxel"
  | "cloudflare"
  | "vercel";

// Mirror of `@opengeni/contracts` SandboxOs. Only "linux" is reachable in v1.
export type SandboxOs = "linux" | "macos" | "windows";

// Mirror of `@opengeni/contracts` SandboxCapabilityName.
export type SandboxCapabilityName =
  | "FileSystem"
  | "Terminal"
  | "Git"
  | "DesktopStream"
  | "Recording";

// Mirror of `@opengeni/contracts` CapabilityUnavailableReason.
export type CapabilityUnavailableReason =
  | "backend_unsupported"
  | "os_unsupported"
  | "not_provisioned"
  | "disabled_by_policy"
  | "lease_cold"
  | "tier_headless";

// Mirror of `@opengeni/contracts` SessionCapabilities (the negotiated handshake
// document). The descriptor table itself is NOT mirrored — it lives in
// contracts (P0.1) and is consumed by the SDK config in a later PR.
export type SessionCapabilities = {
  sessionId: string;
  backend: SandboxBackend;
  os: SandboxOs;
  liveness: "cold" | "warming" | "warm" | "draining";
  leaseEpoch: number;
  viewerHeartbeatIntervalMs: number;
  FileSystem: {
    available: boolean;
    readOnly: boolean;
    root: string;
    pathSep: "/" | "\\";
    treeMode: "lazy" | "snapshot";
    reason: CapabilityUnavailableReason | null;
  };
  Terminal: {
    transport: "sse-events" | "pty-ws" | null;
    ptyCapable: boolean;
    shell: string;
    url: string | null;
    token: string | null;
    reason: CapabilityUnavailableReason | null;
  };
  Git: {
    available: boolean;
    repos: string[];
    reason: CapabilityUnavailableReason | null;
  };
  DesktopStream: {
    transport: "vnc-ws" | "rdp-ws" | "webrtc" | null;
    client: "novnc" | "web-rdp" | null;
    mode: "read-only" | "interactive";
    url: string | null;
    token: string | null;
    expiresAt: string | null;
    resolution: [number, number];
    unredacted: boolean;
    requiresAcknowledgment: boolean;
    acknowledged: boolean;
    reason: CapabilityUnavailableReason | null;
  };
  Recording: {
    available: boolean;
    modes: ("manual" | "on-turn" | "on-verify")[];
    codecs: ("h264-mp4" | "vp9-webm")[];
    reason: CapabilityUnavailableReason | null;
  };
  negotiatedAt: string;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RepositoryResourceRef = {
  kind: "repository";
  uri: string;
  ref: string;
  mountPath?: string | undefined;
  subpath?: string | undefined;
  githubInstallationId?: number | undefined;
  githubRepositoryId?: number | undefined;
};

export type FileResourceRef = {
  kind: "file";
  fileId: string;
  mountPath?: string | undefined;
};

export type ResourceRef = RepositoryResourceRef | FileResourceRef;

export type ToolRef = {
  kind: "mcp";
  id: string;
};

export type GoalSpec = {
  text: string;
  successCriteria?: string | undefined;
  maxAutoContinuations?: number | undefined;
};

export type Session = {
  id: string;
  workspaceId: string;
  accountId: string;
  status: SessionStatus;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
  environmentId: string | null;
  firstPartyMcpPermissions: string[] | null;
  createIdempotencyKey: string | null;
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionTurnStatus =
  | "queued"
  | "running"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled";

export type SessionTurnSource = "user" | "scheduled_task" | "api" | "goal";

export type SessionTurn = {
  id: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  status: SessionTurnStatus;
  source: SessionTurnSource;
  position: number;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const SESSION_EVENT_TYPES = [
  "session.created",
  "session.status.changed",
  "session.requiresAction",
  "session.context.compacted",
  "session.context.cleared",
  "user.message",
  "user.interrupt",
  "user.approvalDecision",
  "turn.queued",
  "turn.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.preempted",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.updated",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
  "artifact.created",
  "goal.set",
  "goal.updated",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.continuation",
] as const;

export type KnownSessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Event types the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce event types without breaking older SDK consumers.
 */
export type SessionEventType = KnownSessionEventType | (string & {});

export type SessionEvent = {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Per-session sequence number: positive, contiguous, strictly increasing. */
  sequence: number;
  type: SessionEventType;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null | undefined;
  turnId?: string | null | undefined;
};

// Payload shapes for the high-traffic event types. `SessionEvent.payload` is
// `unknown` on the wire; these are the documented shapes producers emit today.
export type AgentTextDeltaPayload = { text: string };
export type AgentMessageCompletedPayload = { text: string };
export type AgentToolCallCreatedPayload = {
  id: string | null;
  name: string;
  arguments: unknown;
  raw?: unknown | undefined;
};
export type AgentToolCallOutputPayload = { id: string | null; output: unknown };
export type SessionStatusChangedPayload = { status: SessionStatus };

export type ScheduledTaskStatus = "active" | "paused";

export type ScheduledTaskRunMode = "new_session_per_run" | "reusable_session";

export type ScheduledTaskOverlapPolicy = "allow_concurrent" | "skip" | "buffer_one";

export type ScheduledTaskDayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type ScheduledTaskScheduleSpec =
  | { type: "once"; runAt: string; timeZone: string }
  | {
      type: "interval";
      everySeconds: number;
      startAt?: string | undefined;
      endAt?: string | undefined;
    }
  | {
      type: "calendar";
      timeZone: string;
      hour: number;
      minute: number;
      daysOfWeek?: ScheduledTaskDayOfWeek[] | undefined;
    };

export type ScheduledTaskAgentConfig = {
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
};

export type ScheduledTask = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  environmentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionRequest = {
  initialMessage: string;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  environmentId?: string | undefined;
  goal?: GoalSpec | undefined;
  clientEventId?: string | undefined;
  // Workspace-scoped CREATE idempotency key: forward a STABLE value to make a
  // double-submit/retry of the same logical create collapse to one session.
  // Distinct from the per-call clientEventId.
  idempotencyKey?: string | undefined;
  firstPartyMcpPermissions?: string[] | undefined;
};

// --- Access, workspaces, API keys -------------------------------------------

export const KNOWN_PERMISSIONS = [
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "workspace:read",
  "workspace:admin",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "environments:manage",
  "environments:use",
  "goals:manage",
] as const;

export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

/**
 * Permissions the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce permissions without breaking older SDK consumers.
 */
export type Permission = KnownPermission | (string & {});

export type ProductAccessMode = "local" | "configured" | "managed";

export type AccountRole = "owner" | "admin" | "member";

export type AccountGrant = {
  accountId: string;
  subjectId: string;
  subjectLabel?: string | undefined;
  role?: AccountRole | undefined;
  permissions: Permission[];
  metadata?: Record<string, unknown> | undefined;
};

export type AccessGrant = {
  workspaceId: string;
  accountId: string;
  subjectId: string;
  subjectLabel?: string | undefined;
  permissions: Permission[];
  metadata?: Record<string, unknown> | undefined;
};

export type AccessContext = {
  mode: ProductAccessMode;
  subjectId: string;
  subjectLabel?: string | undefined;
  accountGrants: AccountGrant[];
  workspaceGrants: AccessGrant[];
  defaultAccountId: string | null;
  defaultWorkspaceId: string | null;
};

export type Workspace = {
  id: string;
  accountId: string;
  name: string;
  slug: string | null;
  externalSource: string | null;
  externalId: string | null;
  agentInstructions: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkspaceRequest = {
  accountId?: string | undefined;
  name: string;
  slug?: string | undefined;
  externalSource?: string | undefined;
  externalId?: string | undefined;
  agentInstructions?: string | null | undefined;
};

export type UpdateWorkspaceRequest = {
  name?: string | undefined;
  slug?: string | null | undefined;
  agentInstructions?: string | null | undefined;
};

export type ApiKey = {
  id: string;
  accountId: string;
  workspaceId: string | null;
  name: string;
  prefix: string;
  permissions: Permission[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateApiKeyRequest = {
  name: string;
  permissions: Permission[];
  expiresAt?: string | undefined;
};

export type CreateApiKeyResponse = {
  apiKey: ApiKey;
  /** The full secret token — shown once at creation, never returned again. */
  token: string;
};

export type ListApiKeysResponse = {
  apiKeys: ApiKey[];
};

// --- Goals -------------------------------------------------------------------

export type SessionGoalStatus = "active" | "paused" | "completed";

export type SessionGoalCreatedBy = "api" | "agent" | "scheduled_task";

export type SessionGoal = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  status: SessionGoalStatus;
  text: string;
  successCriteria: string | null;
  evidence: string | null;
  rationale: string | null;
  pausedReason: string | null;
  createdBy: SessionGoalCreatedBy;
  version: number;
  autoContinuations: number;
  noProgressStreak: number;
  maxAutoContinuations: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type UpdateSessionGoalRequest = {
  status: "paused" | "active";
  rationale?: string | undefined;
};

// --- Operator context controls (/clear, /compact) ----------------------------

/** Outcome of a manual /compact trigger. */
export type CompactSessionContextResult = {
  /**
   * queued: a client-side (Azure) compaction will run before the next turn.
   * noop:   nothing to do (server-managed provider, mode off, or no history).
   */
  status: "queued" | "noop";
  message: string;
};

// --- Turn queue --------------------------------------------------------------

export type UpdateSessionTurnRequest = {
  prompt?: string | undefined;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  metadata?: Record<string, unknown> | undefined;
};

// --- Scheduled tasks: requests + runs ----------------------------------------

/** Input shape for agent config on create/update (server applies defaults). */
export type ScheduledTaskAgentConfigInput = {
  prompt: string;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
};

export type CreateScheduledTaskRequest = {
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode?: ScheduledTaskRunMode | undefined;
  overlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
  agentConfig: ScheduledTaskAgentConfigInput;
  status?: ScheduledTaskStatus | undefined;
  environmentId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type UpdateScheduledTaskRequest = {
  name?: string | undefined;
  schedule?: ScheduledTaskScheduleSpec | undefined;
  runMode?: ScheduledTaskRunMode | undefined;
  overlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
  agentConfig?: ScheduledTaskAgentConfigInput | undefined;
  status?: ScheduledTaskStatus | undefined;
  environmentId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ScheduledTaskRunStatus = "queued" | "dispatched" | "failed";

export type ScheduledTaskTriggerType = "scheduled" | "manual";

export type ScheduledTaskRun = {
  id: string;
  accountId: string;
  workspaceId: string;
  taskId: string;
  status: ScheduledTaskRunStatus;
  triggerType: ScheduledTaskTriggerType;
  scheduledAt: string | null;
  firedAt: string;
  sessionId: string | null;
  triggerEventId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

// --- Environments -------------------------------------------------------------

/**
 * Variable values are write-only by design: the API never returns a value, so
 * reads expose name + version metadata only. Values are decrypted exclusively
 * inside the worker at sandbox materialization time.
 */
export type WorkspaceEnvironmentVariableMetadata = {
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceEnvironment = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  variables: WorkspaceEnvironmentVariableMetadata[];
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkspaceEnvironmentRequest = {
  name: string;
  description?: string | undefined;
  /** Initial variables. Values are write-only: they never come back on reads. */
  variables?: { name: string; value: string }[] | undefined;
};

export type UpdateWorkspaceEnvironmentRequest = {
  name?: string | undefined;
  description?: string | null | undefined;
};

// --- Files ---------------------------------------------------------------------

export type FileStatus = "pending_upload" | "ready" | "failed" | "expired" | "deleted";

export type FileAsset = {
  id: string;
  workspaceId: string;
  status: FileStatus;
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  bucket: string;
  objectKey: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateFileUploadRequest = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string | undefined;
};

export type CreateFileUploadResponse = {
  fileId: string;
  uploadId: string;
  /** Pre-signed PUT URL for the file bytes (direct to object storage). */
  putUrl: string;
  /** Headers that MUST be sent with the PUT for the signature to validate. */
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxSizeBytes: number;
};

export type CompleteFileUploadResponse = {
  file: FileAsset;
};

export type FileDownloadUrlResponse = {
  url: string;
  expiresAt: string;
};

/** Bytes accepted by the `uploadFile` helper. */
export type FileUploadData = Blob | ArrayBuffer | Uint8Array | string;

export type UploadFileInput = {
  filename: string;
  contentType: string;
  data: FileUploadData;
  sha256?: string | undefined;
};

// --- Documents -------------------------------------------------------------------

export type DocumentStatus = "queued" | "indexing" | "ready" | "failed";

export type DocumentBase = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Document = {
  id: string;
  workspaceId: string;
  baseId: string;
  fileId: string;
  status: DocumentStatus;
  title: string;
  parser: string;
  chunkCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSearchResult = {
  chunkId: string;
  workspaceId: string;
  documentId: string;
  baseId: string;
  fileId: string;
  title: string;
  text: string;
  score: number;
  chunkIndex: number;
  metadata: Record<string, unknown>;
};

export type CreateDocumentBaseRequest = {
  name: string;
  description?: string | undefined;
};

export type DocumentSearchRequest = {
  query: string;
  limit?: number | undefined;
};

export type DocumentSearchResponse = {
  results: DocumentSearchResult[];
};

// --- Capability packs ---------------------------------------------------------

export type CapabilityPackConnectorAuthModel =
  | "oauth2_authorization_code_pkce"
  | "oauth2_authorization_code"
  | "api_key"
  | "credential_ref";

export type CapabilityPackConnector = {
  id: string;
  name: string;
  category: string;
  authModel: CapabilityPackConnectorAuthModel;
  providers: string[];
  scopes: string[];
  required: boolean;
  metadata: Record<string, unknown>;
};

export type CapabilityPackKnowledge = {
  type: "document_base";
  id: string;
  name: string;
  description: string | null;
  required: boolean;
};

export type CapabilityPackScheduledTaskTemplate = {
  id: string;
  name: string;
  description: string;
  defaultSchedule: ScheduledTaskScheduleSpec;
  defaultRunMode: ScheduledTaskRunMode;
  defaultOverlapPolicy: ScheduledTaskOverlapPolicy;
  prompt?: string | undefined;
};

export type CapabilityPackSkillFile = {
  path: string;
  content: string;
};

export type CapabilityPackSkill = {
  name: string;
  description?: string | undefined;
  files: CapabilityPackSkillFile[];
};

export type CapabilityPackEnvironmentSpec = {
  description: string;
  requiredVariables: string[];
  required: boolean;
};

export type CapabilityPack = {
  id: string;
  name: string;
  description: string;
  role: string;
  category: string;
  version: string;
  sandboxImage?: string | undefined;
  skills: CapabilityPackSkill[];
  tools: ToolRef[];
  connectors: CapabilityPackConnector[];
  knowledge: CapabilityPackKnowledge[];
  scheduledTaskTemplates: CapabilityPackScheduledTaskTemplate[];
  environment?: CapabilityPackEnvironmentSpec | undefined;
  metadata: Record<string, unknown>;
};

/** Input shape for registering a pack manifest (server applies defaults). */
export type RegisterCapabilityPackRequest = {
  id: string;
  name: string;
  description: string;
  role: string;
  category: string;
  version: string;
  sandboxImage?: string | undefined;
  skills?: {
    name: string;
    description?: string | undefined;
    files: CapabilityPackSkillFile[];
  }[] | undefined;
  tools?: ToolRef[] | undefined;
  connectors?: {
    id: string;
    name: string;
    category: string;
    authModel: CapabilityPackConnectorAuthModel;
    providers?: string[] | undefined;
    scopes?: string[] | undefined;
    required?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
  }[] | undefined;
  knowledge?: {
    type: "document_base";
    id: string;
    name: string;
    description?: string | null | undefined;
    required?: boolean | undefined;
  }[] | undefined;
  scheduledTaskTemplates?: {
    id: string;
    name: string;
    description: string;
    defaultSchedule: ScheduledTaskScheduleSpec;
    defaultRunMode?: ScheduledTaskRunMode | undefined;
    defaultOverlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
    prompt?: string | undefined;
  }[] | undefined;
  environment?: {
    description: string;
    requiredVariables?: string[] | undefined;
    required?: boolean | undefined;
  } | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type WorkspaceRegisteredPack = {
  accountId: string;
  workspaceId: string;
  pack: CapabilityPack;
  createdAt: string;
  updatedAt: string;
};

export type PackInstallationStatus = "active" | "disabled";

export type PackInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  packId: string;
  status: PackInstallationStatus;
  metadata: Record<string, unknown>;
  enabledAt: string;
  updatedAt: string;
};

export type EnablePackRequest = {
  environmentId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ListPacksResponse = {
  packs: CapabilityPack[];
  installations: PackInstallation[];
};

export type GetPackResponse = {
  pack: CapabilityPack;
  installation: PackInstallation | null;
};

// --- Capabilities ---------------------------------------------------------------

export type CapabilityKind = "pack" | "mcp" | "api" | "skill" | "plugin";

export type CapabilitySource = "built_in" | "configured" | "public_registry" | "manual";

export type CapabilityInstallationStatus = "active" | "disabled";

export type CapabilityRuntime = {
  available: boolean;
  mcpServerId?: string | undefined;
  transport?: string | undefined;
  notes: string | null;
};

export type CapabilityCatalogItem = {
  id: string;
  accountId?: string | undefined;
  workspaceId?: string | undefined;
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  homepageUrl: string | null;
  endpointUrl: string | null;
  installUrl: string | null;
  authModel: string | null;
  tools: ToolRef[];
  runtime: CapabilityRuntime;
  enabled: boolean;
  enabledReason: string | null;
  metadata: Record<string, unknown>;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type CapabilityInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  kind: CapabilityKind;
  status: CapabilityInstallationStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  enabledAt: string;
  updatedAt: string;
};

export type CapabilityCatalogResponse = {
  items: CapabilityCatalogItem[];
  installations: CapabilityInstallation[];
};

export type CreateCapabilityCatalogItemRequest = {
  id?: string | undefined;
  kind: Exclude<CapabilityKind, "pack">;
  source?: CapabilitySource | undefined;
  name: string;
  description?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  homepageUrl?: string | undefined;
  endpointUrl?: string | undefined;
  installUrl?: string | undefined;
  authModel?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type EnableCapabilityRequest = {
  config?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  /**
   * Credential headers for remote MCP capabilities. Write-only: encrypted at
   * rest, injected only into the runtime MCP client, never returned by the
   * API (responses expose header names only).
   */
  headers?: Record<string, string> | undefined;
  /**
   * Initial environment attachment for kind=pack capabilities — mirrors the
   * dedicated POST /packs/:id/enable body. Required to enable an
   * environment.required pack through this unified path; ignored otherwise.
   */
  environmentId?: string | undefined;
};

export type DiscoverMcpCapabilitiesResponse = {
  items: CapabilityCatalogItem[];
  source: "official_mcp_registry";
  sourceUrl: string;
};

// --- GitHub ---------------------------------------------------------------------

export type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  accountLogin: string;
  accountType: string | null;
};

export type GitHubAppInfo = {
  configured: boolean;
  appId: string | null;
  clientId: string | null;
  appSlug: string | null;
  /** Ready-to-open GitHub install URL (carries the signed state), if configured. */
  installUrl: string | null;
  /** Setting names still missing when `configured` is false. */
  missing: string[];
};

export type GitHubRepositoriesResponse = {
  repositories: GitHubRepository[];
};

export type CreateGitHubAppManifestRequest = {
  appName?: string | undefined;
  organization?: string | undefined;
  public?: boolean | undefined;
  includeCiPermissions?: boolean | undefined;
};

export type CreateGitHubAppManifestResponse = {
  /** GitHub URL to POST the manifest to (personal or organization flow). */
  actionUrl: string;
  state: string;
  manifest: Record<string, unknown>;
};

// --- Billing --------------------------------------------------------------------

export type BillingMode = "disabled" | "stripe";

export type EntitlementsMode = "none" | "static" | "managed";

export type BillingBalance = {
  accountId: string;
  balanceMicros: number;
  currency: "usd";
  updatedAt: string;
};

export const KNOWN_USAGE_EVENT_TYPES = [
  "agent_run.created",
  "agent_run.completed",
  "model.tokens",
  "model.cost",
  "file.uploaded",
  "file.deleted",
  "document.indexed",
  "scheduled_task.fired",
  "api_key.request",
] as const;

export type KnownUsageEventType = (typeof KNOWN_USAGE_EVENT_TYPES)[number];

export type UsageEventType = KnownUsageEventType | (string & {});

export type UsageEvent = {
  id: string;
  workspaceId: string;
  accountId: string;
  subjectId: string | null;
  eventType: UsageEventType;
  quantity: number;
  unit: string;
  sourceResourceType: string | null;
  sourceResourceId: string | null;
  idempotencyKey: string;
  occurredAt: string;
  recordedAt: string;
  exportedToBillingAt: string | null;
  billingProviderEventId: string | null;
};

export type EntitlementValue = boolean | string | number | string[];

export type Entitlements = Record<string, EntitlementValue>;

export type BillingSummary = {
  mode: BillingMode;
  balance: BillingBalance;
};

export type BillingUsageResponse = {
  balance: BillingBalance;
  usage: UsageEvent[];
};

export type BillingEntitlementsResponse = {
  accountId: string;
  mode: EntitlementsMode;
  entitlements: Entitlements;
};

export type CreateCheckoutRequest = {
  accountId?: string | undefined;
  /** USD amount with cent precision (server enforces min/max). */
  amountUsd: number;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
};

export type CreateCheckoutResponse = {
  checkoutSessionId: string;
  url: string;
};

export type UserMessageEventInput = {
  type: "user.message";
  clientEventId?: string | undefined;
  payload: {
    text: string;
    resources?: ResourceRef[] | undefined;
    tools?: ToolRef[] | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
  };
};

export type UserInterruptEventInput = {
  type: "user.interrupt";
  clientEventId?: string | undefined;
  payload?: { reason?: string | undefined } | undefined;
};

export type UserApprovalDecisionEventInput = {
  type: "user.approvalDecision";
  clientEventId?: string | undefined;
  payload: {
    approvalId: string;
    decision: "approve" | "reject";
    message?: string | undefined;
  };
};

/** Control/user events a client may POST to a session's event log. */
export type ClientSessionEventInput =
  | UserMessageEventInput
  | UserInterruptEventInput
  | UserApprovalDecisionEventInput;
