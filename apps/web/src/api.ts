import type {
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  ClientConfig,
  CreateCapabilityInput,
  CreateFileUploadResponse,
  AddDocumentMetadata,
  DocumentBase,
  DocumentSearchMode,
  DocumentSearchResult,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubRepository,
  IndexedDocument,
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceKind,
  ReasoningEffort,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  Session,
  SessionEvent,
  ToolRef,
  TurnSubmission,
} from "./types";

export function resolveApiBaseUrl(value: string | undefined): string {
  return (value ?? "").replace(/\/+$/, "");
}

export const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const accessKeyStorageKey = "opengeni.accessKey";

export function getStoredAccessKey(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  const value = localStorage.getItem(accessKeyStorageKey);
  return value && value.trim().length > 0 ? value : null;
}

export function setStoredAccessKey(value: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(accessKeyStorageKey, value);
}

export function clearStoredAccessKey(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.removeItem(accessKeyStorageKey);
}

export function authHeadersForAccessKey(value: string | null): Record<string, string> {
  return value ? { authorization: `Bearer ${value}` } : {};
}

function authHeaders(): Record<string, string> {
  return authHeadersForAccessKey(getStoredAccessKey());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text}`);
  }
  return await response.json() as T;
}

export function createSession(input: {
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<Session> {
  return request<Session>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools ?? [],
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      clientEventId: crypto.randomUUID(),
    }),
  });
}

export function fetchClientConfig(): Promise<ClientConfig> {
  return request<ClientConfig>("/v1/config/client");
}

export function fetchCapabilities(): Promise<CapabilityCatalogResponse> {
  return request<CapabilityCatalogResponse>("/v1/capabilities");
}

export function createCapability(input: CreateCapabilityInput): Promise<CapabilityCatalogItem> {
  return request<CapabilityCatalogItem>("/v1/capabilities", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function enableCapability(capabilityId: string, input: { config?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}): Promise<unknown> {
  return request(`/v1/capabilities/${encodeURIComponent(capabilityId)}/enable`, {
    method: "POST",
    body: JSON.stringify({
      config: input.config ?? {},
      metadata: input.metadata ?? {},
    }),
  });
}

export function disableCapability(capabilityId: string): Promise<unknown> {
  return request(`/v1/capabilities/${encodeURIComponent(capabilityId)}/disable`, {
    method: "POST",
  });
}

export async function discoverMcpRegistryCapabilities(input: { query?: string; limit?: number } = {}): Promise<CapabilityCatalogItem[]> {
  const params = new URLSearchParams();
  if (input.query?.trim()) {
    params.set("query", input.query.trim());
  }
  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  const suffix = params.toString() ? `?${params}` : "";
  const response = await request<{ items: CapabilityCatalogItem[] }>(`/v1/capabilities/discovery/mcp-registry${suffix}`);
  return response.items;
}

export function fetchSession(sessionId: string): Promise<Session> {
  return request<Session>(`/v1/sessions/${sessionId}`);
}

export async function fetchEvents(sessionId: string, after = 0): Promise<SessionEvent[]> {
  const limit = 500;
  const events: SessionEvent[] = [];
  let cursor = after;
  while (true) {
    const page = await request<SessionEvent[]>(`/v1/sessions/${sessionId}/events?after=${cursor}&limit=${limit}`);
    events.push(...page);
    if (page.length < limit) {
      return events;
    }
    cursor = page[page.length - 1]!.sequence;
  }
}

export function sendUserMessage(sessionId: string, submission: TurnSubmission): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.message",
      clientEventId: crypto.randomUUID(),
      payload: {
        text: submission.text,
        resources: submission.resources ?? [],
        tools: submission.tools ?? [],
        model: submission.model,
        reasoningEffort: submission.reasoningEffort,
      },
    }),
  });
}

export async function uploadFileAsset(file: File): Promise<FileAsset> {
  const upload = await request<CreateFileUploadResponse>("/v1/files/uploads", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name || "file",
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  const put = await fetch(upload.putUrl, {
    method: "PUT",
    body: file,
    headers: upload.requiredHeaders,
  });
  if (!put.ok) {
    throw new Error(`Object storage upload failed: ${put.status} ${await put.text()}`);
  }
  const completed = await request<{ file: FileAsset }>(`/v1/files/uploads/${upload.uploadId}/complete`, {
    method: "POST",
  });
  return completed.file;
}

export async function fetchFileDownloadUrl(fileId: string): Promise<FileDownloadUrlResponse> {
  return await request<FileDownloadUrlResponse>(`/v1/files/${fileId}/download-url`, {
    method: "POST",
  });
}

export async function fetchFileAsset(fileId: string): Promise<FileAsset> {
  return await request<FileAsset>(`/v1/files/${fileId}`);
}

export function createDocumentBase(input: { name: string; description?: string }): Promise<DocumentBase> {
  return request<DocumentBase>("/v1/document-bases", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchDocumentBases(): Promise<DocumentBase[]> {
  return request<DocumentBase[]>("/v1/document-bases");
}

export function fetchDocuments(baseId: string): Promise<IndexedDocument[]> {
  return request<IndexedDocument[]>(`/v1/document-bases/${baseId}/documents`);
}

export function addDocumentToBase(baseId: string, fileId: string, metadata: AddDocumentMetadata = {}): Promise<IndexedDocument> {
  return request<IndexedDocument>(`/v1/document-bases/${baseId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      fileId,
      ...metadata,
    }),
  });
}

