import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type SessionAuthorizationPort } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  acquireLease,
  claimSessionWorkForAttempt,
  commitWarmingToWarm,
  createDb,
  createSession,
  createSessionMcpServers,
  initializeSessionStartAtomically,
  listSessionEvents,
  mutateSessionControlInTransaction,
  withWorkspaceRls,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { registerSessionRoutes } from "../src/routes/sessions";

const SECRET = "session-authorization-route-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-authorization");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function appWith(port?: SessionAuthorizationPort): Hono {
  const noop = async () => undefined;
  const app = new Hono();
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      streamTokenSecret: "session-authorization-stream-secret",
      sandboxOwnershipEnabled: true,
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
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    ...(port ? { sessionAuthorization: port } : {}),
  } as unknown as ApiRouteDeps);
  return app;
}

function fullAppWith(port: SessionAuthorizationPort): Hono {
  return createApp({
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    sessionAuthorization: port,
  });
}

async function callMcpTool<T>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-authorization-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session authorization",
    workspaceExternalSource: "session-authorization-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session authorization",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const root = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "private root",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  const child = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    parentSessionId: root.id,
    initialMessage: "private child",
    initialTurnInstructions: "host-only selected-record context",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  const hidden = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "hidden sibling",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return { grant, root, child, hidden, authorization };
}

