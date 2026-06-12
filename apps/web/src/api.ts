// The console's only bespoke HTTP surface: client config bootstrap and the
// Better Auth (managed session) endpoints, which sit outside the public API
// the SDK covers. Everything else goes through `@opengeni/sdk`.
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";

import type { AuthSession, ClientConfig } from "./types";

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
 * The console's API client is the public `@opengeni/sdk` client pointed at
 * the same API the console is served from. Auth headers are computed per
 * request (the stored access key can change at runtime) and cookies ride
 * along for managed-session deployments.
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
