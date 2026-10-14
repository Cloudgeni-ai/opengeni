import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import { SITE_NO_ORIGIN_ID } from "@opengeni/contracts/site-session-http";
import {
  assertNotSiteClampedAgent,
  assertScheduledTaskMutationOwner,
  createValidatedScheduledTask,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  siteAgentClamp,
  siteAgentMayReachSession,
  withSiteSessionOrigin,
  type ApiRouteDeps,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
  type SiteSessionOrigin,
} from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
import { registerSitePublicationTools } from "../src/mcp/site-publication-tools";
import { resolveSiteManagement } from "../src/site-publishing/service";

// OPE-801: Site pages reach only the SITE_OPERATIONS allowlist and only their
// own Site's sessions, everything they start records which Site, and agents
// started from a Site cannot reach outside it (schedules, automations, other
// sessions). These run the real routes against PostgreSQL as the restricted
// application role.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("site-frame-boundary");
  if (!acquired) throw new Error("Site frame boundary tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const permissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "artifacts:read",
  "artifacts:publish",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
] as const;

function memoryObjectStorage(): ObjectStorageDependency {
  const objects = new Map<string, Uint8Array>();
  return {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    getObjectRange: async (input: { key: string; start: number; endInclusive: number }) => {
      const bytes = objects.get(input.key);
      return bytes
        ? { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v" }
        : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    createGetUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPutUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders: {},
    }),
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageDependency;
}

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Site frame fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...permissions, "workspace:admin", "members:manage", "account:admin"],
  });
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    // Published Sites on, so their management routes are reachable.
    sitesDomain: "sites.example.test",
    sitesGatewaySecret: "c".repeat(40),
  });
  const objectStorage = memoryObjectStorage();
  // Every workflow call is a no-op: these tests only check what is admitted.
  const workflowClient = new Proxy({}, { get: () => noop }) as unknown as SessionWorkflowClient;
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage,
    workflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const identity = await ensureExternalIdentity(db.db, {
    accountId,
    source,
    externalId: crypto.randomUUID(),
  });
  const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({
      identity: { source, externalId: identity.externalId },
      permissions,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status).toBe(200);
  const grant: AccessGrant = {
    accountId,
    workspaceId: workspace.id,
    subjectId: identity.subjectId,
    permissions: [...permissions] as AccessGrant["permissions"],
    principalKind: "human_session",
  };
  const headers = {
    ...service,
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
    ),
  };
  const ws = `/v1/workspaces/${workspace.id}`;
  const call = (method: string, path: string, frame: Record<string, string> = {}, body?: unknown) =>
    app.request(`${ws}${path}`, {
      method,
      headers: { ...headers, ...frame },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const publish = async (title: string) => {
    const response = await call(
      "POST",
      "/published-artifacts",
      {},
      {
        title,
        html: `<!doctype html><h1>${title}</h1>`,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { artifact: { id: string }; version: { id: string } };
    return {
      siteId: body.artifact.id,
      versionId: body.version.id,
      frame: (frameId: string) => ({
        "x-opengeni-site-frame": "1",
        "x-opengeni-site-frame-id": frameId,
        "x-opengeni-site-id": body.artifact.id,
        "x-opengeni-site-version": body.version.id,
      }),
    };
  };
  const inline = (frameId: string) => ({
    "x-opengeni-site-frame": "1",
    "x-opengeni-site-frame-id": frameId,
  });
  const startSession = async (frame: Record<string, string> = {}) => {
    const response = await call("POST", "/sessions", frame, {
      initialMessage: "Hello from a page",
      sandboxBackend: "none",
    });
    expect(response.status, await response.clone().text()).toBe(202);
    return ((await response.json()) as { id: string }).id;
  };
  const sessionRow = async (sessionId: string) => {
    const [row] = await shared.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from sessions where id = ${sessionId}`;
    return row!;
  };
  const turns = async (sessionId: string) =>
    await shared.admin<{ surface: string | null; metadata: Record<string, unknown> }[]>`
      select surface, metadata from session_turns where session_id = ${sessionId}
      order by created_at`;
  const agentGrant = async (sessionId: string): Promise<AccessGrant> => {
    const [turn] = await shared.admin<{ id: string }[]>`
      select id from session_turns where session_id = ${sessionId} order by created_at limit 1`;
    return {
      ...grant,
      principalKind: "agent_attempt",
      metadata: { sessionId, ...(turn ? { turnId: turn.id } : {}) },
    };
  };
  /** An agent grant with a running turn and attempt, as the worker's first-party MCP sees it. */
  const liveAgentGrant = async (sessionId: string): Promise<AccessGrant> => {
    const [turn] = await shared.admin<{ id: string }[]>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id, initiator_context
      ) values (
        ${accountId}, ${workspace.id}, ${sessionId}, gen_random_uuid(),
        ${`frame-wf-${crypto.randomUUID()}`}, 'running',
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${sessionId}),
        'Agent work', 'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${identity.subjectId},
        '{"accepted":true}'::jsonb
      ) returning id`;
    const attemptId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`update sessions set active_turn_id = ${turn!.id} where id = ${sessionId}`;
      await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
      await tx`insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies
        ) values (
          ${attemptId}, ${accountId}, ${workspace.id}, ${sessionId}, ${turn!.id}, 1,
          'running', 'frame-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
          '{}'::jsonb
        )`;
    });
    return {
      ...grant,
      principalKind: "agent_attempt",
      metadata: { sessionId, turnId: turn!.id, attemptId, executionGeneration: 1 },
    };
  };
  return {
    app,
    settings,
    objectStorage,
    accountId,
    workspace,
    grant,
    headers,
    service,
    call,
    publish,
    inline,
    startSession,
    sessionRow,
    turns,
    agentGrant,
    liveAgentGrant,
  };
}

test("a published Site frame reaches only SITE_OPERATIONS and only its own Site's sessions", async () => {
  const f = await fixture();
  const siteA = await f.publish("Site A");
  const siteB = await f.publish("Site B");
  const frameA = siteA.frame("frame-a");
  const frameB = siteB.frame("frame-b");

  // Create from a Site records which Site and version; the first turn is a Site turn.
  const fromA = await f.startSession(frameA);
  expect((await f.sessionRow(fromA)).metadata._opengeniSiteOrigin).toEqual({
    siteId: siteA.siteId,
    title: "Site A",
    versionId: siteA.versionId,
  });
  expect((await f.turns(fromA)).map((turn) => turn.surface)).toEqual(["site"]);
  const plain = await f.startSession();
  expect((await f.sessionRow(plain)).metadata._opengeniSiteOrigin).toBeUndefined();

  // The same Site reads and messages its own session, and the turn records the Site.
  expect((await f.call("GET", `/sessions/${fromA}`, frameA)).status).toBe(200);
  const sent = await f.call("POST", `/sessions/${fromA}/events`, frameA, {
    type: "user.message",
    payload: { text: "A follow-up from Site A" },
  });
  expect(sent.status, await sent.clone().text()).toBeLessThan(300);
  const sentTurns = await f.turns(fromA);
  expect(sentTurns).toHaveLength(2);
  expect(sentTurns[1]!.surface).toBe("site");
  expect(sentTurns[1]!.metadata._opengeniSiteOrigin).toEqual({
    siteId: siteA.siteId,
    title: "Site A",
    versionId: siteA.versionId,
  });

  // Site B, and Site A on a session no Site started, get the same 404 as a
  // missing session on every read and agent operation.
  const missing = crypto.randomUUID();
  const operations: Array<[string, string, unknown]> = [
    ["GET", "", undefined],
    ["GET", "/events", undefined],
    ["GET", "/events/stream", undefined],
    ["GET", "/queue", undefined],
    ["POST", "/events", { type: "user.message", payload: { text: "From Site B" } }],
    ["POST", "/steer", { text: "From Site B" }],
    ["POST", "/control", { action: "interrupt" }],
    ["GET", "/composer-draft", undefined],
    ["POST", "/composer-draft/submit", {}],
  ];
  for (const [method, suffix, body] of operations) {
    for (const [frame, sessionId] of [
      [frameB, fromA],
      [frameA, plain],
      [frameB, missing],
    ] as const) {
      const response = await f.call(method, `/sessions/${sessionId}${suffix}`, frame, body);
      expect({ op: `${method} ${suffix}`, status: response.status }).toEqual({
        op: `${method} ${suffix}`,
        status: 404,
      });
    }
  }
  // Nothing Site B tried reached Site A's session.
  expect(await f.turns(fromA)).toHaveLength(2);

  // Outside the allowlist, a frame reaches nothing, even routes the viewer may use.
  for (const [method, path] of [
    ["GET", "/scheduled-tasks"],
    ["POST", "/scheduled-tasks"],
    ["GET", "/automations/triggers"],
    ["PUT", `/sessions/${fromA}/tool-policy`],
    ["PUT", `/sessions/${fromA}/visibility`],
    ["GET", `/sessions/${fromA}/turns`],
    ["GET", "/published-artifacts"],
  ] as const) {
    const response = await f.call(method, path, frameA, method === "GET" ? undefined : {});
    expect({ path: `${method} ${path}`, status: response.status }).toEqual({
      path: `${method} ${path}`,
      status: 404,
    });
  }
  expect((await f.call("GET", "/scheduled-tasks")).status).toBe(200);

  // A frame lists only its own Site's conversations.
  const listed = await f.call("GET", `/sessions?originSiteId=${siteA.siteId}`, frameA);
  expect(listed.status).toBe(200);
  const ids = ((await listed.json()) as Array<{ id: string }>).map((session) => session.id);
  expect(ids).toEqual([fromA]);
  expect((await f.call("GET", `/sessions?originSiteId=${siteB.siteId}`, frameA)).status).toBe(404);
  expect((await f.call("GET", "/sessions", frameA)).status).toBe(404);

  // Another Site's data is refused as the Site Data service refuses it.
  expect(
    (await f.call("POST", `/published-artifacts/${siteB.siteId}/data/query`, frameA, {})).status,
  ).toBe(403);

  // A published origin the viewer cannot verify fails instead of running unattributed.
  const forged = { ...frameA, "x-opengeni-site-version": crypto.randomUUID() };
  expect((await f.call("GET", `/sessions/${fromA}`, forged)).status).toBe(404);
});

test("an inline frame without a published Site reaches only the sessions it started", async () => {
  const f = await fixture();
  const site = await f.publish("Published");
  const first = await f.startSession(f.inline("frame-1"));
  expect((await f.sessionRow(first)).metadata._opengeniSiteOrigin).toEqual({
    siteId: null,
    title: "",
    frame: "inline",
    frameId: "frame-1",
  });
  expect((await f.turns(first)).map((turn) => turn.surface)).toEqual(["site"]);
  expect((await f.call("GET", `/sessions/${first}`, f.inline("frame-1"))).status).toBe(200);
  const steer = await f.call("POST", `/sessions/${first}/steer`, f.inline("frame-1"), {
    text: "Same frame",
  });
  expect(steer.status, await steer.clone().text()).toBeLessThan(300);
  const steered = await f.turns(first);
  expect(steered.at(-1)!.metadata._opengeniSiteOrigin).toEqual({
    siteId: null,
    title: "",
    frame: "inline",
    frameId: "frame-1",
  });
  for (const frame of [
    f.inline("frame-2"),
    site.frame("frame-1"),
    { "x-opengeni-site-frame": "1" },
  ])
    expect((await f.call("GET", `/sessions/${first}`, frame)).status).toBe(404);
  // A frame without a published Site lists no Site and has no Site Data.
  expect(
    (await f.call("GET", `/sessions?originSiteId=${SITE_NO_ORIGIN_ID}`, f.inline("frame-1")))
      .status,
  ).toBe(200);
  expect(
    (await f.call("GET", `/sessions?originSiteId=${site.siteId}`, f.inline("frame-1"))).status,
  ).toBe(404);
  expect(
    (
      await f.call(
        "POST",
        `/published-artifacts/${site.siteId}/data/query`,
        f.inline("frame-1"),
        {},
      )
    ).status,
  ).toBe(403);
});

test("a tool a Site page called acts only on that Site's sessions", async () => {
  const f = await fixture();
  const siteA = await f.publish("Site A");
  const siteB = await f.publish("Site B");
  const fromA = await f.startSession(siteA.frame("frame-a"));
  const plain = await f.startSession();
  const authorize = (origin: SiteSessionOrigin, sessionId: string, operation: string) =>
    withSiteSessionOrigin(origin, () =>
      requireSessionAuthorization({ db: db.db }, f.grant, {
        sessionId,
        operation: operation as never,
        surface: "first_party_mcp",
      }),
    );
  const originA = { siteId: siteA.siteId, title: "Site A" };
  const originB = { siteId: siteB.siteId, title: "Site B" };
  await expect(authorize(originA, fromA, "session.append")).resolves.toBeDefined();
  for (const [origin, sessionId] of [
    [originB, fromA],
    [originA, plain],
  ] as const)
    for (const operation of ["session.append", "session.steer", "session.control"])
      await expect(authorize(origin, sessionId, operation)).rejects.toBeInstanceOf(
        SessionAuthorizationDeniedError,
      );
  // Reads keep the viewer's ordinary authorization.
  await expect(authorize(originB, fromA, "session.read")).resolves.toBeDefined();
  // An agent a Site started reads only sessions acting for the same Site:
  // another session's transcript is data its page must not reach.
  const otherFromA = await f.startSession(siteA.frame("frame-a2"));
  const fromAAgent = await f.liveAgentGrant(fromA);
  const plainAgent = await f.liveAgentGrant(plain);
  const agentRead = (agent: AccessGrant, sessionId: string) =>
    requireSessionAuthorization({ db: db.db }, agent, {
      sessionId,
      operation: "session.read",
      surface: "first_party_mcp",
    });
  await expect(agentRead(fromAAgent, fromA)).resolves.toBeDefined();
  await expect(agentRead(fromAAgent, otherFromA)).resolves.toBeDefined();
  await expect(agentRead(fromAAgent, plain)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  await expect(agentRead(plainAgent, fromA)).resolves.toBeDefined();
  // Without a Site origin nothing changes.
  await expect(
    requireSessionAuthorization({ db: db.db }, f.grant, {
      sessionId: plain,
      operation: "session.append",
      surface: "first_party_mcp",
    }),
  ).resolves.toBeDefined();
});

test("agents started from a Site cannot create or change schedules or reach other sessions", async () => {
  const f = await fixture();
  const siteA = await f.publish("Site A");
  const siteB = await f.publish("Site B");
  const fromA = await f.startSession(siteA.frame("frame-a"));
  const otherFromA = await f.startSession(siteA.frame("frame-a2"));
  const fromB = await f.startSession(siteB.frame("frame-b"));
  const fromFrame = await f.startSession(f.inline("frame-1"));
  const plain = await f.startSession();
  // A child an inline-frame session spawned acts for that frame too.
  const child = await withSessionRlsActorContext({ subjectId: f.grant.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      parentSessionId: fromFrame,
      initialMessage: "Child work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.grant.subjectId },
      subjectId: f.grant.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );

  expect(await siteAgentClamp(db.db, await f.agentGrant(fromA))).toEqual({
    clamped: true,
    originSiteIds: [siteA.siteId],
  });
  expect(await siteAgentClamp(db.db, await f.agentGrant(fromFrame))).toMatchObject({
    clamped: true,
    originSiteIds: [],
  });
  expect(await siteAgentClamp(db.db, await f.agentGrant(child.id))).toMatchObject({
    clamped: true,
  });
  expect(await siteAgentClamp(db.db, await f.agentGrant(plain))).toEqual({
    clamped: false,
    originSiteIds: [],
  });
  expect(await siteAgentClamp(db.db, f.grant)).toBeNull();

  const refusal = "An agent started from a Site page cannot create or change schedules";
  for (const sessionId of [fromA, fromFrame, child.id]) {
    const agent = await f.agentGrant(sessionId);
    await expect(assertNotSiteClampedAgent(db.db, agent, "schedules")).rejects.toMatchObject({
      status: 403,
      message: refusal,
    });
    await expect(
      createValidatedScheduledTask({
        settings: f.settings,
        db: db.db,
        objectStorage: f.objectStorage,
        grant: agent,
        payload: {
          name: "Nightly",
          schedule: { type: "manual" },
          runMode: "new_session_per_run",
          agentConfig: { prompt: "Do it", tools: [], resources: [], metadata: {} },
        } as never,
      }),
    ).rejects.toMatchObject({ status: 403, message: refusal });
  }
  await expect(
    assertNotSiteClampedAgent(db.db, await f.agentGrant(plain), "schedules"),
  ).resolves.toBeUndefined();

  // A Site-started agent messages only sessions acting for the same Site.
  const scope = { accountId: f.accountId, workspaceId: f.workspace.id };
  const caller = (sessionId: string) => ({ sessionId, turnId: null });
  expect(await siteAgentMayReachSession(db.db, scope, caller(fromA), fromA)).toBe(true);
  expect(await siteAgentMayReachSession(db.db, scope, caller(fromA), otherFromA)).toBe(true);
  expect(await siteAgentMayReachSession(db.db, scope, caller(fromA), plain)).toBe(false);
  expect(await siteAgentMayReachSession(db.db, scope, caller(fromA), fromB)).toBe(false);
  expect(await siteAgentMayReachSession(db.db, scope, caller(fromA), crypto.randomUUID())).toBe(
    false,
  );
  expect(await siteAgentMayReachSession(db.db, scope, caller(child.id), fromFrame)).toBe(true);
  expect(await siteAgentMayReachSession(db.db, scope, caller(child.id), fromA)).toBe(false);
  // An agent no Site started is not limited by this clamp.
  expect(await siteAgentMayReachSession(db.db, scope, caller(plain), fromA)).toBe(true);
});

test("a schedule created from a Site records the Site; another Site cannot change it", async () => {
  const f = await fixture();
  const siteA = await f.publish("Site A");
  const siteB = await f.publish("Site B");
  const originA: SiteSessionOrigin = {
    siteId: siteA.siteId,
    title: "Site A",
    versionId: siteA.versionId,
  };
  const originB: SiteSessionOrigin = { siteId: siteB.siteId, title: "Site B" };
  const forged = { _opengeniSiteOrigin: { siteId: siteB.siteId, title: "Forged" }, keep: "me" };
  const create = () =>
    f.call(
      "POST",
      "/scheduled-tasks",
      {},
      {
        name: "From a Site",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize", metadata: forged },
      },
    );
  // A Site tool call runs inside the validated Site origin.
  const fromSite = await withSiteSessionOrigin(originA, create);
  expect(fromSite.status, await fromSite.clone().text()).toBe(201);
  const task = (await fromSite.json()) as { id: string };
  const [row] = await shared.admin<{ agent_config: { metadata: Record<string, unknown> } }[]>`
    select agent_config from scheduled_tasks where id = ${task.id}`;
  expect(row!.agent_config.metadata).toEqual({ keep: "me", _opengeniSiteOrigin: originA });
  // Without a Site origin a caller cannot supply one.
  const direct = await create();
  expect(direct.status).toBe(201);
  const directTask = (await direct.json()) as { id: string };
  const [directRow] = await shared.admin<{ agent_config: { metadata: Record<string, unknown> } }[]>`
    select agent_config from scheduled_tasks where id = ${directTask.id}`;
  expect(directRow!.agent_config.metadata).toEqual({ keep: "me" });

  // The creating Site may run its schedule; another Site, or a Site on a
  // schedule no Site created, sees no schedule at all.
  await expect(
    withSiteSessionOrigin(originA, () => assertScheduledTaskMutationOwner(db.db, f.grant, task.id)),
  ).resolves.toBeUndefined();
  for (const [origin, taskId] of [
    [originB, task.id],
    [originA, directTask.id],
  ] as const)
    await expect(
      withSiteSessionOrigin(origin, () => assertScheduledTaskMutationOwner(db.db, f.grant, taskId)),
    ).rejects.toMatchObject({ status: 404 });
  // An agent started from a Site cannot change any schedule.
  const fromA = await f.startSession(siteA.frame("frame-a"));
  await expect(
    assertScheduledTaskMutationOwner(db.db, await f.agentGrant(fromA), directTask.id),
  ).rejects.toMatchObject({ status: 403 });

  // Automations are never created or changed from a Site page, even by an admin.
  const automation = await withSiteSessionOrigin(originA, () =>
    f.app.request(`/v1/workspaces/${f.workspace.id}/automations/sources`, {
      method: "POST",
      headers: f.service,
      body: JSON.stringify({}),
    }),
  );
  expect(automation.status).toBe(403);
  expect(await automation.text()).toContain("A Site page cannot create or change automations");
  // Outside a Site the same admin request reaches validation.
  const outside = await f.app.request(`/v1/workspaces/${f.workspace.id}/automations/sources`, {
    method: "POST",
    headers: f.service,
    body: JSON.stringify({}),
  });
  expect(outside.status).not.toBe(403);
});

test("Site pages and agents started from them cannot change Site publications", async () => {
  const f = await fixture();
  const site = await f.publish("Site A");
  const fromSite = await f.startSession(site.frame("frame-a"));
  const plain = await f.startSession();
  const deps = {
    db: db.db,
    settings: f.settings,
    objectStorage: f.objectStorage,
  } as unknown as ApiRouteDeps;
  const origin: SiteSessionOrigin = {
    siteId: site.siteId,
    title: "Site A",
    versionId: site.versionId,
  };
  const clamped = await f.agentGrant(fromSite);
  const refusedWith = (code: string) => ({ status: 403, details: { code } });

  // The check every publication change runs first.
  await expect(
    resolveSiteManagement(deps, clamped, site.siteId, { mutate: true }),
  ).rejects.toMatchObject(refusedWith("site_agent_forbidden"));
  await expect(
    withSiteSessionOrigin(origin, () =>
      resolveSiteManagement(deps, f.grant, site.siteId, { mutate: true }),
    ),
  ).rejects.toMatchObject(refusedWith("site_page_forbidden"));
  // People, and agents no Site started, still manage their Sites.
  await expect(
    resolveSiteManagement(deps, f.grant, site.siteId, { mutate: true }),
  ).resolves.toMatchObject({ manager: true });
  await expect(
    resolveSiteManagement(deps, await f.liveAgentGrant(plain), site.siteId, { mutate: true }),
  ).resolves.toMatchObject({ manager: true });
  // A Site-started agent is refused before anything else, live attempt or not.
  await expect(
    resolveSiteManagement(deps, await f.liveAgentGrant(fromSite), site.siteId, { mutate: true }),
  ).rejects.toMatchObject(refusedWith("site_agent_forbidden"));

  // The agent tool refuses a Site-started agent.
  const server = new McpServer({ name: "site-publication-clamp", version: "1" });
  registerSitePublicationTools(
    server,
    deps,
    clamped,
    async () => undefined,
    (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "site-publication-clamp", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    const result = await mcp.callTool({
      name: "site_publication_update",
      arguments: { siteId: site.siteId, access: "members" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(JSON.parse(text).error.details.code).toBe("site_agent_forbidden");
  } finally {
    await mcp.close();
  }

  // Every publication route: a framed page never reaches it (the frame
  // allowlist), and a request inside a Site origin is refused by the route.
  const publication = `/published-artifacts/${site.siteId}/publication`;
  const routes: Array<[string, string, unknown]> = [
    ["PUT", publication, { access: "members" }],
    ["DELETE", publication, undefined],
    ["POST", `${publication}/takedown`, { reason: "From a Site page" }],
    ["POST", `${publication}/restore`, {}],
    ["PUT", "/site-limit-profile", { kind: "free" }],
  ];
  // The workspace limit profile is an admin route: the admin credential calls it.
  const as = (path: string, frame: Record<string, string>, method: string, body: unknown) =>
    path === "/site-limit-profile"
      ? f.app.request(`/v1/workspaces/${f.workspace.id}${path}`, {
          method,
          headers: { ...f.service, ...frame },
          body: JSON.stringify(body),
        })
      : f.call(method, path, frame, body);
  for (const [method, path, body] of routes) {
    const framed = await as(path, site.frame("frame-a"), method, body);
    expect({ route: `${method} ${path}`, status: framed.status }).toEqual({
      route: `${method} ${path}`,
      status: 404,
    });
    const inOrigin = await withSiteSessionOrigin(origin, () => as(path, {}, method, body));
    const json = (await inOrigin.json()) as { error?: { details?: { code?: string } } };
    expect({
      route: `${method} ${path}`,
      status: inOrigin.status,
      code: json.error?.details?.code,
    }).toEqual({ route: `${method} ${path}`, status: 403, code: "site_page_forbidden" });
  }
  const [published] = await shared.admin<{ n: number }[]>`
    select count(*)::int as n from site_publications where site_id = ${site.siteId}`;
  expect(published!.n).toBe(0);
  // Outside a Site the same person publishes.
  expect((await f.call("PUT", publication, {}, { access: "members" })).status).toBe(201);

  // A Site page may start a conversation, but not choose its tools or authority.
  for (const extra of [
    { tools: [{ kind: "mcp", id: "crm" }] },
    { firstPartyMcpTools: ["sessions_list"] },
    { vaultPolicy: { mode: "all" } },
  ]) {
    const response = await f.call("POST", "/sessions", site.frame("frame-a"), {
      initialMessage: "Hello from a page",
      sandboxBackend: "none",
      ...extra,
    });
    expect({ extra, status: response.status }).toEqual({ extra, status: 403 });
    expect(((await response.json()) as { code?: string }).code).toBe(
      "SITE_SESSION_TOOLS_FORBIDDEN",
    );
  }
});
