import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { WebSocket as UpstreamWebSocket } from "ws";
import type {
  ApiWebSocketConnection,
  ApiWebSocketLike,
  ApiWebSocketUpgradeServer,
} from "./api-websocket";

export const INTERACTION_FRAME_PROXY_PATH = "/v1/interaction/frame-proxy";
export const INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX = "opengeni-frame-proxy.";

const TOKEN_VERSION = 1;
const TOKEN_IV_BYTES = 12;
const TOKEN_TAG_BYTES = 16;
const TOKEN_MAX_BYTES = 8 * 1024;
const TOKEN_KEY_CONTEXT = "OpenGeni interaction frame proxy v1";
const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 12 * 1024 * 1024;

type ProxyGrant = Readonly<{
  version: 1;
  upstreamUrl: string;
  upstreamProtocols: readonly string[];
  responseProtocol: string;
  origin: string | null;
  expiresAt: number;
}>;

export type InteractionFrameProxyAttachment = Readonly<{
  url: string;
  protocols: readonly string[];
}>;

/** Docker boxes and OpenSandbox lifecycle proxies cannot carry browserd's
 * WebSocket subprotocol grant to the viewer. The API frame-proxy holds the
 * upstream URL + protocols; Modal/Daytona/Blaxel native tunnels stay direct. */
export function placementUsesInteractionFrameProxy(
  backend: string | null | undefined,
): boolean {
  return backend === "docker" || backend === "opensandbox";
}

