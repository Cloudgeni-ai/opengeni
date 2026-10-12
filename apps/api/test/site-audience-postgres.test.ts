import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessGrant } from "@opengeni/contracts";
import {
  resolveNewSiteAudience,
  resolveSiteAudienceChange,
  siteViewerForGrant,
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
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
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
  const app = createApp({
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
  } as unknown as AppDependencies);
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

test("only a person can make or keep a Site Only me", async () => {
  const f = await fixture();
  // An agent cannot change a Site's audience; its person does, from Opengeni.
  await expect(
    resolveSiteAudienceChange({
      db: db.db,
      settings: f.settings,
      grant: { ...f.owner.grant, principalKind: "agent_attempt" },
      viewer: { subjectId: f.owner.subjectId },
      requested: "workspace",
    }),
  ).rejects.toMatchObject({ status: 403 });
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
