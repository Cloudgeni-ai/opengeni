import type {
  ClientConfig,
  AccessContext,
  AuthSession,
  ApiKey,
  BillingBalance,
  CreateFileUploadResponse,
  DocumentBase,
  DocumentSearchResult,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubRepository,
  IndexedDocument,
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
export const bundleDeploymentRevision = String(import.meta.env.VITE_OPENGENI_DEPLOYMENT_REVISION ?? "");
const accessKeyStorageKey = "opengeni.accessKey";
const deploymentReloadStoragePrefix = "opengeni.reloadForRevision:";
let activeAuthConfig: ClientConfig["auth"] | null = null;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

export function isApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

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

export function configureClientAuth(auth: ClientConfig["auth"]): void {
  activeAuthConfig = auth;
}

export function authHeadersForAccessKey(value: string | null, auth: ClientConfig["auth"] | null = activeAuthConfig): Record<string, string> {
  if (!value) {
    return {};
  }
  if (auth?.mode === "deploymentKey") {
    return { "x-opengeni-access-key": value };
  }
  if (auth?.mode === "configuredToken") {
    return { authorization: `Bearer ${value}` };
  }
  return {};
}

function authHeaders(): Record<string, string> {
  return authHeadersForAccessKey(getStoredAccessKey());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text);
  }
  return await response.json() as T;
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/v1/auth${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth ${response.status}: ${text}`);
  }
  return await response.json() as T;
}

export async function fetchAuthSession(): Promise<AuthSession | null> {
  return await authRequest<AuthSession | null>("/get-session", { method: "GET" });
}

export async function signUpEmail(input: { name: string; email: string; password: string }): Promise<unknown> {
  return await authRequest<unknown>("/sign-up/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendVerificationEmail(input: { email: string }): Promise<{ status: boolean }> {
  return await authRequest<{ status: boolean }>("/send-verification-email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signInEmail(input: { email: string; password: string; rememberMe?: boolean }): Promise<unknown> {
  return await authRequest<unknown>("/sign-in/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signOutManaged(): Promise<unknown> {
  return await authRequest<unknown>("/sign-out", { method: "POST" });
}

export function createSession(input: {
  workspaceId: string;
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<Session> {
  return request<Session>(workspacePath(input.workspaceId, "/sessions"), {
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

export async function fetchClientConfig(): Promise<ClientConfig> {
  const config = await request<ClientConfig>("/v1/config/client");
  reloadIfStaleDeployment(config);
  configureClientAuth(config.auth);
  return config;
}

export function shouldReloadForDeploymentRevision(
  config: Pick<ClientConfig, "deploymentRevision">,
  bundleRevision = bundleDeploymentRevision,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined" ? null : sessionStorage,
): boolean {
  if (!bundleRevision || !config.deploymentRevision || bundleRevision === config.deploymentRevision || !storage) {
    return false;
  }
  const key = `${deploymentReloadStoragePrefix}${config.deploymentRevision}`;
  if (storage.getItem(key) === bundleRevision) {
    return false;
  }
  storage.setItem(key, bundleRevision);
  return true;
}

function reloadIfStaleDeployment(config: ClientConfig): void {
  if (!shouldReloadForDeploymentRevision(config)) {
    return;
  }
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export function fetchAccessContext(): Promise<AccessContext> {
  return request<AccessContext>("/v1/access/me");
}

export function fetchWorkspaces(): Promise<import("./types").Workspace[]> {
  return request<import("./types").Workspace[]>("/v1/workspaces");
}

export function fetchSession(workspaceId: string, sessionId: string): Promise<Session> {
  return request<Session>(workspacePath(workspaceId, `/sessions/${sessionId}`));
}

export async function fetchEvents(workspaceId: string, sessionId: string, after = 0): Promise<SessionEvent[]> {
  const limit = 500;
  const events: SessionEvent[] = [];
  let cursor = after;
  while (true) {
    const page = await request<SessionEvent[]>(workspacePath(workspaceId, `/sessions/${sessionId}/events?after=${cursor}&limit=${limit}`));
    events.push(...page);
    if (page.length < limit) {
      return events;
    }
    cursor = page[page.length - 1]!.sequence;
  }
}

export function sendUserMessage(workspaceId: string, sessionId: string, submission: TurnSubmission): Promise<SessionEvent> {
  return request<SessionEvent>(workspacePath(workspaceId, `/sessions/${sessionId}/events`), {
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

export async function uploadFileAsset(workspaceId: string, file: File): Promise<FileAsset> {
  const upload = await request<CreateFileUploadResponse>(workspacePath(workspaceId, "/files/uploads"), {
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
  const completed = await request<{ file: FileAsset }>(workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`), {
    method: "POST",
  });
  return completed.file;
}

