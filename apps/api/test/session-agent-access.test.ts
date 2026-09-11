import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
  type Session,
  type SessionAuthorizationListScope,
  type SessionScopeSubjectId,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  resolveSessionMemoryAgentScope,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// ---------------------------------------------------------------------------
// End-to-end proof of the agent-access boundary (migration 0427): sessions are
// created through the public HTTP create, every attempt is a real claimed turn
// whose signed claims the seam validates against durable rows, and every read
// goes through the same MCP tools and HTTP routes a live agent uses.
// ---------------------------------------------------------------------------

const SECRET = "session-agent-access-e2e-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const HUMAN_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
];
const AGENT_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "documents:search",
];
const AGENT_TOOLS = [
  "session_get",
  "session_events",
  "sessions_list",
  "session_create",
  "knowledge_search",
  "knowledge_get",
  "knowledge_browse",
  "knowledge_save",
] as const;
const u1: SessionScopeSubjectId = "user:u_1";
const u2: SessionScopeSubjectId = "user:u_2";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  app: Hono;
  deps: ApiRouteDeps;
  humanBearer: string;
};

type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function dependencies(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "session-agent-access-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({ embedder: undefined }) as never,
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
}

async function fixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-agent-access-e2e",
    accountExternalId: `account-${suffix}`,
    accountName: "Session agent access",
    workspaceExternalSource: "session-agent-access-e2e",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session agent access",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const deps = dependencies();
  const humanBearer = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: HUMAN_PERMISSIONS,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    app: createApp(deps),
    deps,
    humanBearer,
  };
}

