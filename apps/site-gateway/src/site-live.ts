/**
 * Live change hints for open Site pages (docs/site-data.md, "Change events").
 *
 * - `GET /_og/live` on a Site host: a WebSocket for the Site's own page. The
 *   gateway checks it like a Site API call (same origin, sign-in, flood
 *   brake), then asks the API to admit the viewer (`POST
 *   /v1/site-runtime/live/admit`, signed with the viewer's fields). The API
 *   answers with the collections this viewer may read.
 * - `GET /_og/live?ticket=…` on the console's frame host: the same for a Site
 *   shown in the console, admitted by a short-lived ticket the API issued
 *   to a signed-in console user (HMAC with the gateway secret), from the
 *   console's origin only.
 * - `POST /_og/internal/site-live/<siteId>`: the API's signed notice after a
 *   Site Data change or a new version.
 *
 * All three reach one `SiteLive` Durable Object per Site, which holds the
 * connections with the WebSocket Hibernation API (idle connections cost no
 * duration) and passes on only hints: collection names and change numbers,
 * intersected with what each connection may read, or "a new version". Never
 * record data: pages refetch through their normal, authorized calls.
 * Without the `SITE_LIVE` binding every route answers 404 and pages keep
 * their fallback checks.
 */
import {
  SITE_GATEWAY_LIVE_PATH,
  SITE_LIVE_INTERNAL_PREFIX,
  SITE_LIVE_TTL_SECONDS,
  SiteLiveAdmission,
  SiteLiveNotice,
  type SiteLiveHint,
} from "@opengeni/contracts";
import { readBodyCapped, rateLimitKeys, underRateLimit } from "./api";
import { base64urlDecode, hmacBase64url, timingSafeEqual } from "./crypto";
import type { GatewayConfig, GatewayEnv } from "./env";
import { applySecurityHeaders, jsonError } from "./headers";
import { signedApiRequest } from "./signing";
import { isSameOriginRequest, requiresSignIn, siteCaller, type SiteContext } from "./site-context";
import {
  precheckSiteDbSignature,
  verifySiteDbSignature,
  type DurableObjectNamespaceLike,
} from "./site-db";

export { SITE_GATEWAY_LIVE_PATH, SITE_LIVE_INTERNAL_PREFIX };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Notices are a few hundred bytes. */
const MAX_NOTICE_BYTES = 16 * 1024;
/** Connections one Site's live object keeps at most; more are refused (pages fall back). */
export const SITE_LIVE_MAX_CONNECTIONS = 2_000;
/** Headers the gateway passes to the live object with an admitted connection. */
const ADMITTED_HEADER = "x-og-live-admitted";

export function isSiteLiveInternalPath(pathname: string): boolean {
  return (
    pathname === SITE_LIVE_INTERNAL_PREFIX || pathname.startsWith(`${SITE_LIVE_INTERNAL_PREFIX}/`)
  );
}

function liveNamespace(env: GatewayEnv): DurableObjectNamespaceLike | null {
  return (env.SITE_LIVE as DurableObjectNamespaceLike | undefined) ?? null;
}

function isWebSocketUpgrade(request: Request): boolean {
  return (
    request.method === "GET" && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
  );
}

type Admitted = { siteId: string; seq: number; collections: string[] | null; ttlSeconds: number };

/** Hand an admitted upgrade to the Site's live object. */
async function connect(
  namespace: DurableObjectNamespaceLike,
  admitted: Admitted,
): Promise<Response> {
  const headers = new Headers({ upgrade: "websocket" });
  headers.set(ADMITTED_HEADER, JSON.stringify(admitted));
  const stub = namespace.get(namespace.idFromName(admitted.siteId));
  return await stub.fetch("https://site-live.internal/connect", { method: "GET", headers });
}