describe("embedding host session authorization routes", () => {
  test("updates MCP approval policy with session-control authority and one durable event", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionMcpServers(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      servers: [
        {
          id: "external_tools",
          url: "https://tools.example.test/mcp",
          requireApproval: false,
        },
      ],
    });
    const decisions: Array<{ operation: string; surface: string }> = [];
    const app = appWith({
      authorizeSession: async ({ operation, surface }) => {
        decisions.push({ operation, surface });
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const requireApproval = Array.from({ length: 245 }, (_, index) => `write_tool_${index}`);
    const path =
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}` +
      "/mcp-servers/external_tools/approval-policy";
    const request = () =>
      app.request(path, {
        method: "PATCH",
        headers: {
          authorization: value.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requireApproval }),
      });

    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      server: { id: "external_tools", requireApproval: [...requireApproval].sort() },
      effectiveFrom: "next_attempt",
    });
    expect(decisions).toContainEqual({
      operation: "session.mcp.approval_policy.write",
      surface: "http",
    });
    expect(decisions).toContainEqual({
      operation: "session.mcp.approval_policy.write",
      surface: "core",
    });

    expect((await request()).status).toBe(200);
    const policyEvents = (
      await listSessionEvents(client.db, value.grant.workspaceId, value.child.id)
    ).filter((event) => event.type === "session.mcp.approval_policy.updated");
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0]?.payload).toEqual({
      serverId: "external_tools",
      effectiveFrom: "next_attempt",
    });
  });

  test("classifies approval-policy requests before returning precise 400 and 404 responses", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionMcpServers(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      servers: [{ id: "external_tools", url: "https://tools.example.test/mcp" }],
    });
    const decisions: string[] = [];
    const app = appWith({
      authorizeSession: async ({ operation }) => {
        decisions.push(operation);
        return { allowed: true, relatedSessionAccess: "target" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const base = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/mcp-servers`;
    const request = (path: string, body: string) =>
      app.request(path, {
        method: "PATCH",
        headers: {
          authorization: value.authorization,
          "content-type": "application/json",
        },
        body,
      });

    expect((await request(`${base}/external_tools/approval-policy`, "{")).status).toBe(400);
    expect(
      (
        await request(
          `${base}/external_tools/approval-policy`,
          JSON.stringify({ requireApproval: "sometimes" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `${base}/${encodeURIComponent("bad server")}/approval-policy`,
          JSON.stringify({ requireApproval: false }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/v1/workspaces/${value.grant.workspaceId}/sessions/${crypto.randomUUID()}` +
            "/mcp-servers/external_tools/approval-policy",
          JSON.stringify({ requireApproval: false }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `${base}/missing_tools/approval-policy`,
          JSON.stringify({ requireApproval: false }),
        )
      ).status,
    ).toBe(404);
    expect(decisions).toHaveLength(5);
    expect(new Set(decisions)).toEqual(new Set(["session.mcp.approval_policy.write"]));
  });

  test("public turn and queue reads omit host instructions while the worker claim retains them", async () => {
    if (!available) return;
    const value = await fixture();
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    if (!started.turn) throw new Error("test session did not create an initial turn");
    const app = appWith({
      authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "target" }),
      resolveListScope: async () => ({ kind: "all" }),
    });
    const headers = { authorization: value.authorization };
    const base = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}`;

    const turnsResponse = await app.request(`${base}/turns`, { headers });
    expect(turnsResponse.status).toBe(200);
    const turns = (await turnsResponse.json()) as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0]).not.toHaveProperty("turnInstructions");

    const queueResponse = await app.request(`${base}/queue`, { headers });
    expect(queueResponse.status).toBe(200);
    const queue = (await queueResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).not.toHaveProperty("turnInstructions");

    const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.child.id,
      workflowId: `session-${value.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toMatchObject({
      action: "claimed",
      turn: { turnInstructions: "host-only selected-record context" },
    });
  });

  test("enforces root-aware detail authorization and in-query list scope", async () => {
    if (!available) return;
    const value = await fixture();
    const decisions: Array<{
      sessionId: string;
      rootSessionId: string;
      operation: string;
      surface: string;
    }> = [];
    const app = appWith({
      authorizeSession: async ({ target, operation, surface }) => {
        decisions.push({ ...target, operation, surface });
        return target.rootSessionId === value.root.id
          ? { allowed: true, relatedSessionAccess: "root" }
          : { allowed: false, reason: "not_found" };
      },
      resolveListScope: async () => ({
        kind: "scoped",
        rootSessionIds: [value.root.id],
        sessionIds: [],
      }),
    });
    const headers = { authorization: value.authorization };
    const base = `/v1/workspaces/${value.grant.workspaceId}/sessions`;

    expect((await app.request(`${base}/${value.child.id}`, { headers })).status).toBe(200);
    expect((await app.request(`${base}/${value.hidden.id}`, { headers })).status).toBe(404);
    expect(decisions).toContainEqual({
      sessionId: value.child.id,
      rootSessionId: value.root.id,
      operation: "session.read",
      surface: "http",
    });

    expect(
      (
        await app.request(`${base}/${value.child.id}/composer-draft`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect(decisions).toContainEqual({
      sessionId: value.child.id,
      rootSessionId: value.root.id,
      operation: "session.composer.read",
      surface: "http",
    });
    expect(decisions).toContainEqual({
      sessionId: value.child.id,
      rootSessionId: value.root.id,
      operation: "session.composer.read",
      surface: "core",
    });

    const listed = await app.request(`${base}?view=page`, { headers });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      pinned: Array<{ id: string }>;
      sessions: Array<{ id: string }>;
    };
    expect(new Set([...page.pinned, ...page.sessions].map((session) => session.id))).toEqual(
      new Set([value.root.id, value.child.id]),
    );
  });

  test("redacts related-session projections for an exact share", async () => {
    if (!available) return;
    const value = await fixture();
    const app = appWith({
      authorizeSession: async ({ target }) =>
        target.sessionId === value.child.id
          ? { allowed: true }
          : { allowed: false, reason: "not_found" },
      resolveListScope: async () => ({
        kind: "scoped",
        rootSessionIds: [],
        sessionIds: [value.child.id],
      }),
    });
    const headers = { authorization: value.authorization };
    const base = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}`;
    const detail = await app.request(base, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: value.child.id,
      parentSessionId: null,
      treeStats: {
        directChildren: 0,
        totalDescendants: 0,
      },
    });
    const lineage = await app.request(`${base}/lineage`, { headers });
    expect(lineage.status).toBe(200);
    expect(await lineage.json()).toEqual({ ancestors: [], children: [], truncated: false });

    await withWorkspaceRls(client.db, value.grant.workspaceId, (scoped) =>
      scoped.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof client.db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId,
          sessionId: value.root.id,
          actor: { type: "human", subjectId: value.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
          reason: "private parent reason",
        }),
      ),
    );
    const queue = await app.request(`${base}/queue`, { headers });
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({
      effectiveControl: {
        state: "paused",
        primaryBlocker: {
          kind: "session",
          displayName: "An ancestor session",
          actor: null,
          reason: null,
          revision: 0,
        },
        additionalBlockerCount: 0,
      },
    });

    const sharedSibling = await createSession(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      initialMessage: "same sandbox group but not shared",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "modal",
      sandboxGroupId: value.child.sandboxGroupId,
    });
    const acquired = await acquireLease(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sandboxGroupId: value.child.sandboxGroupId,
      kind: "turn",
      holderId: "session-authorization-shared-capability",
      subjectId: value.child.id,
      backend: "none",
      leaseTtlMs: 5_000,
    });
    if (acquired.role !== "spawner") throw new Error("test lease was not acquired");
    const committed = await commitWarmingToWarm(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sandboxGroupId: value.child.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "session-authorization-warm-box",
      dataPlaneUrl: null,
      resumeBackendId: "none",
      resumeState: { backendId: "none" },
      leaseTtlMs: 5_000,
    });
    expect(committed.committed).toBe(true);
    const capabilities = await app.request(`${base}/stream-capabilities`, { headers });
    expect(capabilities.status).toBe(200);
    expect((await capabilities.json()) as unknown).toMatchObject({
      DesktopStream: { shared: true, sharedSessionIds: [] },
    });
    expect(sharedSibling.id).not.toBe(value.child.id);
  });

  test("authorizes every session-bound first-party MCP request at the transport seam", async () => {
    if (!available) return;
    const value = await fixture();
    const calls: Array<{ operation: string; surface: string; sessionId: string }> = [];
    const port: SessionAuthorizationPort = {
      authorizeSession: async ({ operation, surface, target }) => {
        calls.push({ operation, surface, sessionId: target.sessionId });
        return { allowed: true };
      },
      resolveListScope: async () => ({ kind: "all" }),
    };
    const token = await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      permissions: ["workspace:read", "sessions:read"],
      sessionId: value.child.id,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const response = await fullAppWith(port).request(
      `/v1/workspaces/${value.grant.workspaceId}/mcp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "session-authorization-test", version: "1" },
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      operation: "session.first_party_mcp.call",
      surface: "first_party_mcp",
      sessionId: value.child.id,
    });

    const denied = await fullAppWith({
      authorizeSession: async () => ({ allowed: false, reason: "revoked" }),
      resolveListScope: async () => ({ kind: "all" }),
    }).request(`/v1/workspaces/${value.grant.workspaceId}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(denied.status).toBe(404);
  });

  test("applies exact host scope to first-party MCP target reads and discovery", async () => {
    if (!available) return;
    const value = await fixture();
    const calls: Array<{ sessionId: string; operation: string; surface: string }> = [];
    const port: SessionAuthorizationPort = {
      authorizeSession: async ({ target, operation, surface }) => {
        calls.push({ sessionId: target.sessionId, operation, surface });
        return target.sessionId === value.child.id
          ? { allowed: true }
          : { allowed: false, reason: "not_found" };
      },
      resolveListScope: async () => ({
        kind: "scoped",
        rootSessionIds: [],
        sessionIds: [value.child.id],
      }),
    };
    const noop = async () => undefined;
    const server = buildOpenGeniMcpServer(
      {
        settings: testSettings(),
        db: client.db,
        bus: new MemoryEventBus(),
        workflowClient: {
          wakeSessionWorkflow: noop,
          requestSessionWorkflowWakeDispatch: noop,
        } as unknown as SessionWorkflowClient,
        objectStorage: null,
        githubStateSecret: "test",
        documentIndexer: { indexDocument: noop },
        getDocumentServices: () => ({}) as never,
        sessionAuthorization: port,
      } as unknown as ApiRouteDeps,
      value.grant,
    );
    const detail = await callMcpTool<{ id: string; parentSessionId: string | null }>(
      server,
      "session_get",
      { sessionId: value.child.id },
    );
    expect(detail).toMatchObject({ id: value.child.id, parentSessionId: null });
    expect(calls).toContainEqual({
      sessionId: value.child.id,
      operation: "session.read",
      surface: "first_party_mcp",
    });
    await expect(
      callMcpTool(server, "session_get", { sessionId: value.hidden.id }),
    ).rejects.toThrow("Session not found or access denied");

    const listed = await callMcpTool<{
      sessions: Array<{ id: string; parentSessionId: string | null }>;
    }>(server, "sessions_list", {});
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id: value.child.id, parentSessionId: null }),
    ]);
  });

  test("reconstructs live agent-attempt authority and rejects the same token after settlement", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    if (!started.turn) throw new Error("test session did not create an initial turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.child.id,
      workflowId: `session-${value.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`test attempt was not claimed`);
    const actors: unknown[] = [];
    const app = appWith({
      authorizeSession: async ({ actor }) => {
        actors.push(actor);
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const token = await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: "worker:session-authorization-test",
      permissions: ["sessions:read"],
      sessionId: value.child.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const headers = { authorization: `Bearer ${token}` };
    const path = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}`;
    expect((await app.request(path, { headers })).status).toBe(200);
    expect(actors).toContainEqual({
      kind: "agent_attempt",
      subjectId: "worker:session-authorization-test",
      callerSessionId: value.child.id,
      callerRootSessionId: value.root.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      initiator: {
        kind: "subject",
        subjectId: value.grant.subjectId,
        label: "Test owner",
      },
      initiatorContext: { label: "Test owner" },
    });

    const admin = postgres(shared.adminUrl, { max: 1 });
    try {
      await admin`
        update session_turn_attempts
        set state = 'closed', outcome = 'completed', closed_at = now()
        where workspace_id = ${value.grant.workspaceId} and id = ${attemptId}
      `;
    } finally {
      await admin.end();
    }
    const callCount = actors.length;
    expect((await app.request(path, { headers })).status).toBe(404);
    expect(actors).toHaveLength(callCount);
  });

  test("fails closed for unavailable policy and unclassified future surfaces", async () => {
    if (!available) return;
    const value = await fixture();
    const app = appWith({
      authorizeSession: async () => {
        throw new Error("host unavailable");
      },
      resolveListScope: async () => {
        throw new Error("host unavailable");
      },
    });
    const headers = { authorization: value.authorization };
    const base = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.root.id}`;
    expect((await app.request(base, { headers })).status).toBe(503);
    expect((await app.request(`${base}/future-surface`, { headers })).status).toBe(503);
  });

  test("preserves standalone workspace behavior when no port is bound", async () => {
    if (!available) return;
    const value = await fixture();
    const response = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.hidden.id}`,
      { headers: { authorization: value.authorization } },
    );
    expect(response.status).toBe(200);
  });
});
