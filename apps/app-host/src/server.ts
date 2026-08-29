import { createHash } from "node:crypto";

import { AppFilePath } from "@opengeni/contracts";
import { type ImmutableRawObjectHead, type ImmutableRawObjectReader } from "@opengeni/storage";

export const APP_HOST_LAUNCH_PATH_PREFIX = "/.opengeni/launch/";
export const APP_HOST_RESOLVER_HEADER = "x-opengeni-app-host-resolver-key";
export const APP_HOST_DEFAULT_RESOLVER_TIMEOUT_MS = 2_000;
export const APP_HOST_RESOLVER_RESPONSE_MAX_BYTES = 16 * 1024;

const LAUNCH_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "identity-credentials-get=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "otp-credentials=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-create=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "speaker-selection=()",
  "storage-access=()",
  "usb=()",
  "web-share=()",
  "window-management=()",
  "xr-spatial-tracking=()",
].join(", ");

export type ResolvedAppObject = Readonly<{
  path: string;
  /** Exact immutable key selected from the frozen release manifest. */
  objectKey: string;
}>;

export type AppLaunchResolution = Readonly<{
  appId: string;
  releaseId: string;
  launchId: string;
  previewId: string | null;
  publicationId: string | null;
  expiresAt: Date;
  spaFallback: boolean;
  /** Null when the normalized requested path is absent from the frozen manifest. */
  requestedObject: ResolvedAppObject | null;
  entryObject: ResolvedAppObject;
}>;

/**
 * The only app-control-plane dependency visible to the byte host. A direct DB
 * adapter or a narrow internal HTTP callout may implement it.
 */
export interface AppLaunchResolver {
  resolve(input: Readonly<{
    host: string;
    /** Lowercase `sha256:<hex>`; the raw launch token never crosses this seam. */
    launchTokenDigest: string;
    /** Already-normalized release-relative path, or null for the release entry. */
    requestedPath: string | null;
  }>): Promise<AppLaunchResolution | null>;
}

export type AppHost = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

export type AppHostFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AppHostOptions = Readonly<{
  resolver: AppLaunchResolver;
  storage: ImmutableRawObjectReader;
  frameAncestors?: readonly string[];
  now?: () => Date;
}>;

export function createAppHost(options: AppHostOptions): AppHost {
  const now = options.now ?? (() => new Date());
  const frameAncestors = options.frameAncestors ?? [];
  const securityHeaders = appHostSecurityHeaders(frameAncestors);
  const controlPlaneHosts = new Set(frameAncestors.map(frameAncestorHost));

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response(null, 405, securityHeaders, { Allow: "GET, HEAD" });
      }
      return response(
        request.method === "HEAD" ? null : JSON.stringify({ ok: true }),
        200,
        securityHeaders,
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response(null, 405, securityHeaders, { Allow: "GET, HEAD" });
    }
    if (
      request.headers.has("cookie") ||
      request.headers.has("authorization") ||
      request.headers.has("proxy-authorization")
    ) {
      return errorResponse("ambient_credentials_rejected", 400, securityHeaders);
    }

    const host = normalizeAppHost(request.headers.get("host") ?? url.host);
    const launch = parseLaunchPath(url.pathname);
    if (!host || !appIdFromAppHost(host) || controlPlaneHosts.has(host) || !launch) {
      return errorResponse("not_found", 404, securityHeaders);
    }
    if (launch.redirectTo) {
      return response(null, 308, securityHeaders, {
        Location: `${launch.redirectTo}${url.search}`,
      });
    }

    let resolution: AppLaunchResolution | null;
    try {
      resolution = await options.resolver.resolve({
        host,
        launchTokenDigest: launchTokenDigest(launch.token),
        requestedPath: launch.path,
      });
    } catch {
      return errorResponse("origin_unavailable", 503, securityHeaders);
    }
    if (
      !resolution ||
      !validResolution(resolution, launch.path, host) ||
      resolution.expiresAt <= now()
    ) {
      return errorResponse("not_found", 404, securityHeaders);
    }

    let selected: { key: string; head: ImmutableRawObjectHead; path: string } | null;
    try {
      selected = await selectObject(options, resolution, launch.path, request);
    } catch {
      return errorResponse("origin_unavailable", 503, securityHeaders);
    }
    if (!selected) return errorResponse("not_found", 404, securityHeaders);

    const range = parseRange(request.headers.get("range"), selected.head.byteSize);
    if (range === "invalid") {
      return response(null, 416, securityHeaders, {
        "Content-Range": `bytes */${selected.head.byteSize}`,
      });
    }
    const selectedRange = request.headers.has("if-range") ? null : range;
    const status = selectedRange ? 206 : 200;
    const start = selectedRange?.start ?? 0;
    const endInclusive = selectedRange?.endInclusive ?? selected.head.byteSize - 1;
    const byteLength = selectedRange
      ? selectedRange.endInclusive - selectedRange.start + 1
      : selected.head.byteSize;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Length": String(byteLength),
      "Content-Type": selected.head.contentType ?? "application/octet-stream",
      ...(selectedRange
        ? {
            "Content-Range":
              `bytes ${selectedRange.start}-${selectedRange.endInclusive}/` +
              selected.head.byteSize,
          }
        : {}),
    };
    if (request.method === "HEAD" || byteLength === 0) {
      return response(null, status, securityHeaders, headers);
    }
    let body: ReadableStream<Uint8Array>;
    try {
      body = options.storage.streamRange({
        key: selected.key,
        start,
        endInclusive,
        expectedVersionToken: selected.head.versionToken,
        signal: request.signal,
      });
    } catch {
      return errorResponse("origin_unavailable", 503, securityHeaders);
    }
    return response(body, status, securityHeaders, headers);
  };

  return Object.freeze({ fetch });
}