export function reindexDocument(documentId: string): Promise<IndexedDocument> {
  return request<IndexedDocument>(`/v1/documents/${documentId}/reindex`, {
    method: "POST",
  });
}

export async function searchDocumentBase(baseId: string, input: {
  query: string;
  mode?: DocumentSearchMode;
  sourceKinds?: KnowledgeSourceKind[];
  aclTags?: string[];
  limit?: number;
}): Promise<DocumentSearchResult[]> {
  const response = await request<{ results: DocumentSearchResult[] }>(`/v1/document-bases/${baseId}/search`, {
    method: "POST",
    body: JSON.stringify({
      query: input.query,
      mode: input.mode,
      sourceKinds: input.sourceKinds,
      aclTags: input.aclTags,
      limit: input.limit ?? 8,
    }),
  });
  return response.results;
}

export function fetchKnowledgeMemories(input: {
  query?: string;
  status?: KnowledgeMemoryStatus;
  kind?: KnowledgeMemoryKind;
  scope?: string;
  limit?: number;
} = {}): Promise<KnowledgeMemory[]> {
  const params = new URLSearchParams();
  if (input.query?.trim()) params.set("query", input.query.trim());
  if (input.status) params.set("status", input.status);
  if (input.kind) params.set("kind", input.kind);
  if (input.scope?.trim()) params.set("scope", input.scope.trim());
  if (input.limit) params.set("limit", String(input.limit));
  const suffix = params.toString() ? `?${params}` : "";
  return request<KnowledgeMemory[]>(`/v1/knowledge/memories${suffix}`);
}

