// @opengeni/runtime/sandbox — the pixel DATA PLANE: exposeStreamPort (P4.2).
//
// This is the heart of Channel B's data plane. exposeStreamPort resolves the
// provider's scoped tunnel for the ONE exposed stream port (6080), assembles the
// direct-to-provider WS URL (client → provider-tunnel direct; the pixel socket
// never traverses OpenGeni), and mints the scoped OpenGeni stream token. It is a
// plain function over a live, externally-owned `{session}` handle — NO Temporal,
// NO worker RPC, NO actor. The API-direct handshake handler (apps/api) calls it
// in-process on a freshly-resumed-by-id box and returns the result as the HTTP
// response; the worker's per-turn resume path calls the same function when a turn
// is the first to bring the box up. Both pull it from this single agent-loop-free
// leaf (@opengeni/runtime/sandbox).
//
// THE TOKEN IS NOT A URL QUERY PARAM. The provider's own scoped tunnel URL
// (Modal raw-TLS host:port, Daytona signed preview, Blaxel preview-token query)
// carries the reach-the-port boundary; the OpenGeni stream token is RECORDED
// against the viewer holder and is the in-box websockify edge boundary (P3/P5).
// Per the master-spine ruling, exposeStreamPort returns the token alongside the
// URL so the caller records it; it does NOT append it to `url`.

import { DESKTOP_STREAM_PORT } from "@opengeni/contracts";
import { mintStreamToken, STREAM_TOKEN_DEFAULT_TTL_SECONDS } from "./stream-token";

/** The provider-resolved endpoint for an exposed port. Mirrors the SDK's
 *  `ExposedPortEndpoint` (host/port/tls/query/...) WITHOUT importing the
 *  agent-loop barrel — the leaf stays agent-loop-free. */
export type ExposedPortEndpoint = {
  host: string;
  port: number;
  tls?: boolean;
  query?: string;
  protocol?: string;
  url?: string;
  /** The URL path the socket connects on. Modal/Daytona/Blaxel serve the edge at
   *  the root (`/`, the default); the selfhosted relay serves it at `/stream`
   *  (M8b). When set, buildStreamUrl uses it instead of the root. */
  path?: string;
  [key: string]: unknown;
};

/** The structural slice of a provider session we need to resolve a tunnel. */
type PortResolvableSession = {
  resolveExposedPort?: (port: number) => Promise<ExposedPortEndpoint>;
};

/** Thrown when the provider cannot expose the stream port (no resolveExposedPort,
 *  or the provider tunnel lookup failed). The caller degrades the desktop cell to
 *  `transport:null` (a value, never a crash) — a headless-only provider or a
 *  transient tunnel failure must not fail the whole handshake. */
export class StreamPortUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StreamPortUnavailableError";
  }
}

export type ExposeStreamPortInput = {
  workspaceId: string;
  sessionId: string;
  /** The sandbox_lease_holders viewer row id the token is scoped to. */
  viewerId: string;
  /** The live lease epoch — the fence the token is pinned to. */
  leaseEpoch: number;
  /** The HMAC secret for the scoped stream token (resolveStreamTokenSecret). */
  streamTokenSecret: string;
  /** The exposed stream port; defaults to 6080. */
  port?: number;
  /** Token TTL in seconds; defaults to STREAM_TOKEN_DEFAULT_TTL_SECONDS. */
  ttlSeconds?: number;
  /** The framebuffer geometry to echo back to the client. */
  resolution?: [number, number];
  /** Override the issue clock (tests). Seconds since the epoch. */
  nowSeconds?: number;
};

export type ExposeStreamPortResult = {
  /** The direct-to-provider WS URL the viewer connects to (provider-scoped; the
   *  OpenGeni token is NOT appended). */
  url: string;
  /** The scoped OpenGeni stream token — recorded against the holder, NEVER a URL
   *  query param. */
  token: string;
  /** ISO absolute expiry of the token (the rotation hot-swap window backstop). */
  expiresAt: string;
  /** The pixel transport the client speaks. */
  transport: "vnc-ws";
  /** The reference noVNC client the SDK helper mounts. */
  client: "novnc";
  resolution: [number, number];
  leaseEpoch: number;
};