export function createInteractionFrameProxyAttachment(input: {
  requestUrl: string;
  rootSecret: string;
  upstreamUrl: string;
  upstreamProtocols: readonly string[];
  origin: string | null;
  expiresAt: string;
}): InteractionFrameProxyAttachment {
  const grant = validateGrant({
    version: TOKEN_VERSION,
    upstreamUrl: input.upstreamUrl,
    upstreamProtocols: input.upstreamProtocols,
    responseProtocol: input.upstreamProtocols[0] ?? "",
    origin: input.origin,
    expiresAt: Date.parse(input.expiresAt),
  });
  const token = encryptGrant(grant, input.rootSecret);
  const url = new URL(input.requestUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = INTERACTION_FRAME_PROXY_PATH;
  url.search = "";
  url.hash = "";
  return Object.freeze({
    url: url.toString(),
    protocols: Object.freeze([
      grant.responseProtocol,
      `${INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX}${token}`,
    ]),
  });
}

export class InteractionFrameProxyTransport {
  constructor(
    private readonly rootSecret: string | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  handles(request: Request): boolean {
    return new URL(request.url).pathname === INTERACTION_FRAME_PROXY_PATH;
  }

  upgrade(request: Request, server: ApiWebSocketUpgradeServer): Response | undefined {
    if (!this.handles(request)) return undefined;
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (!this.rootSecret) return new Response("Service Unavailable", { status: 503 });
    const offered = offeredProtocols(request.headers.get("sec-websocket-protocol"));
    const proxyProtocol = offered.find((protocol) =>
      protocol.startsWith(INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX),
    );
    if (!proxyProtocol) return new Response("WebSocket proxy grant required", { status: 426 });
    let grant: ProxyGrant;
    try {
      grant = decryptGrant(
        proxyProtocol.slice(INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX.length),
        this.rootSecret,
      );
    } catch {
      return new Response("Invalid WebSocket proxy grant", { status: 401 });
    }
    if (grant.expiresAt <= this.clock()) {
      return new Response("WebSocket proxy grant expired", { status: 401 });
    }
    if (!offered.includes(grant.responseProtocol)) {
      return new Response("WebSocket protocol required", { status: 426 });
    }
    const origin = normalizedOrigin(request.headers.get("origin"));
    if (origin !== grant.origin) {
      return new Response("WebSocket origin is not allowed", { status: 403 });
    }
    const connection = new InteractionFrameProxyConnection(grant);
    const upgraded = server.upgrade(request, {
      data: connection,
      headers: { "sec-websocket-protocol": grant.responseProtocol },
    });
    return upgraded ? undefined : new Response("Bad Request", { status: 400 });
  }
}

export class InteractionFrameProxyConnection implements ApiWebSocketConnection {
  private socket: ApiWebSocketLike | null = null;
  private upstream: UpstreamWebSocket | null = null;
  private upstreamOpen = false;
  private terminal = false;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;

  constructor(private readonly grant: ProxyGrant) {}

  attach(socket: ApiWebSocketLike): void {
    if (this.socket || this.terminal) {
      socket.close(4400, "invalid connection state");
      return;
    }
    this.socket = socket;
    let upstream: UpstreamWebSocket;
    try {
      upstream = new UpstreamWebSocket(this.grant.upstreamUrl, [...this.grant.upstreamProtocols], {
        ...(this.grant.origin ? { headers: { origin: this.grant.origin } } : {}),
      });
    } catch {
      this.fail(1011, "upstream unavailable");
      return;
    }
    this.upstream = upstream;
    upstream.binaryType = "arraybuffer";
    upstream.once("open", () => {
      if (this.terminal) {
        upstream.close(1000, "viewer closed");
        return;
      }
      this.upstreamOpen = true;
      for (const message of this.queued) upstream.send(webSocketBinary(message));
      this.queued = [];
      this.queuedBytes = 0;
    });
    upstream.on("message", (data) => {
      if (this.terminal || !this.socket) return;
      const bytes = binaryMessage(data);
      if (!bytes || this.socket.send(bytes, false) <= 0) {
        this.fail(1011, "stream unavailable");
      }
    });
    upstream.on("error", () => this.fail(1011, "upstream unavailable"));
    upstream.once("close", (code, reason) => {
      this.fail(safeCloseCode(code), boundedReason(reason.toString("utf8")));
    });
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.terminal) return;
    if (typeof message === "string") {
      this.fail(4400, "binary frames required");
      return;
    }
    const bytes =
      message instanceof Uint8Array ? Uint8Array.from(message) : new Uint8Array(message).slice();
    if (this.upstreamOpen && this.upstream) {
      this.upstream.send(webSocketBinary(bytes));
      return;
    }
    if (
      this.queued.length + 1 > MAX_QUEUED_MESSAGES ||
      this.queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES
    ) {
      this.fail(4409, "viewer is too fast");
      return;
    }
    this.queued.push(bytes);
    this.queuedBytes += bytes.byteLength;
  }

  transportClosed(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.upstream?.close(1000, "viewer closed");
    this.clear();
  }

  private fail(code: number, reason: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.upstream?.close(code === 1000 ? 1000 : 1011, reason);
    this.socket?.close(code, reason);
    this.clear();
  }

  private clear(): void {
    this.queued = [];
    this.queuedBytes = 0;
    this.socket = null;
    this.upstream = null;
  }
}

function encryptGrant(grant: ProxyGrant, rootSecret: string): string {
  const iv = randomBytes(TOKEN_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(rootSecret), iv);
  cipher.setAAD(Buffer.from(TOKEN_KEY_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decryptGrant(token: string, rootSecret: string): ProxyGrant {
  const bytes = Buffer.from(token, "base64url");
  if (
    token.length === 0 ||
    token.length > TOKEN_MAX_BYTES ||
    bytes.byteLength <= TOKEN_IV_BYTES + TOKEN_TAG_BYTES
  ) {
    throw new Error("invalid proxy grant");
  }
  const iv = bytes.subarray(0, TOKEN_IV_BYTES);
  const tag = bytes.subarray(TOKEN_IV_BYTES, TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const ciphertext = bytes.subarray(TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(rootSecret), iv);
  decipher.setAAD(Buffer.from(TOKEN_KEY_CONTEXT));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return validateGrant(JSON.parse(plaintext));
}

function tokenKey(rootSecret: string): Buffer {
  if (rootSecret.length === 0) throw new Error("proxy authority is empty");
  return createHmac("sha256", rootSecret).update(TOKEN_KEY_CONTEXT).digest();
}

function validateGrant(value: unknown): ProxyGrant {
  if (!value || typeof value !== "object") throw new Error("invalid proxy grant");
  const grant = value as Record<string, unknown>;
  if (grant.version !== TOKEN_VERSION) throw new Error("invalid proxy grant version");
  const upstreamUrl = requireUpstreamUrl(grant.upstreamUrl);
  const upstreamProtocols = requireProtocols(grant.upstreamProtocols);
  if (
    typeof grant.responseProtocol !== "string" ||
    grant.responseProtocol !== upstreamProtocols[0]
  ) {
    throw new Error("invalid proxy response protocol");
  }
  const origin = grant.origin === null ? null : normalizedOrigin(grant.origin);
  if (grant.origin !== null && !origin) throw new Error("invalid proxy origin");
  if (!Number.isSafeInteger(grant.expiresAt) || (grant.expiresAt as number) <= 0) {
    throw new Error("invalid proxy expiry");
  }
  return Object.freeze({
    version: TOKEN_VERSION,
    upstreamUrl,
    upstreamProtocols: Object.freeze(upstreamProtocols),
    responseProtocol: upstreamProtocols[0]!,
    origin,
    expiresAt: grant.expiresAt as number,
  });
}

function requireUpstreamUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("invalid upstream URL");
  }
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid upstream URL");
  }
  return url.toString();
}

function requireProtocols(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new Error("invalid upstream protocols");
  }
  return value.map((protocol) => {
    if (
      typeof protocol !== "string" ||
      protocol.length === 0 ||
      protocol.length > 2048 ||
      protocol.includes(",")
    ) {
      throw new Error("invalid upstream protocol");
    }
    return protocol;
  });
}

function offeredProtocols(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function normalizedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function binaryMessage(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

function webSocketBinary(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function safeCloseCode(code: number): number {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1011;
}

function boundedReason(reason: string): string {
  const normalized = reason.trim();
  return normalized.length > 0 && Buffer.byteLength(normalized) <= 123
    ? normalized
    : "upstream closed";
}
