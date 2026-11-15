import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";
import {
  resolveNewArtifactAudience,
  resolveNewSiteAudience,
  siteViewerForGrant,
  type ApiRouteDeps,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
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
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { resolveSiteSessionOrigin } from "../src/site-session-origin";

// A Site's audience is the same model as a chat's and a schedule's: the whole
// workspace, or only its owner. These run the real routes against PostgreSQL
// as the restricted application role.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("site-audience");
  if (!acquired) throw new Error("Site audience tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "artifacts:read",
  "artifacts:publish",
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
    await shared.admin`insert into managed_accounts (name) values ('Site audience fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "artifacts:read",
      "artifacts:publish",
      "account:admin",
    ],
  });
  const settings = testSettings({ productAccessMode: "configured", sandboxBackend: "none" });
  const deps = {
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memoryObjectStorage(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  };
  const app = createApp(deps as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: readonly string[]) => {
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
    return {
      subjectId: identity.subjectId,
      grant,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person(memberPermissions);
  const other = await person(memberPermissions);
  const admin = await person([...memberPermissions, "workspace:admin"]);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'site-audience-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const base = `/v1/workspaces/${workspace.id}/published-artifacts`;
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(`${base}${path}`, {
      method,
      headers: who.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const publish = async (title: string, visibility?: "private" | "workspace") => {
    const response = await call(owner, "POST", "", {
      title,
      html: `<!doctype html><h1>${title}</h1>`,
      idempotencyKey: crypto.randomUUID(),
      ...(visibility ? { visibility } : {}),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as {
      artifact: { id: string; visibility: string; ownerSubjectId: string | null };
      version: { id: string };
    };
  };
  const listIds = async (who: { headers: Record<string, string> }) =>
    (
      (await (await call(who, "GET", "")).json()) as { artifacts: Array<{ id: string }> }
    ).artifacts.map((artifact) => artifact.id);
  const catalog = async (who: { headers: Record<string, string> }) =>
    (
      (await (
        await app.request(`/v1/workspaces/${workspace.id}/artifact-catalog?kind=site`, {
          headers: who.headers,
        })
      ).json()) as { items: Array<{ id: string; visibility?: string }> }
    ).items;
  return {
    app,
    deps,
    settings,
    accountId,
    workspace,
    owner,
    other,
    admin,
    call,
    publish,
    listIds,
    catalog,
  };
}

test("an Only me Site is hidden from other members and admins until its owner shares it", async () => {
  const f = await fixture();
  const team = await f.publish("Team dashboard");
  expect(team.artifact.visibility).toBe("workspace");
  expect(team.artifact.ownerSubjectId).toBe(f.owner.subjectId);
  const mine = await f.publish("My notes", "private");
  expect(mine.artifact.visibility).toBe("private");
  const siteId = mine.artifact.id;
  const versionId = mine.version.id;

  expect((await f.listIds(f.owner)).sort()).toEqual([team.artifact.id, siteId].sort());
  expect(await f.listIds(f.other)).toEqual([team.artifact.id]);
  expect(await f.listIds(f.admin)).toEqual([team.artifact.id]);
  expect((await f.catalog(f.owner)).find((item) => item.id === siteId)?.visibility).toBe("private");
  expect((await f.catalog(f.owner)).find((item) => item.id === team.artifact.id)?.visibility).toBe(
    "workspace",
  );
  expect((await f.catalog(f.other)).map((item) => item.id)).toEqual([team.artifact.id]);
  expect((await f.catalog(f.admin)).map((item) => item.id)).toEqual([team.artifact.id]);

  // Every read and change of the Site treats it as missing for anyone else.
  const missing = crypto.randomUUID();
  const routes = [
    ["GET", "", undefined],
    ["GET", "/content", undefined],
    ["GET", "/html", undefined],
    ["GET", "/downloads", undefined],
    [
      "POST",
      "/versions",
      { html: "<h1>Mine now</h1>", expectedCurrentVersionId: versionId, idempotencyKey: "x" },
    ],
    [
      "POST",
      "/rollback",
      { versionId, expectedCurrentVersionId: versionId, reason: "x", idempotencyKey: "y" },
    ],
    [
      "PATCH",
      "/status",
      { status: "archived", expectedCurrentVersionId: versionId, reason: "x", idempotencyKey: "z" },
    ],
    ["PUT", "/visibility", { visibility: "workspace" }],
  ] as const;
  for (const who of [f.other, f.admin]) {
    for (const [method, suffix, body] of routes) {
      const denied = await f.call(who, method, `/${siteId}${suffix}`, body);
      const absent = await f.call(who, method, `/${missing}${suffix}`, body);
      expect({ route: `${method} ${suffix}`, status: denied.status }).toEqual({
        route: `${method} ${suffix}`,
        status: absent.status,
      });
      expect({ route: `${method} ${suffix}`, status: denied.status }).toEqual({
        route: `${method} ${suffix}`,
        status: 404,
      });
    }
  }
  // Nor can anyone else pin it, or start a Site conversation from it.
  const pin = await f.app.request(
    `/v1/workspaces/${f.workspace.id}/artifact-catalog/site/${siteId}/pin`,
    { method: "PUT", headers: f.other.headers, body: JSON.stringify({ pinned: true }) },
  );
  expect(pin.status).toBe(404);
  await expect(resolveSiteSessionOrigin(db.db, f.other.grant, siteId, versionId)).rejects.toThrow(
    "Site origin not found",
  );
  expect(await resolveSiteSessionOrigin(db.db, f.owner.grant, siteId, versionId)).toMatchObject({
    siteId,
  });

  // The owner reads it everywhere.
  for (const suffix of ["", "/content", "/downloads"]) {
    const read = await f.call(f.owner, "GET", `/${siteId}${suffix}`);
    expect({ suffix, status: read.status }).toEqual({ suffix, status: 200 });
  }

  // Only the owner decides who sees a workspace Site, too.
  const notYours = await f.call(f.other, "PUT", `/${team.artifact.id}/visibility`, {
    visibility: "private",
  });
  expect(notYours.status).toBe(403);
  expect(((await notYours.json()) as { code: string }).code).toBe(
    "WORKSPACE_ARTIFACT_OWNER_REQUIRED",
  );

  // Sharing with the workspace opens it to everyone.
  const opened = await f.call(f.owner, "PUT", `/${siteId}/visibility`, { visibility: "workspace" });
  expect(opened.status).toBe(200);
  expect(((await opened.json()) as { artifact: { visibility: string } }).artifact.visibility).toBe(
    "workspace",
  );
  expect((await f.listIds(f.other)).sort()).toEqual([team.artifact.id, siteId].sort());
  expect((await f.call(f.other, "GET", `/${siteId}/content`)).status).toBe(200);
  expect((await f.catalog(f.other)).find((item) => item.id === siteId)?.visibility).toBe(
    "workspace",
  );

  // And limiting it again hides it again.
  const limited = await f.call(f.owner, "PUT", `/${siteId}/visibility`, { visibility: "private" });
  expect(limited.status).toBe(200);
  expect(await f.listIds(f.other)).toEqual([team.artifact.id]);
  expect((await f.call(f.other, "GET", `/${siteId}`)).status).toBe(404);
});

test("a Site made in an Only me chat starts Only me without exposing the chat", async () => {
  const f = await fixture();
  const chat = await withSessionRlsActorContext({ subjectId: f.owner.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Private work",
      resources: [],
      metadata: {},
      visibility: "user_private",
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      subjectId: f.owner.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const workspaceChat = await withSessionRlsActorContext({ subjectId: f.owner.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Team work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      subjectId: f.owner.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const audienceFor = (
    who: { subjectId: string; grant: AccessGrant },
    sourceSessionId: string | null,
    requested?: "private" | "workspace",
  ) =>
    withSessionRlsActorContext({ subjectId: who.subjectId }, async () =>
      resolveNewSiteAudience({
        db: db.db,
        settings: f.settings,
        grant: who.grant,
        viewer: await siteViewerForGrant(db.db, who.grant),
        requested,
        sourceSessionId,
      }),
    );
  expect(await audienceFor(f.owner, chat.id)).toEqual({
    visibility: "user_private",
    ownerSubjectId: f.owner.subjectId,
  });
  // An explicit choice still wins over the chat's audience.
  expect(await audienceFor(f.owner, chat.id, "workspace")).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: f.owner.subjectId,
  });
  expect(await audienceFor(f.owner, workspaceChat.id)).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: f.owner.subjectId,
  });
  expect(await audienceFor(f.owner, null)).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: f.owner.subjectId,
  });
  // Someone who cannot see the chat learns nothing from it.
  expect(await audienceFor(f.other, chat.id)).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: f.other.subjectId,
  });
  // A run there without a person (such as a meeting summary) still makes the
  // chat owner's Only me things; where the chat is not visible, it learns nothing.
  const withoutPerson = (subjectId: string, sourcePrivate = false) =>
    withSessionRlsActorContext({ subjectId }, async () =>
      resolveNewArtifactAudience({
        db: db.db,
        settings: f.settings,
        grant: f.owner.grant,
        viewer: { subjectId: null },
        requested: undefined,
        sourceSessionId: chat.id,
        sourcePrivate,
        noun: "document",
      }),
    );
  expect(await withoutPerson(f.owner.subjectId)).toEqual({
    visibility: "user_private",
    ownerSubjectId: f.owner.subjectId,
  });
  expect(await withoutPerson(f.other.subjectId)).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: null,
  });
  // Made from an Only me file, a document starts Only me for its person, even
  // from a shared chat; without a person it cannot be Only me.
  const fromOwnFile = (who: { subjectId: string | null }, requested?: "private" | "workspace") =>
    withSessionRlsActorContext({ subjectId: f.owner.subjectId }, async () =>
      resolveNewArtifactAudience({
        db: db.db,
        settings: f.settings,
        grant: f.owner.grant,
        viewer: who,
        requested,
        sourceSessionId: workspaceChat.id,
        sourcePrivate: true,
        noun: "document",
      }),
    );
  expect(await fromOwnFile({ subjectId: f.owner.subjectId })).toEqual({
    visibility: "user_private",
    ownerSubjectId: f.owner.subjectId,
  });
  expect(await fromOwnFile({ subjectId: f.owner.subjectId }, "workspace")).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: f.owner.subjectId,
  });
  expect(await fromOwnFile({ subjectId: null })).toEqual({
    visibility: "workspace_shared",
    ownerSubjectId: null,
  });

  // Its versions name the chat; nobody else sees the Site, and once shared
  // they still never see the chat.
  const site = await f.publish("From my chat", "private");
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const turnId = crypto.randomUUID(),
      attemptId = crypto.randomUUID();
    await tx`update workspace_artifact_versions set source_session_id = ${chat.id}, source_turn_id = ${turnId}, source_attempt_id = ${attemptId}, source_execution_generation = 1 where artifact_id = ${site.artifact.id}`;
    await tx`update workspace_artifact_events set source_session_id = ${chat.id}, source_turn_id = ${turnId}, source_attempt_id = ${attemptId}, source_execution_generation = 1 where artifact_id = ${site.artifact.id}`;
  });
  const ownerDetail = await (await f.call(f.owner, "GET", `/${site.artifact.id}`)).json();
  expect(JSON.stringify(ownerDetail)).toContain(chat.id);
  const hidden = await f.call(f.other, "GET", `/${site.artifact.id}`);
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain(chat.id);
  expect(JSON.stringify(await f.catalog(f.other))).not.toContain(site.artifact.id);

  expect(
    (await f.call(f.owner, "PUT", `/${site.artifact.id}/visibility`, { visibility: "workspace" }))
      .status,
  ).toBe(200);
  const opened = await f.call(f.other, "GET", `/${site.artifact.id}`);
  expect(opened.status).toBe(200);
  expect(await opened.text()).not.toContain(chat.id);
  expect(JSON.stringify(await f.catalog(f.other))).not.toContain(chat.id);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * sandbox_file_publish for a running agent turn in a chat shared with the
 * workspace, acting for `initiator` (null: a run without a person).
 */
async function agentFilePublish(
  f: Fixture,
  initiator: string | null,
  permissions: AccessGrant["permissions"] = [
    "files:read",
    "files:upload",
    "artifacts:read",
    "artifacts:publish",
  ],
) {
  const session = await createSession(db.db, {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Share the Site",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) VALUES (
      ${f.accountId}, ${f.workspace.id}, ${session.id}, gen_random_uuid(),
      ${`site-audience-wf-${crypto.randomUUID()}`}, 'running', 0, 'Share the Site',
      'gpt-5.6-sol', 'medium', 'none', 1, ${initiator === null ? "service" : "subject"},
      ${initiator ?? "service:site-audience-test"}, '{"accepted":true}'::jsonb
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
    await tx`UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${f.accountId}, ${f.workspace.id}, ${session.id}, ${turn!.id}, 1,
        'running', 'site-audience-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:first-party-mcp",
    permissions,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: ["sandbox_file_publish"],
    },
  };
  const server = buildOpenGeniMcpServer(f.deps as unknown as ApiRouteDeps, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "site-audience-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const description = (await mcp.listTools()).tools.find(
    (tool) => tool.name === "sandbox_file_publish",
  )?.description;
  const share = async (artifactId: string, visibility: "private" | "workspace") => {
    const result = await mcp.callTool({
      name: "sandbox_file_publish",
      arguments: { artifactId, visibility },
    });
    const text =
      (result.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === "text",
      )?.text ?? "";
    return { isError: result.isError === true, text };
  };
  return { description, share, close: () => mcp.close() };
}

