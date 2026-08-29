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
const boundedHttp1SseTransport = "http1-bounded";
const boundedHttp1SseBatchContentType = "application/vnd.opengeni.sse-batch";
const HTTP1_BROWSER_SSE_RECONNECT_GRACE_MS = 4_000;
const HTTP1_BROWSER_SSE_BATCH_MAX_BYTES = 512 * 1024;
// New APIs answer bounded HTTP/1 event requests from an immediate durable
// snapshot. Keep a browser-owned backstop as well: it bounds a stalled network
// response and preserves rolling compatibility with older five-second APIs.
const HTTP1_BROWSER_SSE_NATIVE_LIFETIME_MS = 11_000;
let activeAuthConfig: ClientConfig["auth"] | null = null;
let managedActorEpoch: string | null = null;
let managedActorRevision = 0;
type ManagedActorRequest = {
  abortActor: (reason: DOMException) => void;
};
const managedActorRequests = new Set<ManagedActorRequest>();
let managedActorForegroundRequestCount = 0;
let managedActorForegroundIdle: Promise<void> | null = null;
let resolveManagedActorForegroundIdle: (() => void) | null = null;
const managedActorMutationListeners = new Set<() => void>();
const managedActorInvalidationListeners = new Set<() => void>();
let managedActorMutationCount = 0;
const MANAGED_ACTOR_EPOCH_HEADER = "x-opengeni-actor-epoch";
const MANAGED_ACTOR_STATE_HEADER = "x-opengeni-actor-state";

function abortManagedActorRequests(reason: DOMException): void {
  for (const managedRequest of [...managedActorRequests]) {
    managedRequest.abortActor(reason);
  }
}

function beginManagedActorForegroundRequest(): () => void {
  if (managedActorForegroundRequestCount === 0) {
    managedActorForegroundIdle = new Promise<void>((resolve) => {
      resolveManagedActorForegroundIdle = resolve;
    });
  }
  managedActorForegroundRequestCount += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    managedActorForegroundRequestCount = Math.max(0, managedActorForegroundRequestCount - 1);
    if (managedActorForegroundRequestCount !== 0) return;
    const resolve = resolveManagedActorForegroundIdle;
    resolveManagedActorForegroundIdle = null;
    managedActorForegroundIdle = null;
    resolve?.();
  };
}

async function waitForManagedActorForegroundIdle(signal: AbortSignal): Promise<void> {
  const pendingIdle = managedActorForegroundIdle;
  if (pendingIdle === null) return;
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pendingIdle.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
  await waitForManagedActorForegroundIdle(signal);
}

export function handleManagedActorPageHide(persisted: boolean): void {
  if (persisted) return;
  abortManagedActorRequests(new DOMException("The document was replaced", "AbortError"));
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", (event) => {
    // A persisted page can resume from the back/forward cache with its effects
    // intact. A document that is actually being replaced cannot run React
    // cleanup reliably after teardown begins, so synchronously release every
    // actor-owned native transport before the old realm disappears.
    handleManagedActorPageHide(event.persisted);
  });
}

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
  abortManagedActorRequests(new DOMException("The browser account changed", "AbortError"));
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
  let endForegroundRequest = () => {};
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    endForegroundRequest();
    managedActorRequests.delete(actorRequest);
    inputSignal?.removeEventListener("abort", abortFromCaller);
    if (tracksMutation) updateManagedActorMutationCount(-1);
  };
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
  );
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const [transportInput, cleanCloseDelayMs, nativeLifetimeMs] = browserSseTransportInput(
    input,
    init,
    headers,
  );
  const boundedHttp1Sse = cleanCloseDelayMs > 0;
  if (isForegroundApiRequest(input, init, headers, boundedHttp1Sse)) {
    endForegroundRequest = beginManagedActorForegroundRequest();
  }
  if (acceptedEpoch && init.credentials !== "omit" && !headers.has(MANAGED_ACTOR_EPOCH_HEADER)) {
    headers.set(MANAGED_ACTOR_EPOCH_HEADER, acceptedEpoch);
  }
  let boundedRequestTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (boundedHttp1Sse) {
      boundedRequestTimer = setTimeout(() => {
        controller.abort(
          new DOMException(
            "The bounded HTTP/1 stream did not complete its native response in time",
            "AbortError",
          ),
        );
      }, nativeLifetimeMs);
      await waitForManagedActorForegroundIdle(controller.signal);
    }
    const response = await fetch(transportInput, {
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
    const finiteSseBatch = finiteSseBatchKind(response, boundedHttp1Sse);
    const detachedResponse = isFiniteJsonResponse(response) || finiteSseBatch !== null;
    if (detachedResponse) {
      const bytes = await readFiniteResponseBytes(response);
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
      if (finiteSseBatch === "legacy") {
        // An older API can expose EOF for its finite text/event-stream body
        // while Chromium still accounts the native request as a live SSE
        // transport. Retire only that rolling-deployment seam. The current
        // vendor-typed response is an ordinary completed HTTP response whose
        // connection must remain reusable.
        controller.abort(
          new DOMException("The finite HTTP/1 stream body was fully detached", "AbortError"),
        );
      }
      endForegroundRequest();
    }
    // Before headers—and through a finite response drain—actor rotation aborts the
    // native fetch. A detached finite body no longer owns a network resource,
    // so only its wrapper remains actor-bound. A live body must also abort its
    // native fetch after admission: cancelling only the source reader can leave
    // Chromium's HTTP/1 request open, eventually exhausting the per-origin
    // connection pool across account switches and tabs. Abort the native fetch
    // synchronously so a pagehide cannot destroy the document before the
    // transport is released. The native reader rejection is still delivered in
    // a later microtask, after the wrapper records its fail-closed AbortError.
    const actorBodyController = new AbortController();
    const abortNativeTransport = detachedResponse
      ? undefined
      : (reason: unknown) => controller.abort(reason);
    abortTarget = detachedResponse
      ? (reason) => actorBodyController.abort(reason)
      : (reason) => {
          // Abort the native fetch before publishing the wrapper abort. The
          // wrapper's abort handler queues reader cancellation, so Chromium
          // sees the fetch signal first and cannot detach an SSE reader while
          // leaving its HTTP/1 transport alive.
          abortNativeTransport?.(reason);
          actorBodyController.abort(reason);
        };
    responseOwnsCleanup = true;
    return managedActorTrackedResponse(
      actorResponse,
      actorBodyController.signal,
      cleanup,
      abortNativeTransport,
      finiteSseBatch !== null ? cleanCloseDelayMs : 0,
      detachedResponse ? 0 : nativeLifetimeMs,
    );
  } finally {
    if (boundedRequestTimer !== null) clearTimeout(boundedRequestTimer);
    if (!responseOwnsCleanup) cleanup();
  }
}

