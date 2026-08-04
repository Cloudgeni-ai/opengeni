import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenGeniClient, type CreateSessionRequest } from "@opengeni/sdk";
import { join, normalize } from "node:path";
import * as z from "zod/v4";
import type {
  SupportCase,
  DemoHealth,
  SupportDomainEvent,
  SupportTicket,
  SupportWorkspaceState,
  TicketPriority,
  TicketStatus,
} from "./types";

const PRODUCT_PORT = Number(process.env.PORT ?? 4100);
const MCP_PORT = Number(process.env.OPENGENI_DEMO_MCP_PORT ?? 4101);
const UNIFIED_SERVER = Boolean(process.env.PORT);
const PRODUCT_APP_ORIGIN = (
  process.env.OPENGENI_DEMO_APP_ORIGIN ?? "http://127.0.0.1:3101"
).replace(/\/+$/, "");
const STATIC_ROOT = join(import.meta.dir, "../dist");
const MCP_SERVER_ID = "northstar_support";
const MCP_TOOLS = ["get_ticket", "get_customer", "update_ticket", "add_internal_note"];
const encoder = new TextEncoder();

const apiKey = process.env.OPENGENI_API_KEY?.trim() ?? "";
const workspaceId = process.env.OPENGENI_WORKSPACE_ID?.trim() ?? "";
const apiBaseUrl = (process.env.OPENGENI_API_BASE_URL ?? "https://app.opengeni.ai").replace(
  /\/+$/,
  "",
);
const mcpToken = process.env.OPENGENI_DEMO_MCP_TOKEN?.trim() ?? "";
const openGeni = new OpenGeniClient({ baseUrl: apiBaseUrl, apiKey });

const createDemoSessionInput = z.object({
  ticketId: z.string().trim().min(1),
  initialMessage: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).max(256),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    .default("medium"),
  latencyMode: z.enum(["standard", "priority", "fast"]).default("standard"),
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

function staticResponse(pathname: string): Response {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = normalize(requested);
  if (safePath.startsWith("..") || safePath.includes("/../")) {
    return new Response("Not found", { status: 404 });
  }
  const asset = Bun.file(join(STATIC_ROOT, safePath));
  if (asset.size > 0) {
    return new Response(asset, {
      headers: {
        "cache-control":
          safePath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  }
  const index = Bun.file(join(STATIC_ROOT, "index.html"));
  return index.size > 0
    ? new Response(index, { headers: { "cache-control": "no-cache" } })
    : new Response("Not found", { status: 404 });
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

async function health(): Promise<DemoHealth> {
  const mcpPublicUrl = await resolvePublicMcpUrl();
  return {
    ok: Boolean(apiKey && workspaceId && mcpToken && mcpPublicUrl),
    workspaceId: workspaceId || null,
    openGeniConfigured: Boolean(apiKey && workspaceId),
    mcpTokenConfigured: Boolean(mcpToken),
    mcpPublicUrl,
  };
}

async function createAgentSession(request: Request): Promise<Response> {
  if (!apiKey || !workspaceId || !mcpToken) {
    return json({ error: "Demo server credentials are not configured." }, 503);
  }
  const mcpUrl = await resolvePublicMcpUrl();
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
    return json({ error: "Choose a valid workspace model before starting the agent." }, 400);
  }
  const {
    ticketId,
    initialMessage: requestedMessage,
    model,
    reasoningEffort,
    latencyMode,
  } = parsedInput.data;
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
    model,
    reasoningEffort,
    latencyMode,
    tools: [{ kind: "mcp", id: MCP_SERVER_ID }],
    mcpServers: [mcpServer] as CreateSessionRequest["mcpServers"],
    metadata: { demo: "northstar-support", ticketId: ticket.id },
    clientEventId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  };
  const session = await openGeni.createSession(workspaceId, sessionRequest);
  return json(session, 201);
}

async function proxyOpenGeni(request: Request): Promise<Response> {
  if (!apiKey || !workspaceId) {
    return json({ error: "OpenGeni credentials are not configured." }, 503);
  }

  const incoming = new URL(request.url);
  const upstreamPath = incoming.pathname.replace(/^\/api\/opengeni/, "");
  const workspacePrefix = `/v1/workspaces/${workspaceId}`;
  const isWorkspacePath =
    upstreamPath === workspacePrefix || upstreamPath.startsWith(`${workspacePrefix}/`);
  const isClientConfigRead = request.method === "GET" && upstreamPath === "/v1/config/client";

  if (!isWorkspacePath && !isClientConfigRead) {
    return json({ error: "API path is outside this demo's scope." }, 403);
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  const body =
    request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const upstream = await fetch(`${apiBaseUrl}${upstreamPath}${incoming.search}`, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function productRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": PRODUCT_APP_ORIGIN,
        "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (url.pathname.startsWith("/api/opengeni/")) {
    try {
      return await proxyOpenGeni(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }
  if (url.pathname === "/api/demo/health" && request.method === "GET") return json(await health());
  if (url.pathname === "/api/demo/state" && request.method === "GET") return json(state);
  if (url.pathname === "/api/demo/events" && request.method === "GET")
    return domainEventStream(request);
  if (url.pathname === "/api/demo/sessions" && request.method === "POST") {
    try {
      return await createAgentSession(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  }
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
  if (url.pathname === "/api/demo/reset" && request.method === "POST") {
    state = freshState();
    emit("demo.reset", "Demo data reset", "all");
    return json(state);
  }
  if (UNIFIED_SERVER && request.method === "GET") return staticResponse(url.pathname);
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
        addActivity(ticket, "OpenGeni agent", `${summary}. Reason: ${reason}`);
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
        author: "OpenGeni agent",
        authorKind: "agent" as const,
        body,
        createdAt: new Date().toISOString(),
      };
      ticket.notes.unshift(note);
      addActivity(ticket, "OpenGeni agent", "Added an internal investigation note");
      emit("ticket.note_added", "Agent added an internal note", ticket.id);
      return toolResult({ ok: true, note });
    },
  );
  return server;
}

async function mcpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
  if (!mcpToken || request.headers.get("authorization") !== `Bearer ${mcpToken}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = buildMcpServer();
  await server.connect(transport);
  return await transport.handleRequest(request);
}

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
console.log("MCP auth               ", mcpToken ? "configured" : "MISSING");
console.log("OpenGeni auth          ", apiKey ? "configured" : "MISSING");
console.log("OpenGeni workspace     ", workspaceId || "MISSING");
