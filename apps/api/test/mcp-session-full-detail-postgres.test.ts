import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  resolveAgentConfig,
  signDelegatedAccessToken,
  type Session,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import type { SessionWorkflowClient } from "@opengeni/core";
import * as db from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../src/app";
import { boundSessionDetailMcp } from "../src/mcp/session-view";

const secret = "mcp-full-session-projection-test";
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: secret,
  environmentsEncryptionKey: Buffer.alloc(32, 67).toString("base64"),
  sandboxBackend: "none",
  webSearchEnabled: false,
  // This metadata fixture uses a static catalog without workspace provider overlays.
  modelCostPolicyJson: "{}",
  resolvedGatewayModelsJson: "[]",
  resolvedOpenRouterModelsJson: "[]",
  resolvedOpperModelsJson: "[]",
  mcpServers: [{ id: "fixture-metadata", url: "https://metadata.example.invalid/mcp" }],
});
let database: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof db.createDb>;
let observed: postgres.Sql;
const queries: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("mcp-full-session-projection");
  if (!acquired) throw new Error("MCP projection tests require PostgreSQL");
  database = acquired;
  client = db.createDb(database.appUrl, { searchPath: database.schema, max: 4 });
  observed = postgres(database.appUrl, {
    max: 4,
    prepare: false,
    connection: { search_path: database.schema },
    debug: (_connection, query) => queries.push(query.trim().replace(/\s+/g, " ")),
  });
  const [role] =
    await observed`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
}, 180_000);

afterAll(async () => {
  for (const server of servers) await server.stop(true);
  await observed?.end();
  await client?.close();
  await database?.release();
}, 60_000);

async function fixture(sessionAuthorization?: SessionAuthorizationPort) {
  const suffix = crypto.randomUUID();
  const access = await db.bootstrapWorkspace(client.db, {
    accountExternalSource: "mcp-full-session-projection",
    accountExternalId: suffix,
    accountName: "MCP projection",
    workspaceExternalSource: "mcp-full-session-projection",
    workspaceExternalId: suffix,
    workspaceName: "MCP projection",
    subjectId: "user:" + suffix,
  });
  const owner = access.workspaceGrants[0]!;
  const create = (capabilities: "all" | "none" | null, workspaceDefault = false) =>
    db.createSession(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      initialMessage: "MCP projection " + suffix,
      resources: [],
      tools: [],
      ...(workspaceDefault
        ? { toolPolicy: { mode: "workspace_default" as const, inheritedFromSessionId: null } }
        : {}),
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyMcpPermissions: null,
      agentConfig:
        capabilities === null
          ? null
          : resolveAgentConfig({
              creator: "api",
              request: { capabilities },
              deployment: { unavailable: {} },
              workspace: { defaults: null, humanInputEnabled: true },
              goal: false,
            }).config!,
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      createdByContext: {},
    });
  const caller = await create("all");
  await db.initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: caller.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await db.claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: caller.id,
    workflowId: "session-" + caller.id,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture attempt was not claimed");
  const subjectId = "worker:" + suffix;
  const claims = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId,
    principalKind: "agent_attempt" as const,
    sessionId: caller.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  };
  const bearer = async (overrides: Partial<typeof claims> = {}) =>
    "Bearer " + (await signDelegatedAccessToken(secret, { ...claims, ...overrides }));
  const app = createApp({
    settings,
    db: drizzle(observed, { schema }) as unknown as db.Database,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    sessionAuthorization: sessionAuthorization ?? null,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  servers.push(server);
  const post = async (
    args: { sessionId?: string; detail?: "compact" | "full" },
    authorization = "",
  ) => {
    const auth = authorization || (await bearer());
    queries.length = 0;
    const response = await fetch(
      new URL("/v1/workspaces/" + owner.workspaceId + "/mcp", server.url),
      {
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "session_get", arguments: args },
        }),
      },
    );
    const body = (await response.json()) as {
      result?: { isError?: boolean; content: Array<{ type: string; text?: string }> };
      error?: { details?: { code?: string } };
    };
    const work = [...queries];
    return { status: response.status, body, queries: work };
  };
  const rest = async (sessionId: string, authorization: string) => {
    const response = await fetch(
      new URL("/v1/workspaces/" + owner.workspaceId + "/sessions/" + sessionId, server.url),
      { headers: { authorization } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Session;
  };
  return { owner, caller, subjectId, bearer, create, post, rest };
}

function value(response: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["post"]>>) {
  expect(response.status).toBe(200);
  expect(response.body.result?.isError, JSON.stringify(response.body)).not.toBe(true);
  const text = response.body.result?.content.find((item) => item.type === "text")?.text;
  expect(text).toBeDefined();
  return JSON.parse(text!);
}

test("authenticated full MCP detail matches REST while reading projection metadata once", async () => {
  const f = await fixture();
  const authorization = await f.bearer();
  await f.post({ detail: "compact" }, authorization);
  const measurements = [];
  for (const capabilities of ["all", "none", null] as const) {
    const target = await f.create(capabilities);
    const expected = boundSessionDetailMcp(await f.rest(target.id, authorization));
    const registry = spyOn(core, "settingsWithEnabledCapabilityMcpServers");
    const workspace = spyOn(db, "requireWorkspace");
    try {
      const response = await f.post({ sessionId: target.id, detail: "full" }, authorization);
      expect(value(response)).toEqual(expected);
      expect(
        registry.mock.calls.every(
          ([, workspaceId, , options]) =>
            workspaceId === f.owner.workspaceId && options?.subjectId === f.subjectId,
        ),
      ).toBe(true);
      expect(
        workspace.mock.calls.every(([, workspaceId]) => workspaceId === f.owner.workspaceId),
      ).toBe(true);
      measurements.push({
        capabilities,
        registry: registry.mock.calls.length,
        workspace: workspace.mock.calls.length,
        statements: response.queries.length,
        transactions: response.queries.filter((query) => query.toLowerCase() === "begin").length,
      });
    } finally {
      registry.mockRestore();
      workspace.mockRestore();
    }
  }
  console.info("MCP_FULL_DETAIL_READS", JSON.stringify(measurements));
  expect(measurements.map(({ registry, workspace }) => ({ registry, workspace }))).toEqual([
    { registry: 1, workspace: 1 },
    { registry: 1, workspace: 1 },
    { registry: 1, workspace: 1 },
  ]);
}, 60_000);

test("projection reads stay request-local across subjects/workspaces and compact detail skips them", async () => {
  const a = await fixture();
  const b = await fixture();
  const registry = spyOn(core, "settingsWithEnabledCapabilityMcpServers");
  const workspace = spyOn(db, "requireWorkspace");
  try {
    for (const [f, subjectId] of [
      [a, a.subjectId],
      [a, "worker:second"],
      [b, b.subjectId],
      [a, a.subjectId],
    ] as const) {
      registry.mockClear();
      workspace.mockClear();
      const result = value(await f.post({ detail: "full" }, await f.bearer({ subjectId })));
      expect(result.id).toBe(f.caller.id);
      expect(result.workspaceId).toBe(f.owner.workspaceId);
      expect(registry.mock.calls).toHaveLength(1);
      expect(registry.mock.calls[0]?.[1]).toBe(f.owner.workspaceId);
      expect(registry.mock.calls[0]?.[3]?.subjectId).toBe(subjectId);
      expect(workspace.mock.calls).toHaveLength(1);
      expect(workspace.mock.calls[0]?.[1]).toBe(f.owner.workspaceId);
    }
    registry.mockClear();
    workspace.mockClear();
    const compact = value(await a.post({ detail: "compact" }));
    expect(compact.id).toBe(a.caller.id);
    expect(compact).not.toHaveProperty("effectiveToolPolicy");
    expect(registry.mock.calls).toHaveLength(0);
    expect(workspace.mock.calls).toHaveLength(0);
  } finally {
    registry.mockRestore();
    workspace.mockRestore();
  }
}, 60_000);

test("projection read failures fail the full tool call without poisoning later requests", async () => {
  const f = await fixture();
  for (const kind of ["workspace", "registry"] as const) {
    const error = new Error("projection " + kind + " unavailable");
    const read =
      kind === "workspace"
        ? spyOn(db, "requireWorkspace").mockRejectedValue(error)
        : spyOn(core, "settingsWithEnabledCapabilityMcpServers").mockRejectedValue(error);
    try {
      const response = await f.post({ detail: "full" });
      expect(response.status).toBe(200);
      expect(response.body.result?.isError).toBe(true);
      expect(JSON.stringify(response.body)).toContain(error.message);
      expect(value(await f.post({ detail: "compact" })).id).toBe(f.caller.id);
    } finally {
      read.mockRestore();
    }
    expect(value(await f.post({ detail: "full" })).id).toBe(f.caller.id);
  }
}, 60_000);

test("full detail keeps live caller, foreign workspace and changing host authorization before metadata", async () => {
  let allowed = true;
  const f = await fixture({
    authorizeSession: async () =>
      allowed ? { allowed: true } : { allowed: false, reason: "forbidden" },
    resolveListScope: async () => ({ kind: "all" }),
  });
  const foreign = await fixture();
  expect(value(await f.post({ detail: "full" })).id).toBe(f.caller.id);
  const registry = spyOn(core, "settingsWithEnabledCapabilityMcpServers");
  const workspace = spyOn(db, "requireWorkspace");
  try {
    const crossWorkspace = await f.post({ sessionId: foreign.caller.id, detail: "full" });
    expect(crossWorkspace.body.result?.isError).toBe(true);
    expect(JSON.stringify(crossWorkspace.body)).not.toContain(foreign.caller.initialMessage);
    const stale = await f.post(
      { detail: "full" },
      await f.bearer({ attemptId: crypto.randomUUID() }),
    );
    expect(stale.status).toBe(403);
    expect(stale.body.error?.details?.code).toBe("agent_attempt_caller_stale");
    allowed = false;
    const denied = await f.post({ detail: "full" });
    expect(denied.status).toBe(404);
    expect(registry.mock.calls).toHaveLength(0);
    expect(workspace.mock.calls).toHaveLength(0);
  } finally {
    registry.mockRestore();
    workspace.mockRestore();
  }
}, 60_000);

test("a later full-detail request observes changed workspace defaults", async () => {
  const f = await fixture();
  const target = await f.create("all", true);
  const before = value(await f.post({ sessionId: target.id, detail: "full" }));
  expect(before.effectiveToolPolicy.effectiveIds).toContain("fixture-metadata");
  await db.withWorkspaceRls(client.db, f.owner.workspaceId, async (tx) => {
    await db.updateWorkspaceSettings(tx, f.owner.workspaceId, {
      sessionToolDefaults: { mcpServerIds: [], inheritConnectedMcpServers: false },
    });
  });
  const after = value(await f.post({ sessionId: target.id, detail: "full" }));
  expect(after.effectiveToolPolicy.effectiveIds).not.toContain("fixture-metadata");
}, 60_000);