const DEFAULT_RESOLUTION: [number, number] = [1280, 800];

/**
 * Assemble the direct-to-provider WS URL from a resolved endpoint. The SDK's
 * `urlForExposedPort(endpoint,'ws')` is the canonical tls-aware, IPv6-bracketing,
 * provider-query-preserving assembler — we reimplement its exact logic here so
 * the leaf stays agent-loop-free (the helper lives behind the bare
 * `@openai/agents-core` root, which the import-discipline test forbids). The
 * provider's own `endpoint.query` (Blaxel `bl_preview_token`, Daytona signed
 * token) is preserved; the OpenGeni token is NOT appended (it is recorded against
 * the holder + validated at the in-box websockify edge).
 */
export function buildStreamUrl(endpoint: ExposedPortEndpoint): string {
  if (typeof endpoint.host !== "string" || endpoint.host.length === 0 || typeof endpoint.port !== "number") {
    throw new StreamPortUnavailableError(
      `provider returned a malformed exposed-port endpoint (host=${String(endpoint.host)}, port=${String(endpoint.port)})`,
    );
  }
  const tls = endpoint.tls ?? false;
  const scheme = tls ? "wss" : "ws";
  const defaultPort = tls ? 443 : 80;
  // Bracket a bare IPv6 host (urlForExposedPort parity).
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
  // The path: default the root `/` (Modal/Daytona/Blaxel edge), or the
  // provider-supplied path (the selfhosted relay's `/stream` route, M8b). Always
  // leading-slash-normalized.
  const rawPath = typeof endpoint.path === "string" && endpoint.path.length > 0 ? endpoint.path : "/";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const origin = endpoint.port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${endpoint.port}`;
  const authority = `${origin}${path}`;
  const query = endpoint.query ?? "";
  return query ? `${authority}?${query}` : authority;
}

/**
 * Resolve the provider's scoped tunnel for the stream port and mint the scoped
 * OpenGeni stream token. Returns a coherent `{url, token, expiresAt, transport,
 * client, resolution}` cell the caller records on the lease (data_plane_url) and
 * returns in the DesktopStream handshake.
 *
 * Throws `StreamPortUnavailableError` when the provider session cannot resolve
 * the port (no `resolveExposedPort`, or the tunnel lookup failed) — the caller
 * maps this to a `transport:null` degradation (a value, never a crash).
 */
export async function exposeStreamPort(
  session: unknown,
  input: ExposeStreamPortInput,
): Promise<ExposeStreamPortResult> {
  const s = session as PortResolvableSession;
  const port = input.port ?? DESKTOP_STREAM_PORT;
  if (typeof s?.resolveExposedPort !== "function") {
    throw new StreamPortUnavailableError(
      "provider session cannot resolve exposed ports (no resolveExposedPort) — desktop stream unavailable",
    );
  }

  let endpoint: ExposedPortEndpoint;
  try {
    // (I7/OD-7) per-provider URL re-resolution folds in here: a provider with a
    // preview/signed token (Daytona/Blaxel) re-resolves its own short-TTL token
    // on every call, so a rotation re-mints both planes' freshness in one place.
    endpoint = await s.resolveExposedPort(port);
  } catch (error) {
    throw new StreamPortUnavailableError(
      `provider failed to resolve the stream port ${port}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const url = buildStreamUrl(endpoint);
  const ttlSeconds = input.ttlSeconds ?? STREAM_TOKEN_DEFAULT_TTL_SECONDS;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const token = await mintStreamToken(input.streamTokenSecret, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    viewerId: input.viewerId,
    leaseEpoch: input.leaseEpoch,
    mode: "view",
    port,
    ttlSeconds,
    nowSeconds,
  });

  return {
    url,
    token,
    expiresAt: new Date((nowSeconds + ttlSeconds) * 1000).toISOString(),
    transport: "vnc-ws",
    client: "novnc",
    resolution: input.resolution ?? DEFAULT_RESOLUTION,
    leaseEpoch: input.leaseEpoch,
  };
}
