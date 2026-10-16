import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  OpenGeniApiError,
  OpenGeniClient,
  createSessionProxyHandler,
  type CreateSessionRequest,
  type OpenGeniClientOptions,
} from "@opengeni/sdk";
import { uuidV5 } from "@opengeni/sdk/chat";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import * as z from "zod/v4";
import {
  TieredConcurrencyLimit,
  TieredRateLimit,
  type RateLimitRefusal,
  type TieredConcurrencyBounds,
  type TieredRateBounds,
} from "./rate-limit";
import type { SupportCase, DemoHealth, TicketPriority, TicketStatus } from "./types";
import { VisitorProductStates, addActivity, addNote, addReply, findCase } from "./visitor-state";
import {
  SessionOwners,
  VisitorCookies,
  forwardedClientAddress,
  networkKey,
  sameOriginRequest,
  sameSecret,
} from "./visitors";

const PRODUCT_PORT = Number(process.env.PORT ?? 4100);
const MCP_PORT = Number(process.env.OPENGENI_DEMO_MCP_PORT ?? 4101);
const UNIFIED_SERVER = Boolean(process.env.PORT);
const PRODUCT_APP_ORIGIN = (
  process.env.OPENGENI_DEMO_APP_ORIGIN ?? "http://127.0.0.1:3101"
).replace(/\/+$/, "");
const STATIC_ROOT = join(import.meta.dir, "../dist");
const MCP_SERVER_ID = "northstar_support";
// Set by this server on every session's MCP server; selects the visitor whose data the tools use.
const MCP_VISITOR_HEADER = "X-Northstar-Visitor";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";
const NOT_FOUND_CACHE_CONTROL = "no-store";
const MCP_TOOLS = ["get_ticket", "get_customer", "update_ticket", "add_internal_note"];
const encoder = new TextEncoder();

// Server-side configuration only; none of it reaches the browser.
const env = {
  apiKey: process.env.OPENGENI_API_KEY?.trim() ?? "",
  workspaceId: process.env.OPENGENI_WORKSPACE_ID?.trim() ?? "",
  apiBaseUrl: (process.env.OPENGENI_API_BASE_URL ?? "https://app.opengeni.ai").replace(/\/+$/, ""),
  mcpToken: process.env.OPENGENI_DEMO_MCP_TOKEN?.trim() ?? "",
};

// Abuse bounds for an anonymous public demo. Each action is limited per
// visitor (cookie), per client network (see `DemoServerConfig.clientIpHeader`),
// and across the demo. Visitors can replace their cookie, so the network and
// demo tiers are the real caps. Requests that fail validation never count.
const MINUTE = 60_000;
// Every agent run spends model usage.
const AGENT_RUNS: TieredRateBounds = {
  visitor: { limit: 6, windowMs: 10 * MINUTE },
  client: { limit: 10, windowMs: 60 * MINUTE },
  demo: { limit: 30, windowMs: 60 * MINUTE },
};
const RESETS: TieredRateBounds = {
  visitor: { limit: 5, windowMs: MINUTE },
  client: { limit: 10, windowMs: MINUTE },
  demo: { limit: 30, windowMs: MINUTE },
};
// Ticket edits, notes, and replies on the visitor's own copy of the board. Each
// one makes that visitor's open pages refetch it.
const PRODUCT_WRITES: TieredRateBounds = {
  visitor: { limit: 20, windowMs: MINUTE },
  client: { limit: 40, windowMs: MINUTE },
  demo: { limit: 120, windowMs: MINUTE },
};
// Every write the proxy forwards to Opengeni: messages, draft saves, controls.
const SESSION_WRITES: TieredRateBounds = {
  visitor: { limit: 60, windowMs: MINUTE },
  client: { limit: 120, windowMs: MINUTE },
  demo: { limit: 600, windowMs: MINUTE },
};
// Messages that start or redirect agent work (send, steer, draft submit, and
// approval or human-input answers). Each one is a durable turn in production.
const SESSION_MESSAGES: TieredRateBounds = {
  visitor: { limit: 20, windowMs: 10 * MINUTE },
  client: { limit: 40, windowMs: 10 * MINUTE },
  demo: { limit: 200, windowMs: 10 * MINUTE },
};
// Reads through the proxy, which forwards them to Opengeni as the demo
// operator: the client config, workspace, and model catalog the panel loads,
// reads of the visitor's own sessions, and each event stream it opens. Reads
// of other sessions are refused without calling Opengeni and never count. A
// read needs no visitor cookie (the page's first config read sets it), and a
// cookie-less read is a new visitor every time, so the network and demo tiers
// are what bound them.
const PROXY_READS: TieredRateBounds = {
  visitor: { limit: 300, windowMs: MINUTE },
  client: { limit: 600, windowMs: MINUTE },
  demo: { limit: 3_000, windowMs: MINUTE },
};
// Open Opengeni event streams; each one holds a connection to the API.
const EVENT_STREAMS: TieredConcurrencyBounds = { visitor: 8, client: 24, demo: 200 };
// Open product update streams (/api/demo/events): one per open demo tab.
const PRODUCT_STREAMS: TieredConcurrencyBounds = { visitor: 4, client: 24, demo: 200 };
// When the Opengeni server accepts per-run usage limits, each run stops before
// its next model request once it has used $1.00 of API-equivalent model usage
// (USD micros). Visitors cannot raise it. The workspace budget is the hard cap
// either way.
const AGENT_RUN_USAGE_LIMIT_MICROS = 1_000_000;
// How long a read of that capability is reused, and how soon a failed read is retried.
const CAPABILITY_RECHECK_MS = MINUTE;
const CAPABILITY_RETRY_MS = 15_000;
// Health waits at most this long for a first capability read (informational
// only), staying well under probe timeouts.
const HEALTH_CAPABILITY_WAIT_MS = 1_500;
// Typed text only, on both the demo API and the proxy: no uploads or recordings.
const MAX_BODY_BYTES = 32 * 1024;
// Every request body this server accepts, MCP calls included, is small JSON.
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_INITIAL_MESSAGE_CHARACTERS = 4_000;
const PROXY_BASE_PATH = "/api/opengeni";

