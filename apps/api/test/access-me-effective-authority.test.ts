import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  AccessContext,
  Permission,
  signDelegatedAccessToken,
  type OrganizationApiKeyAccess,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps, type SessionWorkflowClient } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const delegationSecret = "access-me-effective-authority-test-secret";
let shared: SharedTestDatabase;
let db: DbClient;
let app: Hono;
let accountId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let foreignWorkspaceId: string;
let personalWorkspaceId: string;
let full: OpenGeniClient;
let read: OpenGeniClient;
let workspaceRead: OpenGeniClient;
let workspaceWrite: OpenGeniClient;

function client(token: string): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl: "http://access-authority.test",
    apiKey: token,
    fetch: async (input, init) => app.request(input, init),
  });
}

async function organizationClient(
  access: OrganizationApiKeyAccess,
  permissions = organizationApiKeyPermissionsForAccess(access),
): Promise<OpenGeniClient> {
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: `${access} organization key`,
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  return client(token);
}

async function workspaceClient(permissions: Permission[]): Promise<OpenGeniClient> {
  const token = crypto.randomUUID();
  await createApiKey(db.db, {
    accountId,
    workspaceId,
    name: "Workspace key",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
  });
  return client(token);
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("access-me-effective-authority");
  if (!acquired) throw new Error("Access authority tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
  const [account] = await shared.admin`
    insert into managed_accounts (name) values ('Access authority fixture') returning id`;
  accountId = String(account!.id);
  workspaceId = (await createWorkspace(db.db, { accountId, name: "Shared workspace" })).id;
  otherWorkspaceId = (await createWorkspace(db.db, { accountId, name: "Other workspace" })).id;
  const [foreign] = await shared.admin`
    insert into managed_accounts (name) values ('Other organization') returning id`;
  foreignWorkspaceId = (
    await createWorkspace(db.db, { accountId: String(foreign!.id), name: "Foreign workspace" })
  ).id;
  personalWorkspaceId = (
    await ensureExternalIdentity(db.db, {
      accountId,
      source: "access-authority-test",
      externalId: "personal-owner",
    })
  ).personalWorkspaceId;

  const noop = async () => undefined;
  const deps = {
    db: db.db,
    settings: testSettings({
      productAccessMode: "managed",
      sandboxBackend: "none",
      delegationSecret,
    }),
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
    schedulePromptPostCommit: () => undefined,
  } as unknown as ApiRouteDeps;
  app = new Hono();
  registerWorkspaceRoutes(app, deps);
  registerSessionRoutes(app, deps);
  // Probe the actual route authorization boundary, not a second permission model.
  app.get("/test/authorize/:workspaceId/:permission", async (c) => {
    await requireAccessGrant(
      c,
      deps,
      c.req.param("workspaceId"),
      Permission.parse(c.req.param("permission")),
    );
    return c.json({ allowed: true });
  });
  full = await organizationClient("full");
  read = await organizationClient("read");
  workspaceRead = await workspaceClient(["workspace:read", "sessions:read", "files:read"]);
  workspaceWrite = await workspaceClient(["workspace:read", "workspace:admin", "secrets:read"]);
}, 180_000);

afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

async function contextFor(key: OpenGeniClient): Promise<AccessContext> {
  return AccessContext.parse(await key.getAccessContext());
}

async function allowed(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    // Only a real authorization denial counts as disagreement/absence; never
    // disguise validation, infrastructure, or provisioning failures as denial.
    expect(error).toMatchObject({ status: 403 });
    return false;
  }
}

