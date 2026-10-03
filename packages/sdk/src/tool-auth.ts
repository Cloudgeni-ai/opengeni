/**
 * Per-user credentials for a product's own MCP tool server.
 *
 * `createSessionProxyHandler({ toolServer })` mints a short-lived token for the
 * user its `resolve` hook authenticated, attaches it to each session it creates,
 * and refreshes it on every message, approval, and answer. The product's MCP
 * endpoint calls {@link verifyToolRequest} on every request and scopes all data
 * access to the returned identity, never to ids the model supplied.
 *
 * Wire format (for non-Node verifiers): an HS256 JWT in `Authorization: Bearer`.
 * The HMAC key is `HMAC-SHA256(key = secret, message = "opengeni-tool-token:v1")`,
 * where `secret` is `OPENGENI_API_KEY` unless one was configured explicitly.
 * Claims: `iss` = `"opengeni-session-proxy"`, `aud` = the tool server URL, `sub` =
 * the external user id, `workspace_id`, `source`, optional `tenant`, `iat`, `exp`.
 */

/** `iss` of every tool token. */
export const TOOL_TOKEN_ISSUER = "opengeni-session-proxy";
/** HMAC message used to derive the signing key from the secret. */
export const TOOL_TOKEN_KEY_LABEL = "opengeni-tool-token:v1";
/** Default token lifetime: one hour, refreshed on every message. */
export const TOOL_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

/** The user a verified tool request acts for. */
export type ToolRequestIdentity = {
  /** External user id the session proxy's `resolve` hook authenticated. */
  user: string;
  /** Tenant from `resolve`, when it returned one. */
  tenant?: string | undefined;
  workspaceId: string;
  /** External identity source (same as the proxy's `asUser` source). */
  source: string;
  expiresAt: Date;
};

export type VerifyToolRequestOptions = {
  /** Signing secret. Defaults to `OPENGENI_API_KEY`; must match the proxy's. */
  secret?: string | undefined;
  /**
   * Exact tool server URL the token must be issued for (`toolServer.url`).
   * Defaults to matching the token audience's path against this request's path.
   */
  audience?: string | undefined;
};

/** A Web `Request`, or a Node/Express request (`headers` plus `originalUrl`/`url`). */
export type ToolRequestLike =
  | Request
  | {
      headers: Record<string, string | string[] | undefined>;
      originalUrl?: string | undefined;
      url?: string | undefined;
    };

/** Missing, expired, forged, or misdirected tool token. Respond with `status` (401). */
export class ToolRequestError extends Error {
  readonly status = 401;
  constructor(readonly code: string) {
    super("Tool request is not authorized.");
    this.name = "ToolRequestError";
  }
  /** A ready 401 response with a `WWW-Authenticate: Bearer` challenge. */
  toResponse(): Response {
    return new Response(JSON.stringify({ error: { code: this.code, message: this.message } }), {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      },
    });
  }
}

/**
 * Verify the tool token on one MCP request and return who it acts for.
 * Throws {@link ToolRequestError} (401) for every invalid token. Call it on
 * every request, before any tool runs.
 *
 * ```ts
 * const user = await verifyToolRequest(request); // { user, tenant, workspaceId }
 * ```
 */