// The demo has one fixed Opengeni operator instead of a login. A real product
// resolves this from its own authenticated session on every request. Anonymous
// browsers are separated by this server (see `VisitorCookies`), not by Opengeni.
const DEMO_USER = { externalId: "maya.chen", source: "northstar-demo" } as const;
const DEMO_USER_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  // Sessions carry a per-session MCP server, which the acting user must be allowed to attach.
  "mcp_servers:attach",
] as const;
const IDEMPOTENCY_NAMESPACE = "6f0b8b2e-3d7c-4f7e-9a51-2f1c5e0d9b44";

const createDemoSessionInput = z.object({
  ticketId: z.string().trim().min(1),
  initialMessage: z.string().trim().min(1).max(MAX_INITIAL_MESSAGE_CHARACTERS).optional(),
  // One id per intentional start; retries of the same start reuse it.
  runId: z.string().uuid(),
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const initialCases: SupportCase[] = [
  {
    customer: {
      id: "cus_aster_01",
      name: "Aster Labs",
      initials: "AL",
      plan: "Scale",
      arr: 48_000,
      healthScore: 82,
      joinedAt: "2024-09-18T10:00:00.000Z",
      primaryContact: {
        name: "Nora Lind",
        role: "Operations lead",
        email: "nora@asterlabs.example",
      },
      recentUsage: {
        activeSeats: 37,
        totalSeats: 45,
        exportsLast30Days: 186,
        failedExportsLast7Days: 14,
      },
    },
    ticket: {
      id: "TKT-2847",
      customerId: "cus_aster_01",
      subject: "Monthly export stalls at 87%",
      body: "Hi team — our monthly finance export has stopped at exactly 87% three times today. We need the report for tomorrow's board meeting. Can someone take a look?",
      status: "open",
      priority: "normal",
      assignee: "Maya Chen",
      channel: "email",
      createdAt: minutesAgo(12),
      slaDueAt: minutesFromNow(108),
      tags: ["exports", "finance"],
      inbox: "mine",
      unread: true,
      notes: [
        {
          id: "note_seed_aster",
          author: "Maya Chen",
          authorKind: "human",
          body: "No platform incident showing. Customer has retried from two browsers.",
          createdAt: minutesAgo(8),
        },
      ],
      replies: [],
      activity: [
        {
          id: "activity_seed_aster",
          actor: "Nora Lind",
          summary: "Created the ticket by email",
          createdAt: minutesAgo(12),
        },
      ],
    },
  },
  {
    customer: {
      id: "cus_pine_01",
      name: "Pine & Co.",
      initials: "PC",
      plan: "Growth",
      arr: 18_000,
      healthScore: 91,
      joinedAt: "2025-02-11T10:00:00.000Z",
      primaryContact: {
        name: "Elias Berg",
        role: "IT manager",
        email: "elias@pine.example",
      },
      recentUsage: {
        activeSeats: 21,
        totalSeats: 25,
        exportsLast30Days: 64,
        failedExportsLast7Days: 1,
      },
    },
    ticket: {
      id: "TKT-2841",
      customerId: "cus_pine_01",
      subject: "Invite emails are delayed",
      body: "Three new teammates have been waiting more than 20 minutes for invite emails. Resending did not help. Could you check the delivery queue?",
      status: "investigating",
      priority: "high",
      assignee: "Maya Chen",
      channel: "email",
      createdAt: minutesAgo(18),
      slaDueAt: minutesFromNow(72),
      tags: ["email", "invites"],
      inbox: "mine",
      unread: true,
      notes: [],
      replies: [],
      activity: [
        {
          id: "activity_seed_pine",
          actor: "Elias Berg",
          summary: "Created the ticket by email",
          createdAt: minutesAgo(18),
        },
      ],
    },
  },
  {
    customer: {
      id: "cus_cinder_01",
      name: "Cinder",
      initials: "CI",
      plan: "Enterprise",
      arr: 96_000,
      healthScore: 96,
      joinedAt: "2023-11-05T10:00:00.000Z",
      primaryContact: {
        name: "Sofia Reyes",
        role: "Security lead",
        email: "sofia@cinder.example",
      },
      recentUsage: {
        activeSeats: 118,
        totalSeats: 140,
        exportsLast30Days: 412,
        failedExportsLast7Days: 0,
      },
    },
    ticket: {
      id: "TKT-2839",
      customerId: "cus_cinder_01",
      subject: "Question about SSO setup",
      body: "We are ready to enforce SSO next week. Can you confirm whether existing sessions are revoked immediately when enforcement is enabled?",
      status: "open",
      priority: "normal",
      assignee: "Maya Chen",
      channel: "email",
      createdAt: minutesAgo(42),
      slaDueAt: minutesFromNow(198),
      tags: ["sso", "security"],
      inbox: "mine",
      unread: false,
      notes: [],
      replies: [],
      activity: [
        {
          id: "activity_seed_cinder",
          actor: "Sofia Reyes",
          summary: "Created the ticket by email",
          createdAt: minutesAgo(42),
        },
      ],
    },
  },
  {
    customer: {
      id: "cus_northwind_01",
      name: "Northwind",
      initials: "NW",
      plan: "Starter",
      arr: 7_200,
      healthScore: 75,
      joinedAt: "2025-08-22T10:00:00.000Z",
      primaryContact: {
        name: "Ava Cole",
        role: "Finance manager",
        email: "ava@northwind.example",
      },
      recentUsage: {
        activeSeats: 8,
        totalSeats: 10,
        exportsLast30Days: 22,
        failedExportsLast7Days: 2,
      },
    },
    ticket: {
      id: "TKT-2835",
      customerId: "cus_northwind_01",
      subject: "Update billing contact",
      body: "Please change our billing contact to finance@northwind.example before the next invoice is generated.",
      status: "open",
      priority: "low",
      assignee: "Unassigned",
      channel: "email",
      createdAt: minutesAgo(67),
      slaDueAt: minutesFromNow(413),
      tags: ["billing"],
      inbox: "unassigned",
      unread: false,
      notes: [],
      replies: [],
      activity: [
        {
          id: "activity_seed_northwind",
          actor: "Ava Cole",
          summary: "Created the ticket by email",
          createdAt: minutesAgo(67),
        },
      ],
    },
  },
];

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": PRODUCT_APP_ORIGIN,
    },
  });
}