async function post(
  f: Fixture,
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await f.app.request(`/v1/workspaces/${f.workspaceId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: bearer },
    body: JSON.stringify({ initialMessage: "hello", model: "scripted-model", ...body }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function createSession(f: Fixture, body: Record<string, unknown>): Promise<Session> {
  // Test identities are asserted by the trusted signing fixture, never by the body.
  const { scopeSubjectId, ...payload } = body;
  const bearer =
    typeof scopeSubjectId === "string"
      ? `Bearer ${await signDelegatedAccessToken(SECRET, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          subjectId: scopeSubjectId,
          permissions: HUMAN_PERMISSIONS,
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1000) + 3_600,
        })}`
      : f.humanBearer;
  const created = await post(f, bearer, payload);
  expect(created.status).toBe(202);
  return created.json as unknown as Session;
}

async function liveAttempt(f: Fixture, sessionId: string): Promise<Attempt> {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
  return {
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

function agentGrant(f: Fixture, attempt: Attempt): AccessGrant {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: `worker:${attempt.sessionId}`,
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      firstPartyMcpTools: [...AGENT_TOOLS],
    },
  };
}

async function agentBearer(f: Fixture, attempt: Attempt): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: `worker:${attempt.sessionId}`,
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt",
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    firstPartyMcpTools: [...AGENT_TOOLS],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function agentServer(f: Fixture, attempt: Attempt) {
  const sessionMemory = await resolveSessionMemoryAgentScope(
    client.db,
    f.workspaceId,
    attempt.sessionId,
    attempt,
  );
  return buildOpenGeniMcpServer(f.deps, agentGrant(f, attempt), {
    workspaceMemoryEnabled: true,
    sessionMemory,
  });
}

function registeredToolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  )
    .filter((name) => !name.startsWith("__opengeni_empty_"))
    .sort();
}

async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: unknown; isError: boolean }> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = (await tool.handler(args, {})) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return { body: JSON.parse(text) as unknown, isError: result.isError === true };
}

/** Every denial surfaces as the seam's non-enumerating "not found or denied". */
async function expectDenied(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toThrow(/Session not found or access denied/u);
}

async function expectAllowed(call: Promise<{ body: unknown; isError: boolean }>): Promise<unknown> {
  const result = await call;
  expect(result.isError).toBe(false);
  return result.body;
}

async function listedIds(server: unknown): Promise<Set<string>> {
  const page = (await expectAllowed(callTool(server, "sessions_list", { limit: 100 }))) as {
    sessions: Array<{ id: string }>;
  };
  return new Set(page.sessions.map((row) => row.id));
}

async function httpGet(f: Fixture, bearer: string, suffix: string): Promise<Response> {
  return await f.app.request(`/v1/workspaces/${f.workspaceId}${suffix}`, {
    headers: { authorization: bearer },
  });
}

async function httpListedIds(f: Fixture, bearer: string, query = ""): Promise<Set<string>> {
  const response = await httpGet(f, bearer, `/sessions${query}`);
  expect(response.status).toBe(200);
  return new Set(((await response.json()) as Array<{ id: string }>).map((row) => row.id));
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-agent-access");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    console.warn("[api-session-agent-access] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("session agent access (real PostgreSQL, HTTP + first-party MCP)", () => {
  test("session-scoped HTTP and MCP lists intersect the host allowlist", async () => {
    if (!available) return;
    const f = await fixture();
    const root = await createSession(f, { agentAccess: "session" });
    const peer = await createSession(f, { agentAccess: "workspace" });
    const attempt = await liveAttempt(f, root.id);
    const server = await agentServer(f, attempt);
    const bearer = await agentBearer(f, attempt);
    const spawned = (await expectAllowed(
      callTool(server, "session_create", { initialMessage: "child" }),
    )) as { resource: { id: string } };
    const childId = spawned.resource.id;
    let scope: SessionAuthorizationListScope = { kind: "all" };
    f.deps.sessionAuthorization = {
      authorizeSession: async () => ({ allowed: true }),
      resolveListScope: async () => scope,
    };
    // Rebuild adapters with the host port installed, as an embedding host would.
    f.app = createApp(f.deps);
    const restrictedServer = await agentServer(f, attempt);
    const cases: Array<[SessionAuthorizationListScope, string[]]> = [
      [{ kind: "scoped", rootSessionIds: [], sessionIds: [] }, []],
      [{ kind: "scoped", rootSessionIds: [], sessionIds: [childId, peer.id] }, [childId]],
      [{ kind: "scoped", rootSessionIds: [childId], sessionIds: [] }, [childId]],
      [{ kind: "scoped", rootSessionIds: [peer.id], sessionIds: [] }, []],
      [{ kind: "scoped", rootSessionIds: [root.id], sessionIds: [] }, [root.id, childId]],
      [{ kind: "all" }, [root.id, childId]],
    ];
    for (const [hostScope, expected] of cases) {
      scope = hostScope;
      expect(await httpListedIds(f, bearer)).toEqual(new Set(expected));
      expect(await listedIds(restrictedServer)).toEqual(new Set(expected));
    }
  });

  test("the create contract stores and projects the scope and rejects an unlabelled user memory", async () => {
    if (!available) return;
    const f = await fixture();
    const created = await createSession(f, {
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    expect(created).toMatchObject({
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    const plain = await createSession(f, {});
    expect(plain).toMatchObject({
      agentAccess: "workspace",
      scopeSubjectId: f.subjectId,
      memoryScope: "workspace",
    });
    const read = await httpGet(f, f.humanBearer, `/sessions/${created.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    expect((await post(f, f.humanBearer, { memoryScope: "user" })).status).toBe(202);
    expect((await post(f, f.humanBearer, { memoryScope: "session" })).status).toBe(422);
    expect(
      (await post(f, f.humanBearer, { scopeSubjectId: { source: "", id: "u_1" } })).status,
    ).toBe(422);
    expect(
      (await post(f, f.humanBearer, { scopeSubjectId: { source: "app", id: "u_1", extra: 1 } }))
        .status,
    ).toBe(422);
    expect((await post(f, f.humanBearer, { agentAccess: "everyone" })).status).toBe(422);
  });

  test("session-scoped trees are isolated from every peer and stay whole inside", async () => {
    if (!available) return;
    const f = await fixture();
    const a = await createSession(f, { agentAccess: "session", scopeSubjectId: u1 });
    const b = await createSession(f, { agentAccess: "session", scopeSubjectId: u1 });
    const c = await createSession(f, { agentAccess: "workspace" });
    const aAttempt = await liveAttempt(f, a.id);
    const bAttempt = await liveAttempt(f, b.id);
    const cAttempt = await liveAttempt(f, c.id);
    const aServer = await agentServer(f, aAttempt);
    const cServer = await agentServer(f, cAttempt);

    // A reaches itself and nothing else, in both MCP and HTTP.
    await expectAllowed(callTool(aServer, "session_get", { sessionId: a.id }));
    await expectAllowed(callTool(aServer, "session_events", { sessionId: a.id }));
    await expectDenied(callTool(aServer, "session_get", { sessionId: b.id }));
    await expectDenied(callTool(aServer, "session_events", { sessionId: b.id }));
    await expectDenied(callTool(aServer, "session_get", { sessionId: c.id }));
    const aBearer = await agentBearer(f, aAttempt);
    expect((await httpGet(f, aBearer, `/sessions/${a.id}/events`)).status).toBe(200);
    expect((await httpGet(f, aBearer, `/sessions/${b.id}/events`)).status).toBe(404);
    expect((await httpGet(f, aBearer, `/sessions/${b.id}`)).status).toBe(404);
    expect((await httpGet(f, aBearer, `/sessions/${b.id}/turns`)).status).toBe(404);
    expect((await httpGet(f, aBearer, `/sessions/${b.id}/queue`)).status).toBe(404);
    expect((await httpGet(f, aBearer, `/sessions/${c.id}/events`)).status).toBe(404);

    // An authorized workspace coordinator can inspect a narrowly scoped task.
    await expectAllowed(callTool(cServer, "session_get", { sessionId: a.id }));
    await expectAllowed(callTool(cServer, "session_events", { sessionId: a.id }));
    await expectAllowed(callTool(cServer, "session_get", { sessionId: c.id }));
    const cBearer = await agentBearer(f, cAttempt);
    expect((await httpGet(f, cBearer, `/sessions/${a.id}/events`)).status).toBe(200);
    expect((await httpGet(f, cBearer, `/sessions/${c.id}/events`)).status).toBe(200);

    // A's child inherits the scope, and the tree stays reachable both ways.
    const spawned = (await expectAllowed(
      callTool(aServer, "session_create", { initialMessage: "child of A" }),
    )) as { resource: { id: string } };
    const childId = spawned.resource.id;
    const child = (await (
      await httpGet(f, f.humanBearer, `/sessions/${childId}`)
    ).json()) as Session;
    expect(child).toMatchObject({
      parentSessionId: a.id,
      rootSessionId: a.id,
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "workspace",
    });
    await expectAllowed(callTool(aServer, "session_get", { sessionId: childId }));
    const childServer = await agentServer(f, await liveAttempt(f, childId));
    await expectAllowed(callTool(childServer, "session_get", { sessionId: a.id }));
    await expectDenied(callTool(childServer, "session_get", { sessionId: b.id }));
    await expectAllowed(callTool(cServer, "session_get", { sessionId: childId }));

    // Discovery is fenced by the same rule, in MCP and HTTP alike.
    expect(await listedIds(aServer)).toEqual(new Set([a.id, childId]));
    expect(await listedIds(cServer)).toEqual(new Set([a.id, b.id, c.id, childId]));
    expect(await httpListedIds(f, aBearer)).toEqual(new Set([a.id, childId]));
    expect(await httpListedIds(f, cBearer)).toEqual(new Set([a.id, b.id, c.id, childId]));
    // Humans keep the complete workspace list.
    expect(await httpListedIds(f, f.humanBearer)).toEqual(new Set([a.id, b.id, c.id, childId]));
    void bAttempt;
  });

  test("user-scoped sessions reach only sessions carrying the same end-user label", async () => {
    if (!available) return;
    const f = await fixture();
    const user1 = await createSession(f, { agentAccess: "user", scopeSubjectId: u1 });
    const user2 = await createSession(f, { agentAccess: "user", scopeSubjectId: u2 });
    const shared1 = await createSession(f, { agentAccess: "workspace", scopeSubjectId: u1 });
    const shared0 = await createSession(f, { agentAccess: "workspace" });
    const user1Server = await agentServer(f, await liveAttempt(f, user1.id));
    const shared1Server = await agentServer(f, await liveAttempt(f, shared1.id));
    const shared0Server = await agentServer(f, await liveAttempt(f, shared0.id));
    await liveAttempt(f, user2.id);

    await expectAllowed(callTool(user1Server, "session_get", { sessionId: shared1.id }));
    await expectDenied(callTool(user1Server, "session_get", { sessionId: user2.id }));
    await expectDenied(callTool(user1Server, "session_get", { sessionId: shared0.id }));
    await expectAllowed(callTool(shared1Server, "session_get", { sessionId: user1.id }));
    await expectAllowed(callTool(shared1Server, "session_get", { sessionId: user2.id }));
    await expectAllowed(callTool(shared1Server, "session_get", { sessionId: shared0.id }));
    await expectAllowed(callTool(shared0Server, "session_get", { sessionId: user1.id }));
    await expectAllowed(callTool(shared0Server, "session_get", { sessionId: shared1.id }));

    expect(await listedIds(user1Server)).toEqual(new Set([user1.id, shared1.id]));
    expect(await listedIds(shared1Server)).toEqual(
      new Set([user1.id, user2.id, shared1.id, shared0.id]),
    );
    expect(await listedIds(shared0Server)).toEqual(
      new Set([user1.id, user2.id, shared1.id, shared0.id]),
    );

    // The human end-user filter is an exact pair.
    expect(
      await httpListedIds(f, f.humanBearer, `?scopeSubjectId=${encodeURIComponent(u1)}`),
    ).toEqual(new Set([user1.id, shared1.id]));
    expect(await httpListedIds(f, f.humanBearer, "?scopeSubjectId=user:u_9")).toEqual(new Set());
    expect((await httpGet(f, f.humanBearer, "/sessions?endUserSource=app")).status).toBe(400);
    expect((await httpGet(f, f.humanBearer, "/sessions?endUserId=u_1")).status).toBe(400);
  });

  test("a child may only narrow its parent's scope, through HTTP and the session_create tool", async () => {
    if (!available) return;
    const f = await fixture();
    const parent = await createSession(f, {
      agentAccess: "user",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    const attempt = await liveAttempt(f, parent.id);
    const bearer = await agentBearer(f, attempt);
    const widenAccess = await post(f, bearer, { agentAccess: "workspace" });
    expect(widenAccess.status).toBe(403);
    expect(widenAccess.json).toMatchObject({
      error: { message: "child agent access may only narrow the parent session" },
    });
    expect((await post(f, bearer, { scopeSubjectId: u2 })).status).toBe(422);
    expect((await post(f, bearer, { memoryScope: "user" })).status).toBe(403);
    expect((await post(f, bearer, { memoryScope: "workspace" })).status).toBe(403);
    const inherited = await post(f, bearer, {});
    expect(inherited.status).toBe(202);
    expect(inherited.json).toMatchObject({
      parentSessionId: parent.id,
      agentAccess: "user",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    const narrowed = await post(f, bearer, { agentAccess: "session", memoryScope: "off" });
    expect(narrowed.status).toBe(202);
    expect(narrowed.json).toMatchObject({
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "off",
    });

    const server = await agentServer(f, attempt);
    const viaTool = (await expectAllowed(
      callTool(server, "session_create", { initialMessage: "tool child", memoryScope: "off" }),
    )) as { resource: { id: string } };
    const toolChild = (await (
      await httpGet(f, f.humanBearer, `/sessions/${viaTool.resource.id}`)
    ).json()) as Session;
    expect(toolChild).toMatchObject({
      agentAccess: "user",
      scopeSubjectId: u1,
      memoryScope: "off",
    });
    // The model surface cannot even name the parent-owned fields.
    const rejected = await callTool(server, "session_create", {
      initialMessage: "widened",
      agentAccess: "workspace",
    });
    expect(rejected.isError).toBe(true);
    const relabelled = await callTool(server, "session_create", {
      initialMessage: "relabelled",
      scopeSubjectId: u2,
    });
    expect(relabelled.isError).toBe(true);
    const widenedMemory = await callTool(server, "session_create", {
      initialMessage: "wider memory",
      memoryScope: "workspace",
    });
    expect(widenedMemory.isError).toBe(true);
  });

  test("Knowledge follows personal/shared scope while Off blocks only authoring", async () => {
    if (!available) return;
    const f = await fixture();
    const owner = await createSession(f, { memoryScope: "user" });
    const peer = await createSession(f, {});
    const silent = await createSession(f, { memoryScope: "off" });
    const ownerServer = await agentServer(f, await liveAttempt(f, owner.id));
    const peerServer = await agentServer(f, await liveAttempt(f, peer.id));
    const silentServer = await agentServer(f, await liveAttempt(f, silent.id));
    expect(registeredToolNames(ownerServer)).not.toContain("memory_save");
    expect(registeredToolNames(silentServer)).toContain("knowledge_search");
    const request = (content: string) => ({
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { kind: "fact", title: "Quokka deployment", content },
    });
    const saved = (await expectAllowed(
      callTool(ownerServer, "knowledge_save", request("quokka deployment is Tuesday")),
    )) as { entryId: string };
    const [row] = await shared!.admin<Array<{ scope: string; subject: string }>>`
      select scope,scope_subject_id as subject from knowledge_entries where id=${saved.entryId}`;
    expect(row).toEqual({ scope: "personal", subject: f.subjectId });
    const search = async (server: Awaited<ReturnType<typeof agentServer>>) =>
      (
        (await expectAllowed(callTool(server, "knowledge_search", { query: "quokka" }))) as {
          entries: { id: string }[];
        }
      ).entries.map((e) => e.id);
    expect(await search(ownerServer)).toEqual([saved.entryId]);
    expect(await search(peerServer)).toEqual([]);
    const sharedEntry = (await expectAllowed(
      callTool(peerServer, "knowledge_save", request("quokka shared pricing")),
    )) as { entryId: string };
    expect(new Set(await search(ownerServer))).toEqual(
      new Set([saved.entryId, sharedEntry.entryId]),
    );
    expect(await search(silentServer)).toEqual([sharedEntry.entryId]);
    expect(
      (await callTool(silentServer, "knowledge_save", request("quokka must not be saved"))).isError,
    ).toBe(true);
  });
});
