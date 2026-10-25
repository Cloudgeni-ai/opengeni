import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  SessionBackgroundCommandListResponse,
  type McpMutationReceiptType,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import {
  acceptSessionHumanInputResponse,
  bootstrapWorkspace,
  acquireLease,
  claimSessionWorkForAttempt,
  commitWarmingToWarm,
  createDb,
  createSession,
  createSessionMcpServers,
  createScheduledTask,
  deleteScheduledTask,
  getActiveSessionHistoryItems,
  initializeSessionStartAtomically,
  listSessionEvents,
  applySessionTurnSettlement,
  getSessionHumanInputRequest,
  mutateSessionControlInTransaction,
  submitHumanPromptInTransaction,
  updateSessionTitle,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceSessionActivityRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createLegacyVariableSet } from "../../../packages/db/test/helpers/legacy-variable-sets";
import {
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { registerSessionRoutes } from "../src/routes/sessions";

const SECRET = "session-authorization-route-test-secret";
const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 73).toString("base64");
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

function appWith(
  port?: SessionAuthorizationPort,
  database: Database = client.db,
  settingsOverrides: Parameters<typeof testSettings>[0] = {},
): Hono {
  const noop = async () => undefined;
  const app = new Hono();
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      streamTokenSecret: "session-authorization-stream-secret",
      sandboxOwnershipEnabled: true,
      ...settingsOverrides,
    }),
    db: database,
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
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    sessionAuthorization: port,
  });
}

test("workspace commands use the live host list scope and reject malformed cursors", async () => {
  if (!available || !shared) return;
  const value = await fixture();
  const ids = [value.root.id, value.hidden.id];
  for (const sessionId of ids)
    await shared.admin`insert into session_background_commands (
    account_id, workspace_id, session_id, provider, control_workspace_id, enrollment_id,
    connection_instance_id, op_id, command_preview
  ) values (${value.grant.accountId}, ${value.grant.workspaceId}, ${sessionId}, 'connected_machine',
    ${value.grant.workspaceId}, ${crypto.randomUUID()}, 'workspace-commands', ${crypto.randomUUID()}, 'bun run dev')`;
  let allowed = true;
  const app = fullAppWith({
    authorizeSession: async () => ({ allowed: false, reason: "not_found" }),
    resolveListScope: async () => ({
      kind: "scoped",
      rootSessionIds: [],
      sessionIds: allowed ? [value.root.id] : [],
    }),
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    subjectId: value.grant.subjectId,
    permissions: ["sessions:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const path = `/v1/workspaces/${value.grant.workspaceId}/sessions?view=running_commands`;
  const read = await app.request(path, { headers: { authorization } });
  expect(read.status).toBe(200);
  expect(
    (await read.json()).commands.map((command: { sessionId: string }) => command.sessionId),
  ).toEqual([value.root.id]);
  allowed = false;
  const revoked = await app.request(path, { headers: { authorization } });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ commands: [], nextCursor: null });
  expect(
    (await app.request(`${path}&cursor=external`, { headers: { authorization } })).status,
  ).toBe(400);
});

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
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  const child = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    parentSessionId: root.id,
    initialMessage: "private child",
    initialModelContext: "host-only selected-record context",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
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
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return { grant, root, child, hidden, authorization };
}

