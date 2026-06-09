export type SessionStatus = "queued" | "running" | "idle" | "requires_action" | "failed" | "cancelled";

export type ResourceRef =
  | {
      kind: "repository";
      uri: string;
      ref: string;
      mountPath?: string;
      subpath?: string;
      githubInstallationId?: number;
      githubRepositoryId?: number;
    }
  | {
      kind: "file";
      fileId: string;
      mountPath?: string;
    };

export type ToolRef = {
  kind: "mcp";
  id: string;
};

export type FileAsset = {
  id: string;
  status: "pending_upload" | "ready" | "failed" | "expired" | "deleted";
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

export type CreateFileUploadResponse = {
  fileId: string;
  uploadId: string;
  putUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxSizeBytes: number;
};

export type FileDownloadUrlResponse = {
  url: string;
  expiresAt: string;
};

export type DocumentBase = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IndexedDocument = {
  id: string;
  baseId: string;
  fileId: string;
  status: "queued" | "indexing" | "ready" | "failed";
  title: string;
  parser: string;
  chunkCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentSearchResult = {
  chunkId: string;
  documentId: string;
  baseId: string;
  fileId: string;
  title: string;
  text: string;
  score: number;
  chunkIndex: number;
  metadata: Record<string, unknown>;
};

export type TurnSubmission = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ClientConfig = {
  deploymentRevision: string;
  defaultModel: string;
  allowedModels: string[];
  defaultReasoningEffort: ReasoningEffort;
  allowedReasoningEfforts: ReasoningEffort[];
  mcpServers: Array<{
    id: string;
    name: string;
  }>;
  fileUploads: {
    enabled: boolean;
    maxSizeBytes: number;
  };
  productAccessMode: "local" | "configured" | "managed";
  auth:
    | { mode: "none" }
    | { mode: "deploymentKey"; headerName: "x-opengeni-access-key" }
    | { mode: "configuredToken"; headerName: "authorization"; scheme: "bearer" }
    | { mode: "managedSession"; session: "cookie" };
};

export type Session = {
  id: string;
  accountId: string;
  workspaceId: string;
  status: SessionStatus;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: "docker" | "modal" | "local" | "none";
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type SessionEvent = {
  id: string;
  workspaceId: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null;
  turnId?: string | null;
};

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

export type ScheduledTaskScheduleSpec =
  | { type: "once"; runAt: string; timeZone?: string }
  | { type: "interval"; everySeconds: number; startAt?: string; endAt?: string }
  | { type: "calendar"; timeZone: string; hour: number; minute: number; daysOfWeek?: string[] };

export type ScheduledTaskAgentConfig = {
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxBackend?: "docker" | "modal" | "local" | "none";
};

export type ScheduledTask = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: "active" | "paused";
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: "new_session_per_run" | "reusable_session";
  overlapPolicy: "allow_concurrent" | "skip" | "buffer_one";
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskRun = {
  id: string;
  accountId: string;
  workspaceId: string;
  taskId: string;
  status: "queued" | "dispatched" | "failed";
  triggerType: "scheduled" | "manual";
  scheduledAt: string | null;
  firedAt: string;
  sessionId: string | null;
  triggerEventId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  accountId: string;
  name: string;
  slug: string | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccessGrant = {
  workspaceId: string;
  accountId: string;
  subjectId: string;
  subjectLabel?: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
};

export type AccountGrant = {
  accountId: string;
  subjectId: string;
  subjectLabel?: string;
  role: string;
  permissions: string[];
};

export type AccessContext = {
  mode: "local" | "configured" | "managed";
  subjectId: string;
  subjectLabel?: string;
  accountGrants: AccountGrant[];
  workspaceGrants: AccessGrant[];
  defaultAccountId?: string;
  defaultWorkspaceId?: string;
};

export type ApiKey = {
  id: string;
  accountId: string;
  workspaceId: string | null;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingBalance = {
  accountId: string;
  balanceMicros: number;
  currency: string;
  updatedAt: string;
};

export type AuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified?: boolean;
    image?: string | null;
  };
};
