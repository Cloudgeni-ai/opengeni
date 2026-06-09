import { z } from "zod";

export const SessionStatus = z.enum([
  "queued",
  "running",
  "idle",
  "requires_action",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SandboxBackend = z.enum(["docker", "modal", "local", "none"]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

export const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const RepositoryResourceRef = z.object({
  kind: z.literal("repository"),
  uri: z.string().min(1),
  ref: z.string().min(1),
  mountPath: z.string().min(1).optional(),
  subpath: z.string().min(1).optional(),
  githubInstallationId: z.number().int().positive().optional(),
  githubRepositoryId: z.number().int().positive().optional(),
});
export type RepositoryResourceRef = z.infer<typeof RepositoryResourceRef>;

export const FileResourceRef = z.object({
  kind: z.literal("file"),
  fileId: z.string().uuid(),
  mountPath: z.string().min(1).optional(),
});
export type FileResourceRef = z.infer<typeof FileResourceRef>;

export const ResourceRef = z.discriminatedUnion("kind", [RepositoryResourceRef, FileResourceRef]);
export type ResourceRef = z.infer<typeof ResourceRef>;

export const FileStatus = z.enum(["pending_upload", "ready", "failed", "expired", "deleted"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileUploadStatus = z.enum(["pending", "completed", "expired", "failed"]);
export type FileUploadStatus = z.infer<typeof FileUploadStatus>;

export const FileAsset = z.object({
  id: z.string().uuid(),
  status: FileStatus,
  filename: z.string(),
  safeFilename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  bucket: z.string(),
  objectKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FileAsset = z.infer<typeof FileAsset>;

export const CreateFileUploadRequest = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().min(1).optional(),
});
export type CreateFileUploadRequest = z.infer<typeof CreateFileUploadRequest>;

export const CreateFileUploadResponse = z.object({
  fileId: z.string().uuid(),
  uploadId: z.string().uuid(),
  putUrl: z.string().url(),
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  maxSizeBytes: z.number().int().positive(),
});
export type CreateFileUploadResponse = z.infer<typeof CreateFileUploadResponse>;

export const CompleteFileUploadResponse = z.object({
  file: FileAsset,
});
export type CompleteFileUploadResponse = z.infer<typeof CompleteFileUploadResponse>;

export const FileDownloadUrlResponse = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});
export type FileDownloadUrlResponse = z.infer<typeof FileDownloadUrlResponse>;

export const DocumentStatus = z.enum(["queued", "indexing", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const KnowledgeSourceKind = z.enum([
  "manual_upload",
  "meeting_transcript",
  "repository",
  "email",
  "chat",
  "document",
  "web",
  "other",
]);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

export const DocumentSearchMode = z.enum(["hybrid", "vector", "keyword"]);
export type DocumentSearchMode = z.infer<typeof DocumentSearchMode>;

export const DocumentBase = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentBase = z.infer<typeof DocumentBase>;

export const Document = z.object({
  id: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  status: DocumentStatus,
  title: z.string(),
  parser: z.string(),
  chunkCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  sourceKind: KnowledgeSourceKind,
  sourceUri: z.string().nullable(),
  sourceExternalId: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceAuthor: z.string().nullable(),
  sourceCreatedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  aclTags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Document = z.infer<typeof Document>;

export const DocumentSearchResult = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  title: z.string(),
  text: z.string(),
  score: z.number(),
  matchType: DocumentSearchMode,
  vectorScore: z.number().nullable(),
  keywordScore: z.number().nullable(),
  chunkIndex: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  sourceKind: KnowledgeSourceKind,
  sourceUri: z.string().nullable(),
  sourceExternalId: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceAuthor: z.string().nullable(),
  sourceCreatedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  aclTags: z.array(z.string()),
});
export type DocumentSearchResult = z.infer<typeof DocumentSearchResult>;

export const CreateDocumentBaseRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateDocumentBaseRequest = z.infer<typeof CreateDocumentBaseRequest>;

export const AddDocumentRequest = z.object({
  fileId: z.string().uuid(),
  title: z.string().min(1).optional(),
  sourceKind: KnowledgeSourceKind.optional(),
  sourceUri: z.string().min(1).optional(),
  sourceExternalId: z.string().min(1).optional(),
  sourceTitle: z.string().min(1).optional(),
  sourceAuthor: z.string().min(1).optional(),
  sourceCreatedAt: z.string().datetime().optional(),
  sourceUpdatedAt: z.string().datetime().optional(),
  sourceVersion: z.string().min(1).optional(),
  aclTags: z.array(z.string().min(1)).optional(),
});
export type AddDocumentRequest = z.infer<typeof AddDocumentRequest>;

export const DocumentSearchRequest = z.object({
  query: z.string().min(1),
  baseIds: z.array(z.string().uuid()).optional(),
  mode: DocumentSearchMode.optional(),
  sourceKinds: z.array(KnowledgeSourceKind).optional(),
  aclTags: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(50).default(5),
});
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequest>;

export const KnowledgeMemoryStatus = z.enum(["proposed", "approved", "rejected"]);
export type KnowledgeMemoryStatus = z.infer<typeof KnowledgeMemoryStatus>;

export const KnowledgeMemoryKind = z.enum(["semantic", "episodic", "procedural", "decision", "preference"]);
export type KnowledgeMemoryKind = z.infer<typeof KnowledgeMemoryKind>;

export const KnowledgeSourceRef = z.object({
  kind: z.enum(["document_chunk", "document", "session_event", "memory", "external"]),
  id: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeSourceRef = z.infer<typeof KnowledgeSourceRef>;

export const KnowledgeMemory = z.object({
  id: z.string().uuid(),
  status: KnowledgeMemoryStatus,
  kind: KnowledgeMemoryKind,
  scope: z.string(),
  text: z.string(),
  sourceRefs: z.array(KnowledgeSourceRef),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.string(), z.unknown()),
  createdBySessionId: z.string().uuid().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeMemory = z.infer<typeof KnowledgeMemory>;

export const CreateKnowledgeMemoryRequest = z.object({
  status: KnowledgeMemoryStatus.default("proposed"),
  kind: KnowledgeMemoryKind.default("semantic"),
  scope: z.string().min(1).default("workspace"),
  text: z.string().min(1),
  sourceRefs: z.array(KnowledgeSourceRef).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdBySessionId: z.string().uuid().optional(),
});
export type CreateKnowledgeMemoryRequest = z.infer<typeof CreateKnowledgeMemoryRequest>;

export const UpdateKnowledgeMemoryRequest = z.object({
  status: KnowledgeMemoryStatus.optional(),
  kind: KnowledgeMemoryKind.optional(),
  scope: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  sourceRefs: z.array(KnowledgeSourceRef).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reviewedBy: z.string().min(1).optional(),
});
export type UpdateKnowledgeMemoryRequest = z.infer<typeof UpdateKnowledgeMemoryRequest>;

export const KnowledgeMemorySearchRequest = z.object({
  query: z.string().min(1).optional(),
  status: KnowledgeMemoryStatus.optional(),
  kind: KnowledgeMemoryKind.optional(),
  scope: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type KnowledgeMemorySearchRequest = z.infer<typeof KnowledgeMemorySearchRequest>;

export const ToolRef = z.object({
  kind: z.literal("mcp"),
  id: z.string().min(1),
});
export type ToolRef = z.infer<typeof ToolRef>;

export class ResourceRefConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRefConflictError";
  }
}

export function mergeToolRefs(existing: ToolRef[], additions: ToolRef[]): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of [...existing, ...additions]) {
    const key = `${tool.kind}:${tool.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

export function mergeResourceRefs(
  existing: ResourceRef[],
  additions: ResourceRef[],
  options: { rejectConflicts?: boolean } = {},
): ResourceRef[] {
  const out = [...existing];
  const mountPaths = new Map(existing.flatMap((resource) => resource.mountPath ? [[resource.mountPath, stableJson(resource)] as const] : []));
  const identities = new Map(existing.map((resource) => [resourceIdentityKey(resource), stableJson(resource)] as const));
  const exact = new Set(existing.map(stableJson));

  for (const resource of additions) {
    const serialized = stableJson(resource);
    if (exact.has(serialized)) {
      continue;
    }
    if (options.rejectConflicts) {
      const existingAtMount = resource.mountPath ? mountPaths.get(resource.mountPath) : undefined;
      if (existingAtMount && existingAtMount !== serialized) {
        throw new ResourceRefConflictError(`resource mount path is already attached: ${resource.mountPath}`);
      }
      const identity = resourceIdentityKey(resource);
      const existingIdentity = identities.get(identity);
      if (existingIdentity && existingIdentity !== serialized) {
        throw new ResourceRefConflictError(`resource is already attached with different settings: ${identity}`);
      }
    }
    out.push(resource);
    exact.add(serialized);
    identities.set(resourceIdentityKey(resource), serialized);
    if (resource.mountPath) {
      mountPaths.set(resource.mountPath, serialized);
    }
  }
  return out;
}

export function reasoningEffortForMetadata(metadata: Record<string, unknown>, fallback: ReasoningEffort): ReasoningEffort {
  const value = metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function resourceIdentityKey(resource: ResourceRef): string {
  if (resource.kind === "file") {
    return `file:${resource.fileId}`;
  }
  return `repository:${resource.uri}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

export const SessionTurnStatus = z.enum(["queued", "running", "requires_action", "completed", "failed", "cancelled"]);
export type SessionTurnStatus = z.infer<typeof SessionTurnStatus>;

export const SessionTurnSource = z.enum(["user", "scheduled_task", "api"]);
export type SessionTurnSource = z.infer<typeof SessionTurnSource>;

export const SessionTurn = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  triggerEventId: z.string().uuid(),
  temporalWorkflowId: z.string(),
  status: SessionTurnStatus,
  source: SessionTurnSource,
  position: z.number().int().positive(),
  prompt: z.string().min(1),
  resources: z.array(ResourceRef),
  tools: z.array(ToolRef),
  model: z.string().min(1),
  reasoningEffort: ReasoningEffort,
  sandboxBackend: SandboxBackend,
  metadata: z.record(z.string(), z.unknown()),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionTurn = z.infer<typeof SessionTurn>;

export const UpdateSessionTurnRequest = z.object({
  prompt: z.string().min(1).optional(),
  resources: z.array(ResourceRef).optional(),
  tools: z.array(ToolRef).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSessionTurnRequest = z.infer<typeof UpdateSessionTurnRequest>;

export const ReorderSessionTurnsRequest = z.object({
  turnIds: z.array(z.string().uuid()).min(1),
});
export type ReorderSessionTurnsRequest = z.infer<typeof ReorderSessionTurnsRequest>;

export const ScheduledTaskStatus = z.enum(["active", "paused"]);
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatus>;

export const ScheduledTaskRunStatus = z.enum(["queued", "dispatched", "failed"]);
export type ScheduledTaskRunStatus = z.infer<typeof ScheduledTaskRunStatus>;

export const ScheduledTaskRunMode = z.enum(["new_session_per_run", "reusable_session"]);
export type ScheduledTaskRunMode = z.infer<typeof ScheduledTaskRunMode>;

export const ScheduledTaskOverlapPolicy = z.enum(["allow_concurrent", "skip", "buffer_one"]);
export type ScheduledTaskOverlapPolicy = z.infer<typeof ScheduledTaskOverlapPolicy>;

export const ScheduledTaskTriggerType = z.enum(["scheduled", "manual"]);
export type ScheduledTaskTriggerType = z.infer<typeof ScheduledTaskTriggerType>;

export const ScheduledTaskScheduleSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    runAt: z.string().datetime({ offset: true }),
    timeZone: z.string().min(1).default("UTC"),
  }),
  z.object({
    type: z.literal("interval"),
    everySeconds: z.number().int().positive(),
    startAt: z.string().datetime({ offset: true }).optional(),
    endAt: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({
    type: z.literal("calendar"),
    timeZone: z.string().min(1).default("UTC"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    daysOfWeek: z.array(z.enum(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"])).min(1).optional(),
  }),
]);
export type ScheduledTaskScheduleSpec = z.infer<typeof ScheduledTaskScheduleSpec>;

export const ScheduledTaskAgentConfig = z.object({
  prompt: z.string().min(1),
  resources: z.array(ResourceRef).default([]),
  tools: z.array(ToolRef).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
});
export type ScheduledTaskAgentConfig = z.infer<typeof ScheduledTaskAgentConfig>;

export const ScheduledTask = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: ScheduledTaskStatus,
  schedule: ScheduledTaskScheduleSpec,
  temporalScheduleId: z.string(),
  runMode: ScheduledTaskRunMode,
  overlapPolicy: ScheduledTaskOverlapPolicy,
  agentConfig: ScheduledTaskAgentConfig,
  reusableSessionId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const ScheduledTaskRun = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  status: ScheduledTaskRunStatus,
  triggerType: ScheduledTaskTriggerType,
  scheduledAt: z.string().nullable(),
  firedAt: z.string(),
  sessionId: z.string().uuid().nullable(),
  triggerEventId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTaskRun = z.infer<typeof ScheduledTaskRun>;

export const CreateScheduledTaskRequest = z.object({
  name: z.string().min(1),
  schedule: ScheduledTaskScheduleSpec,
  runMode: ScheduledTaskRunMode.default("new_session_per_run"),
  overlapPolicy: ScheduledTaskOverlapPolicy.default("allow_concurrent"),
  agentConfig: ScheduledTaskAgentConfig,
  status: ScheduledTaskStatus.default("active"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateScheduledTaskRequest = z.infer<typeof CreateScheduledTaskRequest>;

export const UpdateScheduledTaskRequest = z.object({
  name: z.string().min(1).optional(),
  schedule: ScheduledTaskScheduleSpec.optional(),
  runMode: ScheduledTaskRunMode.optional(),
  overlapPolicy: ScheduledTaskOverlapPolicy.optional(),
  agentConfig: ScheduledTaskAgentConfig.optional(),
  status: ScheduledTaskStatus.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateScheduledTaskRequest = z.infer<typeof UpdateScheduledTaskRequest>;

export const CapabilityPackConnectorAuthModel = z.enum([
  "oauth2_authorization_code_pkce",
  "oauth2_authorization_code",
  "api_key",
  "credential_ref",
]);
export type CapabilityPackConnectorAuthModel = z.infer<typeof CapabilityPackConnectorAuthModel>;

export const CapabilityPackConnector = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  authModel: CapabilityPackConnectorAuthModel,
  providers: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).default([]),
  required: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityPackConnector = z.infer<typeof CapabilityPackConnector>;

export const CapabilityPackKnowledge = z.object({
  type: z.literal("document_base"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  required: z.boolean().default(false),
});
export type CapabilityPackKnowledge = z.infer<typeof CapabilityPackKnowledge>;

export const CapabilityPackScheduledTaskTemplate = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultSchedule: ScheduledTaskScheduleSpec,
  defaultRunMode: ScheduledTaskRunMode.default("new_session_per_run"),
  defaultOverlapPolicy: ScheduledTaskOverlapPolicy.default("skip"),
});
export type CapabilityPackScheduledTaskTemplate = z.infer<typeof CapabilityPackScheduledTaskTemplate>;

export const CapabilityPack = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  category: z.string().min(1),
  version: z.string().min(1),
  tools: z.array(ToolRef).default([]),
  connectors: z.array(CapabilityPackConnector).default([]),
  knowledge: z.array(CapabilityPackKnowledge).default([]),
  scheduledTaskTemplates: z.array(CapabilityPackScheduledTaskTemplate).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityPack = z.infer<typeof CapabilityPack>;

export const PackInstallationStatus = z.enum(["active", "disabled"]);
export type PackInstallationStatus = z.infer<typeof PackInstallationStatus>;

export const PackInstallation = z.object({
  id: z.string().uuid(),
  packId: z.string().min(1),
  status: PackInstallationStatus,
  metadata: z.record(z.string(), z.unknown()),
  enabledAt: z.string(),
  updatedAt: z.string(),
});
export type PackInstallation = z.infer<typeof PackInstallation>;

export const EnablePackRequest = z.object({
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EnablePackRequest = z.infer<typeof EnablePackRequest>;

export const SocialProvider = z.enum([
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "custom",
]);
export type SocialProvider = z.infer<typeof SocialProvider>;

export const SocialConnectionStatus = z.enum(["connected", "needs_reauth", "disabled"]);
export type SocialConnectionStatus = z.infer<typeof SocialConnectionStatus>;

export const SocialConnection = z.object({
  id: z.string().uuid(),
  provider: SocialProvider,
  accountHandle: z.string().min(1),
  accountName: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  status: SocialConnectionStatus,
  scopes: z.array(z.string()),
  credentialRef: z.string().nullable(),
  tokenMetadata: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SocialConnection = z.infer<typeof SocialConnection>;

export const CreateSocialConnectionRequest = z.object({
  provider: SocialProvider,
  accountHandle: z.string().min(1),
  accountName: z.string().min(1).optional(),
  externalAccountId: z.string().min(1).optional(),
  status: SocialConnectionStatus.default("connected"),
  scopes: z.array(z.string().min(1)).default([]),
  credentialRef: z.string().min(1).optional(),
  tokenMetadata: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSocialConnectionRequest = z.infer<typeof CreateSocialConnectionRequest>;

export const SocialPost = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: SocialProvider,
  externalPostId: z.string().nullable(),
  url: z.string().url().nullable(),
  authorHandle: z.string().nullable(),
  text: z.string(),
  publishedAt: z.string(),
  metrics: z.record(z.string(), z.number()),
  raw: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type SocialPost = z.infer<typeof SocialPost>;

export const CreateSocialPostRequest = z.object({
  connectionId: z.string().uuid(),
  externalPostId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  authorHandle: z.string().min(1).optional(),
  text: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  metrics: z.record(z.string(), z.number()).default({}),
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSocialPostRequest = z.infer<typeof CreateSocialPostRequest>;

export const MarketingDailyAnalysisTaskRequest = z.object({
  name: z.string().min(1).optional(),
  connectionIds: z.array(z.string().uuid()).default([]),
  documentBaseIds: z.array(z.string().uuid()).default([]),
  timeZone: z.string().min(1).default("UTC"),
  hour: z.number().int().min(0).max(23).default(9),
  minute: z.number().int().min(0).max(59).default(0),
  promptInstructions: z.string().min(1).optional(),
  status: ScheduledTaskStatus.default("active"),
  runMode: ScheduledTaskRunMode.default("new_session_per_run"),
  overlapPolicy: ScheduledTaskOverlapPolicy.default("skip"),
});
export type MarketingDailyAnalysisTaskRequest = z.infer<typeof MarketingDailyAnalysisTaskRequest>;

export const CapabilityKind = z.enum(["pack", "mcp", "api", "skill", "plugin"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilitySource = z.enum(["built_in", "configured", "public_registry", "manual"]);
export type CapabilitySource = z.infer<typeof CapabilitySource>;

export const CapabilityInstallationStatus = z.enum(["active", "disabled"]);
export type CapabilityInstallationStatus = z.infer<typeof CapabilityInstallationStatus>;

export const CapabilityRuntime = z.object({
  available: z.boolean().default(false),
  mcpServerId: z.string().min(1).optional(),
  transport: z.string().min(1).optional(),
  notes: z.string().nullable().default(null),
});
export type CapabilityRuntime = z.infer<typeof CapabilityRuntime>;

export const CapabilityCatalogItem = z.object({
  id: z.string().min(1),
  kind: CapabilityKind,
  source: CapabilitySource,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  category: z.string().min(1).default("custom"),
  tags: z.array(z.string().min(1)).default([]),
  homepageUrl: z.string().url().nullable().default(null),
  endpointUrl: z.string().url().nullable().default(null),
  installUrl: z.string().url().nullable().default(null),
  authModel: z.string().min(1).nullable().default(null),
  tools: z.array(ToolRef).default([]),
  runtime: CapabilityRuntime.default({ available: false, notes: null }),
  enabled: z.boolean().default(false),
  enabledReason: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CapabilityCatalogItem = z.infer<typeof CapabilityCatalogItem>;

export const CapabilityInstallation = z.object({
  id: z.string().uuid(),
  capabilityId: z.string().min(1),
  kind: CapabilityKind,
  status: CapabilityInstallationStatus,
  config: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  enabledAt: z.string(),
  updatedAt: z.string(),
});
export type CapabilityInstallation = z.infer<typeof CapabilityInstallation>;

export const CreateCapabilityCatalogItemRequest = z.object({
  id: z.string().min(1).optional(),
  kind: CapabilityKind.exclude(["pack"]),
  source: CapabilitySource.default("manual"),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  category: z.string().min(1).default("custom"),
  tags: z.array(z.string().min(1)).default([]),
  homepageUrl: z.string().url().optional(),
  endpointUrl: z.string().url().optional(),
  installUrl: z.string().url().optional(),
  authModel: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCapabilityCatalogItemRequest = z.infer<typeof CreateCapabilityCatalogItemRequest>;

export const EnableCapabilityRequest = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EnableCapabilityRequest = z.infer<typeof EnableCapabilityRequest>;

export const CapabilityCatalogResponse = z.object({
  items: z.array(CapabilityCatalogItem),
  installations: z.array(CapabilityInstallation),
});
export type CapabilityCatalogResponse = z.infer<typeof CapabilityCatalogResponse>;

export const DiscoverMcpCapabilitiesResponse = z.object({
  items: z.array(CapabilityCatalogItem),
  source: z.literal("official_mcp_registry"),
  sourceUrl: z.string().url(),
});
export type DiscoverMcpCapabilitiesResponse = z.infer<typeof DiscoverMcpCapabilitiesResponse>;

export const Session = z.object({
  id: z.string().uuid(),
  status: SessionStatus,
  initialMessage: z.string(),
  resources: z.array(ResourceRef),
  tools: z.array(ToolRef),
  metadata: z.record(z.string(), z.unknown()),
  model: z.string(),
  sandboxBackend: SandboxBackend,
  temporalWorkflowId: z.string().nullable(),
  activeTurnId: z.string().uuid().nullable(),
  lastSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const SessionEventType = z.enum([
  "session.created",
  "session.status.changed",
  "session.requiresAction",
  "user.message",
  "user.interrupt",
  "user.approvalDecision",
  "turn.queued",
  "turn.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
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
]);
export type SessionEventType = z.infer<typeof SessionEventType>;

export const SessionEvent = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: SessionEventType,
  payload: z.unknown().default({}),
  occurredAt: z.string(),
  clientEventId: z.string().min(1).nullable().optional(),
  turnId: z.string().uuid().nullable().optional(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const CreateSessionRequest = z.object({
  initialMessage: z.string().min(1),
  resources: z.array(ResourceRef).default([]),
  tools: z.array(ToolRef).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
  clientEventId: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const ClientSessionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user.message"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({
      text: z.string().min(1),
      resources: z.array(ResourceRef).default([]),
      tools: z.array(ToolRef).default([]),
      model: z.string().min(1).optional(),
      reasoningEffort: ReasoningEffort.optional(),
    }),
  }),
  z.object({
    type: z.literal("user.interrupt"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({ reason: z.string().optional() }).default({}),
  }),
  z.object({
    type: z.literal("user.approvalDecision"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({
      approvalId: z.string().min(1),
      decision: z.enum(["approve", "reject"]),
      message: z.string().optional(),
    }),
  }),
]);
export type ClientSessionEvent = z.infer<typeof ClientSessionEvent>;

export const SessionBusMessage = z.object({
  sessionId: z.string().uuid(),
  events: z.array(SessionEvent).min(1),
});
export type SessionBusMessage = z.infer<typeof SessionBusMessage>;

export const GitHubAppManifestCreate = z.object({
  appName: z.string().optional(),
  organization: z.string().optional(),
  public: z.boolean().default(false),
  includeCiPermissions: z.boolean().default(true),
});
export type GitHubAppManifestCreate = z.infer<typeof GitHubAppManifestCreate>;

export const GitHubRepository = z.object({
  id: z.number().int(),
  installationId: z.number().int(),
  fullName: z.string(),
  name: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  cloneUrl: z.string(),
  defaultBranch: z.string(),
  accountLogin: z.string(),
  accountType: z.string().nullable(),
});
export type GitHubRepository = z.infer<typeof GitHubRepository>;

export const ClientConfig = z.object({
  defaultModel: z.string(),
  allowedModels: z.array(z.string()).min(1),
  defaultReasoningEffort: ReasoningEffort,
  allowedReasoningEfforts: z.array(ReasoningEffort).min(1),
  mcpServers: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).default([]),
  fileUploads: z.object({
    enabled: z.boolean(),
    maxSizeBytes: z.number().int().positive(),
  }),
  auth: z.object({
    required: z.boolean(),
    headerName: z.literal("authorization"),
    scheme: z.literal("bearer"),
  }).default({
    required: false,
    headerName: "authorization",
    scheme: "bearer",
  }),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

export type HealthResponse = {
  service: string;
  environment: string;
  ok: boolean;
};