describe("embedding host session authorization routes", () => {
  test("background-command diagnostics preserve the read boundary without observing the command", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    const commandId = crypto.randomUUID();
    await shared.admin`insert into session_background_commands ${shared.admin({
      id: commandId,
      account_id: value.grant.accountId,
      workspace_id: value.grant.workspaceId,
      session_id: value.root.id,
      provider: "connected_machine",
      state: "running",
      control_workspace_id: value.grant.workspaceId,
      enrollment_id: crypto.randomUUID(),
      connection_instance_id: crypto.randomUUID(),
      op_id: crypto.randomUUID(),
      last_reconcile_outcome: "provider_offline",
      reconcile_attempts: 2,
    })}`;
    const before =
      await shared.admin`select row_to_json(c) as value from session_background_commands c where id=${commandId}`;
    const targets: string[] = [];
    const app = fullAppWith({
      authorizeSession: async ({ target: { sessionId } }) => {
        targets.push(sessionId);
        return sessionId === value.root.id
          ? { allowed: true, relatedSessionAccess: "target" }
          : { allowed: false, reason: "not_found" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      permissions: ["sessions:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const path = (id: string) =>
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${id}/background-commands`;
    const response = await app.request(path(value.root.id), { headers: { authorization } });
    expect(response.status).toBe(200);
    const body = SessionBackgroundCommandListResponse.parse(await response.json());
    expect(body.commands[0]).toMatchObject({
      id: commandId,
      state: "running",
      observationStatus: "unavailable",
      reconciliation: { lastOutcome: "provider_offline", attempts: 2, terminalProof: null },
    });
    const denied = await app.request(path(value.hidden.id), { headers: { authorization } });
    expect(denied.status).toBe(404);
    expect(targets).toContain(value.root.id);
    expect(targets).toContain(value.hidden.id);
    const after =
      await shared.admin`select row_to_json(c) as value from session_background_commands c where id=${commandId}`;
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  test("rejects operator-disabled HTTP relevance discovery before storage", async () => {
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `user:${crypto.randomUUID()}`;
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId,
      workspaceId,
      subjectId,
      permissions: ["sessions:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    let databaseTouches = 0;
    const database = new Proxy(
      {},
      {
        get() {
          databaseTouches += 1;
          throw new Error("disabled work discovery reached storage");
        },
      },
    ) as Database;
    const app = appWith(
      {
        authorizeSession: async () => ({ allowed: true }),
        resolveListScope: async () => ({ kind: "all" }),
      },
      database,
      { workDiscoveryEnabled: false },
    );

    const response = await app.request(
      `/v1/workspaces/${workspaceId}/agent-topology?query=permission-scoped`,
      { headers: { authorization } },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("work discovery is disabled");
    expect(databaseTouches).toBe(0);
  });

  test("projects the independent human-advisory rollout decision", async () => {
    if (!available) return;
    const value = await fixture();
    const app = appWith(
      {
        authorizeSession: async () => ({ allowed: true }),
        resolveListScope: async () => ({ kind: "all" }),
      },
      client.db,
      { workDiscoveryHumanAdvisoriesEnabled: false },
    );

    const response = await app.request(`/v1/workspaces/${value.grant.workspaceId}/agent-topology`, {
      headers: { authorization: value.authorization },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{
        relatedWork: { advisoryOnly: boolean; noAdditionalAccess: boolean };
      }>;
      humanAdvisoriesEnabled: boolean;
    };
    expect(body.humanAdvisoriesEnabled).toBe(false);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(
      body.sessions.every(
        (session) =>
          session.relatedWork.advisoryOnly === true &&
          session.relatedWork.noAdditionalAccess === true,
      ),
    ).toBe(true);
  });

  test("keeps the legacy raw revision array and exposes pagination separately", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    await shared.admin`
      insert into session_goals (account_id, workspace_id, session_id, text)
      values (
        ${value.grant.accountId}, ${value.grant.workspaceId}, ${value.child.id},
        'API revision compatibility goal'
      )`;

    const rawResponse = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal/revisions`,
      { headers: { authorization: value.authorization } },
    );
    expect(rawResponse.status).toBe(200);
    const raw = (await rawResponse.json()) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);

    const pageResponse = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal/revisions/page?limit=1`,
      { headers: { authorization: value.authorization } },
    );
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.json()).toMatchObject({
      revisions: expect.any(Array),
      hasMore: false,
      nextCursor: null,
    });

    const malformedPageResponse = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal/revisions/page?limit=not-a-number`,
      { headers: { authorization: value.authorization } },
    );
    expect(malformedPageResponse.status).toBe(400);
    expect(await malformedPageResponse.text()).toStartWith(
      "invalid goal revision page query: limit: ",
    );

    await shared.admin`
      insert into session_goals (account_id, workspace_id, session_id, text)
      values (
        ${value.grant.accountId}, ${value.grant.workspaceId}, ${value.root.id},
        'Foreign cursor anchor goal'
      )`;
    const [foreignRevision] = await shared.admin<{ id: string }[]>`
      select id
      from session_goal_revisions
      where account_id = ${value.grant.accountId}
        and workspace_id = ${value.grant.workspaceId}
        and session_id = ${value.root.id}
      order by created_at desc, id desc
      limit 1`;
    if (!foreignRevision) throw new Error("foreign goal revision fixture was not created");
    const foreignCursorResponse = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal/revisions/page?limit=1&before=${foreignRevision.id}`,
      { headers: { authorization: value.authorization } },
    );
    expect(foreignCursorResponse.status).toBe(409);
    expect(await foreignCursorResponse.text()).toBe(
      "goal revision cursor is not visible in this session",
    );
  });

  test("GET goal ignores a malformed legacy continuation instead of returning 500", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    await shared.admin`
      update sessions
      set status = 'idle'
      where id = ${value.child.id} and workspace_id = ${value.grant.workspaceId}`;
    const [goal] = await shared.admin<{ id: string }[]>`
      insert into session_goals (account_id, workspace_id, session_id, text)
      values (
        ${value.grant.accountId}, ${value.grant.workspaceId}, ${value.child.id},
        'API malformed continuation goal'
      )
      returning id`;
    if (!goal) throw new Error("goal fixture was not created");
    await shared.admin`
      insert into session_system_updates (
        account_id, workspace_id, session_id, kind, source_id,
        dedupe_key, summary, payload
      ) values (
        ${value.grant.accountId}, ${value.grant.workspaceId}, ${value.child.id},
        'goal_continuation', ${goal.id}, ${`api-malformed-${crypto.randomUUID()}`},
        'malformed API continuation',
        ${shared.admin.json({
          type: "goal_continuation",
          goalId: goal.id,
          goalVersion: "not-an-integer",
          prompt: "continue safely",
        })}
      )`;

    const response = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal`,
      { headers: { authorization: value.authorization } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      continuation?: { state?: string; reason?: string };
    };
    expect(body.continuation).toMatchObject({
      state: "invariant_broken",
      reason: "missing_obligation",
    });
  });

  test("GET goal answers 200 null for a goal-less session only when the client opts in", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    const goalPath = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/goal`;
    const headers = { authorization: value.authorization };

    // Existing clients keep the original 404 contract.
    const legacy = await appWith().request(goalPath, { headers });
    expect(legacy.status).toBe(404);

    const optedIn = await appWith().request(`${goalPath}?absent=null`, { headers });
    expect(optedIn.status).toBe(200);
    expect(await optedIn.json()).toBeNull();

    // Only the exact opt-in value changes the answer.
    const otherValue = await appWith().request(`${goalPath}?absent=empty`, { headers });
    expect(otherValue.status).toBe(404);

    // A missing session is still a 404, opt-in or not.
    const missingSession = await appWith().request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${crypto.randomUUID()}/goal?absent=null`,
      { headers },
    );
    expect(missingSession.status).toBe(404);

    // A session with a goal returns it either way.
    await shared.admin`
      insert into session_goals (account_id, workspace_id, session_id, text)
      values (
        ${value.grant.accountId}, ${value.grant.workspaceId}, ${value.child.id},
        'API absent opt-in goal'
      )`;
    const withGoal = await appWith().request(`${goalPath}?absent=null`, { headers });
    expect(withGoal.status).toBe(200);
    expect(((await withGoal.json()) as { text?: string }).text).toBe("API absent opt-in goal");
  });

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

  test("answers 410 variable_sets_removed for the retired session Variable Set route", async () => {
    if (!available) return;
    const value = await fixture();
    const app = appWith({
      authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "root" }),
      resolveListScope: async () => ({ kind: "all" }),
    });
    const response = await app.request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/variable-sets`,
      {
        method: "PUT",
        headers: { authorization: value.authorization, "content-type": "application/json" },
        body: JSON.stringify({ variableSetIds: [crypto.randomUUID()] }),
      },
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "variable_sets_removed",
      details: { vaultsPath: "/vaults" },
    });
    const [session] = await shared!.admin<Array<{ variableSetIds: string[] }>>`
      select variable_set_ids as "variableSetIds" from sessions
      where workspace_id = ${value.grant.workspaceId} and id = ${value.child.id}
    `;
    expect(session).toEqual({ variableSetIds: [] });
  });

  test("rejects non-empty legacy Variable Set create fields with 422 and accepts empty ones", async () => {
    if (!available) return;
    const value = await fixture();
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      permissions: ["sessions:create", "sessions:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const app = appWith(undefined);
    const create = (legacy: Record<string, unknown>) =>
      app.request(`/v1/workspaces/${value.grant.workspaceId}/sessions`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ initialMessage: "legacy field probe", ...legacy }),
      });
    const legacyId = crypto.randomUUID();
    for (const [legacy, fields] of [
      [{ variableSetIds: [legacyId] }, ["variableSetIds"]],
      [{ variableSetId: legacyId }, ["variableSetId"]],
      [{ environmentId: legacyId }, ["environmentId"]],
    ] as const) {
      const response = await create(legacy);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "variable_sets_removed",
        details: { fields },
      });
    }
    const accepted = await create({ variableSetIds: [], variableSetId: null, environmentId: null });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ variableSetIds: [] });
  });

  test("preserves unrelated create-time foreign key failures", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    const variableSet = await createLegacyVariableSet(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      name: `session-create-unrelated-fk-${crypto.randomUUID()}`,
    });
    let failure: unknown;
    try {
      await createSession(client.db, {
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId,
        initialMessage: "unrelated create FK",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "modal",
        variableSetIds: [variableSet.id],
        variableSetId: variableSet.id,
        createdBy: { kind: "subject", subjectId: value.grant.subjectId, label: "Test owner" },
        createdByContext: {},
        subjectId: value.grant.subjectId,
        beforeCreateCommit: async () => {
          await shared.admin`
            insert into session_variable_set_attachments (
              account_id,
              workspace_id,
              session_id,
              variable_set_id,
              position,
              session_status
            ) values (
              ${value.grant.accountId},
              ${value.grant.workspaceId},
              ${crypto.randomUUID()},
              ${variableSet.id},
              0,
              'queued'
            )
          `;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as { code?: string } | undefined)?.code).toBe("23503");
    expect((failure as { constraint_name?: string } | undefined)?.constraint_name).toBe(
      "session_variable_set_attachments_session_fk",
    );
  });

  test("updates the durable session tool policy and returns a version conflict", async () => {
    if (!available) return;
    const value = await fixture();
    const decisions: Array<{ operation: string; surface: string }> = [];
    const app = appWith({
      authorizeSession: async ({ operation, surface }) => {
        decisions.push({ operation, surface });
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const path = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/tool-policy`;
    const request = (expectedVersion: number) =>
      app.request(path, {
        method: "PUT",
        headers: {
          authorization: value.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: "explicit",
          tools: [],
          firstPartyMcpTools: [],
          expectedVersion,
        }),
      });

    const response = await request(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: value.child.id,
      tools: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: value.root.id },
      toolPolicyVersion: 2,
    });
    expect(decisions).toContainEqual({
      operation: "session.tool_policy.write",
      surface: "http",
    });
    expect(decisions).toContainEqual({
      operation: "session.tool_policy.write",
      surface: "core",
    });

    const conflict = await request(1);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "SESSION_TOOL_POLICY_CONFLICT",
      currentVersion: 2,
    });
    const policyEvents = (
      await listSessionEvents(client.db, value.grant.workspaceId, value.child.id)
    ).filter((event) => event.type === "session.tool_policy.updated");
    expect(policyEvents).toHaveLength(1);
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

  test("authorizes browser activation as realtime control before validating its body", async () => {
    if (!available) return;
    const value = await fixture();
    const decisions: Array<{ operation: string; surface: string }> = [];
    const app = appWith({
      authorizeSession: async ({ operation, surface }) => {
        decisions.push({ operation, surface });
        return { allowed: true, relatedSessionAccess: "target" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const response = await app.request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}` +
        `/realtime/${crypto.randomUUID()}/connections/${crypto.randomUUID()}/activate`,
      {
        method: "POST",
        headers: {
          authorization: value.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(422);
    expect(decisions).toContainEqual({
      operation: "session.realtime.control",
      surface: "http",
    });
  });

  test("public projections omit model context while canonical history retains it", async () => {
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
    expect(turns[0]).not.toHaveProperty("modelContext");

    const acceptedQueueResponse = await app.request(`${base}/queue`, { headers });
    expect(acceptedQueueResponse.status).toBe(200);
    const acceptedQueue = (await acceptedQueueResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(acceptedQueue.items).toHaveLength(0);

    const queuedSubmission = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      value.grant.workspaceId,
      value.grant.subjectId,
      (db) =>
        submitHumanPromptInTransaction(db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId,
          sessionId: value.child.id,
          subjectId: value.grant.subjectId,
          actor: { type: "human", subjectId: value.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "queued projection probe",
          modelContext: "queued host-only context",
          resources: [],
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          reasoningEffortFallback: "low",
          source: "user",
        }),
    );
    expect(queuedSubmission.routing).toBe("queued_for_execution");

    const queueResponse = await app.request(`${base}/queue`, { headers });
    expect(queueResponse.status).toBe(200);
    const queue = (await queueResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).not.toHaveProperty("modelContext");

    const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.child.id,
      workflowId: `session-${value.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toMatchObject({ action: "claimed", turn: { id: started.turn.id } });
    if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
    expect(claimed.turn).not.toHaveProperty("modelContext");
    const history = await getActiveSessionHistoryItems(
      client.db,
      value.grant.workspaceId,
      value.child.id,
    );
    expect(JSON.stringify(history[0]?.item)).toContain("host-only selected-record context");
    expect(JSON.stringify(history[0]?.item)).toContain("private child");
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
    expect(
      (await app.request(`${base}/${value.hidden.id}/codex-accounts`, { headers })).status,
    ).toBe(404);
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
    expect(await lineage.json()).toEqual({
      ancestors: [],
      children: [],
      truncated: false,
      sessionHasSchedules: false,
      sessionHasUpcomingSchedules: false,
      sessionWaitingForEvents: false,
    });

    await withWorkspaceSessionActivityRls(client.db, value.grant.workspaceId, (scoped) =>
      mutateSessionControlInTransaction(scoped, {
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId,
        sessionId: value.root.id,
        actor: { type: "human", subjectId: value.grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
        reason: "private parent reason",
      }),
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
      reasoningEffort: "medium",
      latencyMode: "standard",
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
      FileSystem: { root: "/workspace" },
      DesktopStream: { shared: true, sharedSessionIds: [] },
    });
    expect(sharedSibling.id).not.toBe(value.child.id);
  });

  test("authorizes narrowly delegated session-bound MCP requests without workspace read", async () => {
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
      permissions: ["sessions:control"],
      sessionId: value.child.id,
      principalKind: "service",
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

    const unboundToken = await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      principalKind: "service",
      permissions: ["sessions:control"],
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const unbound = await fullAppWith(port).request(
      `/v1/workspaces/${value.grant.workspaceId}/mcp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unboundToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "session-authorization-test", version: "1" },
          },
        }),
      },
    );
    expect(unbound.status).toBe(403);
  });

  test("applies exact host scope to first-party MCP target reads and discovery", async () => {
    if (!available) return;
    const value = await fixture();
    for (const sessionId of [value.child.id, value.hidden.id]) {
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: value.grant.workspaceId,
          sessionId,
          title: "Shared host search target",
          source: "user",
        }),
      ).toMatchObject({ updated: true });
    }
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
    const topologyResponse = await appWith(port).request(
      `/v1/workspaces/${value.grant.workspaceId}/agent-topology?query=${encodeURIComponent("Shared host search target")}`,
      { headers: { authorization: value.authorization } },
    );
    expect(topologyResponse.status).toBe(200);
    const topology = (await topologyResponse.json()) as {
      sessions: Array<{ id: string }>;
      total: number;
    };
    expect(topology.total).toBe(1);
    expect(topology.sessions).toEqual([expect.objectContaining({ id: value.child.id })]);

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
    const detail = await callMcpTool<{ id: string; parentSessionId?: string }>(
      server,
      "session_get",
      { sessionId: value.child.id },
    );
    expect(detail).toMatchObject({ id: value.child.id });
    expect(detail).not.toHaveProperty("parentSessionId");
    expect(calls).toContainEqual({
      sessionId: value.child.id,
      operation: "session.read",
      surface: "first_party_mcp",
    });
    await expect(
      callMcpTool(server, "session_get", { sessionId: value.hidden.id }),
    ).rejects.toThrow("Session not found or access denied");

    const listed = await callMcpTool<{
      sessions: Array<{ id: string; parentSessionId?: string }>;
      total: number;
    }>(server, "sessions_list", { query: "Shared host search target" });
    expect(listed.total).toBe(1);
    expect(listed.sessions).toEqual([expect.objectContaining({ id: value.child.id })]);
    expect(listed.sessions[0]).not.toHaveProperty("parentSessionId");
    await withWorkspaceSessionActivityRls(client.db, value.grant.workspaceId, (scoped) =>
      mutateSessionControlInTransaction(scoped, {
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId,
        sessionId: value.root.id,
        actor: { type: "human", subjectId: value.grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
        reason: "private parent reason",
      }),
    );
    for (const mode of ["compact", "full"] as const) {
      const paused = await callMcpTool<Record<string, unknown>>(server, "session_get", {
        sessionId: value.child.id,
        detail: mode,
      });
      expect(JSON.stringify(paused)).toContain("An ancestor session");
      expect(JSON.stringify(paused)).not.toContain("private parent reason");
      expect(JSON.stringify(paused)).not.toContain(value.root.id);
      if (mode === "full") {
        expect(paused.effectiveToolPolicy).toMatchObject({ inheritedFromSessionId: null });
      }
      await expect(
        callMcpTool(server, "session_get", { sessionId: value.hidden.id, detail: mode }),
      ).rejects.toThrow("Session not found or access denied");
      const rows = await callMcpTool<{ total: number; sessions: unknown[] }>(
        server,
        "sessions_list",
        { detail: mode },
      );
      expect(rows.total).toBe(1);
      expect(JSON.stringify(rows.sessions)).not.toContain(value.root.id);
      expect(JSON.stringify(rows.sessions)).not.toContain(value.hidden.id);
    }
  });

  test("authorizes first-party MCP parent-to-child Pause, Resume, and Agent Steer exactly once", async () => {
    if (!available) return;
    const value = await fixture();
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.root.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    if (!started.turn) throw new Error("test caller did not create an initial turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.root.id,
      workflowId: `session-${value.root.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`test caller was not claimed`);
    const target = value.child;
    const decisions: Array<{
      operation: string;
      surface: string;
      sessionId: string;
    }> = [];
    const port = {
      authorizeSession: async ({ operation, surface, target: authorizationTarget }) => {
        decisions.push({
          operation,
          surface,
          sessionId: authorizationTarget.sessionId,
        });
        if (surface === "core") {
          throw new Error("duplicate core authorization");
        }
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    } satisfies SessionAuthorizationPort;
    const noop = async () => undefined;
    const mcpDeps = {
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
    } as unknown as ApiRouteDeps;
    const server = buildOpenGeniMcpServer(mcpDeps, {
      ...value.grant,
      permissions: ["workspace:read", "sessions:read", "sessions:control"],
      metadata: {
        sessionId: value.root.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: ["session_pause", "session_resume", "session_steer"],
      },
    });

    const paused = await callMcpTool<McpMutationReceiptType>(server, "session_pause", {
      sessionId: target.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(paused).toMatchObject({
      operation: "session_pause",
      outcome: "updated",
      changed: true,
      resource: { type: "session", id: target.id, state: "paused" },
      idempotency: { status: "applied" },
    });
    const unchangedPauseKey = crypto.randomUUID();
    const unchangedPause = await callMcpTool<McpMutationReceiptType>(server, "session_pause", {
      sessionId: target.id,
      idempotencyKey: unchangedPauseKey,
    });
    expect(unchangedPause).toMatchObject({
      operation: "session_pause",
      outcome: "unchanged",
      changed: false,
      resource: { type: "session", id: target.id, state: "paused" },
      idempotency: { status: "applied" },
    });
    const replayedPause = await callMcpTool<McpMutationReceiptType>(server, "session_pause", {
      sessionId: target.id,
      idempotencyKey: unchangedPauseKey,
    });
    expect(replayedPause).toMatchObject({
      operation: "session_pause",
      outcome: "replayed",
      changed: false,
      resource: { type: "session", id: target.id, state: "paused" },
      idempotency: { status: "replayed" },
    });
    expect(replayedPause.relatedResources).toEqual(unchangedPause.relatedResources);
    const resumed = await callMcpTool<McpMutationReceiptType>(server, "session_resume", {
      sessionId: target.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(resumed).toMatchObject({
      operation: "session_resume",
      outcome: "updated",
      changed: true,
      resource: { type: "session", id: target.id, state: "active" },
    });
    const steered = await callMcpTool<{ updateId: string }>(server, "session_steer", {
      sessionId: target.id,
      instruction: "Take the newest direction exactly once",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(steered.updateId).toEqual(expect.any(String));

    const operatorServer = buildOpenGeniMcpServer(mcpDeps, {
      ...value.grant,
      permissions: ["workspace:read", "sessions:read", "sessions:control"],
    });
    const operatorPaused = await callMcpTool<McpMutationReceiptType>(
      operatorServer,
      "session_pause",
      {
        sessionId: target.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(operatorPaused).toMatchObject({
      receiptVersion: "mcp-mutation-receipt.v1",
      operation: "session_pause",
      outcome: "updated",
      changed: true,
      resource: { type: "session", id: target.id, state: "paused" },
      relatedResources: [{ type: "session_command_receipt" }],
    });
    expect(operatorPaused).not.toHaveProperty("effectiveControl");
    const operatorResumed = await callMcpTool<McpMutationReceiptType>(
      operatorServer,
      "session_resume",
      {
        sessionId: target.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(operatorResumed).toMatchObject({
      receiptVersion: "mcp-mutation-receipt.v1",
      operation: "session_resume",
      outcome: "updated",
      changed: true,
      resource: { type: "session", id: target.id, state: "active" },
    });
    expect(operatorResumed).not.toHaveProperty("effectiveControl");

    expect(decisions).toEqual([
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.steer",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
      {
        operation: "session.control",
        surface: "first_party_mcp",
        sessionId: target.id,
      },
    ]);
  });

  /** A live root attempt plus a child frozen on one structured question. */
  async function childHumanInputFixture() {
    const value = await fixture();
    const noop = async () => undefined;
    // Live caller attempt on the root.
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.root.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    if (!started.turn) throw new Error("test caller did not create an initial turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.root.id,
      workflowId: `session-${value.root.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("test caller was not claimed");
    // Freeze a structured human-input request on the child.
    const childStarted = await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: null,
    });
    if (!childStarted.turn) throw new Error("child did not create an initial turn");
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
      sessionId: value.child.id,
      workflowId: `session-${value.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (childClaim.action !== "claimed") throw new Error("child turn was not claimed");
    const requestId = crypto.randomUUID();
    const questions = [
      {
        id: "env",
        kind: "single_select" as const,
        prompt: "Which environment?",
        options: [
          { id: "staging", label: "Staging" },
          { id: "production", label: "Production" },
        ],
        required: true,
        allowOther: false,
      },
    ];
    const frozen = await applySessionTurnSettlement(client.db, value.grant.workspaceId, {
      sessionId: value.child.id,
      turnId: childClaim.turn.id,
      triggerEventId: childClaim.turn.triggerEventId,
      attemptId: childAttemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: childClaim.turn.id,
      runState: {
        serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
        pendingApprovals: [{ id: "tool-call-1", rawItem: { name: "write_file" } }],
        humanInputRequests: [
          {
            id: requestId,
            toolCallId: "human-call-1",
            questions,
            allowSkip: false,
            expiresAt: null,
          },
        ],
      },
      events: [
        {
          type: "session.humanInput.requested",
          payload: {
            request: { id: requestId, questions, allowSkip: false, expiresAt: null },
          },
        },
        { type: "session.requiresAction", payload: { approvals: [{ id: "tool-call-1" }] } },
        { type: "session.status.changed", payload: { status: "requires_action" } },
      ],
    });
    expect(frozen.action).toBe("settled");

    const mcpDeps = {
      settings: testSettings(),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
      } as unknown as SessionWorkflowClient,
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}) as never,
    } as unknown as ApiRouteDeps;
    const agentGrant = {
      ...value.grant,
      permissions: ["workspace:read", "sessions:read", "sessions:control"],
      metadata: {
        sessionId: value.root.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: ["session_human_input_respond"],
      },
    };
    const server = buildOpenGeniMcpServer(mcpDeps, agentGrant);
    return { value, attemptId, requestId, mcpDeps, agentGrant, server };
  }

  test("lets a live agent answer a child's human-input request but never decide a tool approval", async () => {
    if (!available) return;
    const { value, attemptId, requestId, mcpDeps, agentGrant, server } =
      await childHumanInputFixture();

    // Tool approvals remain human-only for agent attempts, on every surface.
    await expect(
      requireSessionAuthorization(mcpDeps, agentGrant, {
        sessionId: value.child.id,
        operation: "session.approval.write",
        surface: "first_party_mcp",
      }),
    ).rejects.toThrow("Session not found or access denied");
    // ...while structured human input may be answered by the live attempt.
    await expect(
      requireSessionAuthorization(mcpDeps, agentGrant, {
        sessionId: value.child.id,
        operation: "session.human_input.write",
        surface: "first_party_mcp",
      }),
    ).resolves.toBeTruthy();

    const idempotencyKey = crypto.randomUUID();
    const answer = (key: string, values = ["staging"]) =>
      callMcpTool<McpMutationReceiptType>(server, "session_human_input_respond", {
        sessionId: value.child.id,
        requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "env", values }],
        },
        idempotencyKey: key,
      });
    const answered = await answer(idempotencyKey);
    expect(answered.resource).toMatchObject({
      type: "session_human_input_request",
      id: requestId,
      state: "answered",
    });
    expect(answered).toMatchObject({ outcome: "updated", changed: true });
    const request = await getSessionHumanInputRequest(
      client.db,
      value.grant.workspaceId,
      value.child.id,
      requestId,
    );
    expect(request).toMatchObject({
      status: "answered",
      respondedBy: `agent_attempt:${attemptId}`,
    });
    const events = await listSessionEvents(client.db, value.grant.workspaceId, value.child.id);
    const responses = events.filter((event) => event.type === "user.humanInputResponse");
    expect(responses).toHaveLength(1);
    // The conversation can say an agent answered, without any subject id.
    expect(responses[0]!.payload).toMatchObject({
      requestId,
      respondedByKind: "agent_attempt",
    });

    // A retry with the same key replays this attempt's own committed answer...
    expect(await answer(idempotencyKey)).toMatchObject({
      outcome: "replayed",
      changed: false,
    });
    // ...while a second, different answer is a clear "already answered" result.
    const again = await answer(crypto.randomUUID(), ["production"]);
    expect(again).toMatchObject({
      outcome: "unchanged",
      changed: false,
      resource: { state: "answered" },
      facts: { alreadyAnswered: true, answeredBy: "you", outcome: "answered" },
    });
    expect(again.warnings[0]).toContain("not used");
    // A person submitting after the agent gets the agent's committed event
    // back, never a second answer.
    const late = await acceptSessionHumanInputResponse(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      requestId,
      response: { outcome: "answered", answers: [{ questionId: "env", values: ["production"] }] },
      respondedBy: value.grant.subjectId,
      respondedByKind: "human",
      clientEventId: crypto.randomUUID(),
    });
    expect(late).toMatchObject({ action: "completed", settledBy: "earlier_response" });
    if (late.action !== "completed") throw new Error("unreachable");
    expect(late.event.id).toBe(responses[0]!.id);
    const after = await listSessionEvents(client.db, value.grant.workspaceId, value.child.id);
    expect(after.filter((event) => event.type === "user.humanInputResponse")).toHaveLength(1);
  });

  test("a person's answer and the parent agent's answer race: exactly one wins, the loser is told", async () => {
    if (!available || !shared) return;
    // The agent's call does authorization work before it reaches the database,
    // so a plain Promise.all almost always lets the person win. Force each
    // order instead: hold the request row lock, start the first answer and
    // wait until it is queued on that lock, then start the second and wait
    // until it is queued too, and only then release. Both answers are in
    // flight together; the first in line must win and the other must be told.
    const blocker = postgres(shared.adminUrl, { max: 1 });
    const monitor = postgres(shared.adminUrl, { max: 1 });
    const lockWaiters = async () => {
      const [row] = await monitor<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `;
      return row?.waiting ?? 0;
    };
    const waitForLockWaiters = async (count: number) => {
      const deadline = Date.now() + 20_000;
      while ((await lockWaiters()) < count) {
        if (Date.now() > deadline)
          throw new Error(`fewer than ${count} answers queued on the lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const raceInOrder = async <First, Second>(
      requestId: string,
      first: () => Promise<First>,
      second: () => Promise<Second>,
    ): Promise<[First, Second]> => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const holder = blocker.begin(async (tx) => {
        await tx`select id from session_human_input_requests where id = ${requestId} for update`;
        locked();
        await released;
      });
      await lockHeld;
      const baseline = await lockWaiters();
      const firstRun = first();
      await waitForLockWaiters(baseline + 1);
      const secondRun = second();
      await waitForLockWaiters(baseline + 2);
      release();
      await holder;
      return [await firstRun, await secondRun];
    };
    const seen = new Set<string>();
    try {
      for (const round of [0, 1, 2, 3]) {
        const { value, attemptId, requestId, server } = await childHumanInputFixture();
        const human = () =>
          acceptSessionHumanInputResponse(client.db, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId,
            sessionId: value.child.id,
            requestId,
            response: {
              outcome: "answered",
              answers: [{ questionId: "env", values: ["production"] }],
            },
            respondedBy: value.grant.subjectId,
            respondedByKind: "human",
            clientEventId: crypto.randomUUID(),
          });
        const agent = () =>
          callMcpTool<McpMutationReceiptType>(server, "session_human_input_respond", {
            sessionId: value.child.id,
            requestId,
            response: {
              outcome: "answered",
              answers: [{ questionId: "env", values: ["staging"] }],
            },
            idempotencyKey: crypto.randomUUID(),
          });
        // Alternate who is first in line; both are in flight when the lock opens.
        const humanFirst = round % 2 === 0;
        const [humanResult, agentReceipt] = humanFirst
          ? await raceInOrder(requestId, human, agent)
          : await raceInOrder(requestId, agent, human).then(
              ([agentRun, humanRun]) => [humanRun, agentRun] as const,
            );
        const request = await getSessionHumanInputRequest(
          client.db,
          value.grant.workspaceId,
          value.child.id,
          requestId,
        );
        const events = await listSessionEvents(client.db, value.grant.workspaceId, value.child.id);
        const responses = events.filter((event) => event.type === "user.humanInputResponse");
        // Exactly one durable answer, whoever won.
        expect(responses).toHaveLength(1);
        seen.add(humanFirst ? "person" : "agent");
        if (humanFirst) {
          expect(request?.respondedBy).toBe(value.grant.subjectId);
          expect(humanResult.action).toBe("accepted");
          expect(request.response).toMatchObject({
            answers: [{ questionId: "env", values: ["production"] }],
          });
          expect(responses[0]!.payload).toMatchObject({
            respondedByKind: "human",
          });
          expect(agentReceipt).toMatchObject({
            outcome: "unchanged",
            changed: false,
            facts: {
              alreadyAnswered: true,
              answeredBy: "person",
              outcome: "answered",
            },
          });
        } else {
          expect(request?.respondedBy).toBe(`agent_attempt:${attemptId}`);
          expect(agentReceipt).toMatchObject({
            outcome: "updated",
            changed: true,
          });
          expect(responses[0]!.payload).toMatchObject({
            respondedByKind: "agent_attempt",
          });
          // The person's late submission returns the winning event, not theirs,
          // so a client can tell that someone else answered first.
          expect(humanResult.action).toBe("completed");
          if (humanResult.action !== "completed") throw new Error("unreachable");
          expect(humanResult.settledBy).toBe("earlier_response");
          expect(humanResult.event.id).toBe(responses[0]!.id);
        }
      }
    } finally {
      await blocker.end();
      await monitor.end();
    }
    expect([...seen].sort()).toEqual(["agent", "person"]);
  });

  test("a parent agent answering after the person answered gets alreadyAnswered", async () => {
    if (!available) return;
    const { value, requestId, server } = await childHumanInputFixture();
    const human = await acceptSessionHumanInputResponse(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "env", values: ["production"] }],
      },
      respondedBy: value.grant.subjectId,
      respondedByKind: "human",
      clientEventId: crypto.randomUUID(),
    });
    expect(human.action).toBe("accepted");
    const receipt = await callMcpTool<McpMutationReceiptType>(
      server,
      "session_human_input_respond",
      {
        sessionId: value.child.id,
        requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "env", values: ["staging"] }],
        },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(receipt).toMatchObject({
      outcome: "unchanged",
      changed: false,
      resource: { id: requestId, state: "answered" },
      facts: {
        alreadyAnswered: true,
        answeredBy: "person",
        outcome: "answered",
      },
    });
    expect(receipt.warnings).toEqual([
      "Already answered by a person; this answer was not used. Do not answer again.",
    ]);
    const request = await getSessionHumanInputRequest(
      client.db,
      value.grant.workspaceId,
      value.child.id,
      requestId,
    );
    expect(request).toMatchObject({
      respondedBy: value.grant.subjectId,
      response: { answers: [{ questionId: "env", values: ["production"] }] },
    });
  });

  test("a parent agent answering after an API client answered is told it was an API client", async () => {
    if (!available) return;
    const { value, requestId, server } = await childHumanInputFixture();
    const api = await acceptSessionHumanInputResponse(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      requestId,
      response: {
        outcome: "answered",
        answers: [{ questionId: "env", values: ["production"] }],
      },
      respondedBy: "api_key:test-key",
      respondedByKind: "api",
      clientEventId: crypto.randomUUID(),
    });
    expect(api.action).toBe("accepted");
    const receipt = await callMcpTool<McpMutationReceiptType>(
      server,
      "session_human_input_respond",
      {
        sessionId: value.child.id,
        requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: "env", values: ["staging"] }],
        },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(receipt).toMatchObject({
      outcome: "unchanged",
      facts: { alreadyAnswered: true, answeredBy: "api", outcome: "answered" },
    });
    expect(receipt.warnings).toEqual([
      "Already answered by an API client; this answer was not used. Do not answer again.",
    ]);
  });

  test("lets a live agent address peer sessions while host policy can only narrow", async () => {
    if (!available) return;
    const value = await fixture();
    const sibling = await createSession(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      parentSessionId: value.root.id,
      initialMessage: "caller sibling",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
      createdBy: {
        kind: "subject",
        subjectId: value.grant.subjectId,
        label: "Test owner",
      },
      createdByContext: {},
    });
    const grandchild = await createSession(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      parentSessionId: value.child.id,
      initialMessage: "caller's direct child",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
      createdBy: {
        kind: "subject",
        subjectId: value.grant.subjectId,
        label: "Test owner",
      },
      createdByContext: {},
    });

    const claimGrant = async (sessionId: string) => {
      const started = await initializeSessionStartAtomically(client.db, {
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId,
        sessionId,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
        goal: null,
      });
      if (!started.turn) throw new Error("test caller did not create an initial turn");
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
        sessionId,
        workflowId: `session-${sessionId}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("test caller was not claimed");
      return {
        ...value.grant,
        principalKind: "agent_attempt" as const,
        metadata: {
          sessionId,
          turnId: claimed.turn.id,
          attemptId,
          executionGeneration: claimed.turn.executionGeneration,
        },
      };
    };

    const callerGrant = await claimGrant(value.child.id);
    const authorize = (
      sessionId: string,
      operation: Parameters<typeof requireSessionAuthorization>[2]["operation"],
      sessionAuthorization?: SessionAuthorizationPort,
    ) =>
      requireSessionAuthorization(
        {
          db: client.db,
          ...(sessionAuthorization ? { sessionAuthorization } : {}),
        },
        callerGrant,
        { sessionId, operation, surface: "first_party_mcp" },
      );

    await expect(authorize(value.child.id, "session.read")).resolves.toMatchObject({
      relatedSessionAccess: "root",
    });
    await expect(authorize(value.root.id, "session.append")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    await expect(authorize(value.root.id, "session.events.read")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    await expect(authorize(grandchild.id, "session.control")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    await expect(authorize(value.root.id, "session.control")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    await expect(authorize(sibling.id, "session.read")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    await expect(authorize(value.hidden.id, "session.append")).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });

    let hostCalls = 0;
    const allowEverything: SessionAuthorizationPort = {
      authorizeSession: async () => {
        hostCalls += 1;
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    };
    await expect(authorize(sibling.id, "session.append", allowEverything)).resolves.toMatchObject({
      relatedSessionAccess: "target",
    });
    expect(hostCalls).toBe(1);

    let deniedCalls = 0;
    const denyPeer: SessionAuthorizationPort = {
      authorizeSession: async () => {
        deniedCalls += 1;
        return { allowed: false, reason: "forbidden" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    };
    await expect(authorize(sibling.id, "session.append", denyPeer)).rejects.toMatchObject({
      reason: "forbidden",
    });
    expect(deniedCalls).toBe(1);

    const grandchildGrant = await claimGrant(grandchild.id);
    await expect(
      requireSessionAuthorization({ db: client.db }, grandchildGrant, {
        sessionId: value.root.id,
        operation: "session.append",
        surface: "first_party_mcp",
      }),
    ).resolves.toMatchObject({ relatedSessionAccess: "target" });
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
      principalKind: "agent_attempt",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const headers = { authorization: `Bearer ${token}` };
    const mcpDeps = {
      settings: testSettings(),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => ({}) as never,
      sessionAuthorization: {
        authorizeSession: async ({ target }: { target: { sessionId: string } }) =>
          target.sessionId === value.hidden.id
            ? { allowed: false as const, reason: "not_found" }
            : { allowed: true as const },
      },
    } as unknown as ApiRouteDeps;
    const agentGrant = {
      ...value.grant,
      principalKind: "agent_attempt" as const,
      metadata: {
        sessionId: value.child.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        // A session-scoped grant registers only its signed selection; an
        // omitted claim now fails closed instead of exposing the default catalog.
        firstPartyMcpTools: ["session_get" as const],
      },
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, agentGrant);
    for (const detail of ["compact", "full"] as const) {
      const own = await callMcpTool<{ id: string }>(mcp, "session_get", { detail });
      expect(own.id).toBe(value.child.id);
      expect(own.id).not.toBe(value.root.id);
      expect(await callMcpTool(mcp, "session_get", { sessionId: value.child.id, detail })).toEqual(
        own,
      );
      expect(
        await callMcpTool(mcp, "session_get", { sessionId: value.root.id, detail }),
      ).toMatchObject({ id: value.root.id });
      await expect(
        callMcpTool(mcp, "session_get", { sessionId: value.hidden.id, detail }),
      ).rejects.toThrow("Session not found or access denied");
      const operator = buildOpenGeniMcpServer(mcpDeps, { ...agentGrant, principalKind: "service" });
      await expect(callMcpTool(operator, "session_get", { detail })).rejects.toThrow(
        "requires an explicit sessionId",
      );
      expect(
        await callMcpTool(operator, "session_get", { sessionId: value.child.id, detail }),
      ).toMatchObject({ id: value.child.id });
    }
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
      initiatingHumanSubjectId: value.grant.subjectId,
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
    for (const args of [{}, { sessionId: value.child.id }, { sessionId: value.root.id }]) {
      await expect(callMcpTool(mcp, "session_get", args)).rejects.toMatchObject({
        reason: "caller_stale",
      });
    }
    await expect(
      requireSessionAuthorizationListScope(
        { db: client.db },
        {
          ...value.grant,
          principalKind: "agent_attempt",
          metadata: {
            sessionId: value.child.id,
            turnId: claimed.turn.id,
            attemptId,
            executionGeneration: claimed.turn.executionGeneration,
          },
        },
        "first_party_mcp",
      ),
    ).rejects.toMatchObject({ reason: "caller_stale" });
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

test("session schedule projections follow current targets and schedule permissions", async () => {
  if (!available) return;
  const value = await fixture();
  const app = fullAppWith({
    resolveListScope: async () => ({ kind: "all" }),
    authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "root" }),
  });
  const task = await createScheduledTask(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: "Paused review",
    status: "paused",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "existing_session",
    overlapPolicy: "skip",
    targetSessionId: value.child.id,
    agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    subjectId: value.grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "scheduled_tasks:run"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const base = `/v1/workspaces/${value.grant.workspaceId}`;
  const read = async (path: string, token = authorization) => {
    const response = await app.request(`${base}${path}`, { headers: { authorization: token } });
    expect(response.status).toBe(200);
    return await response.json();
  };
  // A paused schedule is still a schedule relationship, but never upcoming.
  expect(await read(`/sessions/${value.child.id}`)).toMatchObject({
    hasSchedules: true,
    hasUpcomingSchedules: false,
    automationWait: null,
  });
  expect(await read(`/sessions/${value.child.id}/lineage`)).toMatchObject({
    sessionHasSchedules: true,
    sessionHasUpcomingSchedules: false,
    sessionAutomationWait: null,
  });
  const withoutScheduleAccess = await read(`/sessions/${value.child.id}`, value.authorization);
  expect(withoutScheduleAccess).toMatchObject({
    hasSchedules: false,
    hasUpcomingSchedules: false,
  });
  expect(withoutScheduleAccess).not.toHaveProperty("automationWait");
  expect(await read(`/scheduled-tasks?sessionId=${value.child.id}`)).toMatchObject([
    { id: task.id },
  ]);
  expect(await read(`/scheduled-tasks?sessionId=${value.hidden.id}`)).toEqual([]);
  const page = await read("/sessions?view=page");
  expect(
    page.sessions.find((session: { id: string }) => session.id === value.child.id),
  ).toMatchObject({ hasSchedules: true, hasUpcomingSchedules: false });
  const upcoming = await createScheduledTask(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: "Daily review",
    status: "active",
    schedule: { type: "calendar", timeZone: "UTC", hour: 9, minute: 0 },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "existing_session",
    overlapPolicy: "skip",
    targetSessionId: value.child.id,
    agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const nextNine = new Date();
  nextNine.setUTCHours(9, 0, 0, 0);
  if (nextNine.getTime() <= Date.now()) nextNine.setUTCDate(nextNine.getUTCDate() + 1);
  const dailyWait = { nextRunAt: nextNine.toISOString(), event: null, automations: 1 };
  expect(await read(`/sessions/${value.child.id}`)).toMatchObject({
    hasSchedules: true,
    hasUpcomingSchedules: true,
    automationWait: dailyWait,
  });
  expect(
    (await read("/sessions?view=page")).sessions.find(
      (session: { id: string }) => session.id === value.child.id,
    ),
  ).toMatchObject({ hasSchedules: true, hasUpcomingSchedules: true, automationWait: dailyWait });
  expect(await read(`/sessions/${value.child.id}/lineage`)).toMatchObject({
    sessionHasUpcomingSchedules: true,
    sessionAutomationWait: dailyWait,
  });
  await deleteScheduledTask(client.db, value.grant.workspaceId, upcoming.id);
  const denied = await app.request(`${base}/scheduled-tasks?sessionId=${value.child.id}`, {
    headers: { authorization: value.authorization },
  });
  expect(denied.status).toBe(403);
  await deleteScheduledTask(client.db, value.grant.workspaceId, task.id);
  expect(await read(`/sessions/${value.child.id}/lineage`)).toMatchObject({
    sessionHasSchedules: false,
  });
});
