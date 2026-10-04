// First-use membership: an organization key acting as an external user
// (`asUser`) on a shared workspace of its own organization creates the
// missing membership once, with the conversation defaults, then continues.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
import { requireFreshAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  acquireOwnerMigratedTestDatabase,
  testSettings,
  MemoryEventBus,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createWorkspace,
  createOrganizationApiKey,
  ensureExternalIdentity,
  ensureExternalWorkspaceMemberOnFirstUse,
  migrate,
  nestedPostgresSqlState,
  provisionRoles,
  type DbClient,
} from "@opengeni/db";
import {
  normalizeOrganizationAccessPolicy,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

// Keep equal to CONVERSATION_PERMISSIONS in packages/sdk/src/tenant-workspaces.ts.
const CONVERSATION_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "mcp_servers:attach",
] as const satisfies readonly Permission[];
const CAPABLE: Permission[] = ["members:manage", "workspace:create", ...CONVERSATION_PERMISSIONS];

let shared: OwnerMigratedTestDatabase;
let db: DbClient;
const appRole = `first_use_member_app_${crypto.randomUUID().replaceAll("-", "")}`;
const appPassword = crypto.randomUUID();
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("external-first-use-membership");
  if (!acquired) throw new Error("First-use membership requires real PostgreSQL");
  shared = acquired;
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(shared.adminUrl, {
    appRole,
    appPassword,
    rlsStrategy: "force",
    artifactOutboxDispatcherPassword: "",
    artifactMaterializerPassword: "",
    hostExportPassword: "",
    temporalPassword: "",
    temporalDatabases: [],
  });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = appRole;
  appUrl.password = appPassword;
  db = createDb(appUrl.toString());
}, 180_000);
afterAll(async () => {
  try {
    await db?.close();
  } finally {
    if (shared) {
      try {
        if ((await shared.admin`select 1 from pg_roles where rolname = ${appRole}`).length) {
          await shared.admin`DROP OWNED BY ${shared.admin(appRole)}`;
          await shared.admin`DROP ROLE ${shared.admin(appRole)}`;
        }
      } finally {
        await shared.release();
      }
    }
  }
}, 60_000);

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
  throw error;
});
let routesRegistered = false;
const delegationSecret = "first-use-membership-test-secret-at-least-32-bytes";

async function organization(
  permissions: Permission[] = CAPABLE,
  options: { scopeTo?: "self" | "other" } = {},
) {
  if (!routesRegistered) {
    const deps = {
      db: db.db,
      settings: testSettings({
        productAccessMode: "configured",
        sandboxBackend: "none",
        delegationSecret,
      }),
      bus: new MemoryEventBus(),
    } as unknown as ApiRouteDeps;
    registerWorkspaceRoutes(app, deps);
    registerOrganizationMembershipRoutes(app, deps);
    // A long-lived connection's re-check (e.g. an open SSE stream).
    app.get("/test/fresh/:workspaceId", async (c) =>
      c.json(await requireFreshAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:read")),
    );
    routesRegistered = true;
  }
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('First-use fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Tenant workspace" });
  const other = await createWorkspace(db.db, { accountId, name: "Other workspace" });
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(db.db, {
    accountId,
    name: "Embedding key",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
    ...(options.scopeTo
      ? {
          policy: normalizeOrganizationAccessPolicy({
            preset: "custom",
            permissions,
            workspaceScope: {
              kind: "selected",
              workspaceIds: [options.scopeTo === "self" ? workspace.id : other.id],
            },
          }),
        }
      : {}),
  });
  const service = new OpenGeniClient({
    baseUrl: "http://fixture",
    apiKey: token,
    fetch: async (input, init) => await app.request(input, init),
  });
  const user = (externalId = crypto.randomUUID()) => ({
    externalId,
    client: service.asUser(externalId, { source: "product" }),
  });
  const actorHeader = (selection: unknown) => encodeURIComponent(JSON.stringify(selection));
  const raw = (path: string, headers: Record<string, string>) =>
    app.request(path, { headers: { authorization: `Bearer ${token}`, ...headers } });
  return { accountId, workspace, other, service, user, key, token, actorHeader, raw };
}

async function lifecycleEvents(workspaceId: string) {
  return await shared.admin<{ actor_service_subject: string | null; kind: string }[]>`
    select actor_service_subject, kind from organization_workspace_lifecycle_events
    where workspace_id = ${workspaceId}::uuid`;
}

async function memberships(workspaceId: string, subjectId: string) {
  return await shared.admin<{ permissions: string[] }[]>`
    select permissions from workspace_memberships
    where workspace_id = ${workspaceId}::uuid and subject_id = ${subjectId}`;
}

async function subjectOf(accountId: string, externalId: string) {
  return (await ensureExternalIdentity(db.db, { accountId, source: "product", externalId }))
    .subjectId;
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof OpenGeniApiError) return error.status;
    throw error;
  }
}

