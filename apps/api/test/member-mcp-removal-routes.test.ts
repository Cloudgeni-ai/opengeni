import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, deleteWorkspace, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerCapabilityRoutes } from "../src/routes/capabilities";

// A member (connections:write, no capabilities:manage) removes only the custom
// MCP servers they turned on themselves. One an admin, another person or no
// recorded installer turned on stays with integration admins, who remove any.
// The catalog says which servers the caller may remove.

const DELEGATION_SECRET = "member-mcp-removal-route-secret";
const settings = testSettings({
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 47).toString("base64"),
});
const MEMBER = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "connections:read",
  "connections:write",
];
const ADMIN = [...MEMBER, "capabilities:manage"];
const READER = ["workspace:read", "sessions:read", "connections:read"];

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let workspaceId = "";
let accountId = "";
const member = `user:mcp-removal-member-${crypto.randomUUID()}`;
const admin = `user:mcp-removal-admin-${crypto.randomUUID()}`;
const otherMember = `user:mcp-removal-other-${crypto.randomUUID()}`;
const reader = `user:mcp-removal-reader-${crypto.randomUUID()}`;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-member-mcp-removal");
  if (!shared) throw new Error("Real PostgreSQL fixture required");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `mcp-removal-account-${crypto.randomUUID()}`,
    accountName: "Member MCP removal account",
    workspaceExternalSource: "test",
    workspaceExternalId: `mcp-removal-workspace-${crypto.randomUUID()}`,
    workspaceName: "Member MCP removal workspace",
    subjectId: admin,
  });
  workspaceId = access.workspaceGrants[0]!.workspaceId;
  accountId = access.workspaceGrants[0]!.accountId;
  for (const [subjectId, permissions] of [
    [member, MEMBER],
    [otherMember, MEMBER],
    [reader, READER],
  ] as const) {
    await shared.admin`insert into workspace_memberships
      (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'member', ${JSON.stringify(permissions)}::jsonb)`;
  }
  app = new Hono();
  registerCapabilityRoutes(app, { db: client.db, settings } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

function permissionsOf(subjectId: string): string[] {
  if (subjectId === admin) return ADMIN;
  if (subjectId === reader) return READER;
  return MEMBER;
}

async function call(
  subjectId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: permissionsOf(subjectId) as never,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const removePath = (id: string) => `/capabilities/${encodeURIComponent(id)}/installation`;

/** Adds a custom MCP server and turns it on, both as `subjectId`. */
async function addServerAs(subjectId: string, name: string): Promise<string> {
  const id = `mcp:removal-${name}-${crypto.randomUUID()}`;
  const host = `tools-${crypto.randomUUID()}.example`;
  const created = await call(subjectId, "POST", "/capabilities", {
    id,
    kind: "mcp",
    name: `Removal ${name}`,
    endpointUrl: `https://${host}/mcp`,
  });
  expect(created.status).toBe(201);
  await enableAs(subjectId, id, host);
  return id;
}

async function enableAs(subjectId: string, id: string, host?: string): Promise<void> {
  const providerDomain = host ?? (await endpointHost(id));
  const enabled = await call(subjectId, "POST", `/capabilities/${encodeURIComponent(id)}/enable`, {
    connectionRef: { providerDomain, kind: "oauth2", subjectScope: "subject" },
  });
  expect(enabled.status).toBeLessThan(300);
}

async function endpointHost(id: string): Promise<string> {
  const [row] = await shared!.admin<{ endpoint_url: string }[]>`
    select endpoint_url from capability_catalog_items
    where workspace_id = ${workspaceId} and id = ${id}`;
  return new URL(row!.endpoint_url).host;
}

async function installation(id: string) {
  const [row] = await shared!.admin<
    { status: string; installed_by_subject_id: string | null }[]
  >`select status, installed_by_subject_id from capability_installations
    where workspace_id = ${workspaceId} and capability_id = ${id}`;
  return row ?? null;
}

async function catalogRowExists(id: string): Promise<boolean> {
  const rows = await shared!.admin`select 1 from capability_catalog_items
    where workspace_id = ${workspaceId} and id = ${id}`;
  return rows.length === 1;
}

async function removableBy(subjectId: string): Promise<Map<string, boolean | undefined>> {
  const response = await call(subjectId, "GET", "/capabilities");
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as {
    items: { id: string; canRemove?: boolean }[];
  };
  return new Map(items.map((item) => [item.id, item.canRemove]));
}

async function expectRefused(response: Response): Promise<void> {
  // The capabilities:manage refusal (MissingPermissionRefusal) says why.
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Only an admin can remove");
}

describe("members remove only the custom MCP servers they added", () => {
  test("canRemove follows who turned each server on", async () => {
    const own = await addServerAs(member, "own");
    const admins = await addServerAs(admin, "admins");
    const others = await addServerAs(otherMember, "others");
    const legacy = await addServerAs(member, "legacy");
    await shared!.admin`update capability_installations set installed_by_subject_id = null
      where workspace_id = ${workspaceId} and capability_id = ${legacy}`;
    expect((await installation(own))?.installed_by_subject_id).toBe(member);
    expect((await installation(admins))?.installed_by_subject_id).toBe(admin);

    const forMember = await removableBy(member);
    expect(forMember.get(own)).toBe(true);
    expect(forMember.get(admins)).toBe(false);
    expect(forMember.get(others)).toBe(false);
    expect(forMember.get(legacy)).toBe(false);
    const forOther = await removableBy(otherMember);
    expect(forOther.get(own)).toBe(false);
    expect(forOther.get(others)).toBe(true);
    const forAdmin = await removableBy(admin);
    for (const id of [own, admins, others, legacy]) expect(forAdmin.get(id)).toBe(true);
    // Built-in and reviewed entries aren't removed here.
    const builtIn = [...forAdmin.entries()].filter(
      ([id]) => ![own, admins, others, legacy].includes(id),
    );
    for (const [, canRemove] of builtIn) expect(canRemove).toBe(false);
  });

  test("a member removes their own server and is refused for anyone else's", async () => {
    const own = await addServerAs(member, "mine");
    const admins = await addServerAs(admin, "admin-added");
    const others = await addServerAs(otherMember, "other-added");
    const legacy = await addServerAs(member, "unattributed");
    await shared!.admin`update capability_installations set installed_by_subject_id = null
      where workspace_id = ${workspaceId} and capability_id = ${legacy}`;

    for (const id of [admins, others, legacy]) {
      await expectRefused(await call(member, "DELETE", removePath(id)));
      expect((await installation(id))?.status).toBe("active");
    }
    expect((await call(reader, "DELETE", removePath(own))).status).toBe(403);

    const removed = await call(member, "DELETE", removePath(own));
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removed: { capabilityId: string } }).removed).toMatchObject(
      { capabilityId: own },
    );
    expect(await installation(own)).toBeNull();
    // Its address (and any admin tool rules) stays; only the installation goes.
    expect(await catalogRowExists(own)).toBe(true);
    expect((await removableBy(member)).get(own)).toBe(false);
    expect((await call(member, "DELETE", removePath(own))).status).toBe(409);
  });

  test("an admin removes any custom server", async () => {
    const own = await addServerAs(member, "admin-removes-member");
    const others = await addServerAs(otherMember, "admin-removes-other");
    const legacy = await addServerAs(admin, "admin-removes-legacy");
    await shared!.admin`update capability_installations set installed_by_subject_id = null
      where workspace_id = ${workspaceId} and capability_id = ${legacy}`;
    for (const id of [own, others, legacy]) {
      expect((await call(admin, "DELETE", removePath(id))).status).toBe(200);
      expect(await installation(id)).toBeNull();
    }
  });

  test("a server an admin turned off stays with admins", async () => {
    const own = await addServerAs(member, "turned-off");
    const disabled = await call(
      admin,
      "POST",
      `/capabilities/${encodeURIComponent(own)}/disable`,
      {},
    );
    expect(disabled.status).toBe(200);
    expect((await removableBy(member)).get(own)).toBe(false);
    await expectRefused(await call(member, "DELETE", removePath(own)));
    expect((await installation(own))?.status).toBe("disabled");
    expect((await removableBy(admin)).get(own)).toBe(true);
  });

  test("whoever adds a removed server back becomes its installer", async () => {
    const id = await addServerAs(member, "re-added");
    expect((await call(member, "DELETE", removePath(id))).status).toBe(200);
    await enableAs(otherMember, id);
    expect((await installation(id))?.installed_by_subject_id).toBe(otherMember);
    expect((await removableBy(otherMember)).get(id)).toBe(true);
    expect((await removableBy(member)).get(id)).toBe(false);
    await expectRefused(await call(member, "DELETE", removePath(id)));
    expect((await call(otherMember, "DELETE", removePath(id))).status).toBe(200);
  });

  test("an organization's server turned off here isn't removable, even by an admin", async () => {
    const id = `mcp:removal-organization-${crypto.randomUUID()}`;
    const host = `org-${crypto.randomUUID()}.example`;
    await shared!.admin`insert into organization_connectors (
        account_id, capability_id, custom_definition, config, metadata,
        created_by_subject_id, updated_by_subject_id
      ) values (
        ${accountId}, ${id},
        ${shared!.admin.json({ name: "Organization docs", description: null, endpointUrl: `https://${host}/mcp` })},
        ${shared!.admin.json({ connectionRef: { providerDomain: host, kind: "oauth2", subjectScope: "subject" } })},
        ${shared!.admin.json({ mcpConnectivity: { status: "auth_deferred" } })},
        ${admin}, ${admin}
      )`;
    try {
      expect((await removableBy(admin)).get(id)).toBe(false);
      const off = await call(admin, "POST", `/capabilities/${encodeURIComponent(id)}/disable`, {});
      expect(off.status).toBe(200);
      expect((await installation(id))?.status).toBe("disabled");
      // Turned off here, it is still the organization's, not a custom server.
      expect((await removableBy(admin)).get(id)).toBe(false);
      expect((await removableBy(member)).get(id)).toBe(false);
      const refused = await call(admin, "DELETE", removePath(id));
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain("Only a custom MCP server added in this workspace");
      expect((await installation(id))?.status).toBe("disabled");
    } finally {
      await shared!.admin`delete from organization_connectors
        where account_id = ${accountId} and capability_id = ${id}`;
    }
  });
});
