import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  DEVELOPER_SETUP_API_KEY_PRESET,
  Permission,
  type ApiKey,
  type Workspace,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  organizationApiKeyExpiryDate,
  organizationApiKeyPermissionsForAccess,
  registerApiKeyRoutes,
} from "../src/routes/api-keys";
import { registerUsageAllowanceRoutes } from "../src/routes/usage-allowances";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-01T12:00:00.000Z");
const permissions: Permission[] = [...DEVELOPER_SETUP_API_KEY_PRESET.permissions];
const organizationPath = `/v1/organizations/${accountId}/api-keys`;
const workspacePath = `/v1/workspaces/${workspaceId}`;
const workspaceRecord: Workspace = {
  id: workspaceId,
  accountId,
  kind: "shared",
  name: "Staging",
  slug: null,
  externalSource: "product",
  externalId: "staging",
  agentInstructions: null,
  settings: {},
  inferenceControl: {
    state: "active",
    revision: 0,
    reason: null,
    changedBy: null,
    changedAt: null,
  },
  defaultRigId: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};
const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: keyId,
    accountId,
    workspaceId: null,
    name: "Setup",
    description: null,
    prefix: "ogk_fixture",
    permissions: [...permissions],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function fixture(overrides: Partial<ApiKey> = {}, credentialKind = "organization") {
  track(
    spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      ...key(overrides),
      credentialKind,
    } as never),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  const workspace = track(spyOn(db, "requireWorkspace").mockResolvedValue(workspaceRecord));
  const deps = {
    db: {} as never,
    settings: testSettings({ productAccessMode: "managed", usageAllowancesEnabled: true }),
    managedAuth: null,
  } as ApiRouteDeps;
  const app = new Hono();
  registerApiKeyRoutes(app, deps);
  registerUsageAllowanceRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  // Exercise the canonical authenticated key ceiling and permission resolver
  // used by setup routes, without manufacturing a stamped AccessContext.
  app.get("/guard/:permission", async (c) => {
    const permission = Permission.parse(c.req.param("permission"));
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    return c.json({ permissions: grant.permissions });
  });
  return { app, workspace };
}