test("a capable key creates the missing membership once and the request succeeds", async () => {
  const org = await organization();
  const { externalId, client } = org.user();
  expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
  const subjectId = await subjectOf(org.accountId, externalId);
  const rows = await memberships(org.workspace.id, subjectId);
  expect(rows).toHaveLength(1);
  expect([...rows[0]!.permissions].sort()).toEqual([...CONVERSATION_PERMISSIONS].sort());
  // A second request reuses it.
  expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
  expect(await memberships(org.workspace.id, subjectId)).toHaveLength(1);
  // The same lifecycle event explicit onboarding writes, attributed to the key.
  expect(await lifecycleEvents(org.workspace.id)).toEqual([
    { actor_service_subject: `api_key:${org.key.id}`, kind: "grant" },
  ]);
}, 60_000);

test("a key without the onboarding authority keeps the 403", async () => {
  const withoutManage = await organization(CAPABLE.filter((p) => p !== "members:manage"));
  const a = withoutManage.user();
  expect(await status(a.client.getWorkspace(withoutManage.workspace.id))).toBe(403);
  expect(
    await memberships(
      withoutManage.workspace.id,
      await subjectOf(withoutManage.accountId, a.externalId),
    ),
  ).toHaveLength(0);

  // Missing one of the default conversation permissions is also refused.
  const narrow = await organization(CAPABLE.filter((p) => p !== "mcp_servers:attach"));
  const b = narrow.user();
  expect(await status(b.client.getWorkspace(narrow.workspace.id))).toBe(403);
  expect(
    await memberships(narrow.workspace.id, await subjectOf(narrow.accountId, b.externalId)),
  ).toHaveLength(0);
}, 60_000);

test("another organization's workspace is refused", async () => {
  const mine = await organization();
  const theirs = await organization();
  const { externalId, client } = mine.user();
  expect(await status(client.getWorkspace(theirs.workspace.id))).toBe(403);
  expect(
    await memberships(theirs.workspace.id, await subjectOf(mine.accountId, externalId)),
  ).toHaveLength(0);
  const [{ n }] = await shared.admin<{ n: number }[]>`
    select count(*)::int as n from workspace_memberships where workspace_id = ${theirs.workspace.id}::uuid
      and subject_id like 'external_user:%'`;
  expect(n).toBe(0);
}, 60_000);

test("an existing membership is never changed", async () => {
  const org = await organization();
  const { externalId, client } = org.user();
  await org.service.addExternalWorkspaceMember(org.workspace.id, {
    identity: { source: "product", externalId },
    permissions: ["workspace:read"],
  });
  expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
  const rows = await memberships(org.workspace.id, await subjectOf(org.accountId, externalId));
  expect(rows.map((row) => row.permissions)).toEqual([["workspace:read"]]);
}, 60_000);