/** HTTP/1 browsers cap all same-origin SSE connections across every tab at six. */
export function shouldBoundBrowserSseForProtocol(protocol: string | null | undefined): boolean {
  const normalized = protocol?.trim().toLowerCase();
  return normalized === "http/1.0" || normalized === "http/1.1";
}

function browserSseTransportInput(
  input: string | URL | Request,
  init: RequestInit,
  headers: Headers,
): readonly [input: string | URL | Request, cleanCloseDelayMs: number, nativeLifetimeMs: number] {
  if (
    requestMethod(input, init) !== "GET" ||
    !headers.get("accept")?.toLowerCase().includes("text/event-stream") ||
    (typeof Request !== "undefined" && input instanceof Request) ||
    !shouldBoundBrowserSseForProtocol(observedApiProtocol())
  ) {
    return [input, 0, 0];
  }
  const url = new URL(String(input), window.location.href);
  url.searchParams.set("transport", boundedHttp1SseTransport);
  // Make the bounded fallback an ordinary finite HTTP request end to end.
  // The SDK parses its SSE-framed bytes directly and does not depend on this
  // media type. Avoiding `text/event-stream` at the native browser boundary
  // prevents a replaced Chromium document from retaining an orphaned SSE
  // request in the connection pool shared by every tab on this origin.
  headers.set("accept", boundedHttp1SseBatchContentType);
  return [
    typeof input === "string" ? url.toString() : url,
    HTTP1_BROWSER_SSE_RECONNECT_GRACE_MS,
    HTTP1_BROWSER_SSE_NATIVE_LIFETIME_MS,
  ];
}

function isForegroundApiRequest(
  input: string | URL | Request,
  init: RequestInit,
  headers: Headers,
  boundedHttp1Sse: boolean,
): boolean {
  if (boundedHttp1Sse || headers.get("accept")?.toLowerCase().includes("text/event-stream")) {
    return false;
  }
  try {
    const raw = typeof Request !== "undefined" && input instanceof Request ? input.url : input;
    const base = typeof window === "undefined" ? "http://opengeni.local" : window.location.href;
    return (
      new URL(String(raw), base).pathname.startsWith("/v1/") &&
      !new Set(["HEAD", "OPTIONS"]).has(requestMethod(input, init))
    );
  } catch {
    return false;
  }
}

function observedApiProtocol(): string | null {
  if (typeof window === "undefined" || typeof performance === "undefined") return null;
  const apiOrigin = new URL(apiBaseUrl || window.location.origin, window.location.href).origin;
  const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const entry = resources[index];
    if (!entry?.nextHopProtocol) continue;
    try {
      if (new URL(entry.name).origin === apiOrigin) return entry.nextHopProtocol;
    } catch {
      // Ignore browser-extension and other non-URL performance entries.
    }
  }
  if (apiOrigin !== window.location.origin) return null;
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return navigation?.nextHopProtocol || null;
}

function isFiniteJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