export function createHttpAppLaunchResolver(options: Readonly<{
  url: string;
  sharedKey: string;
  timeoutMs?: number;
  fetchImpl?: AppHostFetch;
}>): AppLaunchResolver {
  const url = resolverUrl(options.url);
  if (
    typeof options.sharedKey !== "string" ||
    options.sharedKey.length < 32 ||
    options.sharedKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(options.sharedKey)
  ) {
    throw new Error("App-host resolver shared key is invalid");
  }
  const timeoutMs = options.timeoutMs ?? APP_HOST_DEFAULT_RESOLVER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("App-host resolver timeout is invalid");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return Object.freeze({
    async resolve(input: Parameters<AppLaunchResolver["resolve"]>[0]) {
      if (
        !normalizeAppHost(input.host) ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.launchTokenDigest) ||
        (input.requestedPath !== null && !AppFilePath.safeParse(input.requestedPath).success)
      ) {
        return null;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            [APP_HOST_RESOLVER_HEADER]: options.sharedKey,
          },
          body: JSON.stringify(input),
        });
        if (result.status === 404) return null;
        if (!result.ok) throw new Error("App-host resolver is unavailable");
        return parseResolution(await readBoundedJson(result), input.requestedPath, input.host);
      } catch {
        throw new Error("App-host resolver is unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export function normalizeAppHost(value: string): string | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 320 ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f,@/\\?#]/u.test(value) ||
    value.startsWith("[")
  ) {
    return null;
  }
  let hostname = value;
  const colon = value.lastIndexOf(":");
  if (colon >= 0) {
    if (value.indexOf(":") !== colon) return null;
    const rawPort = value.slice(colon + 1);
    const port = Number(rawPort);
    if (!/^\d{1,5}$/u.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    hostname = value.slice(0, colon);
  }
  hostname = hostname.replace(/\.$/u, "").toLowerCase();
  if (hostname.length < 1 || hostname.length > 253) return null;
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    return null;
  }
  return hostname;
}

export function launchTokenDigest(token: string): string {
  if (!LAUNCH_TOKEN.test(token)) throw new Error("Launch token is invalid");
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function appHostSecurityHeaders(frameAncestors: readonly string[]): Readonly<Headers> {
  const ancestors = frameAncestors.map(normalizeFrameAncestor);
  if (new Set(ancestors).size !== ancestors.length) {
    throw new Error("App-host frame ancestors must not contain duplicates");
  }
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(" ") : "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0, no-transform",
    "Content-Security-Policy": csp,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": PERMISSIONS_POLICY,
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-XSS-Protection": "0",
  });
}