export async function verifyToolRequest(
  request: ToolRequestLike,
  options: VerifyToolRequestOptions = {},
): Promise<ToolRequestIdentity> {
  const key = await signingKey(resolveToolTokenSecret(options.secret));
  const { authorization, path } = requestParts(request);
  const match = /^Bearer[ ]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    authorization?.trim() ?? "",
  );
  if (!match) throw new ToolRequestError("token_missing");
  const [header, payload, signature] = match[1]!.split(".") as [string, string, string];
  let protectedHeader: unknown;
  let claims: Record<string, unknown>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlDecode(signature);
    protectedHeader = JSON.parse(utf8(base64UrlDecode(header)));
    claims = JSON.parse(utf8(base64UrlDecode(payload)));
  } catch {
    throw new ToolRequestError("token_malformed");
  }
  if (
    !protectedHeader ||
    typeof protectedHeader !== "object" ||
    (protectedHeader as { alg?: unknown }).alg !== "HS256" ||
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims)
  ) {
    throw new ToolRequestError("token_malformed");
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) throw new ToolRequestError("token_invalid");
  const now = Math.floor(Date.now() / 1000);
  const { iss, aud, sub, exp, iat, workspace_id, source, tenant } = claims;
  if (iss !== TOOL_TOKEN_ISSUER) throw new ToolRequestError("token_invalid");
  if (typeof exp !== "number" || exp <= now) throw new ToolRequestError("token_expired");
  if (typeof iat !== "number" || iat > now + CLOCK_SKEW_SECONDS) {
    throw new ToolRequestError("token_invalid");
  }
  if (typeof aud !== "string" || !audienceMatches(aud, options.audience, path)) {
    throw new ToolRequestError("token_audience");
  }
  if (
    typeof sub !== "string" ||
    !sub ||
    typeof workspace_id !== "string" ||
    !workspace_id ||
    typeof source !== "string" ||
    (tenant !== undefined && typeof tenant !== "string")
  ) {
    throw new ToolRequestError("token_invalid");
  }
  return {
    user: sub,
    ...(tenant !== undefined ? { tenant } : {}),
    workspaceId: workspace_id,
    source,
    expiresAt: new Date(exp * 1000),
  };
}

/** Mint one tool token. The session proxy calls this; products rarely need to. */
export async function mintToolToken(input: {
  /** Tool server URL; becomes `aud`. */
  audience: string;
  user: string;
  tenant?: string | undefined;
  workspaceId: string;
  source: string;
  secret?: string | undefined;
  ttlSeconds?: number | undefined;
}): Promise<string> {
  const ttl = input.ttlSeconds ?? TOOL_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new TypeError(`ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}.`);
  }
  const key = await signingKey(resolveToolTokenSecret(input.secret));
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: TOOL_TOKEN_ISSUER,
    aud: input.audience,
    sub: input.user,
    workspace_id: input.workspaceId,
    source: input.source,
    ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
    iat: now,
    exp: now + ttl,
  });
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The configured secret, else `OPENGENI_API_KEY`. Throws when neither is set. */
export function resolveToolTokenSecret(secret: string | undefined): string {
  const resolved =
    secret ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.OPENGENI_API_KEY;
  if (!resolved) {
    throw new TypeError(
      "Tool tokens need a signing secret: set OPENGENI_API_KEY, or pass the same `secret` to the session proxy's toolServer and verifyToolRequest.",
    );
  }
  return resolved;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** HS256 key derived from the secret, so the raw secret never signs tokens itself. */
function signingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const root = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const derived = await crypto.subtle.sign(
        "HMAC",
        root,
        new TextEncoder().encode(TOOL_TOKEN_KEY_LABEL),
      );
      return await crypto.subtle.importKey(
        "raw",
        derived,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    })();
    key.catch(() => keys.delete(secret));
    if (keys.size >= 16) keys.delete(keys.keys().next().value!);
    keys.set(secret, key);
  }
  return key;
}

function requestParts(request: ToolRequestLike): {
  authorization: string | undefined;
  path: string | undefined;
} {
  if (typeof Request !== "undefined" && request instanceof Request) {
    return {
      authorization: request.headers.get("authorization") ?? undefined,
      path: new URL(request.url).pathname,
    };
  }
  const node = request as Exclude<ToolRequestLike, Request>;
  const headers = node.headers as unknown;
  const raw =
    headers && typeof (headers as Headers).get === "function"
      ? ((headers as Headers).get("authorization") ?? undefined)
      : (headers as Record<string, string | string[] | undefined>)?.authorization;
  const authorization = Array.isArray(raw) ? undefined : raw;
  const target = node.originalUrl ?? node.url;
  return {
    authorization,
    path: target === undefined ? undefined : new URL(target, "http://localhost").pathname,
  };
}

function audienceMatches(
  aud: string,
  expected: string | undefined,
  requestPath: string | undefined,
): boolean {
  if (expected !== undefined) return aud === expected;
  if (requestPath === undefined) return false;
  let audiencePath: string;
  try {
    audiencePath = new URL(aud).pathname;
  } catch {
    return false;
  }
  const trim = (path: string) => path.replace(/\/+$/, "") || "/";
  return trim(audiencePath) === trim(requestPath);
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
