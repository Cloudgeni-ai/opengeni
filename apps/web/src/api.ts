// The console primarily uses `@opengeni/sdk`. Bootstrap, managed-session,
// and optional connector routes share this authenticated request helper so
// connector-only code does not increase the core session bundle.
import {
  OpenGeniApiError,
  OpenGeniBrowserClient,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
} from "@opengeni/sdk/browser";
import type { OrganizationUserSetupPreview } from "@opengeni/contracts";

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
let managedActorEpoch: string | null = null;
let managedActorRevision = 0;
type ManagedActorRequest = {
  abortActor: (reason: DOMException) => void;
};
const managedActorRequests = new Set<ManagedActorRequest>();
const managedActorMutationListeners = new Set<() => void>();
const managedActorInvalidationListeners = new Set<() => void>();
let managedActorMutationCount = 0;
const MANAGED_ACTOR_EPOCH_HEADER = "x-opengeni-actor-epoch";
const MANAGED_ACTOR_STATE_HEADER = "x-opengeni-actor-state";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly field: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
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
export function createOpenGeniClient(beginSharedRead?: () => number): OpenGeniBrowserClient {
  const createdAtActorRevision = managedActorRevision;
  return new OpenGeniBrowserClient({
    baseUrl: apiBaseUrl,
    beginSharedRead,
    headers: () => authHeaders(),
    fetch: async (input, init) => {
      const actorBound = activeAuthConfig?.mode === "managedSession" || managedActorEpoch !== null;
      if (actorBound) {
        if (createdAtActorRevision !== managedActorRevision) {
          throw new DOMException("The browser account changed", "AbortError");
        }
      }
      const response = await managedActorFetch(input, {
        ...init,
        // API requests need managed-session cookies. The SDK explicitly marks
        // signed object-storage requests as credential-free; preserve that
        // narrower policy instead of overriding it at the console boundary.
        credentials: init?.credentials ?? "include",
        signal: init?.signal,
      });
      handleApiContractResponse(response);
      return response;
    },
  });
}

/**
 * Rotate the browser's accepted actor epoch before exposing any new tenant
 * state. Every older finite request is aborted and its eventual response is
 * rejected even when the underlying transport cannot be cancelled.
 */
export function configureManagedActorEpoch(epoch: string | null): void {
  if (managedActorEpoch === epoch) return;
  managedActorEpoch = epoch;
  managedActorRevision += 1;
  const reason = new DOMException("The browser account changed", "AbortError");
  for (const managedRequest of managedActorRequests) {
    managedRequest.abortActor(reason);
  }
}

export function currentManagedActorEpoch(): string | null {
  return managedActorEpoch;
}

export function managedActorMutationBusySnapshot(): boolean {
  return managedActorMutationCount > 0;
}

export function subscribeManagedActorMutationBusy(listener: () => void): () => void {
  managedActorMutationListeners.add(listener);
  return () => managedActorMutationListeners.delete(listener);
}

export function subscribeManagedActorInvalidation(listener: () => void): () => void {
  managedActorInvalidationListeners.add(listener);
  return () => managedActorInvalidationListeners.delete(listener);
}

function updateManagedActorMutationCount(delta: 1 | -1): void {
  const before = managedActorMutationCount > 0;
  managedActorMutationCount = Math.max(0, managedActorMutationCount + delta);
  if (before !== managedActorMutationCount > 0) {
    for (const listener of managedActorMutationListeners) listener();
  }
}

function notifyManagedActorInvalidation(): void {
  for (const listener of managedActorInvalidationListeners) listener();
}

function requestMethod(input: string | URL | Request, init: RequestInit): string {
  const inherited =
    typeof Request !== "undefined" && input instanceof Request ? input.method : null;
  return String(init.method ?? inherited ?? "GET").toUpperCase();
}