async function selectObject(
  options: AppHostOptions,
  resolution: AppLaunchResolution,
  requestedPath: string | null,
  request: Request,
): Promise<{ key: string; head: ImmutableRawObjectHead; path: string } | null> {
  let selectedObject = requestedPath === null ? resolution.entryObject : resolution.requestedObject;
  if (
    !selectedObject &&
    requestedPath !== null &&
    resolution.spaFallback &&
    acceptsSpaFallback(request)
  ) {
    selectedObject = resolution.entryObject;
  }
  if (!selectedObject) return null;
  const head = await options.storage.head({
    key: selectedObject.objectKey,
    signal: request.signal,
  });
  return head ? { key: selectedObject.objectKey, head, path: selectedObject.path } : null;
}

function acceptsSpaFallback(request: Request): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase().startsWith("text/html"));
}

function parseLaunchPath(pathname: string):
  | { token: string; path: string | null; redirectTo?: undefined }
  | { token: string; path: null; redirectTo: string }
  | null {
  if (!pathname.startsWith(APP_HOST_LAUNCH_PATH_PREFIX)) return null;
  const remainder = pathname.slice(APP_HOST_LAUNCH_PATH_PREFIX.length);
  const slash = remainder.indexOf("/");
  const encodedToken = slash < 0 ? remainder : remainder.slice(0, slash);
  let token: string;
  try {
    token = decodeURIComponent(encodedToken);
  } catch {
    return null;
  }
  if (!LAUNCH_TOKEN.test(token)) return null;
  if (slash < 0) {
    return { token, path: null, redirectTo: `${APP_HOST_LAUNCH_PATH_PREFIX}${encodedToken}/` };
  }
  const encodedPath = remainder.slice(slash + 1);
  if (!encodedPath) return { token, path: null };
  const encodedSegments = encodedPath.split("/");
  if (encodedSegments.at(-1) === "") encodedSegments.pop();
  if (encodedSegments.length === 0 || encodedSegments.some((segment) => segment.length === 0)) {
    return null;
  }
  const segments: string[] = [];
  try {
    for (const encoded of encodedSegments) {
      const decoded = decodeURIComponent(encoded);
      if (decoded.includes("/") || decoded.includes("\\")) return null;
      segments.push(decoded);
    }
  } catch {
    return null;
  }
  const path = segments.join("/");
  return AppFilePath.safeParse(path).success ? { token, path } : null;
}

function validResolution(
  value: AppLaunchResolution,
  requestedPath: string | null,
  host: string,
): boolean {
  return (
    UUID.test(value.appId) &&
    appHostMatchesAppId(host, value.appId) &&
    UUID.test(value.releaseId) &&
    UUID.test(value.launchId) &&
    ((value.previewId !== null && UUID.test(value.previewId) && value.publicationId === null) ||
      (value.previewId === null &&
        value.publicationId !== null &&
        UUID.test(value.publicationId))) &&
    typeof value.spaFallback === "boolean" &&
    validResolvedObject(value.entryObject) &&
    frozenAppBuildObjectKeyMatchesAppId(value.entryObject.objectKey, value.appId) &&
    (requestedPath === null
      ? value.requestedObject === null
      : value.requestedObject === null ||
        (validResolvedObject(value.requestedObject) &&
          frozenAppBuildObjectKeyMatchesAppId(value.requestedObject.objectKey, value.appId) &&
          value.requestedObject.path === requestedPath)) &&
    value.expiresAt instanceof Date &&
    Number.isFinite(value.expiresAt.getTime())
  );
}

function validResolvedObject(value: ResolvedAppObject): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    AppFilePath.safeParse(value.path).success &&
    typeof value.objectKey === "string" &&
    value.objectKey.length >= 1 &&
    value.objectKey.length <= 2_048 &&
    value.objectKey.trim() === value.objectKey &&
    !/[\u0000-\u001f\u007f]/u.test(value.objectKey)
  );
}

