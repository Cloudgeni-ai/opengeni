import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type McpMutationReceiptType,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  acquireLease,
  claimSessionWorkForAttempt,
  commitWarmingToWarm,
  createDb,
  createSession,
  createSessionMcpServers,
  createVariableSet,
  deleteVariableSet,
  getActiveSessionHistoryItems,
  initializeSessionStartAtomically,
  listSessionEvents,
  applySessionTurnSettlement,
  getSessionHumanInputRequest,
  mutateSessionControlInTransaction,
  submitHumanPromptInTransaction,
  updateSessionTitle,
  updateSessionVariableSets,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceSessionActivityRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

async function waitForBlockedBackend(blockerPid: number, description: string): Promise<number> {
  if (!shared) throw new Error("database unavailable");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<Array<{ pid: number }>>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.usename = 'opengeni_app'
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
    await Bun.sleep(10);
  }
  throw new Error(`${description} did not block behind backend ${blockerPid}`);
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

async function variableSetControlAuthorization(value: Awaited<ReturnType<typeof fixture>>) {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    subjectId: value.grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "variable-sets:attach", "variable-sets:use"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function variableSetCreateAuthorization(value: Awaited<ReturnType<typeof fixture>>) {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    subjectId: value.grant.subjectId,
    permissions: ["sessions:create", "sessions:read", "variable-sets:attach", "variable-sets:use"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function sessionCreateFootprint(
  workspaceId: string,
  sessionId: string,
  createIdempotencyKey: string,
) {
  if (!shared) throw new Error("database unavailable");
  const [state] = await shared.admin<
    Array<{
      sessionCount: number;
      selectionCount: number;
      attachmentCount: number;
      eventCount: number;
      auditCount: number;
      turnCount: number;
      historyCount: number;
      wakeCount: number;
      leaseCount: number;
      runtimeMutationCount: number;
      usageCount: number;
      spawnDenialCount: number;
    }>
  >`
    select
      (select count(*)::int from sessions session_value
        where session_value.workspace_id = ${workspaceId}
          and session_value.id = ${sessionId}) as "sessionCount",
      (select count(*)::int from sessions session_value
        where session_value.workspace_id = ${workspaceId}
          and session_value.id = ${sessionId}
          and (session_value.variable_set_id is not null
            or session_value.variable_set_ids <> '[]'::jsonb)) as "selectionCount",
      (select count(*)::int from session_variable_set_attachments attachment
        where attachment.workspace_id = ${workspaceId}
          and attachment.session_id = ${sessionId}) as "attachmentCount",
      (select count(*)::int from session_events event_value
        where event_value.workspace_id = ${workspaceId}
          and event_value.session_id = ${sessionId}) as "eventCount",
      (select count(*)::int from audit_events audit_value
        where audit_value.workspace_id = ${workspaceId}
          and audit_value.target_id = ${sessionId}) as "auditCount",
      (select count(*)::int from session_turns turn_value
        where turn_value.workspace_id = ${workspaceId}
          and turn_value.session_id = ${sessionId}) as "turnCount",
      (select count(*)::int from session_history_items history_value
        where history_value.workspace_id = ${workspaceId}
          and history_value.session_id = ${sessionId}) as "historyCount",
      (select count(*)::int from session_workflow_wake_outbox wake_value
        where wake_value.workspace_id = ${workspaceId}
          and wake_value.session_id = ${sessionId}) as "wakeCount",
      (select count(*)::int from sandbox_leases lease_value
        where lease_value.workspace_id = ${workspaceId}
          and lease_value.sandbox_group_id = ${sessionId}) as "leaseCount",
      (select count(*)::int from sandbox_workspace_mutation_admissions admission_value
        where admission_value.workspace_id = ${workspaceId}
          and admission_value.session_id = ${sessionId}) as "runtimeMutationCount",
      (select count(*)::int from usage_events usage_value
        where usage_value.workspace_id = ${workspaceId}
          and usage_value.session_id = ${sessionId}) as "usageCount",
      (select count(*)::int from session_spawn_denials denial_value
        where denial_value.workspace_id = ${workspaceId}
          and denial_value.idempotency_key = ${createIdempotencyKey}) as "spawnDenialCount"
  `;
  if (!state) throw new Error("session create footprint is unavailable");
  return state;
}

async function sessionVariableSetMutationState(value: Awaited<ReturnType<typeof fixture>>) {
  if (!shared) throw new Error("database unavailable");
  const [state] = await shared.admin<
    Array<{
      status: string;
      variableSetIds: string[];
      variableSetId: string | null;
      lastSequence: number;
      updatedAt: string;
      attachmentCount: number;
      eventCount: number;
      auditCount: number;
      rotatedLeaseCount: number;
    }>
  >`
    select session_value.status,
      session_value.variable_set_ids as "variableSetIds",
      session_value.variable_set_id as "variableSetId",
      session_value.last_sequence as "lastSequence",
      session_value.updated_at::text as "updatedAt",
      (select count(*)::int from session_variable_set_attachments attachment
        where attachment.workspace_id = ${value.grant.workspaceId}
          and attachment.session_id = ${value.child.id}) as "attachmentCount",
      (select count(*)::int from session_events event_value
        where event_value.workspace_id = ${value.grant.workspaceId}
          and event_value.session_id = ${value.child.id}
          and event_value.type = 'session.variable_sets.updated') as "eventCount",
      (select count(*)::int from audit_events audit_value
        where audit_value.workspace_id = ${value.grant.workspaceId}
          and audit_value.target_id = ${value.child.id}
          and audit_value.action like 'session.variable_set%') as "auditCount",
      (select count(*)::int from sandbox_leases lease
        where lease.workspace_id = ${value.grant.workspaceId}
          and lease.sandbox_group_id = session_value.sandbox_group_id
          and lease.rotation_requested_at is not null) as "rotatedLeaseCount"
    from sessions session_value
    where session_value.workspace_id = ${value.grant.workspaceId}
      and session_value.id = ${value.child.id}
  `;
  if (!state) throw new Error("session Variable Set state is unavailable");
  return state;
}

async function expectControlledVariableSetRemovalRace(removal: "revoke" | "delete"): Promise<void> {
  if (!shared) throw new Error("database unavailable");
  const value = await fixture();
  const retainedVariableSet = await createVariableSet(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: `session-${removal}-retained-${crypto.randomUUID()}`,
  });
  const variableSet = await createVariableSet(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: `session-${removal}-race-${crypto.randomUUID()}`,
  });
  expect(
    await updateSessionVariableSets(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      sessionId: value.child.id,
      subjectId: value.grant.subjectId,
      variableSets: [
        {
          id: retainedVariableSet.id,
          name: retainedVariableSet.name,
          scope: retainedVariableSet.scope,
        },
      ],
    }),
  ).toMatchObject({ status: "updated" });
  const before = await sessionVariableSetMutationState(value);
  const routeClient = createDb(shared.appUrl, { max: 1 });
  const removalClient = createDb(shared.appUrl, { max: 1 });
  const blockerReady = deferred<number>();
  const releaseBlocker = deferred();
  let blocker: Promise<unknown> | null = null;
  let request: Promise<Response> | null = null;
  try {
    blocker = shared.admin.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (!backend) throw new Error("session mutation blocker backend is unavailable");
      await tx`select id from sessions
        where workspace_id = ${value.grant.workspaceId}
          and id = ${value.child.id}
        for update`;
      blockerReady.resolve(backend.pid);
      await releaseBlocker.promise;
    });
    const blockerPid = await blockerReady.promise;
    const app = appWith(
      {
        authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "root" }),
        resolveListScope: async () => ({ kind: "all" }),
      },
      routeClient.db,
    );
    request = app.request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/variable-sets`,
      {
        method: "PUT",
        headers: {
          authorization: await variableSetControlAuthorization(value),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          variableSetIds:
            removal === "revoke"
              ? [variableSet.id, retainedVariableSet.id]
              : [retainedVariableSet.id, variableSet.id],
        }),
      },
    );
    expect(
      await waitForBlockedBackend(blockerPid, `Variable Set ${removal} race request`),
    ).toBeGreaterThan(0);

    if (removal === "revoke") {
      expect(
        await deleteVariableSet(
          removalClient.db,
          {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId,
            subjectId: value.grant.subjectId,
          },
          variableSet.id,
        ),
      ).toBe(true);
    } else {
      await shared.admin`
        delete from workspace_variable_sets
        where account_id = ${value.grant.accountId}
          and id = ${variableSet.id}
      `;
    }
    releaseBlocker.resolve();

    const response = await request;
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("no longer available");
    expect(await sessionVariableSetMutationState(value)).toEqual(before);
  } finally {
    releaseBlocker.resolve();
    await Promise.allSettled([...(blocker ? [blocker] : []), ...(request ? [request] : [])]);
    await routeClient.close();
    await removalClient.close();
  }
}

async function expectControlledVariableSetCreateRemovalRace(
  removal: "revoke" | "delete",
): Promise<void> {
  if (!shared) throw new Error("database unavailable");
  const value = await fixture();
  const retainedVariableSet = await createVariableSet(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: `session-create-${removal}-retained-${crypto.randomUUID()}`,
  });
  const variableSet = await createVariableSet(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    name: `session-create-${removal}-race-${crypto.randomUUID()}`,
  });
  const requestedSessionId = crypto.randomUUID();
  const createIdempotencyKey = `session-create-${removal}-${crypto.randomUUID()}`;
  const routeClient = createDb(shared.appUrl, { max: 1 });
  const removalClient = createDb(shared.appUrl, { max: 1 });
  const blockerReady = deferred<number>();
  const releaseBlocker = deferred();
  let blocker: Promise<unknown> | null = null;
  let request: Promise<Response> | null = null;
  try {
    blocker = shared.admin.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (!backend) throw new Error("session create blocker backend is unavailable");
      await tx`select pg_advisory_xact_lock(
        hashtextextended(${`workspace-control:${value.grant.workspaceId}`}, 0)
      )`;
      await tx`select workspace_id from workspace_inference_controls
        where workspace_id = ${value.grant.workspaceId}
        for update`;
      blockerReady.resolve(backend.pid);
      await releaseBlocker.promise;
    });
    const blockerPid = await blockerReady.promise;
    const app = appWith(undefined, routeClient.db);
    request = app.request(`/v1/workspaces/${value.grant.workspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: await variableSetCreateAuthorization(value),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestedSessionId,
        initialMessage: `Variable Set create ${removal} race`,
        ...(removal === "revoke" ? { idempotencyKey: createIdempotencyKey } : {}),
        variableSetIds:
          removal === "revoke"
            ? [variableSet.id, retainedVariableSet.id]
            : [retainedVariableSet.id, variableSet.id],
      }),
    });
    expect(
      await waitForBlockedBackend(blockerPid, `Variable Set create ${removal} race request`),
    ).toBeGreaterThan(0);

    if (removal === "revoke") {
      expect(
        await deleteVariableSet(
          removalClient.db,
          {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId,
            subjectId: value.grant.subjectId,
          },
          variableSet.id,
        ),
      ).toBe(true);
    } else {
      await shared.admin`
        delete from workspace_variable_sets
        where account_id = ${value.grant.accountId}
          and id = ${variableSet.id}
      `;
    }
    releaseBlocker.resolve();

    const response = await request;
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "SESSION_CREATE_REJECTED",
      message: "One or more selected Variable Sets are no longer available.",
      details: { variableSetIds: [variableSet.id] },
    });
    expect(
      await sessionCreateFootprint(
        value.grant.workspaceId,
        requestedSessionId,
        createIdempotencyKey,
      ),
    ).toEqual({
      sessionCount: 0,
      selectionCount: 0,
      attachmentCount: 0,
      eventCount: 0,
      auditCount: 0,
      turnCount: 0,
      historyCount: 0,
      wakeCount: 0,
      leaseCount: 0,
      runtimeMutationCount: 0,
      usageCount: 0,
      spawnDenialCount: 0,
    });
  } finally {
    releaseBlocker.resolve();
    await Promise.allSettled([...(blocker ? [blocker] : []), ...(request ? [request] : [])]);
    await routeClient.close();
    await removalClient.close();
  }
}

