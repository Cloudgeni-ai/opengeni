// Session wire shapes come from @opengeni/sdk (pinned to @opengeni/contracts
// by the SDK's contract-parity tests) — the console no longer mirrors them.
export type {
  ReasoningEffort,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskScheduleSpec,
  Session,
  SessionEvent,
  SessionStatus,
  ToolRef,
} from "@opengeni/sdk";
import type { ReasoningEffort, ResourceRef, ToolRef } from "@opengeni/sdk";

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

export type CapabilityKind = "pack" | "mcp" | "api" | "skill" | "plugin";

export type CapabilitySource = "built_in" | "configured" | "public_registry" | "manual";

export type CapabilityCatalogItem = {
  id: string;
  accountId?: string;
  workspaceId?: string;
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
  runtime: {
    available: boolean;
    mcpServerId?: string;
    transport?: string;
    notes: string | null;
  };
  enabled: boolean;
  enabledReason: string | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type CapabilityInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  kind: CapabilityKind;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  enabledAt: string;
  updatedAt: string;
};

export type CapabilityCatalogResponse = {
  items: CapabilityCatalogItem[];
  installations: CapabilityInstallation[];
};

export type CreateCapabilityInput = {
  id?: string;
  kind: Exclude<CapabilityKind, "pack">;
  source?: CapabilitySource;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  homepageUrl?: string;
  endpointUrl?: string;
  installUrl?: string;
  authModel?: string;
  metadata?: Record<string, unknown>;
};
