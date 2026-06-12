import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";

import type {
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  ClientConfig,
  AccessContext,
  AuthSession,
  ApiKey,
  BillingBalance,
  CreateCapabilityInput,
  CreateFileUploadResponse,
  DocumentBase,
  DocumentSearchResult,
  FileAsset,
  FileDownloadUrlResponse,
  GitHubRepository,
  IndexedDocument,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
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
  return (error instanceof ApiError || error instanceof OpenGeniApiError) && error.status === status;
}

/**
 * The console's session client is the public `@opengeni/sdk` client pointed
 * at the same API the console proxies everything else through. Auth headers
 * are computed per request (the stored access key can change at runtime) and
 * cookies ride along for managed-session deployments.
 */
export function createOpenGeniClient(): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl: apiBaseUrl,
    headers: () => authHeaders(),
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
  });
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

export function fetchCapabilities(workspaceId: string, signal?: AbortSignal): Promise<CapabilityCatalogResponse> {
  return request<CapabilityCatalogResponse>(workspacePath(workspaceId, "/capabilities"), { signal });
}

export function createCapability(workspaceId: string, input: CreateCapabilityInput): Promise<CapabilityCatalogItem> {
  return request<CapabilityCatalogItem>(workspacePath(workspaceId, "/capabilities"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function enableCapability(workspaceId: string, capabilityId: string, input: { config?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}): Promise<unknown> {
  return request(workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`), {
    method: "POST",
    body: JSON.stringify({
      config: input.config ?? {},
      metadata: input.metadata ?? {},
    }),
  });
}

export function disableCapability(workspaceId: string, capabilityId: string): Promise<unknown> {
  return request(workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/disable`), {
    method: "POST",
  });
}

export async function discoverMcpRegistryCapabilities(workspaceId: string, input: { query?: string; limit?: number } = {}): Promise<CapabilityCatalogItem[]> {
  const params = new URLSearchParams();
  if (input.query?.trim()) {
    params.set("query", input.query.trim());
  }
  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  const suffix = params.toString() ? `?${params}` : "";
  const response = await request<{ items: CapabilityCatalogItem[] }>(workspacePath(workspaceId, `/capabilities/discovery/mcp-registry${suffix}`));
  return response.items;
}

export function fetchWorkspaces(): Promise<import("./types").Workspace[]> {
  return request<import("./types").Workspace[]>("/v1/workspaces");
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

export async function fetchGitHubStatus(workspaceId: string, signal?: AbortSignal): Promise<{ configured: boolean; missing: string[]; installUrl: string | null }> {
  return await request(workspacePath(workspaceId, "/github/app"), { signal });
}

export async function fetchGitHubRepositories(workspaceId: string, signal?: AbortSignal): Promise<GitHubRepository[]> {
  const payload = await request<{ repositories: GitHubRepository[] }>(workspacePath(workspaceId, "/github/repositories"), { signal });
  return payload.repositories;
}

export async function startGitHubManifest(workspaceId: string, organization?: string): Promise<{ actionUrl: string; manifest: Record<string, unknown>; state: string }> {
  return await request(workspacePath(workspaceId, "/github/app-manifest"), {
    method: "POST",
    body: JSON.stringify({ organization: organization || undefined, public: false, includeCiPermissions: true }),
  });
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

export function createBillingCheckout(amountUsd: number, accountId?: string): Promise<{ url: string; checkoutSessionId: string }> {
  return request<{ url: string; checkoutSessionId: string }>("/v1/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ amountUsd, accountId }),
  });
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}