export async function managedActorFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const acceptedEpoch = managedActorEpoch;
  const acceptedRevision = managedActorRevision;
  const controller = new AbortController();
  const inputSignal =
    init.signal ??
    (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
  let abortTarget = (reason: unknown) => controller.abort(reason);
  const abortFromCaller = () => abortTarget(inputSignal?.reason);
  if (inputSignal?.aborted) abortFromCaller();
  else inputSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const actorRequest: ManagedActorRequest = {
    abortActor: (reason) => abortTarget(reason),
  };
  managedActorRequests.add(actorRequest);
  const tracksMutation =
    acceptedEpoch !== null && !new Set(["GET", "HEAD", "OPTIONS"]).has(requestMethod(input, init));
  if (tracksMutation) updateManagedActorMutationCount(1);
  let responseOwnsCleanup = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    managedActorRequests.delete(actorRequest);
    inputSignal?.removeEventListener("abort", abortFromCaller);
    if (tracksMutation) updateManagedActorMutationCount(-1);
  };
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
  );
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (acceptedEpoch && init.credentials !== "omit" && !headers.has(MANAGED_ACTOR_EPOCH_HEADER)) {
    headers.set(MANAGED_ACTOR_EPOCH_HEADER, acceptedEpoch);
  }
  try {
    const response = await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (
      acceptedEpoch !== null &&
      response.headers.get(MANAGED_ACTOR_STATE_HEADER)?.toLowerCase() === "changed"
    ) {
      notifyManagedActorInvalidation();
    }
    const responseEpoch = response.headers.get(MANAGED_ACTOR_EPOCH_HEADER);
    const responseIsStale = () =>
      acceptedRevision !== managedActorRevision ||
      acceptedEpoch !== managedActorEpoch ||
      (acceptedEpoch !== null && responseEpoch !== null && responseEpoch !== acceptedEpoch);
    if (responseIsStale()) {
      void response.body?.cancel();
      throw new DOMException("Ignored a response from the previous browser account", "AbortError");
    }
    if (!response.body) return response;
    // Finite JSON is consumed before it crosses the actor boundary. Returning
    // a manual bridge over a native compressed response can leave Chromium's
    // transport lifecycle unresolved even after the source reader reaches
    // EOF. Draining here also guarantees the native body already has a
    // rejection consumer before any post-header actor abort.
    let actorResponse = response;
    const finiteJsonResponse = isFiniteJsonResponse(response);
    if (finiteJsonResponse) {
      const bytes = await response.arrayBuffer();
      if (responseIsStale()) {
        throw new DOMException(
          "Ignored a response from the previous browser account",
          "AbortError",
        );
      }
      actorResponse = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    // Before headers—and through a finite JSON drain—actor rotation aborts the
    // native fetch. A detached finite body no longer owns a network resource,
    // so only its wrapper remains actor-bound. A live body must also abort its
    // native fetch after admission: cancelling only the source reader can leave
    // Chromium's HTTP/1 request open, eventually exhausting the per-origin
    // connection pool across account switches and tabs. Publish the wrapper
    // abort first so downstream consumption still fails closed with the same
    // AbortError, then release the native transport in the next microtask.
    const actorBodyController = new AbortController();
    abortTarget = finiteJsonResponse
      ? (reason) => actorBodyController.abort(reason)
      : (reason) => {
          actorBodyController.abort(reason);
          queueMicrotask(() => controller.abort(reason));
        };
    responseOwnsCleanup = true;
    return managedActorTrackedResponse(actorResponse, actorBodyController.signal, cleanup);
  } finally {
    if (!responseOwnsCleanup) cleanup();
  }
}

function isFiniteJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

