import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Permission, Workspace } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createWorkspace,
  deleteWorkspaceIfQuiescent,
  nestedPostgresSqlState,
  safeDatabaseErrorFacts,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import {
  organizationApiKeyPermissions,
  organizationReadApiKeyPermissions,
} from "../src/routes/api-keys";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

/**
 * An integrating backend provisions organization workspaces with its
 * organization API key (`ensureWorkspace`) and must be able to remove them
 * again (tenant offboarding, test cleanup) through the organization route,
 * with exactly the authority the ordinary workspace DELETE already grants.
 */

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let scheduleDeletes = 0;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-organization-workspace-key-deletion");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("organization workspace key deletion tests require PostgreSQL");
    }
    return;
  }
  client = createDb(shared.appUrl);
  const noop = async () => undefined;
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
    workflowClient: {
      deleteScheduledTaskSchedule: async () => {
        scheduleDeletes += 1;
      },
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    schedulePromptPostCommit: () => undefined,
    managedAuth: {
      api: { getSession: async () => ({ headers: new Headers(), response: null }) },
    } as never,
  } as unknown as ApiRouteDeps;
  app = new Hono();
  registerWorkspaceRoutes(app, deps);
  registerOrganizationMembershipRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function organizationKey(accountId: string, permissions: Permission[]) {
  const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(client!.db, {
    accountId,
    workspaceId: null,
    name: "Integration backend",
    prefix: token.slice(0, 14),
    keyHash: await sha256Hex(token),
    permissions,
    credentialKind: "organization",
  });
  return { authorization: `Bearer ${token}` };
}

async function organizationFixture() {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('key deletion') returning id`;
  const accountId = account!.id;
  // The organization always keeps at least one other workspace.
  const home = await createWorkspace(client!.db, { accountId, name: "Home" });
  const personal = await createWorkspace(client!.db, { accountId, name: "Personal" });
  await shared!.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${`user:owner-${crypto.randomUUID()}`}, 'active', ${personal.id})`;
  return { accountId, home, personal };
}

function del(path: string, headers: Record<string, string>) {
  return app!.request(`http://x${path}`, { method: "DELETE", headers });
}