describe("GET /v1/access/me API-key effective authority", () => {
  test("full organization authority is explicit without enumerating workspaces or implying secrets", async () => {
    const context = await contextFor(full);
    expect(context.workspaceGrants).toEqual([]);
    expect(context.defaultWorkspaceId).toBeNull();
    expect(context.accountGrants[0]?.permissions).toEqual([
      "account:read",
      "workspace:create",
      "api_keys:manage",
    ]);
    expect(context.credential).toMatchObject({
      kind: "organization_api_key",
      access: "full",
      accountId,
      workspaceId: null,
    });
    const effective = context.credential!.effectiveWorkspacePermissions;
    expect(Array.isArray(effective)).toBe(true);
    for (const permission of [
      "workspace:admin",
      "sessions:create",
      "sessions:read",
      "members:manage",
      "mcp_servers:attach",
    ] as const) {
      expect(effective).toContain(permission);
    }
    expect(context.credential!.effectiveWorkspacePermissions).not.toContain("secrets:read");
    expect(context.credential!.effectiveWorkspacePermissions).not.toContain("workspace:create");
    expect(context.credential!.effectiveWorkspacePermissions).not.toContain("account:admin");
    expect(context.credential!.note).toContain("Personal workspaces");
    expect(context.credential!.note).toContain("accountGrants");
  });

  test("read-only organization authority reports its exact restricted workspace permissions", async () => {
    const context = await contextFor(read);
    expect(context.workspaceGrants).toEqual([]);
    expect(context.accountGrants[0]?.permissions).toEqual(["account:read"]);
    expect(context.credential).toMatchObject({
      kind: "organization_api_key",
      access: "read",
      accountId,
      workspaceId: null,
      effectiveWorkspacePermissions: ["workspace:read", "sessions:read", "files:read"],
    });
    expect(await read.getWorkspace(workspaceId)).toMatchObject({ id: workspaceId });
    expect(await read.listSessions(workspaceId)).toEqual([]);
  });

  test("workspace keys report only their bound authority, including explicit secret permission", async () => {
    const context = await contextFor(workspaceRead);
    expect(context.credential).toMatchObject({
      kind: "workspace_api_key",
      accountId,
      workspaceId,
      effectiveWorkspacePermissions: ["workspace:read", "sessions:read", "files:read"],
    });
    expect(context.credential?.access).toBeUndefined();
    expect(context.workspaceGrants[0]?.permissions).toEqual([
      "workspace:read",
      "sessions:read",
      "files:read",
    ]);
    expect(await workspaceRead.getWorkspace(workspaceId)).toMatchObject({ id: workspaceId });
    await expect(workspaceRead.getWorkspace(otherWorkspaceId)).rejects.toMatchObject({
      status: 403,
    });
    const writable = await contextFor(workspaceWrite);
    expect(writable.credential!.effectiveWorkspacePermissions).toContain("sessions:create");
    expect(writable.credential!.effectiveWorkspacePermissions).toContain("secrets:read");
    expect(
      await workspaceWrite.createSession(workspaceId, {
        initialMessage: "Authority test",
        model: "scripted-model",
      }),
    ).toMatchObject({ workspaceId });
    await expect(
      workspaceWrite.asUser("workspace-key-user").getAccessContext(),
    ).rejects.toMatchObject({ status: 403 });
  });

  for (const kind of ["full", "read", "workspace"] as const) {
    test(`${kind} metadata agrees with live permissions, provisioning, external onboarding and asUser creation`, async () => {
      const key = kind === "full" ? full : kind === "read" ? read : workspaceRead;
      const context = await contextFor(key);
      const effective = context.credential!.effectiveWorkspacePermissions;
      for (const permission of [
        "workspace:read",
        "workspace:admin",
        "sessions:create",
        "sessions:read",
        "members:manage",
        "mcp_servers:attach",
        "api_keys:manage",
        "secrets:read",
      ] as const) {
        const decision = await allowed(() =>
          key.requestJsonResponse(`/test/authorize/${workspaceId}/${permission}`),
        );
        expect(decision).toBe(effective.includes(permission));
      }

      const createsWorkspace = context.accountGrants.some(
        (grant) => grant.accountId === accountId && grant.permissions.includes("workspace:create"),
      );
      expect(
        await allowed(() =>
          key.ensureWorkspace({
            accountId,
            externalSource: "access-authority-test",
            externalId: crypto.randomUUID(),
            name: "Provisioned workspace",
          }),
        ),
      ).toBe(createsWorkspace);

      const identity = { source: "access-authority-test", externalId: crypto.randomUUID() };
      const memberPermissions: Permission[] = [
        "workspace:read",
        "sessions:create",
        "sessions:read",
      ];
      const organizationKey = context.credential!.kind === "organization_api_key";
      expect(
        await allowed(() =>
          key.addExternalWorkspaceMember(workspaceId, {
            identity,
            permissions: memberPermissions,
          }),
        ),
      ).toBe(organizationKey && effective.includes("members:manage"));
      // User membership is an independent premise. A read-only key must still
      // deny creates even when the user was onboarded by the full service key.
      await full.addExternalWorkspaceMember(workspaceId, {
        identity,
        permissions: memberPermissions,
      });
      expect(
        await allowed(() =>
          key.asUser(identity.externalId, { source: identity.source }).createSession(workspaceId, {
            initialMessage: "Authority test",
            model: "scripted-model",
          }),
        ),
      ).toBe(organizationKey && effective.includes("sessions:create"));
    });
  }

  test("custom restricted organization permissions are resolved from stored grants, not the tier label", async () => {
    const key = await organizationClient("read", ["workspace:read", "sessions:create"]);
    const context = await contextFor(key);
    expect(context.credential).toMatchObject({
      access: "read",
      effectiveWorkspacePermissions: ["workspace:read", "sessions:create"],
    });
    expect(
      await key.createSession(workspaceId, {
        initialMessage: "Authority test",
        model: "scripted-model",
      }),
    ).toMatchObject({ workspaceId });
    await expect(key.listSessions(workspaceId)).rejects.toMatchObject({ status: 403 });
  });

  test("organization scope excludes Personal and foreign workspaces and asUser does not advertise service authority", async () => {
    for (const key of [full, read]) {
      expect(await key.getWorkspace(otherWorkspaceId)).toMatchObject({ id: otherWorkspaceId });
      await expect(key.getWorkspace(personalWorkspaceId)).rejects.toMatchObject({ status: 403 });
      await expect(key.getWorkspace(foreignWorkspaceId)).rejects.toMatchObject({ status: 403 });
    }
    const actor = full.asUser("personal-owner", { source: "access-authority-test" });
    expect((await contextFor(actor)).credential).toBeUndefined();
    await expect(
      actor.createSession(workspaceId, {
        initialMessage: "Authority test",
        model: "scripted-model",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await contextFor(full.asService("authority-test"))).credential).toEqual(
      (await contextFor(full)).credential,
    );
  });

  test("delegated contexts never claim organization-key authority", async () => {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: "api_key:unverified-shape",
      permissions: ["workspace:admin"],
      principalKind: "service",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect((await contextFor(client(token))).credential).toBeUndefined();
  });
});