function request(app: Hono, path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: "Bearer ogk_developer_setup_fixture",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function minting() {
  return track(
    spyOn(db, "createOrganizationApiKey").mockImplementation(async (_db, input) =>
      key({
        name: input.name,
        permissions: input.permissions,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      }),
    ),
  );
}

describe("Developer setup organization API keys", () => {
  test("discovers and provisions workspaces without redundant account/read scopes", async () => {
    const { app } = fixture();
    const list = track(
      spyOn(db, "listSharedWorkspacesForAccount").mockResolvedValue([workspaceRecord]),
    );
    expect((await request(app, "/v1/workspaces")).status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), accountId);
    expect((await request(app, workspacePath)).status).toBe(200);
    const access = await (await request(app, "/v1/access/me")).json();
    expect(access.credential.access).toBe("full");
    expect(access.accountGrants[0].permissions).toEqual(["workspace:create", "api_keys:manage"]);
    expect(permissions).not.toContain("workspace:read");
    expect(permissions).not.toContain("account:read");

    track(spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue(null));
    const ensure = track(
      spyOn(db, "ensureWorkspaceByExternalIdentity").mockResolvedValue({
        workspace: workspaceRecord,
        created: true,
      }),
    );
    const body = { externalSource: "product", externalId: "staging", name: "Staging" };
    expect((await request(app, "/v1/workspaces/external", "PUT", body)).status).toBe(201);
    expect(ensure.mock.calls[0]![1]).toMatchObject({ accountId, ...body });
    const noCreate = fixture({ permissions: permissions.filter((p) => p !== "workspace:create") });
    expect((await request(noCreate.app, "/v1/workspaces/external", "PUT", body)).status).toBe(403);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  test("persona updates require the irreducible workspace-admin scope", async () => {
    const { app } = fixture();
    const update = track(spyOn(db, "updateWorkspace").mockResolvedValue(workspaceRecord));
    expect(
      (await request(app, workspacePath, "PATCH", { agentInstructions: "Product persona" })).status,
    ).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.anything(), workspaceId, {
      agentInstructions: "Product persona",
    });
    const noAdmin = fixture({ permissions: permissions.filter((p) => p !== "workspace:admin") });
    expect(
      (await request(noAdmin.app, workspacePath, "PATCH", { agentInstructions: "Product persona" }))
        .status,
    ).toBe(403);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("mints exactly the setup floor with a one-day default and full authority semantics", async () => {
    const { app } = fixture();
    const create = minting();
    const started = Date.now();
    const response = await request(app, organizationPath, "POST", {
      name: "Setup",
      preset: "developer_setup",
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.apiKey.permissions).toEqual(permissions);
    expect(result.apiKey.access).toBe("full");
    const expires = new Date(result.apiKey.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(started + 24 * 60 * 60 * 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect(create.mock.calls[0]![1]).toMatchObject({
      accountId,
      permissions,
      rotationSourceApiKeyId: keyId,
    });
    expect(result.apiKey).not.toHaveProperty("keyHash");
    expect(result.token).toMatch(/^ogk_/);
  });

  test("honors explicit expiry without changing legacy full/read defaults", () => {
    expect(organizationApiKeyExpiryDate({ preset: "developer_setup" }, now)?.toISOString()).toBe(
      "2026-10-02T12:00:00.000Z",
    );
    expect(
      organizationApiKeyExpiryDate(
        { preset: "developer_setup", expiresAt: "2026-10-01T13:00:00+00:00" },
        now,
      )?.toISOString(),
    ).toBe("2026-10-01T13:00:00.000Z");
    expect(organizationApiKeyExpiryDate({}, now)).toBeNull();
    const legacyFull: Permission[] = [
      "account:read",
      "workspace:create",
      "workspace:read",
      "workspace:admin",
      "api_keys:manage",
    ];
    expect(organizationApiKeyPermissionsForAccess("full")).toEqual(legacyFull);
    expect(organizationApiKeyPermissionsForAccess("read")).toEqual([
      "account:read",
      "workspace:read",
      "sessions:read",
      "files:read",
    ]);
    const copy = organizationApiKeyPermissionsForAccess("full");
    copy.pop();
    expect(organizationApiKeyPermissionsForAccess("full")).toEqual(legacyFull);
  });

  test.each(["full", "read"] as const)(
    "legacy %s requests still mint without a default expiry",
    async (access) => {
      const { app } = fixture();
      minting();
      const response = await request(app, organizationPath, "POST", { name: "Legacy", access });
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.apiKey.permissions).toEqual(organizationApiKeyPermissionsForAccess(access));
      expect(result.apiKey.access).toBe(access);
      expect(result.apiKey.expiresAt).toBeNull();
    },
  );

  test.each(["secrets:read", "members:manage", "account:admin", "billing:manage"] as const)(
    "setup cannot delegate missing high-trust literal %s onto workspace keys",
    async (permission) => {
      const { app } = fixture();
      const create = track(spyOn(db, "createApiKey"));
      expect(
        (
          await request(app, `${workspacePath}/api-keys`, "POST", {
            name: "Child",
            permissions: [permission],
          })
        ).status,
      ).toBe(403);
      expect(create).not.toHaveBeenCalled();
    },
  );

  test.each([
    { name: "Setup", preset: "all_permissions" },
    { name: "Setup", preset: "unknown" },
    { name: "Setup", preset: "developer_setup", access: "read" },
    { name: "Setup", preset: "developer_setup", permissions: Permission.options },
  ])("rejects invalid or contradictory presets before minting: %j", async (body) => {
    const { app } = fixture();
    const create = minting();
    expect((await request(app, organizationPath, "POST", body)).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ["read-only", { permissions: organizationApiKeyPermissionsForAccess("read") }, "organization"],
    ["workspace-scoped", { workspaceId }, "workspace"],
    ["foreign organization", { accountId: crypto.randomUUID() }, "organization"],
  ] as const)("%s keys cannot mint setup organization keys", async (_label, overrides, kind) => {
    const { app } = fixture(overrides, kind);
    const create = minting();
    expect(
      (await request(app, organizationPath, "POST", { name: "Setup", preset: "developer_setup" }))
        .status,
    ).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  test("setup's admin floor covers sessions, tools, approvals, schedules and cleanup guards", async () => {
    const { app } = fixture();
    for (const permission of [
      "workspace:read",
      "workspace:admin",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "connections:read",
      "connections:write",
      "capabilities:manage",
      "mcp_servers:attach",
      "scheduled_tasks:run",
      "scheduled_tasks:manage",
      "secrets:write",
    ] satisfies Permission[]) {
      expect((await request(app, `/guard/${permission}`)).status).toBe(200);
    }
    // Do not misrepresent the short stored list as narrow setup-only authority.
    expect(hasPermission(permissions, "files:write")).toBe(true);
    expect(hasPermission(permissions, "members:manage")).toBe(true);
    expect(hasPermission(permissions, "secrets:read")).toBe(false);
    expect((await request(app, "/guard/secrets:read")).status).toBe(403);
  });

  test("canonical organization stamp and literal key management are required for budgets", async () => {
    const { app } = fixture();
    const set = track(
      spyOn(db, "setWorkspaceAllowance").mockResolvedValue({
        includedCredits: 1_000_000,
        period: "monthly",
        version: 1,
      }),
    );
    const body = { includedCredits: 1_000_000, period: "monthly", expectedVersion: 0 };
    expect((await request(app, `${workspacePath}/allowance`, "PUT", body)).status).toBe(200);
    expect(set.mock.calls[0]![1]).toMatchObject({ accountId, workspaceId });

    const withoutKeyManagement = fixture({
      permissions: permissions.filter((permission) => permission !== "api_keys:manage"),
    });
    expect(
      (await request(withoutKeyManagement.app, `${workspacePath}/allowance`, "PUT", body)).status,
    ).toBe(403);
    const workspaceKey = fixture({ workspaceId }, "workspace");
    expect(
      (await request(workspaceKey.app, `${workspacePath}/allowance`, "PUT", body)).status,
    ).toBe(403);
    expect(set).toHaveBeenCalledTimes(1);
  });

  test("organization setup authority excludes Personal and foreign workspaces", async () => {
    const { app, workspace } = fixture();
    workspace.mockResolvedValue({ id: workspaceId, accountId, kind: "personal" } as never);
    expect((await request(app, "/guard/workspace:admin")).status).toBe(403);
    workspace.mockResolvedValue({
      id: workspaceId,
      accountId: crypto.randomUUID(),
      kind: "shared",
    } as never);
    expect((await request(app, "/guard/workspace:admin")).status).toBe(403);
  });
});