export function createKnowledgeMemory(input: {
  text: string;
  kind?: KnowledgeMemoryKind;
  scope?: string;
  confidence?: number;
  status?: KnowledgeMemoryStatus;
  metadata?: Record<string, unknown>;
}): Promise<KnowledgeMemory> {
  return request<KnowledgeMemory>("/v1/knowledge/memories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateKnowledgeMemory(memoryId: string, input: Partial<{
  status: KnowledgeMemoryStatus;
  kind: KnowledgeMemoryKind;
  scope: string;
  text: string;
  confidence: number;
  metadata: Record<string, unknown>;
  reviewedBy: string;
}>): Promise<KnowledgeMemory> {
  return request<KnowledgeMemory>(`/v1/knowledge/memories/${encodeURIComponent(memoryId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function sendInterrupt(sessionId: string, reason?: string): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.interrupt",
      clientEventId: crypto.randomUUID(),
      payload: { reason },
    }),
  });
}

export function sendApproval(sessionId: string, approvalId: string, decision: "approve" | "reject"): Promise<SessionEvent> {
  return request<SessionEvent>(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      type: "user.approvalDecision",
      clientEventId: crypto.randomUUID(),
      payload: { approvalId, decision },
    }),
  });
}

function streamUrl(sessionId: string, after: number): string {
  const path = `${apiBaseUrl}/v1/sessions/${sessionId}/events/stream`;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("after", String(after));
  return url.toString();
}

export async function streamSessionEvents(
  sessionId: string,
  after: number,
  onEvent: (event: SessionEvent) => void,
  signalOrOptions?: AbortSignal | StreamSessionEventsOptions,
): Promise<void> {
  const options = normalizeStreamOptions(signalOrOptions);
  const baseDelayMs = options.reconnectDelayMs ?? 500;
  const maxDelayMs = options.maxReconnectDelayMs ?? 5000;
  const signal = options.signal;
  let cursor = after;
  let retryDelayMs = baseDelayMs;

  while (!signal?.aborted) {
    options.onState?.("connecting");
    try {
      await readSessionEventStream(sessionId, cursor, (event) => {
        cursor = Math.max(cursor, event.sequence);
        retryDelayMs = baseDelayMs;
        options.onState?.("live");
        onEvent(event);
      }, signal);
      if (signal?.aborted) {
        break;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        break;
      }
      if (!isRetryableStreamError(error)) {
        options.onState?.("error");
        throw error;
      }
      options.onState?.("error");
    }

    options.onState?.("connecting");
    await waitForReconnect(retryDelayMs, signal);
    retryDelayMs = nextReconnectDelay(retryDelayMs, baseDelayMs, maxDelayMs);
  }
}

type StreamConnectionState = "connecting" | "live" | "error";

type StreamSessionEventsOptions = {
  signal?: AbortSignal;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onState?: (state: StreamConnectionState) => void;
};

class SessionStreamHttpError extends Error {
  constructor(readonly status: number, text: string) {
    super(`API ${status}: ${text}`);
    this.name = "SessionStreamHttpError";
  }
}

async function readSessionEventStream(
  sessionId: string,
  after: number,
  onEvent: (event: SessionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(streamUrl(sessionId, after), {
    headers: authHeaders(),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new SessionStreamHttpError(response.status, text);
  }
  if (!response.body) {
    throw new Error("SSE response did not include a readable body");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseEvent(block);
        if (event) {
          onEvent(event);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeStreamOptions(signalOrOptions?: AbortSignal | StreamSessionEventsOptions): StreamSessionEventsOptions {
  if (!signalOrOptions) {
    return {};
  }
  if (isAbortSignal(signalOrOptions)) {
    return { signal: signalOrOptions };
  }
  return signalOrOptions;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && "aborted" in value
    && "addEventListener" in value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof SessionStreamHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function nextReconnectDelay(currentDelayMs: number, baseDelayMs: number, maxDelayMs: number): number {
  if (maxDelayMs <= baseDelayMs) {
    return maxDelayMs;
  }
  return Math.min(Math.max(currentDelayMs * 2, baseDelayMs), maxDelayMs);
}

async function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timeout);
      done();
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSseEvent(block: string): SessionEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data ? JSON.parse(data) as SessionEvent : null;
}

export async function fetchGitHubStatus(): Promise<{ configured: boolean; missing: string[]; installUrl: string | null }> {
  return await request("/v1/github/app");
}

export async function fetchGitHubRepositories(): Promise<GitHubRepository[]> {
  const payload = await request<{ repositories: GitHubRepository[] }>("/v1/github/repositories");
  return payload.repositories;
}

export async function startGitHubManifest(organization?: string): Promise<{ actionUrl: string; manifest: Record<string, unknown>; state: string }> {
  return await request("/v1/github/app-manifest", {
    method: "POST",
    body: JSON.stringify({ organization: organization || undefined, public: false, includeCiPermissions: true }),
  });
}

export function fetchScheduledTasks(): Promise<ScheduledTask[]> {
  return request<ScheduledTask[]>("/v1/scheduled-tasks");
}

export function fetchScheduledTaskRuns(taskId: string): Promise<ScheduledTaskRun[]> {
  return request<ScheduledTaskRun[]>(`/v1/scheduled-tasks/${taskId}/runs`);
}

export function createScheduledTask(input: {
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTask["runMode"];
  overlapPolicy: ScheduledTask["overlapPolicy"];
  agentConfig: ScheduledTaskAgentConfig;
}): Promise<ScheduledTask> {
  return request<ScheduledTask>("/v1/scheduled-tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateScheduledTask(taskId: string, input: Partial<{
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTask["runMode"];
  overlapPolicy: ScheduledTask["overlapPolicy"];
  agentConfig: ScheduledTaskAgentConfig;
  status: ScheduledTask["status"];
}>): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/v1/scheduled-tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function pauseScheduledTask(taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/v1/scheduled-tasks/${taskId}/pause`, { method: "POST" });
}

export function resumeScheduledTask(taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/v1/scheduled-tasks/${taskId}/resume`, { method: "POST" });
}

export function triggerScheduledTask(taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/v1/scheduled-tasks/${taskId}/trigger`, { method: "POST" });
}

export function deleteScheduledTask(taskId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/v1/scheduled-tasks/${taskId}`, { method: "DELETE" });
}
