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
import { RateLimiter, consumeRateLimits, type RateLimitRefusal } from "./rate-limit";
import type {
  SupportCase,
  DemoHealth,
  SupportDomainEvent,
  SupportTicket,
  SupportWorkspaceState,
  TicketPriority,
  TicketStatus,
} from "./types";
import { SessionOwners, VisitorCookies, sameOriginRequest } from "./visitors";

const PRODUCT_PORT = Number(process.env.PORT ?? 4100);
const MCP_PORT = Number(process.env.OPENGENI_DEMO_MCP_PORT ?? 4101);
const UNIFIED_SERVER = Boolean(process.env.PORT);
const PRODUCT_APP_ORIGIN = (
  process.env.OPENGENI_DEMO_APP_ORIGIN ?? "http://127.0.0.1:3101"
).replace(/\/+$/, "");
const STATIC_ROOT = join(import.meta.dir, "../dist");
const MCP_SERVER_ID = "northstar_support";
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

// Abuse bounds for an anonymous public demo: every agent run spends model
// usage. Visitors can drop their cookie, so the global limits are the real cap.
const AGENT_RUNS_PER_VISITOR = { limit: 6, windowMs: 10 * 60_000 };
const AGENT_RUNS_GLOBAL = { limit: 30, windowMs: 60 * 60_000 };
const RESETS_PER_VISITOR = { limit: 5, windowMs: 60_000 };
const RESETS_GLOBAL = { limit: 30, windowMs: 60_000 };
// Each run stops before its next model request once it has used $1.00 of
// API-equivalent model usage (USD micros). Visitors cannot raise it.
const AGENT_RUN_USAGE_LIMIT_MICROS = 1_000_000;
// Typed messages only: no uploads or recordings travel through the proxy.
const PROXY_MAX_BODY_BYTES = 32 * 1024;
const MAX_INITIAL_MESSAGE_CHARACTERS = 4_000;

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

let state: SupportWorkspaceState = freshState();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

function freshState(): SupportWorkspaceState {
  return {
    revision: 1,
    cases: structuredClone(initialCases),
  };
}

function getCase(ticketId: string): SupportCase | null {
  return state.cases.find((supportCase) => supportCase.ticket.id === ticketId) ?? null;
}

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

function emit(
  type: SupportDomainEvent["type"],
  summary: string,
  ticketId: string,
): SupportDomainEvent {
  state.revision += 1;
  const event: SupportDomainEvent = {
    id: crypto.randomUUID(),
    type,
    ticketId,
    revision: state.revision,
    summary,
    occurredAt: new Date().toISOString(),
  };
  const frame = encoder.encode(
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  for (const subscriber of subscribers) {
    try {
      subscriber.enqueue(frame);
    } catch {
      subscribers.delete(subscriber);
    }
  }
  return event;
}

function addActivity(ticket: SupportTicket, actor: string, summary: string): void {
  ticket.activity.unshift({
    id: crypto.randomUUID(),
    actor,
    summary,
    createdAt: new Date().toISOString(),
  });
}

function domainEventStream(request: Request): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      subscribers.add(next);
      next.enqueue(
        encoder.encode(
          `event: connected\ndata: ${JSON.stringify({ revision: state.revision })}\n\n`,
        ),
      );
      keepalive = setInterval(() => {
        try {
          next.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          subscribers.delete(next);
        }
      }, 15_000);
    },
    cancel() {
      if (controller) subscribers.delete(controller);
      if (keepalive) clearInterval(keepalive);
    },
  });
  request.signal.addEventListener(
    "abort",
    () => {
      if (controller) subscribers.delete(controller);
      if (keepalive) clearInterval(keepalive);
    },
    { once: true },
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": PRODUCT_APP_ORIGIN,
    },
  });
}

