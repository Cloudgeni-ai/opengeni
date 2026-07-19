// The console's bespoke HTTP surface: client config bootstrap, short-lived
// transcription credentials, and Better Auth (managed session) endpoints.
// Everything covered by the public SDK still goes through `@opengeni/sdk`.
import type {
  OpenAIClientSecret,
  OpenAIClientSecretRequest,
  OpenAIGrantSettlement,
  OpenAIGrantUsageReport,
} from "@opengeni/react/transcription/openai-realtime";
import {
  OpenGeniApiError,
  OpenGeniClient,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
} from "@opengeni/sdk";

import type { AuthSession, ClientConfig } from "./types";

export function resolveApiBaseUrl(value: string | undefined): string {
  return (value ?? "").replace(/\/+$/, "");
}

export const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
export const bundleDeploymentRevision = String(
  import.meta.env.VITE_OPENGENI_DEPLOYMENT_REVISION ?? "",
);
const accessKeyStorageKey = "opengeni.accessKey";
const deploymentReloadStoragePrefix = "opengeni.reloadForRevision:";
const contractReloadStoragePrefix = "opengeni.reloadForApiContract:";
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
  return (
    (error instanceof ApiError || error instanceof OpenGeniApiError) && error.status === status
  );
}

/**
 * The console's API client is the public `@opengeni/sdk` client pointed at
 * the same API the console is served from. Auth headers are computed per
 * request (the stored access key can change at runtime) and cookies ride
 * along for managed-session deployments.
 */
export function createOpenGeniClient(): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl: apiBaseUrl,
    headers: () => authHeaders(),
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, credentials: "include" });
      handleApiContractResponse(response);
      return response;
    },
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

export function authHeadersForAccessKey(
  value: string | null,
  auth: ClientConfig["auth"] | null = activeAuthConfig,
): Record<string, string> {
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
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      ...authHeaders(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    handleApiContractResponse(response);
    const text = await response.text();
    throw new ApiError(response.status, text);
  }
  return (await response.json()) as T;
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
  return (await response.json()) as T;
}

export async function fetchAuthSession(): Promise<AuthSession | null> {
  return await authRequest<AuthSession | null>("/get-session", { method: "GET" });
}

export async function signUpEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<unknown> {
  return await authRequest<unknown>("/sign-up/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendVerificationEmail(input: {
  email: string;
}): Promise<{ status: boolean }> {
  return await authRequest<{ status: boolean }>("/send-verification-email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signInEmail(input: {
  email: string;
  password: string;
  rememberMe?: boolean;
}): Promise<unknown> {
  return await authRequest<unknown>("/sign-in/email", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function signOutManaged(): Promise<unknown> {
  return await authRequest<unknown>("/sign-out", { method: "POST" });
}

// Completes a password reset. `token` comes from the emailed link
// (`<PUBLIC_BASE_URL>/reset-password?token=…`); Better Auth mounts this at
// `/v1/auth/reset-password` and expects `{ newPassword, token }`.
export async function resetPassword(input: {
  newPassword: string;
  token: string;
}): Promise<unknown> {
  return await authRequest<unknown>("/reset-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchClientConfig(): Promise<ClientConfig> {
  const config = await request<ClientConfig>("/v1/config/client");
  reloadIfStaleApiContract(config);
  reloadIfStaleDeployment(config);
  configureClientAuth(config.auth);
  return config;
}

export async function mintOpenAITranscriptionClientSecret(
  workspaceId: string,
  input: OpenAIClientSecretRequest,
  signal?: AbortSignal,
): Promise<OpenAIClientSecret> {
  return await request<OpenAIClientSecret>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/transcription/client-secret`,
    {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    },
  );
}

export async function reportOpenAITranscriptionUsage(
  workspaceId: string,
  input: OpenAIGrantUsageReport,
): Promise<void> {
  await request(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/transcription/grants/${encodeURIComponent(input.grantId)}/usage`,
    {
      method: "POST",
      body: JSON.stringify({
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        providerEventId: input.providerEventId,
        durationSeconds: input.durationSeconds,
      }),
    },
  );
}

export async function settleOpenAITranscriptionGrant(
  workspaceId: string,
  input: OpenAIGrantSettlement,
  signal?: AbortSignal,
): Promise<void> {
  await request(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/transcription/grants/${encodeURIComponent(input.grantId)}/settle`,
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        status: input.status,
      }),
    },
  );
}

export function shouldReloadForApiContractRevision(
  config: { apiContractRevision: string },
  bundleRevision: string = OPENGENI_API_CONTRACT_REVISION,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): boolean {
  if (!config.apiContractRevision || config.apiContractRevision === bundleRevision || !storage) {
    return false;
  }
  const key = `${contractReloadStoragePrefix}${config.apiContractRevision}`;
  if (storage.getItem(key) === bundleRevision) {
    return false;
  }
  storage.setItem(key, bundleRevision);
  return true;
}

function handleApiContractResponse(response: Response): void {
  const apiContractRevision = response.headers.get(OPENGENI_API_CONTRACT_HEADER);
  if (!apiContractRevision || apiContractRevision === OPENGENI_API_CONTRACT_REVISION) {
    return;
  }
  reloadForApiContract({ apiContractRevision });
}

function reloadIfStaleApiContract(config: { apiContractRevision: string }): void {
  if (config.apiContractRevision !== OPENGENI_API_CONTRACT_REVISION) {
    reloadForApiContract(config);
  }
}

function reloadForApiContract(config: { apiContractRevision: string }): void {
  const willReload = shouldReloadForApiContractRevision(config);
  showApiUpdateNotice(willReload);
  if (willReload && typeof window !== "undefined") {
    window.setTimeout(() => window.location.reload(), 150);
  }
}

function showApiUpdateNotice(willReload: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  const existing = document.getElementById("opengeni-api-update-notice");
  const notice = existing ?? document.createElement("div");
  notice.id = "opengeni-api-update-notice";
  notice.setAttribute("role", "status");
  notice.textContent = willReload
    ? "OpenGeni updated — reloading…"
    : "OpenGeni updated. Reload this tab to continue.";
  Object.assign(notice.style, {
    position: "fixed",
    inset: "16px 16px auto auto",
    zIndex: "2147483647",
    border: "1px solid rgba(255,255,255,.14)",
    borderRadius: "10px",
    background: "#17191d",
    color: "#f5f7fa",
    boxShadow: "0 12px 32px rgba(0,0,0,.35)",
    font: "500 14px/1.4 Inter, system-ui, sans-serif",
    padding: "10px 14px",
  });
  if (!existing) {
    document.body.append(notice);
  }
}

export function shouldReloadForDeploymentRevision(
  config: Pick<ClientConfig, "deploymentRevision">,
  bundleRevision = bundleDeploymentRevision,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): boolean {
  if (
    !bundleRevision ||
    !config.deploymentRevision ||
    bundleRevision === config.deploymentRevision ||
    !storage
  ) {
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