test("parallel first requests write exactly one membership", async () => {
  const org = await organization();
  const { externalId, client } = org.user();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => client.getWorkspace(org.workspace.id)),
  );
  expect(results.every((workspace) => workspace.id === org.workspace.id)).toBe(true);
  expect(
    await memberships(org.workspace.id, await subjectOf(org.accountId, externalId)),
  ).toHaveLength(1);
}, 60_000);

test("a removed member is created again on the next request", async () => {
  const org = await organization();
  const { externalId, client } = org.user();
  await client.getWorkspace(org.workspace.id);
  const identity = await ensureExternalIdentity(db.db, {
    accountId: org.accountId,
    source: "product",
    externalId,
  });
  const removed = await org.service.cancelExternalWorkspaceMemberGrant(
    org.accountId,
    org.workspace.id,
    identity.organizationMembershipId,
    { operationId: crypto.randomUUID(), cancelGrantOperationId: crypto.randomUUID() },
  );
  expect(removed.removed).toBe(true);
  expect(await memberships(org.workspace.id, identity.subjectId)).toHaveLength(0);
  expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
  const rows = await memberships(org.workspace.id, identity.subjectId);
  expect(rows).toHaveLength(1);
  expect([...rows[0]!.permissions].sort()).toEqual([...CONVERSATION_PERMISSIONS].sort());
}, 60_000);

test("the organization key's own service requests never create memberships", async () => {
  const org = await organization();
  const before = await shared.admin<{ n: number }[]>`
    select count(*)::int as n from workspace_memberships where workspace_id = ${org.workspace.id}::uuid`;
  await org.service.getWorkspace(org.workspace.id);
  const after = await shared.admin<{ n: number }[]>`
    select count(*)::int as n from workspace_memberships where workspace_id = ${org.workspace.id}::uuid`;
  expect(after).toEqual(before);
}, 60_000);

test("an identity suspended while its first request is in flight never gets a membership", async () => {
  const org = await organization([...CAPABLE, "account:admin"]);
  const { externalId, client } = org.user();
  // The request resolved this identity as active before it was suspended.
  await client.getAccessContext();
  const identity = await ensureExternalIdentity(db.db, {
    accountId: org.accountId,
    source: "product",
    externalId,
  });
  await org.service.updateExternalIdentityMembership(
    org.accountId,
    identity.organizationMembershipId,
    {
      kind: "suspend",
      expectedAuthorizationRevision: identity.authorizationRevision,
      operationId: crypto.randomUUID(),
    },
  );
  // The provisioning step re-checks the identity under the organization fence.
  const refused = await ensureExternalWorkspaceMemberOnFirstUse(
    db.db,
    {
      organizationId: org.accountId,
      workspaceId: org.workspace.id,
      actorSubjectId: `api_key:${org.key.id}`,
    },
    {
      subjectId: identity.subjectId,
      identity: { source: "product", externalId },
      permissions: [...CONVERSATION_PERMISSIONS],
    },
  ).then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? nestedPostgresSqlState(error),
  );
  expect(refused).toBe("42501");
  expect(await memberships(org.workspace.id, identity.subjectId)).toHaveLength(0);
  expect(await status(client.getWorkspace(org.workspace.id))).toBe(403);
  expect(await memberships(org.workspace.id, identity.subjectId)).toHaveLength(0);
}, 60_000);

test("a request needing a permission outside the defaults creates nothing", async () => {
  const org = await organization();
  const { externalId, client } = org.user();
  // PATCH /v1/workspaces/:id requires workspace:admin.
  expect(await status(client.updateWorkspace(org.workspace.id, { name: "Renamed" }))).toBe(403);
  expect(
    await memberships(org.workspace.id, await subjectOf(org.accountId, externalId)),
  ).toHaveLength(0);
}, 60_000);