async function resolvePublicMcpUrl(): Promise<string | null> {
  const configured = process.env.OPENGENI_DEMO_MCP_URL?.trim();
  if (configured) {
    try {
      const endpoint = new URL(configured);
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
      if (!endpoint.pathname.endsWith("/mcp")) endpoint.pathname += "/mcp";
      return endpoint.toString();
    } catch {
      return null;
    }
  }
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

export type ProductHandlerConfig = {
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
  /** Test seam: the fetch the server-side Opengeni client uses. */
  fetch?: OpenGeniClientOptions["fetch"];
  /** Test seam: the clock the rate limits use. */
  now?: () => number;
};

/**
 * The product backend: the demo's own API plus the packaged Opengeni session
 * proxy. Each browser is an anonymous visitor that can reach only the agent
 * sessions it started.
 */
export function createProductHandler(
  config: ProductHandlerConfig,
): (request: Request) => Promise<Response> {
  const { workspaceId, mcpToken } = config;
  const configured = Boolean(config.apiKey && workspaceId);
  const openGeni = new OpenGeniClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const visitors = new VisitorCookies(config.appOrigin ?? PRODUCT_APP_ORIGIN);
  const owners = new SessionOwners();
  const limit = (bounds: { limit: number; windowMs: number }, message: string) =>
    new RateLimiter({ ...bounds, message, ...(config.now ? { now: config.now } : {}) });
  const runsPerVisitor = limit(AGENT_RUNS_PER_VISITOR, "Too many agent runs from this browser");
  const runsGlobal = limit(AGENT_RUNS_GLOBAL, "The demo has started too many agent runs recently");
  const resetsPerVisitor = limit(RESETS_PER_VISITOR, "Too many resets from this browser");
  const resetsGlobal = limit(RESETS_GLOBAL, "The demo has been reset too often recently");

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

  // The browser's only Opengeni route: the packaged session proxy. It acts as
  // the demo operator through asUser, pins the configured workspace, and serves
  // only the conversation routes this panel uses.
  const openGeniProxy = createSessionProxyHandler(openGeni, {
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
    maxBodyBytes: PROXY_MAX_BODY_BYTES,
  });

  async function health(): Promise<DemoHealth> {
    const mcpPublicUrl = await config.resolveMcpUrl();
    return {
      ok: Boolean(configured && mcpToken && mcpPublicUrl),
      workspaceId: workspaceId || null,
      openGeniConfigured: configured,
      mcpTokenConfigured: Boolean(mcpToken),
      mcpPublicUrl,
    };
  }

  async function createAgentSession(request: Request, visitorId: string): Promise<Response> {
    if (!configured || !mcpToken) {
      return json({ error: "Demo server credentials are not configured." }, 503);
    }
    const refusal = consumeRateLimits([
      [runsPerVisitor, visitorId],
      [runsGlobal, "all"],
    ]);
    if (refusal) return tooManyRequests(refusal);
    const mcpUrl = await config.resolveMcpUrl();
    if (!mcpUrl) {
      return json(
        {
          error: "No public HTTPS MCP endpoint is configured or detected.",
        },
        503,
      );
    }
    const parsedInput = createDemoSessionInput.safeParse(await request.json().catch(() => ({})));
    if (!parsedInput.success) {
      return json({ error: "Invalid agent start request." }, 400);
    }
    const { ticketId, initialMessage: requestedMessage, runId } = parsedInput.data;
    const supportCase = getCase(ticketId);
    if (!supportCase) {
      return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
    }
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
      headers: { Authorization: `Bearer ${mcpToken}` },
    };
    const sessionRequest: CreateSessionRequest = {
      initialMessage,
      instructions: `You are the embedded support copilot inside Northstar, a fictional SaaS product. You are working only on ticket ${ticket.id} for ${customer.name}. Always inspect the ticket and customer with Northstar Support tools before drawing conclusions. When evidence warrants action, call update_ticket and add_internal_note immediately. Product actions are pre-approved for this demo, so execute them without asking for confirmation. Never invent customer data. Keep the final answer brief and operational.`,
      tools: [{ kind: "mcp", id: MCP_SERVER_ID }],
      mcpServers: [mcpServer] as CreateSessionRequest["mcpServers"],
      // Explicit selections: only the Northstar MCP server, no first-party tools.
      // A per-session MCP server must also be selected in `tools` to be usable.
      firstPartyMcpTools: [],
      // A pure tool agent: no sandbox to start, and no shell around the product tools.
      sandboxBackend: "none",
      // The narrowest session: private to the demo operator, agent reach limited
      // to its own session tree, and no Knowledge shared between visitors.
      visibility: "private",
      agentAccess: "session",
      memoryScope: "off",
      usageLimitMicros: AGENT_RUN_USAGE_LIMIT_MICROS,
      metadata: { demo: "northstar-support", ticketId: ticket.id },
      // Stable per visitor and start: a retried request returns the same
      // session, and no other visitor can replay into it.
      idempotencyKey: `northstar:${ticket.id}:${await uuidV5(
        `${visitorId}:${runId}`,
        IDEMPOTENCY_NAMESPACE,
      )}`,
    };
    // The workspace's default model applies; the browser cannot choose one.
    await ensureDemoMembership();
    const session = await openGeni
      .asUser(DEMO_USER.externalId, { source: DEMO_USER.source })
      .createSession(workspaceId, sessionRequest);
    if (!owners.claim(session.id, visitorId)) {
      return json({ error: "This agent run belongs to another visitor." }, 409);
    }
    return json(session, 201);
  }

  async function apiRequest(request: Request, url: URL, visitorId: string): Promise<Response> {
    if (url.pathname.startsWith("/api/opengeni/")) {
      try {
        return await openGeniProxy(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    if (request.method !== "GET" && !sameOriginRequest(request)) {
      return json({ error: "Cross-site requests are not allowed." }, 403);
    }
    if (url.pathname === "/api/demo/health" && request.method === "GET") {
      return json(await health());
    }
    if (url.pathname === "/api/demo/sessions" && request.method === "POST") {
      try {
        return await createAgentSession(request, visitorId);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    if (url.pathname === "/api/demo/reset" && request.method === "POST") {
      const refusal = consumeRateLimits([
        [resetsPerVisitor, visitorId],
        [resetsGlobal, "all"],
      ]);
      if (refusal) return tooManyRequests(refusal);
      state = freshState();
      emit("demo.reset", "Demo data reset", "all");
      return json(state);
    }
    return await productDataRequest(request, url);
  }

  return async function productRequest(request: Request): Promise<Response> {
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
    const response = await apiRequest(request, url, known ?? issued!.id);
    return issued ? withSetCookie(response, issued.setCookie) : response;
  };
}

function tooManyRequests({ limiter, retryAfterSeconds }: RateLimitRefusal): Response {
  const wait =
    retryAfterSeconds < 90
      ? `${retryAfterSeconds} seconds`
      : `${Math.ceil(retryAfterSeconds / 60)} minutes`;
  const response = json({ error: `${limiter.message}. Try again in ${wait}.` }, 429);
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
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

/** The fictional product's own data, shared by every visitor. */
async function productDataRequest(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/demo/state" && request.method === "GET") return json(state);
  if (url.pathname === "/api/demo/events" && request.method === "GET")
    return domainEventStream(request);
  if (url.pathname === "/api/demo/ticket" && request.method === "PATCH") {
    const input = (await request.json().catch(() => ({}))) as {
      ticketId?: unknown;
      priority?: unknown;
      status?: unknown;
    };
    const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
    const supportCase = getCase(ticketId);
    if (!supportCase) return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
    const { ticket } = supportCase;
    const priorities: TicketPriority[] = ["low", "normal", "high", "urgent"];
    const statuses: TicketStatus[] = ["open", "investigating", "waiting_on_customer", "resolved"];
    const changes: string[] = [];
    if (
      typeof input.priority === "string" &&
      priorities.includes(input.priority as TicketPriority) &&
      input.priority !== ticket.priority
    ) {
      changes.push(`priority to ${input.priority}`);
      ticket.priority = input.priority as TicketPriority;
    }
    if (
      typeof input.status === "string" &&
      statuses.includes(input.status as TicketStatus) &&
      input.status !== ticket.status
    ) {
      changes.push(`status to ${input.status.replaceAll("_", " ")}`);
      ticket.status = input.status as TicketStatus;
    }
    if (changes.length > 0) {
      const summary = `Maya changed ${changes.join(" and ")}`;
      addActivity(ticket, "Maya Chen", summary);
      emit("ticket.updated", summary, ticket.id);
    }
    return json(state);
  }
  if (url.pathname === "/api/demo/notes" && request.method === "POST") {
    const input = (await request.json().catch(() => ({}))) as {
      ticketId?: unknown;
      body?: unknown;
    };
    const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
    const supportCase = getCase(ticketId);
    if (!supportCase) return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
    const { ticket } = supportCase;
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (body.length < 2 || body.length > 1_000) {
      return json({ error: "Internal note must be between 2 and 1,000 characters." }, 422);
    }
    ticket.notes.unshift({
      id: crypto.randomUUID(),
      author: "Maya Chen",
      authorKind: "human",
      body,
      createdAt: new Date().toISOString(),
    });
    addActivity(ticket, "Maya Chen", "Added an internal note");
    emit("ticket.note_added", "Maya added an internal note", ticket.id);
    return json(state);
  }
  if (url.pathname === "/api/demo/replies" && request.method === "POST") {
    const input = (await request.json().catch(() => ({}))) as {
      ticketId?: unknown;
      body?: unknown;
    };
    const ticketId = typeof input.ticketId === "string" ? input.ticketId : "";
    const supportCase = getCase(ticketId);
    if (!supportCase) return json({ error: `Ticket ${ticketId || "unknown"} not found.` }, 404);
    const { ticket, customer } = supportCase;
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (body.length < 2 || body.length > 2_000) {
      return json({ error: "Reply must be between 2 and 2,000 characters." }, 422);
    }
    ticket.replies.push({
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
    emit("ticket.replied", `Reply sent to ${customer.primaryContact.name}`, ticket.id);
    return json(state);
  }
  return new Response("Not found", { status: 404 });
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "northstar-support", version: "1.0.0" });
  server.registerTool(
    "get_ticket",
    {
      description:
        "Get the complete support ticket, including priority, status, SLA, customer message, internal notes, and activity.",
      inputSchema: {
        ticketId: z.string().describe("Ticket id from the active Northstar session"),
      },
    },
    async ({ ticketId }) => {
      const supportCase = getCase(ticketId);
      return supportCase
        ? toolResult(supportCase.ticket)
        : {
            ...toolResult({ error: `Ticket ${ticketId} not found` }),
            isError: true,
          };
    },
  );
  server.registerTool(
    "get_customer",
    {
      description:
        "Get the customer account behind the ticket, including plan, ARR, health, contact, seats, and recent export reliability.",
      inputSchema: {
        customerId: z.string().describe("Customer id from the ticket"),
      },
    },
    async ({ customerId }) => {
      const customer =
        state.cases.find((supportCase) => supportCase.customer.id === customerId)?.customer ?? null;
      return customer
        ? toolResult(customer)
        : {
            ...toolResult({ error: `Customer ${customerId} not found` }),
            isError: true,
          };
    },
  );
  server.registerTool(
    "update_ticket",
    {
      description:
        "Update support ticket priority, status, or assignee. Include a short evidence-based reason. This changes product data immediately.",
      inputSchema: {
        ticketId: z.string(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        status: z.enum(["open", "investigating", "waiting_on_customer", "resolved"]).optional(),
        assignee: z.string().min(1).optional(),
        reason: z.string().min(5),
      },
    },
    async ({ ticketId, priority, status, assignee, reason }) => {
      const supportCase = getCase(ticketId);
      if (!supportCase) {
        return {
          ...toolResult({ error: `Ticket ${ticketId} not found` }),
          isError: true,
        };
      }
      const { ticket } = supportCase;
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
      const summary = changes.length
        ? `Updated ${changes.join(", ")}`
        : "Reviewed ticket; no field changes";
      if (changes.length > 0) {
        addActivity(ticket, "Opengeni agent", `${summary}. Reason: ${reason}`);
        emit("ticket.updated", summary, ticket.id);
      }
      return toolResult({ ok: true, summary, ticket });
    },
  );
  server.registerTool(
    "add_internal_note",
    {
      description:
        "Add a concise internal note to the ticket. Use this to preserve investigation evidence and the recommended next step.",
      inputSchema: {
        ticketId: z.string(),
        body: z.string().min(10).max(1_000),
      },
    },
    async ({ ticketId, body }) => {
      const supportCase = getCase(ticketId);
      if (!supportCase) {
        return {
          ...toolResult({ error: `Ticket ${ticketId} not found` }),
          isError: true,
        };
      }
      const { ticket } = supportCase;
      const existing = ticket.notes.find(
        (note) => note.authorKind === "agent" && note.body === body,
      );
      if (existing) {
        return toolResult({ ok: true, duplicate: true, note: existing });
      }
      const note = {
        id: crypto.randomUUID(),
        author: "Opengeni agent",
        authorKind: "agent" as const,
        body,
        createdAt: new Date().toISOString(),
      };
      ticket.notes.unshift(note);
      addActivity(ticket, "Opengeni agent", "Added an internal investigation note");
      emit("ticket.note_added", "Agent added an internal note", ticket.id);
      return toolResult({ ok: true, note });
    },
  );
  return server;
}

async function mcpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
  if (!env.mcpToken || request.headers.get("authorization") !== `Bearer ${env.mcpToken}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = buildMcpServer();
  await server.connect(transport);
  return await transport.handleRequest(request);
}

if (import.meta.main) {
  // One handler per process: its visitor cookie key and session ownership live in memory.
  const productRequest = createProductHandler({
    ...env,
    resolveMcpUrl: resolvePublicMcpUrl,
    serveStatic: UNIFIED_SERVER,
  });
  const productServer = Bun.serve({
    hostname: UNIFIED_SERVER ? "0.0.0.0" : "127.0.0.1",
    port: PRODUCT_PORT,
    idleTimeout: 255,
    fetch: async (request) => {
      if (UNIFIED_SERVER && new URL(request.url).pathname === "/mcp") {
        return await mcpRequest(request);
      }
      return await productRequest(request);
    },
  });
  const mcpServer = UNIFIED_SERVER
    ? productServer
    : Bun.serve({
        hostname: "127.0.0.1",
        port: MCP_PORT,
        idleTimeout: 255,
        fetch: mcpRequest,
      });

  console.log(`Northstar product API  http://127.0.0.1:${productServer.port}/api/demo/health`);
  console.log(`Northstar MCP server   http://127.0.0.1:${mcpServer.port}/mcp`);
  console.log("MCP auth               ", env.mcpToken ? "configured" : "MISSING");
  console.log("Opengeni auth          ", env.apiKey ? "configured" : "MISSING");
  console.log("Opengeni workspace     ", env.workspaceId || "MISSING");
}