/** `GET /_og/live` on a Site host. */
export async function handleSiteLive(site: SiteContext): Promise<Response> {
  const security = { noindex: true, hsts: site.hsts };
  const namespace = liveNamespace(site.env);
  if (!namespace) return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (!isWebSocketUpgrade(site.request))
    return jsonError(426, { code: "upgrade_required", message: "Open a WebSocket" }, security);
  if (!isSameOriginRequest(site.request, site.siteOrigin))
    return jsonError(
      403,
      { code: "site_cross_origin", message: "Live updates must come from the Site's own page" },
      security,
    );
  if (requiresSignIn(site.config, site.record) && !site.session)
    return jsonError(
      401,
      { code: "site_sign_in_required", message: "Sign in to use this Site" },
      security,
    );
  if (!(await underRateLimit(site, rateLimitKeys(site, "live"))))
    return jsonError(
      429,
      { code: "site_rate_limited", message: "Too many requests; slow down", retryable: true },
      { ...security, headers: { "Retry-After": "60" } },
    );
  let admitted: Admitted;
  try {
    const response = await fetch(
      await signedApiRequest(site.config, siteCaller(site), {
        method: "POST",
        suffix: "/live/admit",
        body: new Uint8Array(0),
        headers: new Headers({ accept: "application/json" }),
      }),
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return new Response(body, {
        status: response.status >= 500 ? 502 : response.status,
        headers: applySecurityHeaders(
          new Headers({
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          }),
          security,
        ),
      });
    }
    const parsed = SiteLiveAdmission.safeParse(await response.json());
    if (!parsed.success || parsed.data.siteId !== site.record.siteId)
      return jsonError(
        502,
        { code: "site_upstream_unavailable", message: "Try again shortly", retryable: true },
        security,
      );
    admitted = parsed.data;
  } catch {
    return jsonError(
      502,
      { code: "site_upstream_unavailable", message: "Try again shortly", retryable: true },
      security,
    );
  }
  return await connect(namespace, admitted);
}

/** A console ticket: `v1.<payload>.<mac>` (see apps/api/src/site-live/service.ts). */
export async function verifySiteLiveTicket(
  secrets: readonly string[],
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Admitted | null> {
  const [version, payload, mac, extra] = token.split(".");
  if (version !== "v1" || !payload || !mac || extra !== undefined || token.length > 8192)
    return null;
  let valid = false;
  for (const secret of secrets) {
    const expected = await hmacBase64url(secret, `OGLIVE1\n${payload}`);
    if (timingSafeEqual(mac, expected)) valid = true;
  }
  if (!valid) return null;
  const bytes = base64urlDecode(payload);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { s, c, q, e, t } = parsed;
    if (typeof s !== "string" || !UUID.test(s)) return null;
    if (typeof e !== "number" || e < nowSeconds) return null;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0) return null;
    const collections =
      c === null
        ? null
        : Array.isArray(c) && c.every((name) => typeof name === "string")
          ? (c as string[])
          : undefined;
    if (collections === undefined) return null;
    const ttlSeconds =
      typeof t === "number" && Number.isInteger(t) && t > 0 && t <= 3600
        ? t
        : SITE_LIVE_TTL_SECONDS;
    return { siteId: s, seq: q, collections, ttlSeconds };
  } catch {
    return null;
  }
}

/** `GET /_og/live?ticket=…` on the console's frame host. */
export async function handleConsoleLive(
  request: Request,
  url: URL,
  env: GatewayEnv,
  config: GatewayConfig,
): Promise<Response> {
  const security = { noindex: true, hsts: !config.development };
  const namespace = liveNamespace(env);
  if (!namespace) return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (!isWebSocketUpgrade(request))
    return jsonError(426, { code: "upgrade_required", message: "Open a WebSocket" }, security);
  // Only the console may open it: browsers always send Origin on WebSockets.
  if (request.headers.get("origin") !== config.appOrigin)
    return jsonError(403, { code: "forbidden", message: "Not allowed" }, security);
  const secrets = [config.secret, ...(config.previousSecret ? [config.previousSecret] : [])];
  const admitted = await verifySiteLiveTicket(secrets, url.searchParams.get("ticket") ?? "");
  if (!admitted)
    return jsonError(401, { code: "unauthorized", message: "Invalid or expired ticket" }, security);
  return await connect(namespace, admitted);
}

