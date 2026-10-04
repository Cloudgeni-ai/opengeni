// First-use membership: an organization key acting as an external user
// (`asUser`) on a shared workspace of its own organization creates the
// missing membership once, with the conversation defaults, then continues.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
import { type ApiRouteDeps } from "@opengeni/core";
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
  migrate,
  provisionRoles,
  type DbClient,
} from "@opengeni/db";
import type { Permission } from "@opengeni/contracts";
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

async function organization(permissions: Permission[] = CAPABLE) {
  if (!routesRegistered) {
    const deps = {
      db: db.db,
      settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
      bus: new MemoryEventBus(),
    } as unknown as ApiRouteDeps;
    registerWorkspaceRoutes(app, deps);
    registerOrganizationMembershipRoutes(app, deps);
    routesRegistered = true;
  }
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('First-use fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Tenant workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Embedding key",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
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
  return { accountId, workspace, service, user };
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