async function workspaceExists(id: string): Promise<boolean> {
  const [row] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from workspaces where id = ${id}`;
  return row!.count === 1;
}

describe("organization API key workspace deletion", () => {
  test.each(["workspace", "organization"] as const)(
    "%s deletion retains audit-linked data and rolls back cleanup before returning a conflict",
    async (route) => {
      if (!app) return;
      const { accountId } = await organizationFixture();
      const tenant = await createWorkspace(client!.db, { accountId, name: "Retained tenant" });
      const key = await organizationKey(accountId, organizationApiKeyPermissions);
      const receiptId = crypto.randomUUID();
      const scheduleId = `retained-workspace-${crypto.randomUUID()}`;
      // These pre-0461 operation receipts remain immutable audit evidence in
      // the current migrated schema, including their restrictive workspace FK.
      await shared!.admin`insert into knowledge_operation_receipts (
        id, account_id, scope_kind, scope_workspace_id, scope_key,
        operation_kind, operation_namespace, operation_id, input_hash, result_id,
        actor_kind, actor_subject_id
      ) values (
        ${receiptId}, ${accountId}, 'workspace', ${tenant.id},
        opengeni_private.scoped_knowledge_scope_key('workspace', ${tenant.id}::uuid, null),
        'provider', 'deletion-regression', ${crypto.randomUUID()}, ${"a".repeat(64)},
        ${crypto.randomUUID()}, 'human', 'user:fixture'
      )`;
      await shared!.admin`insert into scheduled_tasks (
        account_id, workspace_id, name, schedule, temporal_schedule_id, agent_config
      ) values (
        ${accountId}, ${tenant.id}, 'retained schedule',
        ${shared!.admin.json({ type: "interval", everySeconds: 60 })}, ${scheduleId},
        ${shared!.admin.json({ prompt: "fixture", resources: [], tools: [], metadata: {} })}
      )`;
      const [before] = await shared!
        .admin`select * from knowledge_operation_receipts where id=${receiptId}`;
      const baselineError = await deleteWorkspaceIfQuiescent(client!.db, {
        accountId,
        workspaceId: tenant.id,
      }).catch((error: unknown) => error);
      expect(nestedPostgresSqlState(baselineError)).toBe("23503");
      expect(safeDatabaseErrorFacts(baselineError).constraint).toBe(
        "knowledge_operation_receipts_scope_workspace_id_fkey",
      );
      const deletesBefore = scheduleDeletes;
      const path =
        route === "workspace"
          ? `/v1/workspaces/${tenant.id}`
          : `/v1/organizations/${accountId}/workspaces/${tenant.id}`;
      const response = await del(path, key);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("retained or linked records");
      expect(await workspaceExists(tenant.id)).toBe(true);
      const [after] = await shared!
        .admin`select * from knowledge_operation_receipts where id=${receiptId}`;
      expect(after).toEqual(before);
      const [rows] = await shared!.admin<{ schedules: number; cleanups: number }[]>`
        select
          (select count(*)::int from scheduled_tasks where temporal_schedule_id=${scheduleId}) as schedules,
          (select count(*)::int from temporal_schedule_cleanup_outbox where temporal_schedule_id=${scheduleId}) as cleanups`;
      expect(rows).toEqual({ schedules: 1, cleanups: 0 });
      expect(scheduleDeletes).toBe(deletesBefore);
    },
    60_000,
  );

  test("a full organization key deletes the workspace it provisioned", async () => {
    if (!app) return;
    const { accountId } = await organizationFixture();
    const key = await organizationKey(accountId, organizationApiKeyPermissions);
    const ensured = await app.request("http://x/v1/workspaces/external", {
      method: "PUT",
      headers: { ...key, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "integration-test",
        externalId: `tenant-${crypto.randomUUID()}`,
        name: "Tenant",
      }),
    });
    expect(ensured.status).toBe(201);
    const { workspace: tenant } = (await ensured.json()) as { workspace: Workspace };
    expect(tenant.accountId).toBe(accountId);

    const deleted = await del(`/v1/organizations/${accountId}/workspaces/${tenant.id}`, key);
    expect(deleted.status).toBe(204);
    expect(await workspaceExists(tenant.id)).toBe(false);
    expect((await del(`/v1/organizations/${accountId}/workspaces/${tenant.id}`, key)).status).toBe(
      404,
    );
  }, 60_000);

  test("the ordinary workspace route grants the same key the same deletion", async () => {
    if (!app) return;
    const { accountId } = await organizationFixture();
    const tenant = await createWorkspace(client!.db, { accountId, name: "Tenant" });
    const key = await organizationKey(accountId, organizationApiKeyPermissions);
    expect((await del(`/v1/workspaces/${tenant.id}`, key)).status).toBe(204);
    expect(await workspaceExists(tenant.id)).toBe(false);
  }, 60_000);

  test("a key never deletes a Personal workspace, another organization's, or without workspace:admin", async () => {
    if (!app) return;
    const { accountId, personal } = await organizationFixture();
    const tenant = await createWorkspace(client!.db, { accountId, name: "Tenant" });
    const other = await organizationFixture();
    const otherTenant = await createWorkspace(client!.db, {
      accountId: other.accountId,
      name: "Other tenant",
    });
    const full = await organizationKey(accountId, organizationApiKeyPermissions);
    const read = await organizationKey(accountId, organizationReadApiKeyPermissions);
    const otherKey = await organizationKey(other.accountId, organizationApiKeyPermissions);

    expect(
      (await del(`/v1/organizations/${accountId}/workspaces/${personal.id}`, full)).status,
    ).toBe(403);
    expect((await del(`/v1/organizations/${accountId}/workspaces/${tenant.id}`, read)).status).toBe(
      403,
    );
    expect(
      (await del(`/v1/organizations/${accountId}/workspaces/${tenant.id}`, otherKey)).status,
    ).toBe(403);
    // Naming another organization's workspace under this organization reveals nothing.
    expect(
      (await del(`/v1/organizations/${accountId}/workspaces/${otherTenant.id}`, full)).status,
    ).toBe(404);
    expect(await workspaceExists(personal.id)).toBe(true);
    expect(await workspaceExists(tenant.id)).toBe(true);
    expect(await workspaceExists(otherTenant.id)).toBe(true);
  }, 60_000);
});
