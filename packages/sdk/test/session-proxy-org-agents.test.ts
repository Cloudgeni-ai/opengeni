import { describe, expect, test } from "bun:test";
import { createSessionProxyHandler, OpenGeniClient, type SessionProxyHandlerOptions } from "../src/index";
import { WORKSPACE_ID } from "./helpers";

const API = "https://api.example.test";
const PRODUCT = "https://product.example.test";

function setup(overrides: Partial<SessionProxyHandlerOptions> = {}) {
  const forwarded: { method: string; path: string; body: unknown }[] = [];
  const service = new OpenGeniClient({
    baseUrl: API,
    apiKey: "og_org_key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = request.method === "GET" ? "" : await request.text();
      forwarded.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json({ id: "33333333-3333-4333-8333-333333333333" }, { status: 201 });
    },
  });
  const handler = createSessionProxyHandler(service, {
    resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
    ...overrides,
  });
  const create = async (body: unknown) =>
    await handler(
      new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const createdBodies = () =>
    forwarded
      .filter((entry) => entry.method === "POST" && entry.path === `/v1/workspaces/${WORKSPACE_ID}/sessions`)
      .map((entry) => entry.body);
  return { create, createdBodies };
}

/** A browser create a product sends today, with a workspace agent object. */
const TODAY_BROWSER_CREATE = {
  initialMessage: "Summarise the open tickets.",
  idempotencyKey: "create-1",
  clientEventId: "client-event-1",
  timeZone: "Europe/Oslo",
  modelContext: "Page: tickets",
  model: "gpt-5.5",
  agent: {
    capabilities: { from: "all", webSearch: false },
    identity: "You are Northwind's assistant.",
    instructions: "Answer briefly.",
    renderer: "markdown",
  },
};

describe("session proxy and organization agents", () => {
  test("compat: today's browser create is forwarded exactly as before (recorded on main)", async () => {
    const { create, createdBodies } = setup();
    expect((await create(TODAY_BROWSER_CREATE)).status).toBe(201);
    expect(createdBodies()).toEqual(RECORDED_FORWARDED_TODAY);
  });

  test("a browser create cannot name an organization agent or set agentOverrides", async () => {
    const { create, createdBodies } = setup();
    const base = { initialMessage: "Hi", idempotencyKey: "create-2" };
    for (const extra of [
      { agent: "support" },
      { agent: "5d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a" },
      { agent: { ref: "support", model: "gpt-5.5", toolServers: [{ server: "crm", headers: { authorization: "x" } }] } },
      { agentOverrides: "allow" },
      { agent: "support", agentOverrides: "reject" },
    ]) {
      expect((await create({ ...base, ...extra })).status).toBe(201);
    }
    for (const body of createdBodies()) {
      expect(body).not.toHaveProperty("agent");
      expect(body).not.toHaveProperty("agentOverrides");
      expect(body).toMatchObject(base);
    }
    expect(createdBodies()).toHaveLength(5);
  });

  test("the host's createSession hook names the organization agent and keeps its overrides", async () => {
    const { create, createdBodies } = setup({
      createSession: (input) => ({
        initialMessage: input.initialMessage,
        agent: { ref: "support", instructions: "The user is on the Pro plan." },
        agentOverrides: "reject",
      }),
    });
    expect((await create({ initialMessage: "Hi" })).status).toBe(201);
    expect(createdBodies()).toEqual([
      expect.objectContaining({
        initialMessage: "Hi",
        agent: { ref: "support", instructions: "The user is on the Pro plan." },
        agentOverrides: "reject",
      }),
    ]);
  });

  test("with a createSession hook, a browser-sent agent is refused as before", async () => {
    const { create, createdBodies } = setup({
      createSession: (input) => ({ initialMessage: input.initialMessage }),
    });
    for (const extra of [{ agent: "support" }, { agentOverrides: "allow" }]) {
      const response = await create({ initialMessage: "Hi", ...extra });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "create_field_not_allowed",
      );
    }
    expect(createdBodies()).toEqual([]);
  });
});

/** Recorded from the unchanged proxy (feat/console-agents 27b50a5, main d07d727). */
const RECORDED_FORWARDED_TODAY: unknown[] = [
  {
    agent: {
      capabilities: { from: "all", webSearch: false },
      identity: "You are Northwind's assistant.",
      instructions: "Answer briefly.",
      renderer: "markdown",
    },
    agentAccess: "session",
    clientEventId: "client-event-1",
    idempotencyKey: "create-1",
    initialMessage: "Summarise the open tickets.",
    memoryScope: "user",
    model: "gpt-5.5",
    modelContext: "Page: tickets",
    timeZone: "Europe/Oslo",
    visibility: "private",
  },
];
