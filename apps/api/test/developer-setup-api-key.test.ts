import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  DEVELOPER_SETUP_API_KEY_PRESET,
  Permission,
  signDelegatedAccessToken,
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
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-01T12:00:00.000Z");
const delegationSecret = "developer-setup-attempt-test-secret";
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
    settings: testSettings({
      productAccessMode: "managed",
      usageAllowancesEnabled: true,
      delegationSecret,
    }),
    managedAuth: null,
  } as ApiRouteDeps;
  const app = new Hono();
  registerApiKeyRoutes(app, deps);
  registerUsageAllowanceRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerOrganizationMembershipRoutes(app, deps);
  // Exercise the canonical authenticated key ceiling and permission resolver
  // used by setup routes, without manufacturing a stamped AccessContext.
  app.get("/guard/:permission", async (c) => {
    const permission = Permission.parse(c.req.param("permission"));
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    return c.json({ permissions: grant.permissions });
  });
  return { app, workspace };
}

function request(
  app: Hono,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: {
      authorization: "Bearer ogk_developer_setup_fixture",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
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
  test.each(["raw", "service", "asUser"] as const)(
    "%s setup credentials cannot list/mint/revoke organization or workspace keys",
    async (lane) => {
      const { app } = fixture();
      const spies = [
        track(spyOn(db, "listApiKeys")),
        track(spyOn(db, "createApiKey")),
        track(spyOn(db, "revokeApiKey")),
        track(spyOn(db, "listOrganizationApiKeys")),
        track(spyOn(db, "createOrganizationApiKey")),
        track(spyOn(db, "revokeOrganizationApiKey")),
      ];
      const headers: Record<string, string> =
        lane === "service" ? { "x-opengeni-service-initiator": "product.setup" } : {};
      if (lane === "asUser") {
        track(
          spyOn(db, "ensureExternalIdentity").mockResolvedValue({
            id: "55555555-5555-4555-8555-555555555555",
            accountId,
            subjectId: "external_user:person",
            source: "product",
            externalId: "person",
            personalWorkspaceId: "66666666-6666-4666-8666-666666666666",
            organizationMembershipId: "77777777-7777-4777-8777-777777777777",
            authorizationRevision: 1,
          } as never),
        );
        headers["x-opengeni-external-actor"] = encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: "product", externalId: "person" },
          }),
        );
      }
      for (const base of [organizationPath, `${workspacePath}/api-keys`]) {
        for (const [method, path, body] of [
          ["GET", base, undefined],
          [
            "POST",
            base,
            { name: "Escalation", permissions: ["workspace:admin", "api_keys:manage"] },
          ],
          ["DELETE", `${base}/${keyId}`, undefined],
        ] as const) {
          // Organization creation has a strict schema, independent of the route's authorization.
          const payload =
            method === "POST" && base === organizationPath
              ? { name: "Escalation", access: "full" }
              : body;
          expect((await request(app, path, method, payload, headers)).status).toBe(403);
        }
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );

  test.each(["workspace:admin", "api_keys:manage", "members:manage"] as const)(
    "setup cannot delegate %s through native or external memberships",
    async (permission) => {
      const { app } = fixture();
      const writes = track(spyOn(db, "upsertWorkspaceMemberAsWorkspaceManager"));
      const onboarding = track(spyOn(db, "addExternalWorkspaceMemberOperation"));
      const updates = track(spyOn(db, "updateExternalWorkspaceMemberOperation"));
      expect(
        (
          await request(app, `${workspacePath}/members`, "POST", {
            organizationMembershipId: "77777777-7777-4777-8777-777777777777",
            permissions: [permission],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app, `${workspacePath}/members/user%3Aother`, "PATCH", {
            permissions: [permission],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app, `${workspacePath}/external-members`, "POST", {
            identity: { source: "product", externalId: "person" },
            permissions: [permission],
            operationId: "88888888-8888-4888-8888-888888888888",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            app,
            `/v1/organizations/${accountId}/workspaces/${workspaceId}/external-members/77777777-7777-4777-8777-777777777777`,
            "PATCH",
            { permissions: [permission], operationId: "88888888-8888-4888-8888-888888888888" },
          )
        ).status,
      ).toBe(403);
      expect(writes).not.toHaveBeenCalled();
      expect(onboarding).not.toHaveBeenCalled();
      expect(updates).not.toHaveBeenCalled();
    },
  );

  test("setup can onboard an ordinary external member without credential-delegation powers", async () => {
    const { app } = fixture();
    const add = track(
      spyOn(db, "addExternalWorkspaceMemberOperation").mockResolvedValue({
        id: "55555555-5555-4555-8555-555555555555",
        accountId,
        source: "product",
        externalId: "person",
        subjectId: "external_user:person",
      } as never),
    );
    expect(
      (
        await request(app, `${workspacePath}/external-members`, "POST", {
          identity: { source: "product", externalId: "person" },
          permissions: ["workspace:read", "sessions:read", "sessions:create"],
          operationId: "88888888-8888-4888-8888-888888888888",
        })
      ).status,
    ).toBe(200);
    expect(add).toHaveBeenCalledTimes(1);
    const update = track(
      spyOn(db, "updateExternalWorkspaceMemberOperation").mockResolvedValue({
        subjectId: "external_user:person",
        organizationMembershipId: "77777777-7777-4777-8777-777777777777",
        permissions: ["workspace:read", "sessions:read"],
        narrowed: true,
        replay: false,
      }),
    );
    expect(
      (
        await request(
          app,
          `/v1/organizations/${accountId}/workspaces/${workspaceId}/external-members/77777777-7777-4777-8777-777777777777`,
          "PATCH",
          {
            permissions: ["workspace:read", "sessions:read"],
            operationId: "88888888-8888-4888-8888-888888888888",
          },
        )
      ).status,
    ).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test.each(["organization", "workspace"] as const)(
    "legacy full %s keys retain workspace key management",
    async (credentialKind) => {
      const { app } = fixture(
        {
          permissions: organizationApiKeyPermissionsForAccess("full"),
          workspaceId: credentialKind === "workspace" ? workspaceId : null,
        },
        credentialKind,
      );
      const list = track(spyOn(db, "listApiKeys").mockResolvedValue([]));
      const create = track(
        spyOn(db, "createApiKey").mockImplementation(async (_db, input) =>
          key({ workspaceId, name: input.name, permissions: input.permissions }),
        ),
      );
      const revoke = track(spyOn(db, "revokeApiKey").mockResolvedValue({ revoked: true }));
      const path = `${workspacePath}/api-keys`;
      expect((await request(app, path)).status).toBe(200);
      expect(
        (await request(app, path, "POST", { name: "Child", permissions: ["sessions:read"] }))
          .status,
      ).toBe(201);
      expect((await request(app, `${path}/${keyId}`, "DELETE")).status).toBe(200);
      expect(list).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledTimes(1);
    },
  );

  test("inherited attempt-admin cannot mint or delegate durable API-key authority", async () => {
    const { app } = fixture();
    const attemptPermissions: Permission[] = ["workspace:admin", "api_keys:manage"];
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: "attempt",
      principalKind: "agent_attempt",
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      permissions: attemptPermissions,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await request(
          app,
          `${workspacePath}/api-keys`,
          "POST",
          { name: "Escalation", permissions: attemptPermissions },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          app,
          `${workspacePath}/members`,
          "POST",
          {
            organizationMembershipId: "77777777-7777-4777-8777-777777777777",
            permissions: attemptPermissions,
          },
          headers,
        )
      ).status,
    ).toBe(403);
  });

  test("discovers and provisions workspaces without redundant account/read scopes", async () => {
    const { app } = fixture();
    const list = track(
      spyOn(db, "listSharedWorkspacesForAccount").mockResolvedValue([workspaceRecord]),
    );
    expect((await request(app, "/v1/workspaces")).status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), accountId);
    expect((await request(app, workspacePath)).status).toBe(200);
    const access = await (await request(app, "/v1/access/me")).json();
    expect(access.credential.access).toBe("developer_setup");
    expect(access.credential.effectiveWorkspacePermissions).not.toContain("api_keys:manage");
    expect(access.credential.effectiveWorkspacePermissions).not.toContain(
      "usage_allowances:manage",
    );
    expect(access.accountGrants[0].permissions).toEqual([
      "workspace:create",
      "usage_allowances:manage",
    ]);
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

  test("native setup creation does not mint an all-permissions creator grant", async () => {
    const { app } = fixture();
    track(spyOn(db, "createWorkspace").mockResolvedValue(workspaceRecord));
    const grant = track(spyOn(db, "grantWorkspaceAccess").mockResolvedValue({} as never));
    expect((await request(app, "/v1/workspaces", "POST", { name: "Staging" })).status).toBe(201);
    expect(grant).not.toHaveBeenCalled();
    expect((await request(app, workspacePath)).status).toBe(200);
    expect((await request(app, "/guard/secrets:read")).status).toBe(403);
    expect((await request(app, `${workspacePath}/api-keys`)).status).toBe(403);

    const legacy = fixture({ permissions: organizationApiKeyPermissionsForAccess("full") });
    expect((await request(legacy.app, "/v1/workspaces", "POST", { name: "Legacy" })).status).toBe(
      201,
    );
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant.mock.calls[0]![1]).toMatchObject({ permissions: db.allWorkspacePermissions });
  });

  test("persisted creator grants cannot widen setup's literal key or secret ceiling", async () => {
    const { app } = fixture();
    track(
      spyOn(db, "getWorkspaceGrant").mockResolvedValue({
        accountId,
        workspaceId,
        subjectId: `api_key:${keyId}`,
        principalKind: "api_key",
        permissions: [...db.allWorkspacePermissions],
      }),
    );
    const response = await request(app, "/guard/sessions:read");
    expect(response.status).toBe(200);
    const resolved = await response.json();
    expect(resolved.permissions).not.toContain("secrets:read");
    expect(resolved.permissions).not.toContain("api_keys:manage");
    expect(resolved.permissions).not.toContain("usage_allowances:manage");
    expect((await request(app, "/guard/secrets:read")).status).toBe(403);
    expect((await request(app, `${workspacePath}/api-keys`)).status).toBe(403);
  });

  test.each(["personal", "foreign"] as const)(
    "persisted creator grants cannot admit setup to %s workspaces",
    async (kind) => {
      const { app, workspace } = fixture();
      workspace.mockResolvedValue({
        ...workspaceRecord,
        ...(kind === "personal"
          ? { kind: "personal" }
          : { accountId: "44444444-4444-4444-8444-444444444444" }),
      });
      track(
        spyOn(db, "getWorkspaceGrant").mockResolvedValue({
          accountId,
          workspaceId,
          subjectId: `api_key:${keyId}`,
          principalKind: "api_key",
          permissions: [...db.allWorkspacePermissions],
        }),
      );
      expect((await request(app, workspacePath)).status).toBe(403);
    },
  );

  test.each(["access", "preset"] as const)(
    "mints exactly setup authority with a one-day default via %s",
    async (field) => {
      const { app } = fixture({ permissions: organizationApiKeyPermissionsForAccess("full") });
      const create = minting();
      const started = Date.now();
      const response = await request(app, organizationPath, "POST", {
        name: "Setup",
        [field]: "developer_setup",
      });
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.apiKey.permissions).toEqual(permissions);
      expect(result.apiKey.access).toBe("developer_setup");
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
    },
  );

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
    expect(organizationApiKeyExpiryDate({ access: "developer_setup" }, now)?.toISOString()).toBe(
      "2026-10-02T12:00:00.000Z",
    );
    expect(organizationApiKeyPermissionsForAccess("developer_setup")).toEqual(permissions);
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
      const { app } = fixture({ permissions: organizationApiKeyPermissionsForAccess("full") });
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

  test("canonical organization stamp and literal allowance management are required for setup budgets", async () => {
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

    const withoutBudgetAuthority = fixture({
      permissions: permissions.filter((permission) => permission !== "usage_allowances:manage"),
    });
    expect(
      (await request(withoutBudgetAuthority.app, `${workspacePath}/allowance`, "PUT", body)).status,
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
