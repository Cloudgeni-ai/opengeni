import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";
const SHORT_CACHE_CONTROL = "public, max-age=3600";
const DEMO_API_PREFIX = "/demo-api";
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export type DemoApiProxyOptions = {
  targetBaseUrl: string;
  /** Server-owned authority headers; never serialized into the demo bundle. */
  credentialHeaders?: HeadersInit | undefined;
  fetch?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
};

export type WebHandlerOptions = {
  demoApiProxy?: DemoApiProxyOptions | undefined;
};

export function createWebHandler(
  root = resolve(import.meta.dir, "../dist"),
  options: WebHandlerOptions = {},
) {
  const distRoot = resolve(root);
  const indexPath = resolve(distRoot, "index.html");

  return async function webHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === DEMO_API_PREFIX || url.pathname.startsWith(`${DEMO_API_PREFIX}/`)) {
      return proxyDemoApi(request, url, options.demoApiProxy);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (pathname === "/react-demo") {
      return Response.redirect(new URL("/react-demo/", url), 308);
    }
    const staticPath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const requestedPath = safePath(distRoot, staticPath);
    if (!requestedPath) {
      return new Response("Bad Request", { status: 400 });
    }

    const requestedFile = Bun.file(requestedPath);
    if (await requestedFile.exists()) {
      return serveFile(request, requestedPath, cacheControlFor(staticPath));
    }
    if (pathname.startsWith("/assets/") || pathname.startsWith("/react-demo/")) {
      return new Response("Not Found", { status: 404 });
    }
    return serveFile(request, indexPath, REVALIDATE_CACHE_CONTROL);
  };
}

async function proxyDemoApi(
  request: Request,
  incomingUrl: URL,
  options: DemoApiProxyOptions | undefined,
): Promise<Response> {
  if (!options) return new Response("Demo API proxy is not configured", { status: 404 });
  const suffix = incomingUrl.pathname.slice(DEMO_API_PREFIX.length);
  if (suffix !== "/healthz" && !suffix.startsWith("/v1/")) {
    return new Response("Not Found", { status: 404 });
  }
  // OpenGeni API route segments never require percent encoding. Reject it so
  // a second URL parser cannot turn a double-encoded dot segment into a path
  // outside the admitted /v1 or /healthz surface.
  if (suffix.includes("%")) {
    return new Response("Bad Request", { status: 400 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== incomingUrl.origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const target = new URL(
    `${suffix}${incomingUrl.search}`,
    normalizedBaseUrl(options.targetBaseUrl),
  );
  const headers = new Headers(request.headers);
  stripHopByHopHeaders(headers);
  for (const name of [
    "authorization",
    "content-length",
    "forwarded",
    "host",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-opengeni-access-key",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }
  for (const [name, value] of new Headers(options.credentialHeaders)) {
    headers.set(name, value);
  }
  // Bun's fetch transparently decodes compressed upstream responses. Ask for
  // the identity representation so the streamed body and response metadata
  // agree even before the defensive response-header normalization below.
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.slice(0, -1));

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  try {
    const upstream = await (options.fetch ?? fetch)(target, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: request.signal,
    });
    const responseHeaders = new Headers(upstream.headers);
    stripHopByHopHeaders(responseHeaders);
    // A fetch implementation may retain the upstream representation headers
    // after transparently decoding its body. Forwarding those stale headers
    // makes browsers attempt a second decompression and fail before the SDK can
    // read even an ordinary JSON error response.
    if (request.method !== "HEAD") {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }
    responseHeaders.set("cache-control", "no-store");
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return new Response("Demo API upstream unavailable", { status: 502 });
  }
}

function stripHopByHopHeaders(headers: Headers): void {
  for (const name of headers.get("connection")?.split(",") ?? []) {
    const normalized = name.trim();
    if (normalized) headers.delete(normalized);
  }
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
}

function normalizedBaseUrl(value: string): string {
  const normalized = value.endsWith("/") ? value : `${value}/`;
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OPENGENI_DEMO_API_URL must use http or https");
  }
  return url.toString();
}

export function demoApiProxyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  readCredentialFile: (path: string) => string | undefined = readDemoCredentialFile,
): DemoApiProxyOptions | undefined {
  const targetBaseUrl = env.OPENGENI_DEMO_API_URL?.trim();
  if (!targetBaseUrl) return undefined;
  // Validate eagerly so a malformed deployment value fails at process startup
  // instead of turning each demo request into an unhandled URL exception.
  normalizedBaseUrl(targetBaseUrl);
  const credentialHeaders = new Headers();
  const apiKeyName = ["OPENGENI", "DEMO", "API", "KEY"].join("_");
  const accessKeyName = ["OPENGENI", "DEMO", "ACCESS", "KEY"].join("_");
  const credentialsDirectory = env.OPENGENI_DEMO_CREDENTIALS_DIR?.trim();
  const bearerValue =
    env[apiKeyName]?.trim() ||
    (credentialsDirectory
      ? readCredentialFile(resolve(credentialsDirectory, "api-key"))
      : undefined);
  const accessValue =
    env[accessKeyName]?.trim() ||
    (credentialsDirectory
      ? readCredentialFile(resolve(credentialsDirectory, "access-key"))
      : undefined);
  if (bearerValue) credentialHeaders.set("authorization", ["Bearer", bearerValue].join(" "));
  if (accessValue) credentialHeaders.set("x-opengeni-access-key", accessValue);
  return {
    targetBaseUrl,
    ...(bearerValue || accessValue ? { credentialHeaders } : {}),
  };
}

function readDemoCredentialFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function safePath(root: string, pathname: string): string | null {
  const candidate = resolve(root, `.${pathname}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE_CONTROL;
  if (extname(pathname) === ".html" || pathname === "/") return REVALIDATE_CACHE_CONTROL;
  return SHORT_CACHE_CONTROL;
}

async function serveFile(request: Request, path: string, cacheControl: string): Promise<Response> {
  const source = Bun.file(path);
  if (!(await source.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  const acceptsGzip =
    !request.headers.has("range") &&
    acceptsEncoding(request.headers.get("accept-encoding"), "gzip");
  const gzip = Bun.file(`${path}.gz`);
  const encoded = acceptsGzip && (await gzip.exists()) ? gzip : null;
  const body = encoded ?? source;
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": source.type || "application/octet-stream",
    vary: "Accept-Encoding",
  });
  if (encoded) headers.set("content-encoding", "gzip");
  if (request.method === "HEAD") {
    headers.set("content-length", String(body.size));
    return new Response(null, { headers });
  }
  return new Response(body, { headers });
}

function acceptsEncoding(header: string | null, encoding: string): boolean {
  if (!header) return false;
  for (const entry of header.split(",")) {
    const segments = entry.trim().split(";");
    const name = segments[0]?.toLowerCase();
    if (name !== encoding.toLowerCase() && name !== "*") continue;
    const parameters = segments.slice(1);
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return quality ? Number(quality.slice(2)) > 0 : true;
  }
  return false;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const hostname = process.env.HOST ?? DEFAULT_HOST;
  Bun.serve({
    hostname,
    port,
    fetch: createWebHandler(undefined, { demoApiProxy: demoApiProxyFromEnvironment() }),
  });
  console.log(`OpenGeni web listening on http://${hostname}:${port}`);
}
