import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  signDelegatedAccessToken,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer, isOpenGeniMcpProtocolOnlyMessage } from "../src/mcp/server";

// Every first-party MCP POST used to pay the whole tool-surface setup: session
// authorization, the learning policy, the workspace, its model catalog, Memory
// scope and admin access (about forty statements). A client connect is three
// POSTs (initialize, notifications/initialized, tools/list), so the two
// handshakes now prove only that the caller is the live attempt and answer
// exactly what the full server would.

const SECRET = "first-party-mcp-handshake-secret";
const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "handshake-test", version: "1" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let traced: ReturnType<typeof postgres>;
const statements: string[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("first-party-mcp-handshake");
  if (!acquired) throw new Error("First-party MCP handshake tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  traced = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    debug: (_connection, query) => {
      statements.push(query.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase());
    },
  });
  await traced`select 1`;
}, 180_000);

afterAll(async () => {
  await traced?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

function mcpRequest(url: string, body: unknown, authorization?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function fixture() {
  const settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
    sandboxBackend: "none",
  });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "mcp-handshake",
    accountExternalId: `account-${suffix}`,
    accountName: "MCP handshake",
    workspaceExternalSource: "mcp-handshake",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "MCP handshake",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: "handshake",
    resources: [],
    tools: [],
    metadata: {},
    model: settings.openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    firstPartyMcpPermissions: null,
    createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Handshake" },
    createdByContext: {},
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("fixture session did not create an initial turn");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture attempt was not claimed");
  const metadata = {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
  };
  const bearer = async (overrides: Partial<typeof metadata> = {}) =>
    `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      principalKind: "agent_attempt",
      ...metadata,
      ...overrides,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
  const grant: AccessGrant = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    principalKind: "agent_attempt",
    metadata,
  };
  const app = createApp({
    settings,
    db: drizzle(traced, { schema }) as unknown as Database,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
  });
  const url = `http://127.0.0.1:8000/v1/workspaces/${owner.workspaceId}/mcp`;
  const post = async (body: unknown, authorization: string) => {
    statements.length = 0;
    const response = await app.request(mcpRequest(url, body, authorization));
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      statements: [...statements],
    };
  };
  return { settings, grant, bearer, post };
}

describe("first-party MCP handshakes", () => {
  test("initialize answers exactly what the full tool server answers", async () => {
    const { settings, grant, bearer, post } = await fixture();
    const viaRoute = await post(initialize, await bearer());
    expect(viaRoute.status).toBe(200);

    const deps = {
      settings,
      db: {},
      bus: new MemoryEventBus(),
    } as unknown as ApiRouteDeps;
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const full = buildOpenGeniMcpServer(deps, grant, { requestOrigin: "http://127.0.0.1:8000" });
    await full.connect(transport);
    const direct = (await (
      await transport.handleRequest(mcpRequest("http://127.0.0.1:8000/mcp", initialize))
    ).json()) as Record<string, unknown>;
    await full.close();

    expect(viaRoute.body).toEqual(direct);
    expect(direct).toMatchObject({
      result: { serverInfo: { name: "opengeni" }, capabilities: { tools: { listChanged: true } } },
    });
  });

  test("handshakes cost one live-attempt read; tools/list still builds the full surface", async () => {
    const { bearer, post } = await fixture();
    const authorization = await bearer();
    const oneRead = ["begin", "with parent", "select target.id", "commit"];

    const init = await post(initialize, authorization);
    expect(init.status).toBe(200);
    expect(init.statements).toEqual(oneRead);

    const notified = await post(initialized, authorization);
    expect(notified.status).toBe(202);
    expect(notified.statements).toEqual(oneRead);

    const pinged = await post(ping, authorization);
    expect(pinged.status).toBe(200);
    expect(pinged.body).toMatchObject({ result: {} });
    expect(pinged.statements).toEqual(oneRead);

    const listed = await post(listTools, authorization);
    expect(listed.status).toBe(200);
    const tools = (listed.body!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.some((tool) => tool.name.startsWith("__opengeni_"))).toBe(false);
  });

  test("a handshake from an attempt that is no longer live is refused like any other call", async () => {
    const { bearer, post } = await fixture();
    const stale = await bearer({ attemptId: crypto.randomUUID() });

    const init = await post(initialize, stale);
    const listed = await post(listTools, stale);
    expect(init.status).toBe(403);
    expect(listed.status).toBe(403);
    const withoutRequestId = (body: Record<string, unknown> | null) => {
      const error = { ...(body?.error as Record<string, unknown>) };
      delete error.requestId;
      return error;
    };
    expect(withoutRequestId(init.body)).toEqual(withoutRequestId(listed.body));
    expect(withoutRequestId(init.body)).toMatchObject({
      details: { code: "agent_attempt_caller_stale" },
    });

    const notified = await post(initialized, stale);
    expect(notified.status).toBe(403);
  });
});

describe("protocol-only message classification", () => {
  test("only handshakes and notifications skip the tool surface", () => {
    expect(isOpenGeniMcpProtocolOnlyMessage(initialize)).toBe(true);
    expect(isOpenGeniMcpProtocolOnlyMessage(initialized)).toBe(true);
    expect(isOpenGeniMcpProtocolOnlyMessage(ping)).toBe(true);
    expect(isOpenGeniMcpProtocolOnlyMessage(listTools)).toBe(false);
    expect(
      isOpenGeniMcpProtocolOnlyMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }),
    ).toBe(false);
    // A request that merely looks like a notification still gets the full path.
    expect(
      isOpenGeniMcpProtocolOnlyMessage({ jsonrpc: "2.0", id: 4, method: "notifications/x" }),
    ).toBe(false);
    expect(isOpenGeniMcpProtocolOnlyMessage({ jsonrpc: "2.0", id: 5, result: {} })).toBe(false);
    expect(isOpenGeniMcpProtocolOnlyMessage([initialize])).toBe(false);
    expect(isOpenGeniMcpProtocolOnlyMessage(null)).toBe(false);
  });
});
