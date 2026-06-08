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

export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "idempotency_conflict",
  "limit_exceeded",
  "provider_verification_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const PageInfo = z.object({
  limit: z.number().int().positive(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfo>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    page: PageInfo,
  });
}

export const Permission = z.enum([
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
]);
export type Permission = z.infer<typeof Permission>;

export const ProductAccessMode = z.enum(["local", "configured", "managed"]);
export type ProductAccessMode = z.infer<typeof ProductAccessMode>;

export const BillingMode = z.enum(["disabled", "stripe"]);
export type BillingMode = z.infer<typeof BillingMode>;

export const EntitlementsMode = z.enum(["none", "static", "managed"]);
export type EntitlementsMode = z.infer<typeof EntitlementsMode>;

export const UsageLimitsMode = z.enum(["none", "static", "managed"]);
export type UsageLimitsMode = z.infer<typeof UsageLimitsMode>;

export const AccountRole = z.enum(["owner", "admin", "member"]);
export type AccountRole = z.infer<typeof AccountRole>;

export const ManagedAccount = z.object({
  id: z.string().uuid(),
  name: z.string(),
  externalSource: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedAccount = z.infer<typeof ManagedAccount>;

export const Workspace = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  slug: z.string().nullable(),
  externalSource: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const AccountGrant = z.object({
  accountId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  role: AccountRole.optional(),
  permissions: z.array(Permission),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AccountGrant = z.infer<typeof AccountGrant>;

export const AccessGrant = z.object({
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  permissions: z.array(Permission),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AccessGrant = z.infer<typeof AccessGrant>;

export const AccessContext = z.object({
  mode: ProductAccessMode,
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  accountGrants: z.array(AccountGrant),
  workspaceGrants: z.array(AccessGrant),
  defaultAccountId: z.string().uuid().nullable(),
  defaultWorkspaceId: z.string().uuid().nullable(),
});
export type AccessContext = z.infer<typeof AccessContext>;

export const DelegatedAccessTokenPayload = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  permissions: z.array(Permission).min(1),
  exp: z.number().int().positive(),
});
export type DelegatedAccessTokenPayload = z.infer<typeof DelegatedAccessTokenPayload>;

export async function signDelegatedAccessToken(secret: string, payload: DelegatedAccessTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(DelegatedAccessTokenPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `ogd_${encodedPayload}.${signature}`;
}

export async function verifyDelegatedAccessToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<DelegatedAccessTokenPayload | null> {
  if (!token.startsWith("ogd_")) {
    return null;
  }
  const withoutPrefix = token.slice("ogd_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  const payload = DelegatedAccessTokenPayload.safeParse(JSON.parse(base64UrlDecode(encodedPayload)));
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

export const CreateWorkspaceRequest = z.object({
  accountId: z.string().uuid().optional(),
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  externalSource: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const UpdateWorkspaceRequest = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).nullable().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

export const ApiKey = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  name: z.string(),
  prefix: z.string(),
  permissions: z.array(Permission),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const CreateApiKeyRequest = z.object({
  name: z.string().min(1),
  workspaceId: z.string().uuid().optional(),
  permissions: z.array(Permission).min(1),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const CreateApiKeyResponse = z.object({
  apiKey: ApiKey,
  token: z.string().min(1),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponse>;

export const UsageEventType = z.enum([
  "agent_run.created",
  "agent_run.completed",
  "model.tokens",
  "model.cost",
  "file.uploaded",
  "file.deleted",
  "document.indexed",
  "scheduled_task.fired",
  "api_key.request",
]);
export type UsageEventType = z.infer<typeof UsageEventType>;

export const UsageEvent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  subjectId: z.string().nullable(),
  eventType: UsageEventType,
  quantity: z.number(),
  unit: z.string(),
  sourceResourceType: z.string().nullable(),
  sourceResourceId: z.string().nullable(),
  idempotencyKey: z.string(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  exportedToBillingAt: z.string().nullable(),
  billingProviderEventId: z.string().nullable(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const LimitAction = z.enum([
  "agent_run:create",
  "tokens:consume",
  "file:upload",
  "document:index",
  "schedule:create",
  "workspace:create",
  "api_key:create",
]);
export type LimitAction = z.infer<typeof LimitAction>;

export const StaticUsageLimits = z.object({
  maxWorkspacesPerAccount: z.number().int().positive().optional(),
  maxApiKeysPerWorkspace: z.number().int().positive().optional(),
  maxSchedulesPerWorkspace: z.number().int().positive().optional(),
  maxFileUploadBytes: z.number().int().positive().optional(),
  maxMonthlyAgentRunsPerWorkspace: z.number().int().positive().optional(),
  maxMonthlyTokensPerWorkspace: z.number().int().positive().optional(),
  maxMonthlyCostMicrosPerAccount: z.number().int().positive().optional(),
  maxDocumentIndexedChunksPerWorkspace: z.number().int().positive().optional(),
});
export type StaticUsageLimits = z.infer<typeof StaticUsageLimits>;

export const EntitlementValue = z.union([z.boolean(), z.string(), z.number(), z.array(z.string())]);
export type EntitlementValue = z.infer<typeof EntitlementValue>;

export const Entitlements = z.record(z.string().min(1), EntitlementValue);
export type Entitlements = z.infer<typeof Entitlements>;

export const LimitDecision = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), code: z.string(), message: z.string() }),
]);
export type LimitDecision = z.infer<typeof LimitDecision>;

export const BillingBalance = z.object({
  accountId: z.string().uuid(),
  balanceMicros: z.number().int(),
  currency: z.literal("usd"),
  updatedAt: z.string(),
});
export type BillingBalance = z.infer<typeof BillingBalance>;

export const CreateCheckoutRequest = z.object({
  accountId: z.string().uuid(),
  packageId: z.enum(["topup_25", "topup_100", "topup_500", "topup_1000"]),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequest>;

export const CreateCheckoutResponse = z.object({
  checkoutSessionId: z.string(),
  url: z.string().url(),
});
export type CreateCheckoutResponse = z.infer<typeof CreateCheckoutResponse>;

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
  workspaceId: z.string().uuid(),
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

export const DocumentBase = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentBase = z.infer<typeof DocumentBase>;

export const Document = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  status: DocumentStatus,
  title: z.string(),
  parser: z.string(),
  chunkCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Document = z.infer<typeof Document>;

export const DocumentSearchResult = z.object({
  chunkId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  title: z.string(),
  text: z.string(),
  score: z.number(),
  chunkIndex: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
});
export type DocumentSearchResult = z.infer<typeof DocumentSearchResult>;

export const CreateDocumentBaseRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateDocumentBaseRequest = z.infer<typeof CreateDocumentBaseRequest>;

export const AddDocumentRequest = z.object({
  fileId: z.string().uuid(),
});
export type AddDocumentRequest = z.infer<typeof AddDocumentRequest>;

export const DocumentSearchRequest = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
});
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequest>;

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
  workspaceId: z.string().uuid(),
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
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
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
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
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

export const Session = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
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
  workspaceId: z.string().uuid(),
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
  workspaceId: z.string().uuid(),
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

export const ClientAuthConfig = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("deploymentKey"),
    headerName: z.literal("x-opengeni-access-key"),
  }),
  z.object({
    mode: z.literal("configuredToken"),
    headerName: z.literal("authorization"),
    scheme: z.literal("bearer"),
  }),
  z.object({
    mode: z.literal("managedSession"),
    session: z.literal("cookie"),
  }),
]);
export type ClientAuthConfig = z.infer<typeof ClientAuthConfig>;

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
  productAccessMode: ProductAccessMode,
  auth: ClientAuthConfig.default({ mode: "none" }),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(signature).toString("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    diff |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return diff === 0;
}

export type HealthResponse = {
  service: string;
  environment: string;
  ok: boolean;
};