/** `POST /_og/internal/site-live/<siteId>`: the API's signed notice. */
export async function handleSiteLiveInternal(
  request: Request,
  url: URL,
  env: GatewayEnv,
  config: GatewayConfig,
): Promise<Response> {
  const security = { noindex: true, hsts: !config.development };
  const namespace = liveNamespace(env);
  if (!namespace) return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (!config.development && url.protocol !== "https:")
    return jsonError(400, { code: "https_required", message: "Use https" }, security);
  const siteId = /^\/_og\/internal\/site-live\/([^/]+)$/u.exec(url.pathname)?.[1];
  if (!siteId || !UUID.test(siteId) || url.search)
    return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (request.method !== "POST")
    return jsonError(405, { code: "method_not_allowed", message: "Use POST" }, security);
  const unauthorized = () =>
    jsonError(401, { code: "unauthorized", message: "Invalid or expired signature" }, security);
  if (precheckSiteDbSignature(request) === null) return unauthorized();
  const body = await readBodyCapped(request, MAX_NOTICE_BYTES);
  if (body === "too_large")
    return jsonError(
      413,
      { code: "too_large", message: "The request body is too large" },
      security,
    );
  const secrets = [config.secret, ...(config.previousSecret ? [config.previousSecret] : [])];
  if (!(await verifySiteDbSignature(secrets, request, url, body))) return unauthorized();
  let notice: SiteLiveNotice;
  try {
    const parsed = SiteLiveNotice.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) throw new Error("invalid");
    notice = parsed.data;
  } catch {
    return jsonError(422, { code: "validation", message: "Invalid notice" }, security);
  }
  const stub = namespace.get(namespace.idFromName(siteId));
  try {
    const response = await stub.fetch("https://site-live.internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notice),
    });
    const out = applySecurityHeaders(new Headers(), security);
    out.set("Content-Type", "application/json; charset=utf-8");
    out.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers: out });
  } catch (error) {
    console.error("site-gateway: site-live notify failed", error);
    return jsonError(
      503,
      { code: "site_live_unavailable", message: "Try again shortly", retryable: true },
      security,
    );
  }
}

// ---------------------------------------------------------------------------
// The per-Site live object
// ---------------------------------------------------------------------------

/** The slice of the WebSocket the live object uses (workers-types is not loaded). */
export type LiveSocket = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

/** The slice of the Durable Object state the live object uses (Hibernation API). */
export type SiteLiveState = {
  acceptWebSocket(socket: LiveSocket, tags?: string[]): void;
  getWebSockets(tag?: string): LiveSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
  /** SQLite-backed objects' synchronous key-value storage (survives hibernation). */
  storage?: { kv?: { get(key: string): unknown; put(key: string, value: unknown): void } };
};

const LAST_SEQ_KEY = "lastSeq";

/** What a connection was admitted for, kept with the socket across hibernation. */
type Attachment = { c: string[] | null; x: number };

function attachment(socket: LiveSocket): Attachment | null {
  try {
    const value = socket.deserializeAttachment() as Attachment | null;
    return value && typeof value.x === "number" ? value : null;
  } catch {
    return null;
  }
}

/** The collections of a change that this connection may hear about, or null for none. */
export function visibleCollections(
  changed: readonly string[],
  readable: readonly string[] | null,
): string[] | null {
  if (readable === null) return [...changed];
  const allowed = new Set(readable);
  const visible = changed.filter((name) => allowed.has(name));
  return visible.length > 0 ? visible : null;
}

function closeQuietly(socket: LiveSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // already closed
  }
}

function send(socket: LiveSocket, hint: SiteLiveHint): void {
  try {
    socket.send(JSON.stringify(hint));
  } catch {
    // A socket that cannot take a message is closed by the runtime.
  }
}

export class SiteLive {
  /** The highest change number passed on, so a connection admitted just before a change still hears it. */
  private lastSeq: number | null = null;