function finiteSseBatchKind(
  response: Response,
  boundedHttp1Sse: boolean,
): "current" | "legacy" | null {
  // The explicit request transform is the authority boundary. Accept the
  // legacy SSE media type only inside that boundary so a new web bundle can
  // safely overlap an older API during a rolling deployment without turning
  // unrelated finite SSE responses into browser-batch transports.
  if (!boundedHttp1Sse) return null;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = response.headers.get("content-length");
  const parsedContentLength = contentLength === null ? Number.NaN : Number(contentLength);
  if (
    contentLength === null ||
    !/^\d+$/.test(contentLength) ||
    !Number.isSafeInteger(parsedContentLength) ||
    parsedContentLength > HTTP1_BROWSER_SSE_BATCH_MAX_BYTES
  ) {
    return null;
  }
  if (contentType === boundedHttp1SseBatchContentType) return "current";
  return contentType === "text/event-stream" ? "legacy" : null;
}

async function readFiniteResponseBytes(response: Response): Promise<ArrayBuffer> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function managedActorTrackedResponse(
  response: Response,
  signal: AbortSignal,
  cleanup: () => void,
  abortNativeTransport?: (reason: unknown) => void,
  cleanCloseDelayMs = 0,
  nativeLifetimeMs = 0,
): Response {
  const reader = response.body!.getReader();
  let settled = false;
  let readerReleased = false;
  let actorAbortReason: unknown | null = null;
  let cleanSeamGrace: Promise<void> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (lifetimeTimer !== null) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = null;
    }
    signal.removeEventListener("abort", abortBody);
    cleanup();
    return true;
  };
  const abortBody = () => {
    if (settled) return;
    const reason = signal.reason ?? new DOMException("The browser account changed", "AbortError");
    actorAbortReason = reason;
    settle();
    // The native fetch signal is aborted before this wrapper signal. Start
    // cancelling its locked reader in the same task as well: a pagehide can
    // destroy this realm before a queued microtask runs, leaving Chromium's
    // old HTTP/1 stream alive and starving the replacement document's finite
    // reads. The returned promise already owns any asynchronous rejection;
    // the wrapper still publishes its AbortError only from the consumer's
    // pull path below.
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(releaseReader);
  };
  const beginCleanSeam = () => {
    if (settled || cleanSeamGrace !== null) return;
    const reason = new DOMException(
      "The bounded HTTP/1 stream reached its native lifetime",
      "AbortError",
    );
    cleanSeamGrace = abortableDelay(cleanCloseDelayMs, signal);
    // The browser signal must be aborted before its locked reader is
    // cancelled. This owns the native request lifecycle even when the API's
    // clean terminal chunk never releases Chromium's connection accounting.
    abortNativeTransport?.(reason);
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(releaseReader);
  };
  const closeCleanSeam = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    await cleanSeamGrace;
    if (actorAbortReason !== null) {
      controller.error(actorAbortReason);
      return;
    }
    releaseReader();
    if (settle()) controller.close();
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
        if (cleanSeamGrace !== null) {
          await closeCleanSeam(controller);
          return;
        }
        try {
          const next = await reader.read();
          if (actorAbortReason !== null) {
            controller.error(actorAbortReason);
            return;
          }
          if (cleanSeamGrace !== null) {
            await closeCleanSeam(controller);
            return;
          }
          if (next.done) {
            // The native body has reached EOF and its HTTP/1 connection is now
            // free. Keep the wrapper logically live for a short grace period
            // so already-queued finite reads win the browser's newly available
            // slots before the SDK reconnects this durable stream.
            if (cleanCloseDelayMs > 0) {
              await abortableDelay(cleanCloseDelayMs, signal);
            }
            if (actorAbortReason !== null) {
              controller.error(actorAbortReason);
              return;
            }
            releaseReader();
            if (settle()) controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          releaseReader();
          if (actorAbortReason !== null) {
            controller.error(actorAbortReason);
          } else if (cleanSeamGrace !== null) {
            await closeCleanSeam(controller);
          } else if (settle()) {
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        const ownsSettlement = settle();
        if (ownsSettlement) abortNativeTransport?.(reason);
        // Let the native fetch abort propagate before detaching its reader. In
        // Chromium the inverse order can leave the HTTP/1 request open even
        // though the JavaScript ReadableStream has been cancelled.
        if (ownsSettlement && abortNativeTransport) await Promise.resolve();
        try {
          await reader.cancel(reason);
        } finally {
          releaseReader();
        }
      },
    },
    { highWaterMark: 0 },
  );
  if (nativeLifetimeMs > 0 && abortNativeTransport) {
    lifetimeTimer = setTimeout(beginCleanSeam, nativeLifetimeMs);
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
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

export async function startManagedSocialSignIn(provider: "google" | "github"): Promise<void> {
  const callbackURL = new URL("/", window.location.origin).toString();
  const response = await authRequest<{ url?: unknown }>("/sign-in/social", {
    method: "POST",
    body: JSON.stringify({
      provider,
      callbackURL,
      errorCallbackURL: callbackURL,
      disableRedirect: true,
    }),
  });
  if (typeof response.url !== "string") {
    throw new Error("The sign-in provider did not return an authorization URL");
  }
  window.location.assign(response.url);
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