function managedActorTrackedResponse(
  response: Response,
  signal: AbortSignal,
  cleanup: () => void,
): Response {
  const reader = response.body!.getReader();
  let settled = false;
  let readerReleased = false;
  let actorAbortReason: unknown | null = null;
  const releaseReader = () => {
    if (readerReleased) return;
    try {
      reader.releaseLock();
      readerReleased = true;
    } catch {
      // A pending read owns the lock until it settles; its completion path
      // retries this release before returning to the downstream consumer.
    }
  };
  const settle = () => {
    if (settled) return false;
    settled = true;
    signal.removeEventListener("abort", abortBody);
    cleanup();
    return true;
  };
  const abortBody = () => {
    if (settled) return;
    const reason = signal.reason ?? new DOMException("The browser account changed", "AbortError");
    actorAbortReason = reason;
    settle();
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(releaseReader);
  };
  // Keep actor-abort rejection consumer-owned. WebKit can report a stream
  // error raised directly inside the abort event as an unhandled page error
  // before the SDK has attached its body reader. Zero buffering also prevents
  // the wrapper from pulling an old response merely to fill an internal queue.
  const body = new ReadableStream<Uint8Array>(
    {
      start() {
        signal.addEventListener("abort", abortBody, { once: true });
        if (signal.aborted) abortBody();
      },
      async pull(controller) {
        if (actorAbortReason !== null) {
          controller.error(actorAbortReason);
          return;
        }
        if (settled) return;
        try {
          const next = await reader.read();
          if (actorAbortReason !== null) {
            controller.error(actorAbortReason);
            return;
          }
          if (next.done) {
            releaseReader();
            if (settle()) controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          releaseReader();
          if (actorAbortReason !== null) {
            controller.error(actorAbortReason);
          } else if (settle()) {
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          releaseReader();
          settle();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await managedActorFetch(`${apiBaseUrl}${path}`, {
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
  const response = await managedActorFetch(`${apiBaseUrl}/v1/auth${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    handleApiContractResponse(response);
    const text = await response.text();
    let code: string | null = null;
    let message = "Authentication request failed";
    try {
      const payload = JSON.parse(text) as { code?: unknown; message?: unknown };
      if (typeof payload.code === "string" && payload.code.trim()) {
        code = payload.code.trim();
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        message = payload.message.trim();
      }
    } catch {
      // Better Auth normally returns JSON. Keep malformed/upstream bodies out
      // of user-facing errors while retaining the HTTP status for mapping.
    }
    const fieldMatch = message.match(/^\[body\.([A-Za-z][A-Za-z0-9_]*)\]\s*/u);
    const field = fieldMatch?.[1] ?? null;
    if (fieldMatch) {
      message = message.slice(fieldMatch[0].length).trim() || "Invalid value";
    }
    throw new AuthApiError(response.status, code, field, message);
  }
  return (await response.json()) as T;
}

export async function fetchAuthSession(): Promise<AuthSession | null> {
  return await authRequest<AuthSession | null>("/get-session", {
    method: "GET",
  });
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

export type SelfServiceOrganizationOnboardingState =
  | "required"
  | "invitation_pending"
  | "unavailable"
  | "complete";

export async function getSelfServiceOrganizationOnboardingStatus(): Promise<{
  state: SelfServiceOrganizationOnboardingState;
}> {
  return await authRequest<{ state: SelfServiceOrganizationOnboardingState }>(
    "/organization-onboarding",
    { method: "GET" },
  );
}

export async function completeSelfServiceOrganizationSetup(input: {
  organizationName: string;
  operationId: string;
}): Promise<{
  status: "complete";
  organizationId: string;
  personalWorkspaceId: string;
}> {
  return await authRequest<{
    status: "complete";
    organizationId: string;
    personalWorkspaceId: string;
  }>("/organization-onboarding", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeOrganizationUserSetup(input: {
  token: string;
  name: string;
  password: string;
  operationId: string;
}): Promise<{ status: "complete" }> {
  return await authRequest<{ status: "complete" }>("/organization-setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function previewOrganizationUserSetup(input: {
  token: string;
}): Promise<OrganizationUserSetupPreview> {
  return await authRequest<OrganizationUserSetupPreview>("/organization-setup/preview", {
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

export type CodexResetRedemptionPreparation = {
  attemptId: string;
  confirmationToken: string;
  expiresAt: string;
  resumable: boolean;
  recoveryStatus: "provider_started" | "completed" | null;
};

export type CodexResetRedemptionResult = {
  status: "completed";
  attemptId: string;
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
  overview: null;
};

/**
 * Browser-only reset-credit preparation. This intentionally bypasses the SDK
 * and all configured bearer/deployment headers: only the Better Auth cookie is
 * allowed to authenticate the irreversible route.
 */
export async function prepareCodexResetRedemption(
  workspaceId: string,
  accountId: string,
  input: { attemptId: string; creditId: string },
): Promise<CodexResetRedemptionPreparation> {
  return await managedBrowserMutation<CodexResetRedemptionPreparation>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/codex/accounts/${encodeURIComponent(accountId)}/reset-credits/prepare`,
    input,
  );
}

/** The sole browser mutation that can redeem one provider reset credit. */
export async function redeemCodexResetCredit(
  workspaceId: string,
  accountId: string,
  input: {
    attemptId: string;
    creditId: string;
    confirmationToken: string;
    confirmation: "REDEEM_USAGE_LIMIT_RESET";
  },
): Promise<CodexResetRedemptionResult> {
  return await managedBrowserMutation<CodexResetRedemptionResult>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/codex/accounts/${encodeURIComponent(accountId)}/reset-credits/redeem`,
    input,
  );
}

async function managedBrowserMutation<T>(path: string, body: unknown): Promise<T> {
  const response = await managedActorFetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    // Managed-session mutations intentionally authenticate only with the
    // Better Auth cookie. The contract header is protocol negotiation, not an
    // access-key/bearer credential, and is required by the API before routing
    // protected state changes.
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    handleApiContractResponse(response);
    throw new ApiError(response.status, await response.text());
  }
  return (await response.json()) as T;
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