function safeStaticPath(root: string, pathname: string): string | null {
  const candidate = resolve(root, `.${pathname}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE_CONTROL;
  if (pathname === "/" || extname(pathname) === ".html") return REVALIDATE_CACHE_CONTROL;
  return IMMUTABLE_CACHE_CONTROL;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": NOT_FOUND_CACHE_CONTROL },
  });
}

function acceptsEncoding(header: string | null, encoding: string): boolean {
  if (!header) return false;
  let wildcardAccepted = false;
  for (const entry of header.split(",")) {
    const segments = entry.trim().split(";");
    const name = segments[0]?.toLowerCase();
    const quality = segments
      .slice(1)
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    const accepted = quality ? Number(quality.slice(2)) > 0 : true;
    if (name === encoding.toLowerCase()) return accepted;
    if (name === "*") wildcardAccepted = accepted;
  }
  return wildcardAccepted;
}

async function resolvedRegularFile(root: string, path: string): Promise<string | null> {
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) return null;
    return (await stat(realPath)).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

async function serveStaticFile(
  request: Request,
  root: string,
  path: string,
  cacheControl: string,
): Promise<Response | null> {
  const sourcePath = await resolvedRegularFile(root, path);
  if (!sourcePath) return null;
  const source = Bun.file(sourcePath);
  const gzipPath = `${path}.gz`;
  const acceptsGzip =
    !request.headers.has("range") &&
    acceptsEncoding(request.headers.get("accept-encoding"), "gzip");
  const encodedPath = acceptsGzip ? await resolvedRegularFile(root, gzipPath) : null;
  const encoded = encodedPath ? Bun.file(encodedPath) : null;
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

export async function staticResponse(
  request: Request,
  pathname: string,
  root = STATIC_ROOT,
): Promise<Response> {
  let requested = pathname;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }
  if (requested.split("/").includes("..")) {
    return notFound();
  }
  requested = requested === "/" ? "/index.html" : requested;
  const filePath = safeStaticPath(root, requested);
  if (!filePath) {
    return notFound();
  }
  const exact = await serveStaticFile(request, root, filePath, cacheControlFor(requested));
  if (exact) return exact;
  if (requested.startsWith("/assets/")) {
    return notFound();
  }
  const indexPath = safeStaticPath(root, "/index.html");
  if (!indexPath) return notFound();
  return (await serveStaticFile(request, root, indexPath, REVALIDATE_CACHE_CONTROL)) ?? notFound();
}

type JsonObject = Record<string, unknown>;

/**
 * The request body, read up to `maxBytes`: empty when there is none, and null
 * when it is larger (by its declared length or as it streams in).
 */
async function readBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The request's JSON object body, read up to MAX_BODY_BYTES: `{}` when it is
 * missing or not a JSON object, and null when it is too large.
 */
async function readJsonBody(request: Request): Promise<JsonObject | null> {
  const bytes = await readBodyBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

/** The `/mcp` endpoint for a configured public origin or full `/mcp` URL, or null when it is not a URL. */
export function publicMcpEndpoint(configured: string): string | null {
  try {
    const endpoint = new URL(configured);
    const path = endpoint.pathname.replace(/\/+$/, "");
    endpoint.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
    return endpoint.toString();
  } catch {
    return null;
  }
}

async function resolvePublicMcpUrl(): Promise<string | null> {
  const configured = process.env.OPENGENI_DEMO_MCP_URL?.trim();
  if (configured) return publicMcpEndpoint(configured);
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      tunnels?: Array<{
        public_url?: string;
        proto?: string;
        config?: { addr?: string };
      }>;
    };
    const tunnel = payload.tunnels?.find(
      (candidate) =>
        candidate.proto === "https" && candidate.config?.addr?.includes(String(MCP_PORT)),
    );
    return tunnel?.public_url ? `${tunnel.public_url.replace(/\/+$/, "")}/mcp` : null;
  } catch {
    return null;
  }
}

export type DemoServerConfig = {
  apiBaseUrl: string;
  /** Organization API key; it never leaves this server. */
  apiKey: string;
  workspaceId: string;
  /** Shared only by Opengeni's encrypted per-session MCP credentials and this server. */
  mcpToken: string;
  /** The public HTTPS `/mcp` endpoint Opengeni calls, or null when none is reachable. */
  resolveMcpUrl: () => Promise<string | null>;
  /** Serve the built UI from `dist` (the single-origin production container). */
  serveStatic: boolean;
  /** Public product origin; an https origin gets Secure visitor cookies. */
  appOrigin?: string | undefined;
  /**
   * The request header a trusted reverse proxy sets to the client address
   * (for example `x-real-ip`), which keys the per-network limits. Unset, or
   * missing on a request, they key on the socket peer. Name only a header the
   * proxy itself overwrites: one a client can send would let it pick a fresh
   * network on every request.
   */
  clientIpHeader?: string | null | undefined;
  /** Test seam: the fetch the server-side Opengeni client uses. */
  fetch?: OpenGeniClientOptions["fetch"];
  /** Test seam: the clock the rate limits and capability checks use. */
  now?: () => number;
};

export type DemoServer = {
  /** The product backend. `peer` is the socket address, used when no proxy header names the client. */
  product: (request: Request, peer?: string | null) => Promise<Response>;
  /** The `/mcp` endpoint Opengeni calls for the product tools: bearer token plus visitor binding. */
  mcp: (request: Request) => Promise<Response>;
};

/** Who is calling: the browser's visitor id, whether it already had a valid cookie, and its network. */
type Caller = { visitorId: string; established: boolean; clientAddress: string | null };

/**
 * What a proxied path addresses, decoded the way the session proxy decodes it,
 * or null for a path the proxy refuses outright.
 */
type ProxiedRoute = { sessionId: string | null; stream: "workspace" | "session" | null };

function proxiedRoute(pathname: string): ProxiedRoute | null {
  const raw = pathname.slice(PROXY_BASE_PATH.length).replace(/\/+$/, "").split("/").slice(1);
  if (raw[0] !== "v1") return null;
  const segments: string[] = [];
  for (const part of raw.slice(1)) {
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  // workspaces/:workspaceId/(sessions/:sessionId/...|live-events/stream)
  const [root, , area, sessionId, ...op] = segments;
  if (root !== "workspaces") return { sessionId: null, stream: null };
  if (area === "live-events") {
    return {
      sessionId: null,
      stream: sessionId === "stream" && op.length === 0 ? "workspace" : null,
    };
  }
  if (area !== "sessions" || !sessionId) return { sessionId: null, stream: null };
  const stream = op.length === 2 && op[0] === "events" && op[1] === "stream" ? "session" : null;
  return { sessionId, stream };
}

/**
 * The product backend (the demo's own API plus the packaged Opengeni session
 * proxy) and its MCP tools. Each browser is an anonymous visitor that can reach
 * only the agent sessions it started and only its own copy of the product data.
 */
export function createDemoServer(config: DemoServerConfig): DemoServer {
  const { workspaceId, mcpToken } = config;
  const configured = Boolean(config.apiKey && workspaceId);
  const now = config.now ?? Date.now;
  const clientIpHeader = config.clientIpHeader?.trim() || null;
  const openGeni = new OpenGeniClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const visitors = new VisitorCookies(config.appOrigin ?? PRODUCT_APP_ORIGIN);
  const owners = new SessionOwners();
  const states = new VisitorProductStates(initialCases);
  // The caller of each request, for the proxy hooks (which receive the same Request).
  const callers = new WeakMap<Request, Caller>();
  const limit = (bounds: TieredRateBounds, action: string) =>
    new TieredRateLimit(bounds, action, config.now);
  const agentRuns = limit(AGENT_RUNS, "agent runs");
  const resets = limit(RESETS, "resets");
  const productWrites = limit(PRODUCT_WRITES, "ticket changes");
  const sessionWrites = limit(SESSION_WRITES, "agent session changes");
  const sessionMessages = limit(SESSION_MESSAGES, "agent messages");
  const proxyReads = limit(PROXY_READS, "agent panel reads");
  const eventStreams = new TieredConcurrencyLimit(EVENT_STREAMS, "agent event streams");
  const productStreams = new TieredConcurrencyLimit(PRODUCT_STREAMS, "product update streams");

  /** The network a request comes from: the trusted proxy's header when set, else the socket peer. */
  function clientNetwork(request: Request, peer: string | null | undefined): string | null {
    const forwarded = clientIpHeader
      ? forwardedClientAddress(request.headers.get(clientIpHeader))
      : null;
    const address = forwarded ?? peer?.trim() ?? "";
    return address ? networkKey(address) : null;
  }

  // Explicit onboarding: the proxy and asUser never grant membership. A stable
  // operation id makes the grant an exact replay on every server start.
  let demoMembership: Promise<void> | null = null;
  function ensureDemoMembership(): Promise<void> {
    demoMembership ??= (async () => {
      try {
        await openGeni.addExternalWorkspaceMember(workspaceId, {
          identity: { externalId: DEMO_USER.externalId, source: DEMO_USER.source },
          permissions: [...DEMO_USER_PERMISSIONS],
          operationId: await uuidV5(
            `membership:${workspaceId}:${DEMO_USER.externalId}:${DEMO_USER_PERMISSIONS.join(",")}`,
            IDEMPOTENCY_NAMESPACE,
          ),
        });
      } catch (error) {
        // Onboarding never overwrites an existing membership (for example one
        // granted with an older permission set). Keep it: every asUser request
        // still checks the live grant.
        if (
          !(error instanceof OpenGeniApiError) ||
          error.status !== 409 ||
          error.code !== "conflict" ||
          error.outcomeUnknown
        ) {
          throw error;
        }
      }
    })().catch((error: unknown) => {
      demoMembership = null;
      throw error;
    });
    return demoMembership;
  }

  // Whether the Opengeni server accepts per-run usage limits
  // (OPENGENI_SESSION_USAGE_LIMITS_ENABLED, reported by GET /v1/config/client).
  // Runs carry the limit only when it does; otherwise they start without one,
  // and the workspace budget remains the hard spend cap. A read is reused for
  // CAPABILITY_RECHECK_MS and a failed one (null) retried after
  // CAPABILITY_RETRY_MS, so neither the demo's readiness nor its runs depend on it.
  let usageLimits: { enabled: boolean | null; checkedAt: number } | null = null;
  let usageLimitsCheck: Promise<boolean | null> | null = null;
  function usageLimitsFresh(): boolean {
    if (!usageLimits) return false;
    const reuseMs = usageLimits.enabled === null ? CAPABILITY_RETRY_MS : CAPABILITY_RECHECK_MS;
    return now() - usageLimits.checkedAt < reuseMs;
  }
  function sessionUsageLimitsEnabled(): Promise<boolean | null> {
    if (!configured) return Promise.resolve(null);
    if (usageLimits && usageLimitsFresh()) return Promise.resolve(usageLimits.enabled);
    usageLimitsCheck ??= openGeni
      .getClientConfig()
      .then(
        (clientConfig) => clientConfig.sessionUsageLimits?.enabled === true,
        () => null,
      )
      .then((enabled) => {
        usageLimits = { enabled, checkedAt: now() };
        return enabled;
      })
      .finally(() => {
        usageLimitsCheck = null;
      });
    return usageLimitsCheck;
  }
  /** Informational for health: the last read while rechecking, and a short wait for the first. */
  async function usageLimitsForHealth(): Promise<boolean | null> {
    if (usageLimits && !usageLimitsFresh()) {
      const last = usageLimits.enabled;
      void sessionUsageLimitsEnabled();
      return last;
    }
    return await within(sessionUsageLimitsEnabled(), HEALTH_CAPABILITY_WAIT_MS, null);
  }

  // The browser's only Opengeni route: the packaged session proxy. It acts as
  // the demo operator through asUser, pins the configured workspace, and serves
  // only the conversation routes this panel uses.
  const openGeniProxy = createSessionProxyHandler(openGeni, {
    basePath: PROXY_BASE_PATH,
    resolve: async () => {
      if (!configured) {
        return json({ error: "Opengeni credentials are not configured." }, 503);
      }
      await ensureDemoMembership();
      return {
        workspaceId,
        user: DEMO_USER.externalId,
        source: DEMO_USER.source,
        // Every browser is anonymous: uploads stay off even if `files` is re-enabled.
        visitor: true,
      };
    },
    // Visitors are cookie-authenticated, so mutations must be same-origin and
    // come from an established visitor.
    authorizeMutation: (request) => sameOriginRequest(request) && visitors.read(request) !== null,
    // The isolation boundary. The proxy calls this before every session-scoped
    // route (read, events and stream, send, steer, queue, composer draft,
    // control, goal, human input, artifacts, realtime). A browser reaches only
    // the sessions it started through /api/demo/sessions; unknown ids are denied.
    authorizeSession: (sessionId, { request }) => owners.owns(sessionId, visitors.read(request)),
    // Runs after `authorizeSession`, before every forwarded message, approval
    // decision, and human-input answer: these start or redirect agent work.
    beforeForwardMessage: (_input, { request }) => {
      const caller = callers.get(request);
      if (!caller?.established) return proxyError(403, "mutation_denied", "Request denied.");
      const refusal = sessionMessages.consume(caller.visitorId, caller.clientAddress);
      return refusal ? tooManyProxyRequests(refusal) : undefined;
    },
    // Browser-initiated creation stays off (no `createSession` hook), and so
    // does every surface this panel does not use.
    sessionList: false,
    archive: false,
    modelSelection: false,
    files: false,
    voiceInput: false,
    realtimeVoice: false,
    sandboxFiles: false,
    artifacts: false,
    sites: false,
    maxBodyBytes: MAX_BODY_BYTES,
  });

  async function health(): Promise<DemoHealth> {
    const [mcpPublicUrl, usageLimitsEnabled] = await Promise.all([
      config.resolveMcpUrl(),
      usageLimitsForHealth(),
    ]);
    return {
      // Ready to start runs. Per-run usage limits are optional, so they never
      // make the demo unready; `sessionUsageLimitsEnabled` only reports them.
      ok: Boolean(configured && mcpToken && mcpPublicUrl),
      workspaceId: workspaceId || null,
      openGeniConfigured: configured,
      mcpTokenConfigured: Boolean(mcpToken),
      mcpPublicUrl,
      sessionUsageLimitsEnabled: usageLimitsEnabled,
    };
  }

  async function createAgentSession(request: Request, caller: Caller): Promise<Response> {
    if (!configured || !mcpToken) {
      return json({ error: "Demo server credentials are not configured." }, 503);
    }
    // Validate everything first: only a start that will reach Opengeni counts
    // against the run limits.
    const body = await readJsonBody(request);
    if (body === null) return json({ error: "Request body is too large." }, 413);
    const parsedInput = createDemoSessionInput.safeParse(body);
    if (!parsedInput.success) {
      return json({ error: "Invalid agent start request." }, 400);
    }
    const { ticketId, initialMessage: requestedMessage, runId } = parsedInput.data;
    const supportCase = findCase(states.read(caller.visitorId), ticketId);
    if (!supportCase) {
      return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
    }
    const mcpUrl = await config.resolveMcpUrl();
    if (!mcpUrl) {
      return json(
        {
          error: "No public HTTPS MCP endpoint is configured or detected.",
        },
        503,
      );
    }
    const refusal = agentRuns.consume(caller.visitorId, caller.clientAddress);
    if (refusal) return tooManyRequests(refusal);
    const { ticket, customer } = supportCase;
    const initialMessage = requestedMessage
      ? requestedMessage
      : `Investigate ${ticket.id}. Use the available support tools, explain the evidence, and take the appropriate actions.`;

    const mcpServer = {
      id: MCP_SERVER_ID,
      name: "Northstar Support",
      url: mcpUrl,
      allowedTools: MCP_TOOLS,
      cacheToolsList: false,
      timeoutMs: 60_000,
      requireApproval: [],
      // The visitor binding makes the tools read and change only this
      // visitor's product data. Opengeni stores these headers encrypted and
      // never returns their values, and the proxy refuses browser credential
      // rotations, so neither the browser nor the model can change it.
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        [MCP_VISITOR_HEADER]: visitors.mcpBinding(caller.visitorId),
      },
    };
    const sessionRequest: CreateSessionRequest = {
      initialMessage,
      instructions: `You are the embedded support copilot inside Northstar, a fictional SaaS product. You are working only on ticket ${ticket.id} for ${customer.name}. Always inspect the ticket and customer with Northstar Support tools before drawing conclusions. When evidence warrants action, call update_ticket and add_internal_note immediately. Product actions are pre-approved for this demo, so execute them without asking for confirmation. Never invent customer data. Keep the final answer brief and operational.`,
      tools: [{ kind: "mcp", id: MCP_SERVER_ID }],
      mcpServers: [mcpServer] as CreateSessionRequest["mcpServers"],
      // Explicit selections: only the Northstar MCP server, no first-party tools.
      // A per-session MCP server must also be selected in `tools` to be usable.
      firstPartyMcpTools: [],
      // Only the session's own tools plus asking the user for input: no web
      // search or fetch, media generation, secrets, subagents, Knowledge,
      // schedules, or workspace tools, and no Skills to read, save, install,
      // or remove (anonymous visitors must not change what others' agents see).
      agent: { capabilities: { from: "none", skills: false } },
      bundledSkillIds: [],
      // A pure tool agent: no sandbox to start, and no shell around the product tools.
      sandboxBackend: "none",
      // The narrowest session: private to the demo operator, agent reach limited
      // to its own session tree, and no Knowledge shared between visitors.
      visibility: "private",
      agentAccess: "session",
      memoryScope: "off",
      metadata: { demo: "northstar-support", ticketId: ticket.id },
      // Stable per visitor and start: a retried request returns the same
      // session, and no other visitor can replay into it.
      idempotencyKey: `northstar:${ticket.id}:${await uuidV5(
        `${caller.visitorId}:${runId}`,
        IDEMPOTENCY_NAMESPACE,
      )}`,
    };
    // The workspace's default model applies; the browser cannot choose one.
    await ensureDemoMembership();
    const operator = openGeni.asUser(DEMO_USER.externalId, { source: DEMO_USER.source });
    let session: Awaited<ReturnType<OpenGeniClient["createSession"]>> | undefined;
    // A per-run usage limit only where the server accepts one: Opengeni refuses
    // a limit with 422 while OPENGENI_SESSION_USAGE_LIMITS_ENABLED is off.
    if ((await sessionUsageLimitsEnabled()) === true) {
      try {
        session = await operator.createSession(workspaceId, {
          ...sessionRequest,
          usageLimitMicros: AGENT_RUN_USAGE_LIMIT_MICROS,
        });
      } catch (error) {
        if (!usageLimitsDisabled(error)) throw error;
        // Turned off since the last read. Opengeni refuses before it creates
        // or replays anything, so the same start continues without a limit.
        usageLimits = { enabled: false, checkedAt: now() };
      }
    }
    session ??= await operator.createSession(workspaceId, sessionRequest);
    if (!owners.claim(session.id, caller.visitorId)) {
      return json({ error: "This agent run belongs to another visitor." }, 409);
    }
    return json(session, 201);
  }

  async function forwardToOpenGeni(request: Request): Promise<Response> {
    try {
      return await openGeniProxy(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }

  async function proxyRequest(request: Request, url: URL, caller: Caller): Promise<Response> {
    const route = proxiedRoute(url.pathname);
    const sessionId = route?.sessionId ?? null;
    const owned =
      caller.established && sessionId !== null && owners.owns(sessionId, caller.visitorId);
    if (request.method !== "GET") {
      // A browser changes only the sessions it started: workspace-level writes
      // stop here, the proxy refuses other sessions without calling Opengeni,
      // and every write it forwards counts.
      if (sessionId === null) return proxyError(404, "route_not_allowed", "Not found.");
      if (owned && sameOriginRequest(request)) {
        const refusal = sessionWrites.consume(caller.visitorId, caller.clientAddress);
        if (refusal) return tooManyProxyRequests(refusal);
      }
      return await forwardToOpenGeni(request);
    }
    if (sessionId !== null && !owned) {
      // The proxy refuses a session this visitor did not start without
      // calling Opengeni, so these reads never count.
      return await forwardToOpenGeni(request);
    }
    if (route?.stream === "workspace" && !caller.established) {
      // The refusal sets the visitor cookie, so the stream's own retry succeeds.
      return proxyError(403, "visitor_required", "Load the demo page first.", true);
    }
    if (route?.stream) {
      // Each open stream holds one connection to Opengeni, and opening one is a read.
      const slot = eventStreams.acquire(caller.visitorId, caller.clientAddress);
      if ("refused" in slot) {
        const response = proxyError(429, "rate_limited", `${slot.refused}.`, true);
        response.headers.set("retry-after", "5");
        return response;
      }
      const refusal = proxyReads.consume(caller.visitorId, caller.clientAddress);
      if (refusal) {
        slot.release();
        return tooManyProxyRequests(refusal);
      }
      return releaseWhenClosed(await forwardToOpenGeni(request), slot.release, request.signal);
    }
    const refusal = proxyReads.consume(caller.visitorId, caller.clientAddress);
    if (refusal) return tooManyProxyRequests(refusal);
    return await forwardToOpenGeni(request);
  }

  /** Product update events for this visitor only, while the page is open. */
  function productEventStream(request: Request, caller: Caller): Response {
    // Updates reach only the visitor they belong to, so the stream needs the
    // cookie the page's first state read set; the page opens it after that read.
    if (!caller.established) {
      return json({ error: "Reload the page to receive product updates." }, 403);
    }
    const slot = productStreams.acquire(caller.visitorId, caller.clientAddress);
    if ("refused" in slot) {
      const response = json({ error: `${slot.refused}. Close a tab and try again.` }, 429);
      response.headers.set("retry-after", "5");
      return response;
    }
    const { visitorId } = caller;
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      unsubscribe();
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = states.subscribe(visitorId, controller);
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({ revision: states.read(visitorId).revision })}\n\n`,
          ),
        );
        keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            stop();
          }
        }, 15_000);
      },
      cancel: stop,
    });
    request.signal.addEventListener("abort", stop, { once: true });
    const response = new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": PRODUCT_APP_ORIGIN,
      },
    });
    return releaseWhenClosed(response, slot.release, request.signal);
  }

  /**
   * Changes to the visitor's own copy of the product data. `admitWrite` runs
   * after a write is validated and before it changes anything; a Response
   * refuses the write.
   */
  async function productWrite(
    request: Request,
    url: URL,
    visitorId: string,
    admitWrite: () => Response | null,
  ): Promise<Response> {
    if (url.pathname === "/api/demo/ticket" && request.method === "PATCH") {
      const input = await readJsonBody(request);
      if (input === null) return json({ error: "Request body is too large." }, 413);
      const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
      const current = findCase(states.read(visitorId), ticketId);
      if (!current) return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
      const priority = PRIORITIES.find(
        (value) => value === input.priority && value !== current.ticket.priority,
      );
      const status = STATUSES.find(
        (value) => value === input.status && value !== current.ticket.status,
      );
      const refused = admitWrite();
      if (refused) return refused;
      if (!priority && !status) return json(states.read(visitorId));
      const state = states.writable(visitorId);
      const { ticket } = findCase(state, ticketId)!;
      const changes: string[] = [];
      if (priority) {
        changes.push(`priority to ${priority}`);
        ticket.priority = priority;
      }
      if (status) {
        changes.push(`status to ${status.replaceAll("_", " ")}`);
        ticket.status = status;
      }
      const summary = `Maya changed ${changes.join(" and ")}`;
      addActivity(ticket, "Maya Chen", summary);
      states.emit(visitorId, state, "ticket.updated", summary, ticket.id);
      return json(state);
    }
    if (url.pathname === "/api/demo/notes" && request.method === "POST") {
      const input = await readJsonBody(request);
      if (input === null) return json({ error: "Request body is too large." }, 413);
      const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
      if (!findCase(states.read(visitorId), ticketId)) {
        return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
      }
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (body.length < 2 || body.length > 1_000) {
        return json({ error: "Internal note must be between 2 and 1,000 characters." }, 422);
      }
      const refused = admitWrite();
      if (refused) return refused;
      const state = states.writable(visitorId);
      const { ticket } = findCase(state, ticketId)!;
      addNote(ticket, {
        id: crypto.randomUUID(),
        author: "Maya Chen",
        authorKind: "human",
        body,
        createdAt: new Date().toISOString(),
      });
      addActivity(ticket, "Maya Chen", "Added an internal note");
      states.emit(visitorId, state, "ticket.note_added", "Maya added an internal note", ticket.id);
      return json(state);
    }
    if (url.pathname === "/api/demo/replies" && request.method === "POST") {
      const input = await readJsonBody(request);
      if (input === null) return json({ error: "Request body is too large." }, 413);
      const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
      if (!findCase(states.read(visitorId), ticketId)) {
        return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
      }
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (body.length < 2 || body.length > 2_000) {
        return json({ error: "Reply must be between 2 and 2,000 characters." }, 422);
      }
      const refused = admitWrite();
      if (refused) return refused;
      const state = states.writable(visitorId);
      const { ticket, customer } = findCase(state, ticketId)!;
      addReply(ticket, {
        id: crypto.randomUUID(),
        author: "Maya Chen",
        body,
        createdAt: new Date().toISOString(),
      });
      ticket.status = "waiting_on_customer";
      ticket.unread = false;
      addActivity(
        ticket,
        "Maya Chen",
        `Replied to ${customer.primaryContact.name} and set the ticket to waiting on customer`,
      );
      states.emit(
        visitorId,
        state,
        "ticket.replied",
        `Reply sent to ${customer.primaryContact.name}`,
        ticket.id,
      );
      return json(state);
    }
    return new Response("Not found", { status: 404 });
  }

  async function apiRequest(request: Request, url: URL, caller: Caller): Promise<Response> {
    if (url.pathname.startsWith(`${PROXY_BASE_PATH}/`)) {
      return await proxyRequest(request, url, caller);
    }
    if (request.method === "GET") {
      // Always 200 once the server answers; `ok` says whether runs can start.
      if (url.pathname === "/api/demo/health") return json(await health());
      // The visitor's own copy of the fictional product's data.
      if (url.pathname === "/api/demo/state") return json(states.read(caller.visitorId));
      if (url.pathname === "/api/demo/events") return productEventStream(request, caller);
      return new Response("Not found", { status: 404 });
    }
    if (!sameOriginRequest(request)) {
      return json({ error: "Cross-site requests are not allowed." }, 403);
    }
    // Every write comes from a browser that already holds a visitor cookie, so
    // dropping the cookie never buys a fresh per-visitor allowance.
    if (!caller.established) {
      return json({ error: "Reload the page and try again." }, 403);
    }
    if (url.pathname === "/api/demo/sessions" && request.method === "POST") {
      try {
        return await createAgentSession(request, caller);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    if (url.pathname === "/api/demo/reset" && request.method === "POST") {
      const refusal = resets.consume(caller.visitorId, caller.clientAddress);
      if (refusal) return tooManyRequests(refusal);
      // Only this visitor starts over.
      const state = states.reset(caller.visitorId);
      states.emit(caller.visitorId, state, "demo.reset", "Demo data reset", "all");
      return json(state);
    }
    return await productWrite(request, url, caller.visitorId, () => {
      const refusal = productWrites.consume(caller.visitorId, caller.clientAddress);
      return refusal ? tooManyRequests(refusal) : null;
    });
  }

  async function product(request: Request, peer?: string | null): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": PRODUCT_APP_ORIGIN,
          "access-control-allow-methods": "GET, HEAD, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (!url.pathname.startsWith("/api/")) {
      if (config.serveStatic && (request.method === "GET" || request.method === "HEAD")) {
        return await staticResponse(request, url.pathname);
      }
      return new Response("Not found", { status: 404 });
    }
    // API responses carry the visitor cookie until the browser has one. A
    // request without a valid cookie is a new visitor that owns no sessions.
    const known = visitors.read(request);
    const issued = known === null ? visitors.issue(request) : null;
    const caller: Caller = {
      visitorId: known ?? issued!.id,
      established: known !== null,
      clientAddress: clientNetwork(request, peer),
    };
    callers.set(request, caller);
    const response = await apiRequest(request, url, caller);
    return issued ? withSetCookie(response, issued.setCookie) : response;
  }

  async function mcp(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!sameSecret(request.headers.get("authorization"), mcpToken ? `Bearer ${mcpToken}` : "")) {
      return json({ error: "unauthorized" }, 401);
    }
    // The binding this server set on the session when it was created selects
    // whose product data the tools use. Sessions from before a restart carry
    // a binding the new process cannot verify, like their visitor cookies.
    const visitorId = visitors.readMcpBinding(request.headers.get(MCP_VISITOR_HEADER));
    if (visitorId === null) return json({ error: "unknown visitor" }, 403);
    // Tool calls are small JSON. The body is read here, under the cap, before
    // the MCP transport parses it.
    let call = request;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const body = await readBodyBytes(request, MAX_REQUEST_BODY_BYTES);
      if (body === null) return json({ error: "Request body is too large." }, 413);
      call = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = buildMcpServer(states, visitorId);
    await server.connect(transport);
    return await transport.handleRequest(call);
  }

  return { product, mcp };
}

