import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenGeniClient, type CreateSessionRequest } from "@opengeni/sdk";
import * as z from "zod/v4";
import type {
  DemoHealth,
  SupportCustomer,
  SupportDemoState,
  SupportDomainEvent,
  SupportTicket,
  TicketPriority,
  TicketStatus,
} from "./types";

const PRODUCT_PORT = 4100;
const MCP_PORT = 4101;
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
const model = process.env.OPENGENI_MODEL?.trim() ?? "";
const openGeni = new OpenGeniClient({ baseUrl: apiBaseUrl, apiKey });

const initialCustomer: SupportCustomer = {
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
};

const initialTicket: SupportTicket = {
  id: "TKT-2847",
  customerId: initialCustomer.id,
  subject: "Monthly export stalls at 87%",
  body: "Hi team — our monthly finance export has stopped at exactly 87% three times today. We need the report for tomorrow's board meeting. Can someone take a look?",
  status: "open",
  priority: "normal",
  assignee: "Maya Chen",
  channel: "email",
  createdAt: "2026-07-15T08:42:00.000Z",
  slaDueAt: "2026-07-15T16:42:00.000Z",
  tags: ["exports", "finance"],
  notes: [
    {
      id: "note_seed",
      author: "Maya Chen",
      authorKind: "human",
      body: "No platform incident showing. Customer has retried from two browsers.",
      createdAt: "2026-07-15T09:03:00.000Z",
    },
  ],
  activity: [
    {
      id: "activity_seed",
      actor: "Nora Lind",
      summary: "Created the ticket by email",
      createdAt: "2026-07-15T08:42:00.000Z",
    },
  ],
};

let state: SupportDemoState = freshState();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

function freshState(): SupportDemoState {
  return {
    revision: 1,
    customer: structuredClone(initialCustomer),
    ticket: structuredClone(initialTicket),
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function emit(type: SupportDomainEvent["type"], summary: string): SupportDomainEvent {
  state.revision += 1;
  const event: SupportDomainEvent = {
    id: crypto.randomUUID(),
    type,
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

function addActivity(actor: string, summary: string): void {
  state.ticket.activity.unshift({
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
  const input = (await request.json().catch(() => ({}))) as {
    initialMessage?: unknown;
  };
  const initialMessage =
    typeof input.initialMessage === "string" && input.initialMessage.trim()
      ? input.initialMessage.trim()
      : "Investigate this support ticket. Use the available support tools, explain the evidence, and take the appropriate actions.";

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
    instructions: `You are the embedded support copilot inside Northstar, a fictional SaaS product. You are working only on ticket TKT-2847 for Aster Labs. Always inspect the ticket and customer with Northstar Support tools before drawing conclusions. The failed-export evidence is important. When evidence warrants action, call update_ticket and add_internal_note immediately. Product actions are pre-approved for this demo, so execute them without asking for confirmation. Never invent customer data. Keep the final answer brief and operational.`,
    ...(model ? { model } : {}),
    reasoningEffort: "low",
    tools: [{ kind: "mcp", id: MCP_SERVER_ID }],
    mcpServers: [mcpServer] as CreateSessionRequest["mcpServers"],
    metadata: { demo: "northstar-support", ticketId: state.ticket.id },
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
  if (upstreamPath !== workspacePrefix && !upstreamPath.startsWith(`${workspacePrefix}/`)) {
    return json({ error: "Workspace path is outside this demo's scope." }, 403);
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
  if (url.pathname === "/api/demo/reset" && request.method === "POST") {
    state = freshState();
    emit("demo.reset", "Demo data reset");
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
        ticketId: z.string().describe("Ticket id, normally TKT-2847"),
      },
    },
    async ({ ticketId }) =>
      ticketId === state.ticket.id
        ? toolResult(state.ticket)
        : {
            ...toolResult({ error: `Ticket ${ticketId} not found` }),
            isError: true,
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
    async ({ customerId }) =>
      customerId === state.customer.id
        ? toolResult(state.customer)
        : {
            ...toolResult({ error: `Customer ${customerId} not found` }),
            isError: true,
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
      if (ticketId !== state.ticket.id) {
        return {
          ...toolResult({ error: `Ticket ${ticketId} not found` }),
          isError: true,
        };
      }
      const changes: string[] = [];
      if (priority && priority !== state.ticket.priority) {
        changes.push(`priority ${state.ticket.priority} → ${priority}`);
        state.ticket.priority = priority as TicketPriority;
      }
      if (status && status !== state.ticket.status) {
        changes.push(`status ${state.ticket.status} → ${status}`);
        state.ticket.status = status as TicketStatus;
      }
      if (assignee && assignee !== state.ticket.assignee) {
        changes.push(`assignee ${state.ticket.assignee} → ${assignee}`);
        state.ticket.assignee = assignee;
      }
      const summary = changes.length
        ? `Updated ${changes.join(", ")}`
        : "Reviewed ticket; no field changes";
      if (changes.length > 0) {
        addActivity("OpenGeni agent", `${summary}. Reason: ${reason}`);
        emit("ticket.updated", summary);
      }
      return toolResult({ ok: true, summary, ticket: state.ticket });
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
      if (ticketId !== state.ticket.id) {
        return {
          ...toolResult({ error: `Ticket ${ticketId} not found` }),
          isError: true,
        };
      }
      const existing = state.ticket.notes.find(
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
      state.ticket.notes.unshift(note);
      addActivity("OpenGeni agent", "Added an internal investigation note");
      emit("ticket.note_added", "Agent added an internal note");
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
  hostname: "127.0.0.1",
  port: PRODUCT_PORT,
  idleTimeout: 255,
  fetch: productRequest,
});
const mcpServer = Bun.serve({
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
