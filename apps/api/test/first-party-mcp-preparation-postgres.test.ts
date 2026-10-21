import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  signDelegatedAccessToken,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
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
  acquireRestrictedRuntimeTestDatabase,
  MemoryEventBus,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../src/app";

const SECRET = "mcp-unused-memory-preparation-test";
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
  sandboxBackend: "none",
});
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name, arguments: args },
});
let database: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;
let observed: postgres.Sql;
const queries: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("mcp-preparation");
  if (!acquired) throw new Error("MCP preparation tests require PostgreSQL");
  database = acquired;
  client = createDb(database.appUrl, { searchPath: database.schema });
  observed = postgres(database.appUrl, {
    max: 8,
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

async function fixture(
  memoryScope: "off" | "workspace" | "user",
  sessionAuthorization?: SessionAuthorizationPort,
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "mcp-preparation",
    accountExternalId: suffix,
    accountName: "MCP preparation",
    workspaceExternalSource: "mcp-preparation",
    workspaceExternalId: suffix,
    workspaceName: "MCP preparation",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const create = () =>
    createSession(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      initialMessage: "MCP preparation",
      resources: [],
      tools: [],
      metadata: {},
      model: settings.openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      memoryScope,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyMcpPermissions: null,
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      createdByContext: {},
    });
  const session = await create();
  await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
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
  const claims = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: "worker:first-party-mcp",
    principalKind: "agent_attempt" as const,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  };
  const bearer = async (overrides: Partial<typeof claims> = {}) =>
    `Bearer ${await signDelegatedAccessToken(SECRET, { ...claims, ...overrides })}`;
  const app = createApp({
    settings,
    db: drizzle(observed, { schema }) as unknown as Database,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    sessionAuthorization: sessionAuthorization ?? null,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  servers.push(server);
  const post = async (body: unknown, authorization: string) => {
    queries.length = 0;
    const started = performance.now();
    const response = await fetch(new URL(`/v1/workspaces/${owner.workspaceId}/mcp`, server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as {
      result?: {
        tools?: Array<{ name: string }>;
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      error?: { details?: { code?: string } };
    };
    return {
      status: response.status,
      body: result,
      queries: [...queries],
      durationMs: performance.now() - started,
    };
  };
  return { bearer, post, session, owner, create };
}

test("MCP HTTP preparation omits unused Memory reads for every retained selector", async () => {
  let catalog: unknown;
  const measurements = [];
  for (const scope of ["off", "workspace", "user"] as const) {
    const f = await fixture(scope);
    const authorization = await f.bearer();
    // Warm the exact-attempt frozen learning snapshot; its cache is independent
    // of the legacy Memory reads removed here.
    await f.post(listTools, authorization);
    const listed = await f.post(listTools, authorization);
    expect(listed.status).toBe(200);
    expect(listed.body.result?.tools?.some(({ name }) => name === "knowledge_search")).toBe(true);
    expect(listed.body.result?.tools?.some(({ name }) => name.startsWith("memory_"))).toBe(false);
    if (catalog) expect(listed.body).toEqual(catalog);
    else catalog = listed.body;
    for (const [method, request] of [
      ["tools/list", listTools],
      ["project_list", call("project_list")],
    ] as const) {
      const requests = [];
      for (let repeat = 0; repeat < 10; repeat++) {
        const response = await f.post(request, authorization);
        expect(response.status).toBe(200);
        if (method === "tools/list") expect(response.body).toEqual(catalog);
        else
          expect(response.body.result).toEqual({
            content: [{ type: "text", text: '{\n  "projects": []\n}' }],
          });
        requests.push(response);
      }
      const durations = requests.map(({ durationMs }) => durationMs).sort((a, b) => a - b);
      const first = requests[0]!;
      measurements.push({
        scope,
        method,
        samples: requests.length,
        statements: first.queries.length,
        transactions: first.queries.filter((query) => query.toLowerCase() === "begin").length,
        medianMs: durations[5],
        p95Ms: durations[9],
        // These are precisely the projections used only by the removed route
        // preparation. Live authorization uses its own target/caller query.
        unusedReads: first.queries.filter(
          (query) =>
            query.startsWith('select "settings" from "workspaces"') ||
            query.startsWith(
              'select "id", "root_session_id", "visibility", "authority_epoch", "owner_subject_id", "site_id", "site_access_root_id", "site_viewer_principal", "site_owner_subject_id", "agent_access", "scope_subject_id", "memory_scope" from "sessions"',
            ),
        ).length,
      });
    }
    const self = await f.post(call("session_get"), authorization);
    expect(self.status).toBe(200);
    expect(self.body.result?.isError).not.toBe(true);
    expect(JSON.stringify(self.body)).toContain(f.session.id);
  }
  console.log("MCP_PREPARATION_MEASUREMENTS", JSON.stringify(measurements));
  console.log(
    "MCP_PREPARATION_CATALOG_SHA256",
    new Bun.CryptoHasher("sha256").update(JSON.stringify(catalog)).digest("hex"),
  );
  expect(measurements.every(({ unusedReads }) => unusedReads === 0)).toBe(true);
}, 60_000);

test("MCP HTTP requests retain live-attempt, tenant, private target and host denials", async () => {
  const f = await fixture("user");
  const authorization = await f.bearer();
  const peer = await f.create();
  // Seed an existing private session owned by another person. The request
  // still uses only the restricted application role, never this fixture port.
  await database.admin.begin(async (tx) => {
    const personalWorkspaceId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await tx`insert into workspaces(id, account_id, name, settings) values (${personalWorkspaceId}, ${f.owner.accountId}, 'Other Personal', '{}')`;
    await tx`set local session_replication_role = replica`;
    await tx`insert into organization_memberships(id, account_id, subject_id, role, status, personal_workspace_id)
      values (${membershipId}, ${f.owner.accountId}, 'user:other', 'member', 'active', ${personalWorkspaceId})`;
    await tx`update sessions set visibility = 'user_private', owner_subject_id = 'user:other', owner_organization_membership_id = ${membershipId} where id = ${peer.id}`;
  });
  const denied = await f.post(call("session_get", { sessionId: peer.id }), authorization);
  expect(denied.status).toBe(200);
  expect(denied.body.result?.isError).toBe(true);
  expect(JSON.stringify(denied.body)).not.toContain(peer.initialMessage);
  const foreign = await fixture("workspace");
  const foreignRead = await f.post(
    call("session_get", { sessionId: foreign.session.id }),
    authorization,
  );
  expect(foreignRead.body.result?.isError).toBe(true);
  for (const body of [listTools, call("project_list")]) {
    const stale = await f.post(body, await f.bearer({ attemptId: crypto.randomUUID() }));
    expect(stale.status).toBe(403);
    expect(stale.body.error?.details?.code).toBe("agent_attempt_caller_stale");
  }
  await database.admin`update sessions set active_turn_id = null where id = ${f.session.id}`;
  expect((await f.post(listTools, authorization)).status).toBe(403);
  expect((await f.post(call("project_list"), authorization)).status).toBe(403);
  const host = await fixture("user", {
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => ({ kind: "all" }),
  });
  const hostBearer = await host.bearer();
  expect((await host.post(listTools, hostBearer)).status).toBe(404);
  expect((await host.post(call("project_list"), hostBearer)).status).toBe(404);
}, 60_000);