function usageLimitsDisabled(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 422 &&
    error.details?.code === "session_usage_limit_disabled"
  );
}

/** `promise`'s value, or `fallback` when it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((settle) => {
        timer = setTimeout(() => settle(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function tooManyRequests({ limiter, retryAfterSeconds }: RateLimitRefusal): Response {
  const response = json(
    { error: `${limiter.message}. Try again in ${wait(retryAfterSeconds)}.` },
    429,
  );
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}

function wait(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

/** A refusal on a proxy route, in the error envelope the Opengeni SDK reads. */
function proxyError(status: number, code: string, message: string, retryable = false): Response {
  return json({ error: { code, message, retryable } }, status);
}

function tooManyProxyRequests({ limiter, retryAfterSeconds }: RateLimitRefusal): Response {
  const response = proxyError(
    429,
    "rate_limited",
    `${limiter.message}. Try again in ${wait(retryAfterSeconds)}.`,
    true,
  );
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}

/** Call `release` once the event stream ends, fails, or the browser goes away. */
function releaseWhenClosed(response: Response, release: () => void, signal: AbortSignal): Response {
  const source = response.body;
  if (!source || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    release();
    return response;
  }
  // `release` is idempotent, so every way the stream can end may call it.
  const finish = () => {
    signal.removeEventListener("abort", finish);
    release();
  };
  if (signal.aborted) finish();
  else signal.addEventListener("abort", finish, { once: true });
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
const STATUSES: TicketStatus[] = ["open", "investigating", "waiting_on_customer", "resolved"];

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(message: string) {
  return { ...toolResult({ error: message }), isError: true };
}

/** The product tools, reading and changing only `visitorId`'s copy of the data. */
function buildMcpServer(states: VisitorProductStates, visitorId: string): McpServer {
  const server = new McpServer({ name: "northstar-support", version: "1.0.0" });
  server.registerTool(
    "get_ticket",
    {
      description:
        "Get the complete support ticket, including priority, status, SLA, customer message, internal notes, and activity.",
      inputSchema: {
        ticketId: z.string().max(64).describe("Ticket id from the active Northstar session"),
      },
    },
    async ({ ticketId }) => {
      const supportCase = findCase(states.read(visitorId), ticketId);
      return supportCase
        ? toolResult(supportCase.ticket)
        : toolError(`Ticket ${ticketId} not found`);
    },
  );
  server.registerTool(
    "get_customer",
    {
      description:
        "Get the customer account behind the ticket, including plan, ARR, health, contact, seats, and recent export reliability.",
      inputSchema: {
        customerId: z.string().max(64).describe("Customer id from the ticket"),
      },
    },
    async ({ customerId }) => {
      const customer =
        states.read(visitorId).cases.find((supportCase) => supportCase.customer.id === customerId)
          ?.customer ?? null;
      return customer ? toolResult(customer) : toolError(`Customer ${customerId} not found`);
    },
  );
  server.registerTool(
    "update_ticket",
    {
      description:
        "Update support ticket priority, status, or assignee. Include a short evidence-based reason. This changes product data immediately.",
      inputSchema: {
        ticketId: z.string().max(64),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        status: z.enum(["open", "investigating", "waiting_on_customer", "resolved"]).optional(),
        assignee: z.string().min(1).max(80).optional(),
        reason: z.string().min(5).max(500),
      },
    },
    async ({ ticketId, priority, status, assignee, reason }) => {
      const current = findCase(states.read(visitorId), ticketId);
      if (!current) return toolError(`Ticket ${ticketId} not found`);
      const changed =
        (priority !== undefined && priority !== current.ticket.priority) ||
        (status !== undefined && status !== current.ticket.status) ||
        (assignee !== undefined && assignee !== current.ticket.assignee);
      if (!changed) {
        return toolResult({
          ok: true,
          summary: "Reviewed ticket; no field changes",
          ticket: current.ticket,
        });
      }
      const state = states.writable(visitorId);
      const { ticket } = findCase(state, ticketId)!;
      const changes: string[] = [];
      if (priority && priority !== ticket.priority) {
        changes.push(`priority ${ticket.priority} → ${priority}`);
        ticket.priority = priority as TicketPriority;
      }
      if (status && status !== ticket.status) {
        changes.push(`status ${ticket.status} → ${status}`);
        ticket.status = status as TicketStatus;
      }
      if (assignee && assignee !== ticket.assignee) {
        changes.push(`assignee ${ticket.assignee} → ${assignee}`);
        ticket.assignee = assignee;
      }
      const summary = `Updated ${changes.join(", ")}`;
      addActivity(ticket, "Opengeni agent", `${summary}. Reason: ${reason}`);
      states.emit(visitorId, state, "ticket.updated", summary, ticket.id);
      return toolResult({ ok: true, summary, ticket });
    },
  );
  server.registerTool(
    "add_internal_note",
    {
      description:
        "Add a concise internal note to the ticket. Use this to preserve investigation evidence and the recommended next step.",
      inputSchema: {
        ticketId: z.string().max(64),
        body: z.string().min(10).max(1_000),
      },
    },
    async ({ ticketId, body }) => {
      const current = findCase(states.read(visitorId), ticketId);
      if (!current) return toolError(`Ticket ${ticketId} not found`);
      const existing = current.ticket.notes.find(
        (note) => note.authorKind === "agent" && note.body === body,
      );
      if (existing) {
        return toolResult({ ok: true, duplicate: true, note: existing });
      }
      const state = states.writable(visitorId);
      const { ticket } = findCase(state, ticketId)!;
      const note = {
        id: crypto.randomUUID(),
        author: "Opengeni agent",
        authorKind: "agent" as const,
        body,
        createdAt: new Date().toISOString(),
      };
      addNote(ticket, note);
      addActivity(ticket, "Opengeni agent", "Added an internal investigation note");
      states.emit(visitorId, state, "ticket.note_added", "Agent added an internal note", ticket.id);
      return toolResult({ ok: true, note });
    },
  );
  return server;
}

if (import.meta.main) {
  // Behind a reverse proxy, every request comes from the proxy's own address.
  // Name the header it overwrites with the client address (X-Real-IP for
  // ingress-nginx), or every visitor shares one per-network limit.
  const clientIpHeader = process.env.OPENGENI_DEMO_CLIENT_IP_HEADER?.trim() || null;
  // One server per process: its visitor cookie key, session ownership, and
  // product data live in memory.
  const demo = createDemoServer({
    ...env,
    resolveMcpUrl: resolvePublicMcpUrl,
    serveStatic: UNIFIED_SERVER,
    clientIpHeader,
  });
  const productServer = Bun.serve({
    hostname: UNIFIED_SERVER ? "0.0.0.0" : "127.0.0.1",
    port: PRODUCT_PORT,
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: async (request, server) => {
      if (UNIFIED_SERVER && new URL(request.url).pathname === "/mcp") {
        return await demo.mcp(request);
      }
      return await demo.product(request, server.requestIP(request)?.address);
    },
  });
  const mcpServer = UNIFIED_SERVER
    ? productServer
    : Bun.serve({
        hostname: "127.0.0.1",
        port: MCP_PORT,
        idleTimeout: 255,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        fetch: demo.mcp,
      });

  console.log(`Northstar product API  http://127.0.0.1:${productServer.port}/api/demo/health`);
  console.log(`Northstar MCP server   http://127.0.0.1:${mcpServer.port}/mcp`);
  console.log("MCP auth               ", env.mcpToken ? "configured" : "MISSING");
  console.log("Opengeni auth          ", env.apiKey ? "configured" : "MISSING");
  console.log("Opengeni workspace     ", env.workspaceId || "MISSING");
  console.log("Client address         ", clientIpHeader ?? "socket peer address");
}