describe("embedding host session authorization routes", () => {
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
    expect(await malformedPageResponse.text()).toBe("invalid goal revision page query");

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

  test("replaces ordered Variable Sets only after exact session and resource authorization", async () => {
    if (!available) return;
    const value = await fixture();
    const first = await createVariableSet(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      name: `session-first-${crypto.randomUUID()}`,
    });
    const second = await createVariableSet(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      name: `session-second-${crypto.randomUUID()}`,
    });
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      permissions: [
        "sessions:read",
        "sessions:control",
        "variable-sets:attach",
        "variable-sets:use",
      ],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const decisions: Array<{ operation: string; surface: string }> = [];
    const app = appWith({
      authorizeSession: async ({ operation, surface }) => {
        decisions.push({ operation, surface });
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    });
    const path = `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/variable-sets`;
    const response = await app.request(path, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ variableSetIds: [first.id, second.id] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: value.child.id,
      variableSetIds: [first.id, second.id],
      variableSetId: second.id,
    });
    expect(decisions).toContainEqual({
      operation: "session.variable_sets.write",
      surface: "http",
    });
    const events = (
      await listSessionEvents(client.db, value.grant.workspaceId, value.child.id)
    ).filter((event) => event.type === "session.variable_sets.updated");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      variableSets: [
        { id: first.id, name: first.name },
        { id: second.id, name: second.name },
      ],
      collisionPolicy: "later_selected_set_wins",
    });
  });

  test("returns 422 without session mutation when Variable Set revoke wins after validation", async () => {
    if (!available || !shared) return;
    await expectControlledVariableSetRemovalRace("revoke");
  });

  test("returns 422 without session mutation when Variable Set delete wins after validation", async () => {
    if (!available || !shared) return;
    await expectControlledVariableSetRemovalRace("delete");
  });

  test("returns structured 422 with no partial create when Variable Set revoke wins after validation", async () => {
    if (!available || !shared) return;
    await expectControlledVariableSetCreateRemovalRace("revoke");
  });

  test("returns structured 422 with no partial create when Variable Set delete wins after validation", async () => {
    if (!available || !shared) return;
    await expectControlledVariableSetCreateRemovalRace("delete");
  });

  test("preserves unrelated create-time foreign key failures", async () => {
    if (!available || !shared) return;
    const value = await fixture();
    const variableSet = await createVariableSet(client.db, {
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

  test("rejects Variable Set replacement after a prompt has been accepted but not claimed", async () => {
    if (!available) return;
    const value = await fixture();
    const variableSet = await createVariableSet(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      name: `session-queued-${crypto.randomUUID()}`,
    });
    await withWorkspaceSubjectSessionActivityRls(
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
          text: "accepted before Variable Set replacement",
          resources: [],
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          reasoningEffortFallback: "low",
          source: "user",
        }),
    );
    const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: value.grant.accountId,
      workspaceId: value.grant.workspaceId,
      subjectId: value.grant.subjectId,
      permissions: [
        "sessions:read",
        "sessions:control",
        "variable-sets:attach",
        "variable-sets:use",
      ],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const app = appWith({
      authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "root" }),
      resolveListScope: async () => ({ kind: "all" }),
    });
    const response = await app.request(
      `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.child.id}/variable-sets`,
      {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ variableSetIds: [variableSet.id] }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("no accepted, queued, claimed, or pending work");
    const [session] = await shared!.admin<
      Array<{ variableSetIds: string[]; variableSetId: string | null }>
    >`
      select variable_set_ids as "variableSetIds", variable_set_id as "variableSetId"
      from sessions
      where workspace_id = ${value.grant.workspaceId}
        and id = ${value.child.id}
    `;
    expect(session).toEqual({ variableSetIds: [], variableSetId: null });
    const events = (
      await listSessionEvents(client.db, value.grant.workspaceId, value.child.id)
    ).filter((event) => event.type === "session.variable_sets.updated");
    expect(events).toHaveLength(0);
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
      total: number;
    }>(server, "sessions_list", { query: "Shared host search target" });
    expect(listed.total).toBe(1);
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id: value.child.id, parentSessionId: null }),
    ]);
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

  test("lets a live agent answer a child's human-input request but never decide a tool approval", async () => {
    if (!available) return;
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

    const answered = await callMcpTool<McpMutationReceiptType>(
      server,
      "session_human_input_respond",
      {
        sessionId: value.child.id,
        requestId,
        response: { outcome: "answered", answers: [{ questionId: "env", values: ["staging"] }] },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(answered.resource).toMatchObject({
      type: "session_human_input_request",
      id: requestId,
      state: "answered",
    });
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
    expect(events.some((event) => event.type === "user.humanInputResponse")).toBe(true);
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