test("an agent changes who can see its person's Site, as they can from the Site page", async () => {
  const f = await fixture();
  const site = await f.publish("Mockup", "private");
  const id = site.artifact.id;
  const agent = await agentFilePublish(f, f.owner.subjectId);
  try {
    expect(agent.description).toContain("an existing file or Site");
    // Shared at the same link: no second Site.
    const opened = await agent.share(id, "workspace");
    expect(opened.isError, opened.text).toBe(false);
    expect(JSON.parse(opened.text)).toEqual({
      type: "site_access",
      artifactId: id,
      title: "Mockup",
      access: {
        visibility: "workspace",
        whoCanOpen: "Everyone in the workspace “Team workspace” can open this Site.",
      },
    });
    expect(await f.listIds(f.other)).toEqual([id]);
    expect((await f.listIds(f.owner)).length).toBe(1);
    // And limited again.
    const limited = await agent.share(id, "private");
    expect(limited.isError, limited.text).toBe(false);
    expect(JSON.parse(limited.text).access.visibility).toBe("private");
    expect(await f.listIds(f.other)).toEqual([]);
  } finally {
    await agent.close();
  }

  // Without permission to publish Sites the tool offers files only, as before.
  const filesOnly = await agentFilePublish(f, f.owner.subjectId, [
    "files:read",
    "files:upload",
    "artifacts:read",
  ]);
  try {
    expect(filesOnly.description).toContain("an existing file, such as");
    expect(await filesOnly.share(id, "workspace")).toEqual({
      isError: true,
      text: "file not found",
    });
  } finally {
    await filesOnly.close();
  }

  // Someone else's agent gets what that person gets: a private Site reads as
  // missing, and a shared one needs its owner.
  const others = await agentFilePublish(f, f.other.subjectId);
  const personless = await agentFilePublish(f, null);
  try {
    const hidden = await others.share(id, "workspace");
    expect(hidden).toEqual({
      isError: true,
      text: "No file or Site you can open has this artifactId.",
    });
    const team = await f.publish("Team page");
    const notOwner = await others.share(team.artifact.id, "private");
    expect(notOwner.isError).toBe(true);
    expect(notOwner.text).toContain("Only the person who owns this Site");
    expect((await personless.share(team.artifact.id, "private")).isError).toBe(true);
    expect(await f.listIds(f.other)).toEqual([team.artifact.id]);
  } finally {
    await others.close();
    await personless.close();
  }
});