function parseRange(
  value: string | null,
  byteSize: number,
): { start: number; endInclusive: number } | "invalid" | null {
  if (!value) return null;
  if (byteSize === 0 || !value.startsWith("bytes=") || value.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, byteSize - suffix), endInclusive: byteSize - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= byteSize) return "invalid";
  const requestedEnd = match[2] ? Number(match[2]) : byteSize - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return "invalid";
  return { start, endInclusive: Math.min(requestedEnd, byteSize - 1) };
}

function normalizeFrameAncestor(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("App-host frame ancestor is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    normalizeAppHost(url.host) === null
  ) {
    throw new Error("App-host frame ancestor must be a credential-free HTTP(S) origin");
  }
  return url.origin;
}

function frameAncestorHost(value: string): string {
  const origin = normalizeFrameAncestor(value);
  return normalizeAppHost(new URL(origin).host)!;
}

export function appHostMatchesAppId(host: string, appId: string): boolean {
  return UUID.test(appId) && appIdFromAppHost(host) === appId.toLowerCase();
}

function appIdFromAppHost(host: string): string | null {
  const normalized = normalizeAppHost(host);
  const appId = normalized?.split(".")[0];
  return appId && UUID.test(appId) ? appId.toLowerCase() : null;
}

function frozenAppBuildObjectKeyMatchesAppId(objectKey: string, appId: string): boolean {
  const segments = objectKey.split("/");
  return (
    segments.length === 9 &&
    segments[0] === "workspaces" &&
    UUID.test(segments[1]!) &&
    segments[2] === "apps" &&
    segments[3]!.toLowerCase() === appId.toLowerCase() &&
    UUID.test(segments[3]!) &&
    segments[4] === "builds" &&
    UUID.test(segments[5]!) &&
    segments[6] === "frozen" &&
    /^[0-9a-f]{64}$/u.test(segments[7]!) &&
    UUID.test(segments[8]!)
  );
}

function resolverUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("App-host resolver URL is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("App-host resolver URL must be credential-free HTTP(S)");
  }
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > APP_HOST_RESOLVER_RESPONSE_MAX_BYTES) {
    throw new Error("App-host resolver response is too large");
  }
  if (!response.body) throw new Error("App-host resolver response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > APP_HOST_RESOLVER_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("App-host resolver response is too large");
    }
    chunks.push(item.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function parseResolution(
  value: unknown,
  requestedPath: string | null,
  host: string,
): AppLaunchResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    typeof object.appId !== "string" ||
    typeof object.releaseId !== "string" ||
    typeof object.launchId !== "string" ||
    (object.previewId !== null && typeof object.previewId !== "string") ||
    (object.publicationId !== null && typeof object.publicationId !== "string") ||
    typeof object.spaFallback !== "boolean" ||
    typeof object.expiresAt !== "string"
  ) {
    return null;
  }
  const requestedObject = parseResolvedObject(object.requestedObject);
  const entryObject = parseResolvedObject(object.entryObject);
  if (object.requestedObject !== null && !requestedObject) return null;
  if (!entryObject) return null;
  const resolution: AppLaunchResolution = {
    appId: object.appId,
    releaseId: object.releaseId,
    launchId: object.launchId,
    previewId: object.previewId as string | null,
    publicationId: object.publicationId as string | null,
    expiresAt: new Date(object.expiresAt),
    spaFallback: object.spaFallback,
    requestedObject,
    entryObject,
  };
  return validResolution(resolution, requestedPath, host) ? Object.freeze(resolution) : null;
}

function parseResolvedObject(value: unknown): ResolvedAppObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.path !== "string" || typeof object.objectKey !== "string") return null;
  const resolved = { path: object.path, objectKey: object.objectKey };
  return validResolvedObject(resolved) ? Object.freeze(resolved) : null;
}

function response(
  body: BodyInit | null,
  status: number,
  securityHeaders: Readonly<Headers>,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(securityHeaders);
  for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
  return new Response(body, { status, headers });
}

function errorResponse(code: string, status: number, securityHeaders: Readonly<Headers>): Response {
  return response(JSON.stringify({ error: code }), status, securityHeaders, {
    "Content-Type": "application/json; charset=utf-8",
  });
}