export async function fetchFileDownloadUrl(workspaceId: string, fileId: string): Promise<FileDownloadUrlResponse> {
  return await request<FileDownloadUrlResponse>(workspacePath(workspaceId, `/files/${fileId}/download-url`), {
    method: "POST",
  });
}

export async function fetchFileAsset(workspaceId: string, fileId: string): Promise<FileAsset> {
  return await request<FileAsset>(workspacePath(workspaceId, `/files/${fileId}`));
}

export function createDocumentBase(workspaceId: string, input: { name: string; description?: string }): Promise<DocumentBase> {
  return request<DocumentBase>(workspacePath(workspaceId, "/document-bases"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchDocumentBases(workspaceId: string): Promise<DocumentBase[]> {
  return request<DocumentBase[]>(workspacePath(workspaceId, "/document-bases"));
}

export function fetchDocuments(workspaceId: string, baseId: string): Promise<IndexedDocument[]> {
  return request<IndexedDocument[]>(workspacePath(workspaceId, `/document-bases/${baseId}/documents`));
}

export function addDocumentToBase(workspaceId: string, baseId: string, fileId: string): Promise<IndexedDocument> {
  return request<IndexedDocument>(workspacePath(workspaceId, `/document-bases/${baseId}/documents`), {
    method: "POST",
    body: JSON.stringify({ fileId }),
  });
}

export function reindexDocument(workspaceId: string, baseId: string, documentId: string): Promise<IndexedDocument> {
  return request<IndexedDocument>(workspacePath(workspaceId, `/document-bases/${baseId}/documents/${documentId}/reindex`), {
    method: "POST",
  });
}

export async function searchDocumentBase(workspaceId: string, baseId: string, query: string): Promise<DocumentSearchResult[]> {
  const response = await request<{ results: DocumentSearchResult[] }>(workspacePath(workspaceId, `/document-bases/${baseId}/search`), {
    method: "POST",
    body: JSON.stringify({ query, limit: 8 }),
  });
  return response.results;
}

export function sendInterrupt(workspaceId: string, sessionId: string, reason?: string): Promise<SessionEvent> {
  return request<SessionEvent>(workspacePath(workspaceId, `/sessions/${sessionId}/events`), {
    method: "POST",
    body: JSON.stringify({
      type: "user.interrupt",
      clientEventId: crypto.randomUUID(),
      payload: { reason },
    }),
  });
}

export function sendApproval(workspaceId: string, sessionId: string, approvalId: string, decision: "approve" | "reject"): Promise<SessionEvent> {
  return request<SessionEvent>(workspacePath(workspaceId, `/sessions/${sessionId}/events`), {
    method: "POST",
    body: JSON.stringify({
      type: "user.approvalDecision",
      clientEventId: crypto.randomUUID(),
      payload: { approvalId, decision },
    }),
  });
}

function streamUrl(workspaceId: string, sessionId: string, after: number): string {
  const path = `${apiBaseUrl}${workspacePath(workspaceId, `/sessions/${sessionId}/events/stream`)}`;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("after", String(after));
  return url.toString();
}

export async function streamSessionEvents(
  workspaceId: string,
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
      await readSessionEventStream(workspaceId, sessionId, cursor, (event) => {
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
  workspaceId: string,
  sessionId: string,
  after: number,
  onEvent: (event: SessionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(streamUrl(workspaceId, sessionId, after), {
    headers: authHeaders(),
    credentials: "include",
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

export async function fetchGitHubStatus(workspaceId: string): Promise<{ configured: boolean; missing: string[]; installUrl: string | null }> {
  return await request(workspacePath(workspaceId, "/github/app"));
}

export async function fetchGitHubRepositories(workspaceId: string): Promise<GitHubRepository[]> {
  const payload = await request<{ repositories: GitHubRepository[] }>(workspacePath(workspaceId, "/github/repositories"));
  return payload.repositories;
}

export async function startGitHubManifest(workspaceId: string, organization?: string): Promise<{ actionUrl: string; manifest: Record<string, unknown>; state: string }> {
  return await request(workspacePath(workspaceId, "/github/app-manifest"), {
    method: "POST",
    body: JSON.stringify({ organization: organization || undefined, public: false, includeCiPermissions: true }),
  });
}

export function fetchScheduledTasks(workspaceId: string): Promise<ScheduledTask[]> {
  return request<ScheduledTask[]>(workspacePath(workspaceId, "/scheduled-tasks"));
}

export function fetchScheduledTaskRuns(workspaceId: string, taskId: string): Promise<ScheduledTaskRun[]> {
  return request<ScheduledTaskRun[]>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}/runs`));
}

export function createScheduledTask(input: {
  workspaceId: string;
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTask["runMode"];
  overlapPolicy: ScheduledTask["overlapPolicy"];
  agentConfig: ScheduledTaskAgentConfig;
}): Promise<ScheduledTask> {
  return request<ScheduledTask>(workspacePath(input.workspaceId, "/scheduled-tasks"), {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      schedule: input.schedule,
      runMode: input.runMode,
      overlapPolicy: input.overlapPolicy,
      agentConfig: input.agentConfig,
    }),
  });
}

export function updateScheduledTask(workspaceId: string, taskId: string, input: Partial<{
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTask["runMode"];
  overlapPolicy: ScheduledTask["overlapPolicy"];
  agentConfig: ScheduledTaskAgentConfig;
  status: ScheduledTask["status"];
}>): Promise<ScheduledTask> {
  return request<ScheduledTask>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}`), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function pauseScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}/pause`), { method: "POST" });
}

export function resumeScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}/resume`), { method: "POST" });
}

export function triggerScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
  return request<ScheduledTask>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}/trigger`), { method: "POST" });
}

export function deleteScheduledTask(workspaceId: string, taskId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(workspacePath(workspaceId, `/scheduled-tasks/${taskId}`), { method: "DELETE" });
}

export async function fetchApiKeys(workspaceId: string): Promise<ApiKey[]> {
  const payload = await request<{ apiKeys: ApiKey[] }>(workspacePath(workspaceId, "/api-keys"));
  return payload.apiKeys;
}

export async function createApiKey(workspaceId: string, input: { name: string; permissions: string[]; expiresAt?: string | null }): Promise<{ apiKey: ApiKey; token: string }> {
  return await request<{ apiKey: ApiKey; token: string }>(workspacePath(workspaceId, "/api-keys"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeApiKey(workspaceId: string, apiKeyId: string): Promise<ApiKey> {
  return request<ApiKey>(workspacePath(workspaceId, `/api-keys/${apiKeyId}`), { method: "DELETE" });
}

export function fetchBilling(accountId?: string): Promise<{ balance: BillingBalance; mode: string }> {
  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return request<{ balance: BillingBalance; mode: string }>(`/v1/billing${query}`);
}

export function createBillingCheckout(packageId: string, accountId?: string): Promise<{ url: string; checkoutSessionId: string }> {
  return request<{ url: string; checkoutSessionId: string }>("/v1/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ packageId, accountId }),
  });
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}