test("only a person can make or keep a Site Only me", async () => {
  const f = await fixture();
  // A key or service has no person to own an Only me Site.
  const service = f.owner.headers.authorization;
  const keyed = await f.app.request(`/v1/workspaces/${f.workspace.id}/published-artifacts`, {
    method: "POST",
    headers: { authorization: service, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Keyed",
      html: "<h1>Keyed</h1>",
      idempotencyKey: crypto.randomUUID(),
      visibility: "private",
    }),
  });
  expect(keyed.status).toBe(422);
  // When the organization turns Only me off, new Sites cannot be limited.
  await shared.admin`update organization_private_session_settings set enabled = false where account_id = ${f.accountId}`;
  const refused = await f.call(f.owner, "POST", "", {
    title: "Not allowed",
    html: "<h1>Not allowed</h1>",
    idempotencyKey: crypto.randomUUID(),
    visibility: "private",
  });
  expect(refused.status).toBe(403);
  const site = await f.publish("Shared");
  const limit = await f.call(f.owner, "PUT", `/${site.artifact.id}/visibility`, {
    visibility: "private",
  });
  expect(limit.status).toBe(403);
});

test("audience projection never bypasses current membership permissions", async () => {
  const f = await fixture();
  await f.publish("Private notes", "private");
  const paths = ["published-artifacts", "artifact-catalog?kind=site", "scheduled-tasks"];
  await shared.admin`update workspace_memberships
    set permissions = '["workspace:read"]'::jsonb
    where workspace_id = ${f.workspace.id} and subject_id = ${f.owner.subjectId}`;
  for (const path of paths) {
    const denied = await f.app.request(`/v1/workspaces/${f.workspace.id}/${path}`, {
      headers: f.owner.headers,
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
  }
});