  constructor(
    private readonly state: SiteLiveState,
    _env: unknown,
  ) {
    // Answer keep-alive pings without waking the object.
    const Pair = (
      globalThis as { WebSocketRequestResponsePair?: new (a: string, b: string) => unknown }
    ).WebSocketRequestResponsePair;
    if (Pair && state.setWebSocketAutoResponse)
      state.setWebSocketAutoResponse(new Pair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.accept(request);
    if (path === "/notify" && request.method === "POST") {
      let notice: SiteLiveNotice;
      try {
        notice = SiteLiveNotice.parse(await request.json());
      } catch {
        return Response.json(
          { error: { code: "validation", message: "Invalid notice" } },
          { status: 422 },
        );
      }
      return Response.json({ delivered: this.broadcast(notice) });
    }
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }

  private accept(request: Request): Response {
    let admitted: Admitted;
    try {
      admitted = JSON.parse(request.headers.get(ADMITTED_HEADER) ?? "") as Admitted;
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    // Expired connections give their place up before the cap is checked.
    const now = Date.now();
    let open = 0;
    for (const socket of this.state.getWebSockets()) {
      const held = attachment(socket);
      if (!held || held.x <= now) closeQuietly(socket, 4001, "reauth");
      else open += 1;
    }
    if (open >= SITE_LIVE_MAX_CONNECTIONS)
      return Response.json(
        {
          error: { code: "site_live_busy", message: "Too many live connections", retryable: true },
        },
        { status: 503 },
      );
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, LiveSocket> })
      .WebSocketPair;
    if (!Pair) return new Response("WebSockets are not available", { status: 500 });
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const expiresAt = Date.now() + admitted.ttlSeconds * 1000;
    server.serializeAttachment({ c: admitted.collections, x: expiresAt } satisfies Attachment);
    send(server, {
      type: "hello",
      seq: admitted.seq,
      collections: admitted.collections,
      ttlSeconds: admitted.ttlSeconds,
    });
    // A change committed between the admission and now was passed on before
    // this connection existed: tell it something may have changed.
    const last = this.readLastSeq();
    if (last !== null && last > admitted.seq)
      send(server, { type: "data", seq: last, collections: null });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private readLastSeq(): number | null {
    if (this.lastSeq !== null) return this.lastSeq;
    try {
      const stored = this.state.storage?.kv?.get(LAST_SEQ_KEY);
      if (typeof stored === "number") this.lastSeq = stored;
    } catch {
      // Without storage, memory is enough while the object is awake.
    }
    return this.lastSeq;
  }

  private rememberSeq(seq: number): void {
    const last = this.readLastSeq();
    if (last !== null && last >= seq) return;
    this.lastSeq = seq;
    try {
      this.state.storage?.kv?.put(LAST_SEQ_KEY, seq);
    } catch {
      // Best effort.
    }
  }

  /** Pass a notice on to every connection that may hear it. Returns how many did. */
  private broadcast(notice: SiteLiveNotice): number {
    const now = Date.now();
    if (notice.type === "data") this.rememberSeq(notice.seq);
    let delivered = 0;
    for (const socket of this.state.getWebSockets()) {
      const admitted = attachment(socket);
      if (!admitted || admitted.x <= now) {
        // The admission ran out: the page reconnects and is checked again.
        closeQuietly(socket, 4001, "reauth");
        continue;
      }
      if (notice.type === "version") {
        send(socket, { type: "version", versionId: notice.versionId });
        delivered += 1;
        continue;
      }
      const collections = visibleCollections(notice.collections, admitted.c);
      if (!collections) continue;
      send(socket, { type: "data", seq: notice.seq, collections });
      delivered += 1;
    }
    return delivered;
  }

  async webSocketMessage(socket: LiveSocket, message: string | ArrayBuffer): Promise<void> {
    // Pages only ping (answered by the auto response when available).
    if (message === "ping") {
      try {
        socket.send("pong");
      } catch {
        // closed
      }
    }
  }

  async webSocketClose(socket: LiveSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  async webSocketError(socket: LiveSocket): Promise<void> {
    try {
      socket.close(1011, "error");
    } catch {
      // already closed
    }
  }
}