test("a selected-scope key admits only inside its scope", async () => {
  const outside = await organization(CAPABLE, { scopeTo: "other" });
  const a = outside.user();
  expect(await status(a.client.getWorkspace(outside.workspace.id))).toBe(403);
  expect(
    await memberships(outside.workspace.id, await subjectOf(outside.accountId, a.externalId)),
  ).toHaveLength(0);
  expect((await a.client.getWorkspace(outside.other.id)).id).toBe(outside.other.id);
  expect(
    await memberships(outside.other.id, await subjectOf(outside.accountId, a.externalId)),
  ).toHaveLength(1);
}, 60_000);

test("a legacy workspace:admin-only key admits with the defaults", async () => {
  const org = await organization(["workspace:admin"]);
  const { externalId, client } = org.user();
  expect((await client.getWorkspace(org.workspace.id)).id).toBe(org.workspace.id);
  const rows = await memberships(org.workspace.id, await subjectOf(org.accountId, externalId));
  expect(rows.map((row) => [...row.permissions].sort())).toEqual([
    [...CONVERSATION_PERMISSIONS].sort(),
  ]);
}, 60_000);

test("linked-native, service-initiator, delegated and agent principals never auto-admit", async () => {
  const org = await organization();
  const externalId = crypto.randomUUID();
  const identity = await ensureExternalIdentity(db.db, {
    accountId: org.accountId,
    source: "product",
    externalId,
  });
  const workspacePath = `/v1/workspaces/${org.workspace.id}`;
  const linked = await org.raw(workspacePath, {
    "x-opengeni-external-actor": org.actorHeader({
      mode: "linked_native",
      identity: { source: "product", externalId },
      linkId: crypto.randomUUID(),
      expectedLinkRevision: 1,
    }),
  });
  expect(linked.status).toBe(403);
  const service = await org.raw(workspacePath, {
    "x-opengeni-external-actor": org.actorHeader({
      mode: "external",
      identity: { source: "product", externalId },
    }),
    "x-opengeni-service-initiator": "embedding-job",
  });
  expect(service.status).toBe(422);
  for (const claims of [
    { principalKind: "human_session" as const },
    { principalKind: "service" as const },
    {
      principalKind: "agent_attempt" as const,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
  ]) {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: org.accountId,
      workspaceId: org.workspace.id,
      subjectId: identity.subjectId,
      permissions: ["workspace:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    });
    // Whatever the delegated lane answers, it never writes a membership.
    await app.request(workspacePath, { headers: { authorization: `Bearer ${token}` } });
    expect(await memberships(org.workspace.id, identity.subjectId)).toHaveLength(0);
  }
  expect(await memberships(org.workspace.id, identity.subjectId)).toHaveLength(0);
}, 60_000);

test("a fresh re-check of an open connection never re-creates a removed membership", async () => {
  const org = await organization();
  const { externalId } = org.user();
  const subjectId = await subjectOf(org.accountId, externalId);
  const external = {
    "x-opengeni-external-actor": org.actorHeader({
      mode: "external",
      identity: { source: "product", externalId },
    }),
  };
  const fresh = `/test/fresh/${org.workspace.id}`;
  // A fresh re-check alone never admits.
  expect((await org.raw(fresh, external)).status).toBe(403);
  expect(await memberships(org.workspace.id, subjectId)).toHaveLength(0);
  // Request entry admits; the open connection's re-check then succeeds.
  expect((await org.raw(`/v1/workspaces/${org.workspace.id}`, external)).status).toBe(200);
  expect((await org.raw(fresh, external)).status).toBe(200);
  // Removed while the connection is open: the re-check denies and re-creates nothing.
  const identity = await ensureExternalIdentity(db.db, {
    accountId: org.accountId,
    source: "product",
    externalId,
  });
  await org.service.cancelExternalWorkspaceMemberGrant(
    org.accountId,
    org.workspace.id,
    identity.organizationMembershipId,
    { operationId: crypto.randomUUID(), cancelGrantOperationId: crypto.randomUUID() },
  );
  expect((await org.raw(fresh, external)).status).toBe(403);
  expect(await memberships(org.workspace.id, subjectId)).toHaveLength(0);
}, 60_000);
