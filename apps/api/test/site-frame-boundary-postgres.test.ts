import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSiteToolBridge } from "@opengeni/sdk/site";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { SITE_NO_ORIGIN_ID } from "@opengeni/contracts/site-session-http";
import {
  assertScheduledTaskMutationOwner,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
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
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";
import { registerKnowledgeEntryTools } from "../src/mcp/knowledge-entries";
import { registerSecretTools } from "../src/mcp/secret-tools";
import { resolveSiteManagement } from "../src/site-publishing/service";

// Site pages reach only the SITE_OPERATIONS allowlist and only their
// own Site's sessions and explicitly allowed chats. Agents retain ordinary
// native authority. These run the real routes against PostgreSQL as the
// restricted application role.
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

async function fixture(overrides: { sandboxBackend?: "none" | "docker" } = {}) {
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
    sandboxBackend: overrides.sandboxBackend ?? "none",
    // Published Sites on, so their management routes are reachable.
    sitesDomain: "sites.example.test",
    sitesGatewaySecret: "c".repeat(40),
    mcpServers: [{ id: "crm", url: "https://crm.example.test/mcp" }],
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
  const publish = async (title: string, extra: Record<string, unknown> = {}) => {
    const response = await call(
      "POST",
      "/published-artifacts",
      {},
      {
        title,
        html: `<!doctype html><h1>${title}</h1>`,
        idempotencyKey: crypto.randomUUID(),
        ...extra,
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
    // A Site page sends only a message and model choices; the workspace
    // default backend in these tests is already "none".
    const response = await call("POST", "/sessions", frame, {
      initialMessage: "Hello from a page",
      ...(Object.keys(frame).length === 0 ? { sandboxBackend: "none" } : {}),
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
  const liveAgentGrant = async (
    sessionId: string,
    surface: "site" | "web" = "web",
  ): Promise<AccessGrant> => {
    const [turn] = await shared.admin<{ id: string }[]>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id, initiator_context, surface
      ) values (
        ${accountId}, ${workspace.id}, ${sessionId}, gen_random_uuid(),
        ${`frame-wf-${crypto.randomUUID()}`}, 'running',
        (select coalesce(max(position), 0) + 1 from session_turns where session_id = ${sessionId}),
        'Agent work', 'gpt-5.6-sol', 'medium', 'none', 1, 'subject', ${identity.subjectId},
        '{"accepted":true}'::jsonb, ${surface}
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

test("existing-chat search includes pinned private children", async () => {
  const f = await fixture();
  const rootResponse = await f.call(
    "POST",
    "/sessions",
    {},
    {
      initialMessage: "Existing project",
      visibility: "private",
      sandboxBackend: "none",
    },
  );
  expect(rootResponse.status, await rootResponse.clone().text()).toBe(202);
  const root = ((await rootResponse.json()) as { id: string }).id;
  const agent = await f.liveAgentGrant(root);
  const child = await withSessionRlsActorContext({ subjectId: f.grant.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      parentSessionId: root,
      visibility: "user_private",
      createdByActor: {
        type: "agent_attempt",
        sessionId: root,
        turnId: String(agent.metadata!.turnId),
        attemptId: String(agent.metadata!.attemptId),
        executionGeneration: 1,
      },
      initialMessage: "Existing specialist",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.grant.subjectId },
      subjectId: f.grant.subjectId,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const title = "Long-running specialist child";
  const renamed = await f.call("PATCH", `/sessions/${child.id}`, {}, { title });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  expect((await f.call("PUT", `/sessions/${child.id}/pin`, {}, { pinned: true })).status).toBe(200);
  const search = `/sessions?view=page&search=${encodeURIComponent(title)}`;
  const omitted = await (await f.call("GET", `${search}&includePinned=false`)).json();
  expect([...omitted.pinned, ...omitted.sessions]).toEqual([]);
  const found = await (await f.call("GET", search)).json();
  expect(found.pinned.map((s: { id: string }) => s.id)).toEqual([child.id]);
  expect(found.pinned[0].tenancy.ownedByCurrentUser).toBe(true);
});

test("Site composer config binds the host workspace instead of querying the site-host alias", async () => {
  const f = await fixture();
  const site = await f.publish("Config dashboard", { visibility: "private" });
  const bridge = createSiteToolBridge({
    workspaceId: f.workspace.id,
    artifactId: site.siteId,
    siteVersionId: site.versionId,
    requestedTools: [],
    workspaceTools: {
      $catalog: async () => {
        throw new Error("unused");
      },
    },
    callTool: async () => {
      throw new Error("unused");
    },
    fetchResponse: (path, init) =>
      f.app.request(path, {
        ...init,
        headers: { ...f.headers, ...Object.fromEntries(new Headers(init.headers)) },
      }),
  });
  const response = await bridge.fetch!(
    {
      type: "opengeni.site.http",
      requestId: "config",
      method: "GET",
      path: "/v1/config/client?workspaceId=site-host",
      headers: [],
    },
    new AbortController().signal,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toHaveProperty("allowedModels");
  const invalid = await f.app.request("/v1/config/client?workspaceId=site-host", {
    headers: f.headers,
  });
  expect(invalid.status).toBe(422);
});

test("an owner can allow an existing chat in one private console Site and revoke its live stream", async () => {
  const f = await fixture();
  const site = await f.publish("Private dashboard", { visibility: "private" });
  const other = await f.publish("Other dashboard", { visibility: "private" });
  const sharedSite = await f.publish("Shared dashboard");
  const sessionId = await f.startSession();
  const unrelated = await f.startSession();
  const before = await f.sessionRow(sessionId);
  const access = `/published-artifacts/${site.siteId}/session-access/${sessionId}`;
  const frame = site.frame("dashboard");
  expect((await f.call("GET", `/sessions/${sessionId}`, frame)).status).toBe(404);
  expect((await f.call("PUT", access, frame)).status).toBe(404);
  expect(
    (await f.call("PUT", `/published-artifacts/${sharedSite.siteId}/session-access/${sessionId}`))
      .status,
  ).toBe(404);
  const allowed = await f.call("PUT", access);
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect((await f.call("PUT", access)).status).toBe(200);
  expect((await f.call("GET", `/sessions/${sessionId}`, frame)).status).toBe(200);
  expect((await f.call("GET", `/sessions/${unrelated}`, frame)).status).toBe(404);
  expect((await f.call("GET", `/sessions/${sessionId}`, other.frame("other"))).status).toBe(404);
  // Published-runtime dispatch carries Site/version provenance, never the console marker.
  expect(
    (
      await f.call("GET", `/sessions/${sessionId}`, {
        "x-opengeni-site-id": site.siteId,
        "x-opengeni-site-version": site.versionId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.call("GET", `/sessions/${sessionId}`, {
        ...frame,
        "x-opengeni-site-frame": "preview",
      })
    ).status,
  ).toBe(404);
  const list = await f.call("GET", `/sessions?view=page&siteAccessId=${site.siteId}`, frame);
  expect(list.status).toBe(200);
  const page = await list.json();
  expect([...page.pinned, ...page.sessions].map((s: { id: string }) => s.id)).toEqual([sessionId]);
  expect(page.siteAccessId).toBe(site.siteId);
  const originList = await f.call("GET", `/sessions?view=page&originSiteId=${site.siteId}`, frame);
  expect((await originList.json()).sessions).toEqual([]);
  for (const filter of ["originSiteId", "siteAccessId"]) {
    // Console-only projections do not honor Site filters and must never bypass them.
    expect(
      (await f.call("GET", `/sessions?view=running_commands&${filter}=${site.siteId}`, frame))
        .status,
    ).toBe(404);
  }
  const draftPath = `/sessions/${sessionId}/composer-draft`;
  const initialDraft = await f.call("GET", draftPath, frame);
  expect(initialDraft.status).toBe(200);
  const initial = await initialDraft.json();
  const draft = {
    text: "Prepared for the owner to review and edit, not send",
    resources: [],
    model: initial.model,
    reasoningEffort: initial.reasoningEffort,
    latencyMode: initial.latencyMode,
    expectedRevision: initial.revision,
  };
  const turnsBeforeDraft = await f.turns(sessionId);
  const saved = await f.call("PUT", draftPath, frame, draft);
  expect(saved.status, await saved.clone().text()).toBe(200);
  const savedDraft = await saved.json();
  expect(savedDraft).toMatchObject({ text: draft.text, revision: initial.revision + 1 });
  expect(await (await f.call("GET", draftPath, frame)).json()).toMatchObject(savedDraft);
  expect(
    (await f.call("PUT", draftPath, frame, { ...draft, text: "Stale overwrite" })).status,
  ).toBe(409);
  expect(await f.turns(sessionId)).toEqual(turnsBeforeDraft);
  expect((await f.call("GET", `/sessions/${sessionId}/events`, frame)).status).toBe(200);
  expect(
    (
      await f.call("POST", `/sessions/${sessionId}/events`, frame, {
        type: "user.message",
        payload: { text: "unsafe", modelContext: "hidden" },
      })
    ).status,
  ).toBe(403);
  const sent = await f.call("POST", `/sessions/${sessionId}/events`, frame, {
    type: "user.message",
    payload: { text: "From the dashboard" },
  });
  expect(sent.status, await sent.clone().text()).toBeLessThan(300);
  expect((await f.sessionRow(sessionId)).metadata).toEqual(before.metadata);
  expect((await f.turns(sessionId)).at(-1)?.surface).toBe("site");
  const controller = new AbortController();
  const stream = await f.app.request(
    `/v1/workspaces/${f.workspace.id}/sessions/${sessionId}/events/stream`,
    {
      headers: { ...f.headers, ...frame },
      signal: controller.signal,
    },
  );
  expect(stream.status).toBe(200);
  const drained = stream.text();
  const deadline = setTimeout(
    () => controller.abort(new Error("revoked stream did not close")),
    8_000,
  );
  try {
    expect((await f.call("DELETE", access)).status).toBe(200);
    expect((await f.call("GET", `/sessions/${sessionId}`, frame)).status).toBe(404);
    expect((await f.call("GET", draftPath, frame)).status).toBe(404);
    expect(
      (
        await f.call("PUT", draftPath, frame, {
          ...draft,
          expectedRevision: savedDraft.revision,
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.call("POST", `/sessions/${sessionId}/events`, frame, { text: "No longer allowed" }))
        .status,
    ).toBe(404);
    const revokedList = await f.call(
      "GET",
      `/sessions?view=page&siteAccessId=${site.siteId}`,
      frame,
    );
    expect((await revokedList.json()).sessions).toEqual([]);
    await drained;
    expect(controller.signal.aborted).toBe(false);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  expect((await f.call("GET", `/sessions/${sessionId}`)).status).toBe(200);
}, 30_000);

test("Site chat grants require the owner, regardless of the agent turn surface", async () => {
  const f = await fixture();
  const site = await f.publish("Owner's dashboard", { visibility: "private" });
  const sessionId = await f.startSession();
  const path = `/published-artifacts/${site.siteId}/session-access/${sessionId}`;
  const other = await ensureExternalIdentity(db.db, {
    accountId: f.accountId,
    source: "example:instance",
    externalId: crypto.randomUUID(),
  });
  const added = await f.app.request(`/v1/workspaces/${f.workspace.id}/external-members`, {
    method: "POST",
    headers: f.service,
    body: JSON.stringify({
      identity: { source: "example:instance", externalId: other.externalId },
      permissions,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status).toBe(200);
  const otherHeaders = {
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { source: "example:instance", externalId: other.externalId },
      }),
    ),
  };
  expect((await f.call("PUT", path, otherHeaders)).status).toBe(404);
  expect((await f.call("PUT", path)).status).toBe(200);
  expect(
    (
      await f.call("GET", `/sessions/${sessionId}`, {
        ...site.frame("other-viewer"),
        ...otherHeaders,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await (
        await f.call("GET", `/published-artifacts/${site.siteId}/session-access`, otherHeaders)
      ).json()
    ).sessionIds,
  ).toEqual([]);
  const makeBearer = async (session: string) => {
    const grant = await f.liveAgentGrant(session);
    return `Bearer ${await signDelegatedAccessToken(f.settings.delegationSecret!, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      subjectId: "worker:first-party-mcp",
      permissions: [...permissions],
      principalKind: "agent_attempt",
      ...(grant.metadata as {
        sessionId: string;
        turnId: string;
        attemptId: string;
        executionGeneration: number;
      }),
      exp: Math.floor(Date.now() / 1000) + 600,
    })}`;
  };
  const plainToken = await makeBearer(await f.startSession());
  const agentRequest = (token: string, method: string) =>
    f.app.request(`/v1/workspaces/${f.workspace.id}${path}`, {
      method,
      headers: { authorization: token },
    });
  expect((await agentRequest(plainToken, "DELETE")).status).toBe(200);
  const grantResponse = await agentRequest(plainToken, "PUT");
  expect(grantResponse.status, await grantResponse.clone().text()).toBe(200);
  const clamped = await makeBearer(await f.startSession(site.frame("site-agent")));
  expect((await agentRequest(clamped, "PUT")).status).toBe(200);
  expect((await agentRequest(clamped, "DELETE")).status).toBe(200);
}, 30_000);

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
  const [audience] =
    await shared.admin`select visibility,owner_subject_id,site_id,site_owner_subject_id
    from sessions where id=${fromA}`;
  expect(audience).toMatchObject({
    visibility: "user_private",
    owner_subject_id: f.grant.subjectId,
    site_id: siteA.siteId,
    site_owner_subject_id: f.grant.subjectId,
  });
  const other = await ensureExternalIdentity(db.db, {
    accountId: f.accountId,
    source: "example:instance",
    externalId: crypto.randomUUID(),
  });
  const added = await f.app.request(`/v1/workspaces/${f.workspace.id}/external-members`, {
    method: "POST",
    headers: f.service,
    body: JSON.stringify({
      identity: { source: "example:instance", externalId: other.externalId },
      permissions,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(added.status).toBe(200);
  const otherActor = {
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({
        mode: "external",
        identity: { source: "example:instance", externalId: other.externalId },
      }),
    ),
  };
  for (const suffix of ["", "/events", "/events/stream", "/queue"]) {
    expect(
      (await f.call("GET", `/sessions/${fromA}${suffix}`, { ...frameA, ...otherActor })).status,
    ).toBe(404);
    expect((await f.call("GET", `/sessions/${fromA}${suffix}`, otherActor)).status).toBe(404);
  }
  const ordinary = await f.call("GET", "/sessions");
  expect(ordinary.status).toBe(200);
  expect(await ordinary.text()).not.toContain(fromA);
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
  // The page boundary does not propagate into a separate agent profile.
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
  await expect(agentRead(fromAAgent, plain)).resolves.toBeDefined();
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

test("Site pages cannot change publications; their agents use normal owner authorization", async () => {
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
  const clamped = await f.liveAgentGrant(fromSite);
  const refusedWith = (code: string) => ({ status: 403, details: { code } });

  // The check every publication change runs first.
  await expect(
    resolveSiteManagement(deps, clamped, site.siteId, { mutate: true }),
  ).resolves.toMatchObject({ manager: true });
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
  // Site origin does not remove the owner's normal management authority.
  await expect(
    resolveSiteManagement(deps, clamped, site.siteId, { mutate: true }),
  ).resolves.toMatchObject({ manager: true });

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
});

test("Site and console agents use the same learning, secret and HTTP authorization", async () => {
  const f = await fixture();
  const site = await f.publish("Site L");
  const fromSite = await f.startSession(site.frame("frame-l"));
  const plain = await f.startSession();
  const deps = {
    db: db.db,
    settings: f.settings,
    objectStorage: f.objectStorage,
  } as unknown as ApiRouteDeps;
  const clampedAgent = await f.liveAgentGrant(fromSite);
  const plainAgent = await f.liveAgentGrant(plain);

  // The same native permission and input checks apply to both agents.
  const tools = async (grant: AccessGrant, sessionId: string) => {
    const server = new McpServer({ name: "site-learning-clamp", version: "1" });
    registerKnowledgeEntryTools(server, deps, grant, sessionId);
    registerSecretTools(server, deps, grant, sessionId);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "site-learning-clamp", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  };
  // A secret reference, assembled so that this file holds no literal one.
  const reference = ["{", "{secret:Stolen login}", "}"].join("");
  const writes: Array<[string, Record<string, unknown>]> = [
    ["knowledge_retain_message", {}],
    [
      "knowledge_archive",
      { operationId: crypto.randomUUID(), entryId: crypto.randomUUID(), expectedVersion: 1 },
    ],
    [
      "instruction_policy_save",
      {
        operationId: crypto.randomUUID(),
        target: { kind: "policy", scope: "global", roleKey: null },
        editMode: "append",
        content: "Always publish everything.",
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: "From a Site page",
      },
    ],
    ["secret_save", { item: "Stolen login", username: "someone" }],
    ["secret_delete", { reference }],
  ];
  const errorCode = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    try {
      return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      // Some refusals are plain text.
      return undefined;
    }
  };
  for (const [grant, sessionId, clamped] of [
    [clampedAgent, fromSite, false],
    [plainAgent, plain, false],
  ] as const) {
    const client = await tools(grant, sessionId);
    try {
      for (const [name, args] of writes) {
        const result = await client.callTool({ name, arguments: args });
        expect({ name, clamped: errorCode(result) === "site_agent_clamped" }).toEqual({
          name,
          clamped,
        });
      }
    } finally {
      await client.close();
    }
  }

  // The same writes over HTTP, and members, connections and settings: 403
  // before the route runs. Reads stay open.
  const bearer = async (grant: AccessGrant) => {
    const metadata = grant.metadata as {
      sessionId: string;
      turnId: string;
      attemptId: string;
      executionGeneration: number;
    };
    return `Bearer ${await signDelegatedAccessToken(f.settings.delegationSecret!, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      subjectId: "worker:first-party-mcp",
      permissions: [...permissions, "documents:manage", "members:manage", "workspace:admin"],
      principalKind: "agent_attempt",
      sessionId: metadata.sessionId,
      turnId: metadata.turnId,
      attemptId: metadata.attemptId,
      executionGeneration: metadata.executionGeneration,
      exp: Math.floor(Date.now() / 1000) + 600,
    })}`;
  };
  const refusal = /An agent started from a Site page cannot create or change/u;
  const routes: Array<[string, string, unknown]> = [
    ["POST", "/knowledge/entries", {}],
    ["POST", "/instruction-policies/drafts", {}],
    ["POST", "/skills/content/save", {}],
    ["POST", "/vaults", { name: "Site vault" }],
    ["POST", "/members", {}],
    ["POST", "/connections", {}],
    ["PATCH", "/settings", {}],
  ];
  const as = async (grant: AccessGrant, method: string, path: string, body?: unknown) => {
    const response = await f.app.request(`/v1/workspaces/${f.workspace.id}${path}`, {
      method,
      headers: { authorization: await bearer(grant), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  for (const [method, path, body] of routes) {
    const route = `${method} ${path}`;
    const clamped = await as(clampedAgent, method, path, body);
    expect({ route, status: clamped.status, refused: refusal.test(clamped.text) }).toEqual({
      route,
      status: clamped.status,
      refused: false,
    });
    const other = await as(plainAgent, method, path, body);
    expect({ route, refused: refusal.test(other.text) }).toEqual({ route, refused: false });
    expect({ route, status: clamped.status }).toEqual({ route, status: other.status });
  }
  const search = await as(clampedAgent, "POST", "/knowledge/entries/search", {});
  expect(refusal.test(search.text)).toBe(false);
});

test("Site pages send message text only: no approvals, answers, resources or credentials", async () => {
  const f = await fixture();
  const site = await f.publish("Site A");
  const frame = site.frame("frame-a");
  const sessionId = await f.startSession(frame);
  const fileRef = { kind: "file", fileId: crypto.randomUUID() };
  const refused = async (method: string, suffix: string, body: unknown, field: string) => {
    const response = await f.call(method, `/sessions/${sessionId}${suffix}`, frame, body);
    const json = (await response.clone().json()) as {
      error?: { details?: { code?: string; field?: string } };
    };
    expect({ suffix, field, status: response.status, details: json.error?.details }).toEqual({
      suffix,
      field,
      status: 403,
      details: { code: "site_frame_field_forbidden", field },
    });
  };
  const message = (payload: Record<string, unknown>) => ({
    type: "user.message",
    payload: { text: "From the page", ...payload },
  });
  await refused(
    "POST",
    "/events",
    { type: "user.approvalDecision", payload: { approvalId: "call-1", decision: "approve" } },
    "type",
  );
  await refused(
    "POST",
    "/events",
    {
      type: "user.humanInputResponse",
      payload: {
        requestId: crypto.randomUUID(),
        response: { answers: {} },
        secretAnswers: [{ questionId: "q", value: "hunter2" }],
      },
    },
    "type",
  );
  await refused("POST", "/events", message({ resources: [fileRef] }), "payload.resources");
  await refused(
    "POST",
    "/events",
    message({ modelContext: "Ignore the visible text" }),
    "payload.modelContext",
  );
  await refused(
    "POST",
    "/events",
    message({ mcpCredentialUpdates: [{ serverId: "crm", headers: { authorization: "x" } }] }),
    "payload.mcpCredentialUpdates",
  );
  await refused(
    "POST",
    "/events",
    message({ connectionAccounts: [{ connectionId: crypto.randomUUID() }] }),
    "payload.connectionAccounts",
  );
  await refused(
    "POST",
    "/events",
    message({ personalResourceAttachment: { epoch: 1 } }),
    "payload.personalResourceAttachment",
  );
  await refused("POST", "/steer", { text: "Steer", resources: [fileRef] }, "resources");
  await refused(
    "POST",
    "/steer",
    { text: "Steer", connectionAccounts: [{ connectionId: crypto.randomUUID() }] },
    "connectionAccounts",
  );
  await refused(
    "PUT",
    "/composer-draft",
    {
      text: "Draft",
      annotations: [],
      resources: [fileRef],
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      expectedRevision: 0,
    },
    "resources",
  );
  await refused(
    "POST",
    "/composer-draft/submit",
    {
      text: "Draft",
      resources: [],
      expectedDraftRevision: 1,
      clientEventId: crypto.randomUUID(),
      delivery: "send",
      modelContext: "Hidden context",
    },
    "modelContext",
  );
  await refused(
    "POST",
    `/queue/${crypto.randomUUID()}/edit`,
    {
      clientEventId: crypto.randomUUID(),
      expectedTurnVersion: 1,
      expectedDraftRevision: 0,
      replaceDraft: true,
      resources: [fileRef],
    },
    "resources",
  );
  // None of those reached the session.
  expect(await f.turns(sessionId)).toHaveLength(1);

  // Message text, annotations and model choices still go through, and empty
  // lists ask for nothing.
  const sent = await f.call(
    "POST",
    `/sessions/${sessionId}/events`,
    frame,
    message({ resources: [], connectionAccounts: [], reasoningEffort: "low" }),
  );
  expect(sent.status, await sent.clone().text()).toBeLessThan(300);
  expect(await f.turns(sessionId)).toHaveLength(2);
  // Outside a frame the same person may still send resources and answers.
  const direct = await f.call("POST", `/sessions/${sessionId}/events`, {}, message({}));
  expect(direct.status, await direct.clone().text()).toBeLessThan(300);
});

test("Site creation and console creation have identical tools and execution settings", async () => {
  const f = await fixture({ sandboxBackend: "docker" });
  const site = await f.publish("Workspace chat", {
    requestedTools: [{ serverId: "crm", toolName: "read_contact" }],
  });
  const create = async (frame: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const response = await f.call("POST", "/sessions", frame, {
      initialMessage: "Hello",
      ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const { id } = await response.json();
    const [row] = await shared.admin`select tools,first_party_mcp_tools,first_party_mcp_permissions,
      agent_config,vault_policy,sandbox_backend,agent_access,memory_scope,tool_policy
      from sessions where id=${id}`;
    return row;
  };
  const consoleConfig = await create({});
  expect(consoleConfig!.sandbox_backend).toBe("docker");
  for (const frame of [site.frame("published"), f.inline("inline")]) {
    expect(await create(frame)).toEqual(consoleConfig);
  }
});

test("Site and console turns in existing and Site-created chats have identical native authority", async () => {
  const f = await fixture();
  const site = await f.publish("Chat", { visibility: "private" });
  const other = await f.startSession();
  const deps = { db: db.db, settings: f.settings, objectStorage: f.objectStorage } as ApiRouteDeps;
  const existing = await f.startSession();
  expect(
    (await f.call("PUT", `/published-artifacts/${site.siteId}/session-access/${existing}`)).status,
  ).toBe(200);
  for (const id of [existing, await f.startSession(site.frame("created"))]) {
    for (const surface of ["site", "web"]) {
      const grant = await f.liveAgentGrant(id, surface as "site" | "web");
      await expect(
        requireSessionAuthorization(deps, grant, {
          sessionId: other,
          operation: "session.read",
          surface: "first_party_mcp",
        }),
      ).resolves.toBeDefined();
      await expect(
        resolveSiteManagement(deps, grant, site.siteId, { mutate: true }),
      ).resolves.toMatchObject({ manager: true });
      // Normal read authorization still rejects nonexistent sessions.
      await expect(
        requireSessionAuthorization(deps, grant, {
          sessionId: crypto.randomUUID(),
          operation: "session.read",
          surface: "first_party_mcp",
        }),
      ).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
      await shared.admin`update session_turn_attempts set state='closed',outcome='completed',closed_at=now()
        where id=${String(grant.metadata!.attemptId)}`;
      await shared.admin`update session_turns set status='completed' where id=${String(grant.metadata!.turnId)}`;
    }
  }
});

test("Site creation preserves normal defaults, workspace restrictions and trusted origin", async () => {
  const f = await fixture();
  const site = await f.publish("Site A");
  const frame = site.frame("frame-a");
  for (const [field, value] of [
    ["tools", [{ kind: "mcp", id: "crm" }]],
    ["firstPartyMcpTools", ["sessions_list"]],
    ["firstPartyMcpPermissions", ["workspace:admin"]],
    ["agent", { instructions: "Hidden context", vaultPolicy: { mode: "all" } }],
    ["vaultPolicy", { mode: "all" }],
    ["sandboxBackend", "none"],
    ["targetSandboxId", crypto.randomUUID()],
    ["resources", [{ kind: "file", fileId: crypto.randomUUID() }]],
    ["modelContext", "Hidden context"],
    ["agentLearning", { knowledge: "automatic" }],
    ["channelId", crypto.randomUUID()],
    ["visibility", "workspace"],
    ["usageLimitMicros", 999_000_000],
    ["goal", { text: "Keep going" }],
  ] as const) {
    const response = await f.call("POST", "/sessions", frame, {
      initialMessage: "Hello from a page",
      [field]: value,
    });
    const json = (await response.json()) as { code?: string; details?: { field?: string } };
    expect({
      field,
      status: response.status,
      code: json.code,
      refused: json.details?.field,
    }).toEqual({ field, status: 403, code: "SITE_SESSION_TOOLS_FORBIDDEN", refused: field });
  }

  // The allowed fields start a session with no vault access, and reserved
  // metadata keys are dropped (the server records the Site origin itself).
  const created = await f.call("POST", "/sessions", frame, {
    initialMessage: "Hello from a page",
    idempotencyKey: crypto.randomUUID(),
    reasoningEffort: "low",
    metadata: { keep: "me", _opengeniSiteOrigin: { siteId: crypto.randomUUID(), title: "Forged" } },
  });
  expect(created.status, await created.clone().text()).toBe(202);
  const { id } = (await created.json()) as { id: string };
  const [row] = await shared.admin<
    { metadata: Record<string, unknown>; vault_policy: unknown; reasoning_effort: string }[]
  >`select metadata, vault_policy, reasoning_effort from sessions where id = ${id}`;
  expect(row!.metadata.keep).toBe("me");
  expect(row!.metadata._opengeniSiteOrigin).toEqual({
    siteId: site.siteId,
    title: "Site A",
    versionId: site.versionId,
  });
  const [ordinary] =
    await shared.admin`select vault_policy from sessions where id = ${await f.startSession()}`;
  expect(row!.vault_policy).toEqual(ordinary!.vault_policy);
  expect(row!.reasoning_effort).toBe("low");

  // Its agent has the workspace's default capabilities without workspace
  // administration (sandboxes, Connected Machines, run_on) or browser and
  // computer control, so the page cannot reach the viewer's machines.
  const agentConfig = async (sessionId: string) => {
    const [config] = await shared.admin<
      { agent_config: { from: string; capabilities: Record<string, unknown> } }[]
    >`select agent_config from sessions where id = ${sessionId}`;
    return config!.agent_config;
  };
  const fromAll = await agentConfig(id);
  expect({
    from: fromAll.from,
    workspaceAdmin: fromAll.capabilities.workspaceAdmin,
    browser: fromAll.capabilities.browser,
  }).toEqual({ from: "all", workspaceAdmin: true, browser: true });
  // A narrower workspace default stays narrow, including explicitly enabled capabilities.
  await shared.admin`
    update workspaces
    set settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{sessionAgentDefaults}',
      ${shared.admin.json({
        capabilities: { from: "none", artifacts: true, workspaceAdmin: true, browser: true },
      })}
    )
    where id = ${f.workspace.id}`;
  const narrow = await f.call("POST", "/sessions", frame, {
    initialMessage: "Hello again",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(narrow.status, await narrow.clone().text()).toBe(202);
  const fromNone = await agentConfig(((await narrow.json()) as { id: string }).id);
  expect({
    from: fromNone.from,
    artifacts: fromNone.capabilities.artifacts,
    subagents: fromNone.capabilities.subagents,
    workspaceAdmin: fromNone.capabilities.workspaceAdmin,
    browser: fromNone.capabilities.browser,
  }).toEqual({
    from: "none",
    artifacts: true,
    subagents: false,
    workspaceAdmin: true,
    browser: true,
  });
});
