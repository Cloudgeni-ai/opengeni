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
} from "@opengeni/db";
import { acquireSharedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// CPU cost of one first-party `POST /v1/workspaces/:id/mcp` (stateless
// Streamable HTTP, one JSON-RPC request per POST). Local only; no credentials.
//
//   bun apps/api/scripts/bench-first-party-mcp.ts [iterations]          in-process server only
//   bun apps/api/scripts/bench-first-party-mcp.ts [iterations] --route  full route + Docker Postgres
//
// `--route` includes delegated-token auth, session authorization, and the
// route's DB reads; Postgres runs in its own container, so the reported
// process CPU is the API side only.
const iterations = Number(process.argv[2] ?? 200);
const routeMode = process.argv.includes("--route");
const SECRET = "bench-first-party-mcp-secret";

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const callTool = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "artifacts_list", arguments: {} },
};

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

async function measure(label: string, serve: (body: unknown) => Promise<unknown>, body: unknown) {
  for (let i = 0; i < 20; i += 1) await serve(body);
  Bun.gc(true);
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let i = 0; i < iterations; i += 1) await serve(body);
  const wall = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000 / iterations;
  console.log(
    `${label}: ${cpuMs.toFixed(2)} ms CPU/request, ${(wall / iterations).toFixed(2)} ms wall/request (n=${iterations})`,
  );
}

async function inProcess(): Promise<void> {
  const deps = {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "bench-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as unknown as ApiRouteDeps;
  const grant: AccessGrant = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "worker:bench",
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    },
  };
  // Same lifecycle as the route: fresh server + transport, one request, close.
  // tools/call fails on the stub DB, which still pays for construction,
  // validation, dispatch, and the error envelope.
  const serve = async (body: unknown) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = buildOpenGeniMcpServer(deps, grant, { requestOrigin: "http://127.0.0.1:8000" });
    try {
      await mcp.connect(transport);
      return await (
        await transport.handleRequest(mcpRequest("http://127.0.0.1:8000/mcp", body))
      ).json();
    } finally {
      await mcp.close().catch(() => undefined);
    }
  };
  const sample = (await serve(listTools)) as { result?: { tools?: unknown[] } };
  console.log(`in-process: tools/list returns ${sample.result?.tools?.length ?? 0} tools`);
  await measure("tools/list", serve, listTools);
  await measure("tools/call", serve, callTool);
}

async function route(): Promise<void> {
  const shared = await acquireSharedTestDatabase("bench-first-party-mcp");
  if (!shared) throw new Error("Docker PostgreSQL test database unavailable");
  const client = createDb(shared.appUrl);
  try {
    const settings = testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      environmentsEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
      sandboxBackend: "none",
    });
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "bench",
      accountExternalId: `account-${suffix}`,
      accountName: "Bench",
      workspaceExternalSource: "bench",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Bench",
      subjectId: `user:${suffix}`,
    });
    const owner = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      initialMessage: "bench",
      resources: [],
      tools: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyMcpPermissions: null,
      createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Bench" },
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
    if (!started.turn) throw new Error("bench session did not create an initial turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("bench attempt was not claimed");
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      principalKind: "agent_attempt",
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as SessionWorkflowClient,
    });
    const url = `http://127.0.0.1:8000/v1/workspaces/${owner.workspaceId}/mcp`;
    const serve = async (body: unknown) => {
      const response = await app.request(mcpRequest(url, body, authorization));
      if (response.status !== 200) {
        throw new Error(`MCP route returned ${response.status}: ${await response.text()}`);
      }
      return await response.json();
    };
    const sample = (await serve(listTools)) as { result?: { tools?: unknown[] } };
    const call = (await serve(callTool)) as { result?: { isError?: boolean } };
    console.log(
      `route: tools/list returns ${sample.result?.tools?.length ?? 0} tools; tools/call isError=${call.result?.isError ?? false}`,
    );
    await measure("tools/list", serve, listTools);
    await measure("tools/call", serve, callTool);
  } finally {
    await client.close();
    await shared.release();
  }
}

await (routeMode ? route() : inProcess());
process.exit(0);
