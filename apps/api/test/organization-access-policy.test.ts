import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  Permission,
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
  type ApiKey,
  type OrganizationAccessPolicy,
  type Workspace,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  registerApiKeyRoutes,
  organizationApiKeyPermissionsForAccess,
} from "../src/routes/api-keys";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";
import { prepareWorkspaceToolGateway } from "../src/workspace-tool-gateway";
import { prepareExternalLinkTurnAdmission } from "../../../packages/core/src/application/external-link-work-admission";

const accountId = "11111111-1111-4111-8111-111111111111";
const keyId = "22222222-2222-4222-8222-222222222222";
const first = "33333333-3333-4333-8333-333333333333";
const second = "44444444-4444-4444-8444-444444444444";
const future = "55555555-5555-4555-8555-555555555555";
const time = "2026-10-02T17:18:00.000Z";
const path = `/v1/organizations/${accountId}/api-keys`;
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function workspace(id: string, kind: "shared" | "personal" = "shared"): Workspace {
  return {
    id,
    accountId,
    kind,
    name: id,
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    defaultRigId: null,
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    createdAt: time,
    updatedAt: time,
  };
}
function policy(permissions: Permission[], selected?: string[]): OrganizationAccessPolicy {
  return normalizeOrganizationAccessPolicy({
    preset: "custom",
    permissions,
    workspaceScope: selected ? { kind: "selected", workspaceIds: selected } : { kind: "all" },
  });
}
function key(accessPolicy?: OrganizationAccessPolicy): ApiKey {
  return {
    id: keyId,
    accountId,
    workspaceId: null,
    name: "Agent",
    description: null,
    prefix: "ogk_fixture",
    permissions: accessPolicy?.permissions ?? organizationApiKeyPermissionsForAccess("full"),
    ...(accessPolicy
      ? {
          policy: accessPolicy,
          workspaceScope: accessPolicy.workspaceScope,
          permissionMode: "explicit" as const,
        }
      : {}),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: time,
    updatedAt: time,
  };
}
function fixture(initial?: OrganizationAccessPolicy) {
  let stored = key(initial);
  const workspaces = new Map([
    [first, workspace(first)],
    [second, workspace(second)],
  ]);
  track(
    spyOn(db, "findActiveApiKeyByHash").mockImplementation(async () => ({
      ...stored,
      credentialKind: "organization",
    })),
  );
  const membership = track(
    spyOn(db, "getWorkspaceGrant").mockResolvedValue({
      accountId,
      workspaceId: second,
      subjectId: `api_key:${keyId}`,
      permissions: ["workspace:admin"],
    }),
  );
  track(
    spyOn(db, "requireWorkspace").mockImplementation(async (_db, id) => {
      const found = workspaces.get(id);
      if (!found) throw new Error("missing");
      return found;
    }),
  );
  track(
    spyOn(db, "listSharedWorkspacesForAccount").mockImplementation(async () =>
      [...workspaces.values()].filter((w) => w.kind === "shared"),
    ),
  );
  track(spyOn(db, "getOrganizationApiKey").mockImplementation(async () => stored));
  track(spyOn(db, "listOrganizationApiKeys").mockImplementation(async () => [stored]));
  track(
    spyOn(db, "updateOrganizationApiKey").mockImplementation(
      async (_db, _account, _id, changes) => {
        stored = {
          ...stored,
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.description !== undefined ? { description: changes.description } : {}),
          ...(changes.policy
            ? {
                permissions: changes.policy.permissions,
                policy: changes.policy,
                workspaceScope: changes.policy.workspaceScope,
                permissionMode: "explicit" as const,
              }
            : {}),
        };
        return stored;
      },
    ),
  );
  const deps = {
    db: {} as never,
    settings: testSettings({ productAccessMode: "managed" }),
    managedAuth: null,
  } as ApiRouteDeps;
  const app = new Hono();
  registerApiKeyRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerOrganizationMembershipRoutes(app, deps);
  app.get("/guard/:workspaceId/:permission", async (c) =>
    c.json(
      await requireAccessGrant(
        c,
        deps,
        c.req.param("workspaceId"),
        Permission.parse(c.req.param("permission")),
      ),
    ),
  );
  return { app, deps, workspaces, membership, stored: () => stored };
}
function request(app: Hono, url: string, method = "GET", body?: unknown) {
  return app.request(url, {
    method,
    headers: {
      authorization: "Bearer ogk_policy_fixture",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("organization key policy API and canonical access", () => {
  test("selected scope blocks other workspaces, even with a persisted membership", async () => {
    const { app, membership } = fixture(policy(["workspace:read", "sessions:read"], [first]));
    expect((await request(app, `/guard/${first}/sessions:read`)).status).toBe(200);
    expect((await request(app, `/guard/${second}/sessions:read`)).status).toBe(403);
    expect(membership).not.toHaveBeenCalled();
    expect(
      (await (await request(app, "/v1/workspaces")).json()).map((w: Workspace) => w.id),
    ).toEqual([first]);
  });
  test("all scope discovers and reaches future shared workspaces but never Personal or another tenant", async () => {
    const { app, workspaces } = fixture(policy(organizationAccessPresetPermissions("full")));
    workspaces.set(future, workspace(future));
    expect((await request(app, `/guard/${future}/sessions:create`)).status).toBe(200);
    expect(
      (await (await request(app, "/v1/workspaces")).json()).map((w: Workspace) => w.id),
    ).toContain(future);
    workspaces.set(second, workspace(second, "personal"));
    expect((await request(app, `/guard/${second}/sessions:read`)).status).toBe(403);
    workspaces.set(second, { ...workspace(second), accountId: future });
    expect((await request(app, `/guard/${second}/sessions:read`)).status).toBe(403);
  });
  test("read-only reads and refuses every mutation scope", async () => {
    const { app } = fixture(policy(organizationAccessPresetPermissions("read_only")));
    for (const permission of organizationAccessPresetPermissions("read_only").filter(
      (p) => !["account:read", "billing:read"].includes(p),
    ))
      expect((await request(app, `/guard/${first}/${permission}`)).status).toBe(200);
    for (const permission of [
      "sessions:create",
      "sessions:control",
      "files:write",
      "workspace:admin",
      "api_keys:manage",
      "connections:write",
      "secrets:write",
    ])
      expect((await request(app, `/guard/${first}/${permission}`)).status).toBe(403);
    expect(
      (await request(app, `/v1/workspaces/${first}`, "PATCH", { name: "Mutation" })).status,
    ).toBe(403);
    expect((await request(app, "/v1/workspaces", "POST", { name: "Mutation" })).status).toBe(403);
  });
  test("custom workspace:admin cannot imply missing mutation permissions or account authority", async () => {
    const { app } = fixture(policy(["workspace:read", "workspace:admin", "sessions:read"]));
    expect((await request(app, `/guard/${first}/workspace:admin`)).status).toBe(200);
    expect((await request(app, `/guard/${first}/sessions:read`)).status).toBe(200);
    for (const permission of [
      "sessions:control",
      "api_keys:manage",
      "secrets:write",
      "account:admin",
      "billing:manage",
    ])
      expect((await request(app, `/guard/${first}/${permission}`)).status).toBe(403);
    expect((await request(app, path)).status).toBe(403);
  });
  test("PATCH narrowing changes the next request and cannot be bypassed by an old membership", async () => {
    const { app } = fixture(policy(organizationAccessPresetPermissions("full")));
    expect((await request(app, `/guard/${second}/sessions:control`)).status).toBe(200);
    const narrowed = policy(organizationAccessPresetPermissions("read_only"), [first]);
    const response = await request(app, `${path}/${keyId}`, "PATCH", {
      name: "Reader",
      description: null,
      policy: narrowed,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.policy).toEqual(narrowed);
    expect(result.workspaceScope).toEqual(narrowed.workspaceScope);
    expect(result.name).toBe("Reader");
    expect(result.token).toBeUndefined();
    expect((await request(app, `/guard/${first}/sessions:read`)).status).toBe(200);
    expect((await request(app, `/guard/${first}/sessions:control`)).status).toBe(403);
    expect((await request(app, `/guard/${second}/sessions:read`)).status).toBe(403);
  });
  test("a gateway live recheck rejects a workspace removed after initial authorization", async () => {
    const { app, deps, stored } = fixture(policy(["workspace:read", "sessions:read"], [first]));
    track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, run) =>
        run({} as never),
      ),
    );
    const lock = track(
      spyOn(db, "lockActiveExternalOrganizationKeyAuthority").mockImplementation(
        async (_db, _account, _key, workspaceId) => {
          const scope = stored().workspaceScope;
          return scope?.kind === "selected" && !scope.workspaceIds.includes(workspaceId!)
            ? null
            : { permissions: stored().permissions, permissionMode: "explicit" as const };
        },
      ),
    );
    app.get("/gateway-recheck", async (c) => {
      const authorization = await requireAccessGrantAuthorization(c, deps, first, "workspace:read");
      await db.updateOrganizationApiKey(deps.db, accountId, keyId, {
        policy: policy(["workspace:read", "sessions:read"], [second]),
      });
      await prepareWorkspaceToolGateway(deps, authorization);
      return c.text("unexpected");
    });
    expect((await request(app, "/gateway-recheck")).status).toBe(403);
    expect(lock.mock.calls[0]).toEqual([{}, accountId, keyId, first]);
  });
  test("metadata-only PATCH, list/get and legacy creation preserve exact legacy permissions and wildcard", async () => {
    const { app, stored } = fixture();
    const before = [...stored().permissions];
    expect((await request(app, `${path}/${keyId}`, "PATCH", { name: "Renamed" })).status).toBe(200);
    expect(stored().permissions).toEqual(before);
    expect((await request(app, `/guard/${first}/sessions:control`)).status).toBe(200);
    expect((await request(app, `/guard/${first}/secrets:read`)).status).toBe(403);
    const detail = await (await request(app, `${path}/${keyId}`)).json();
    const list = await (await request(app, path)).json();
    expect(detail.permissions).toEqual(before);
    expect(detail.workspaceScope).toEqual({ kind: "all" });
    expect(detail.policy.permissions).toEqual(
      normalizeOrganizationAccessPolicy({
        preset: "custom",
        permissions: before,
        workspaceScope: { kind: "all" },
      }).permissions,
    );
    expect(list.apiKeys[0]).toEqual(detail);
    const create = track(
      spyOn(db, "createOrganizationApiKey").mockImplementation(async (_db, input) => ({
        ...key(),
        permissions: input.permissions,
      })),
    );
    expect((await request(app, path, "POST", { name: "Legacy" })).status).toBe(201);
    expect(create.mock.calls[0]?.[1].permissions).toEqual(before);
    expect(create.mock.calls[0]?.[1].policy).toBeUndefined();
  });
  test("create forwards normalized policy and refuses invalid scopes and mixed tiers", async () => {
    const { app } = fixture();
    const create = track(
      spyOn(db, "createOrganizationApiKey").mockImplementation(async (_db, input) =>
        key(input.policy),
      ),
    );
    const target = policy(["sessions:read", "workspace:read"], [first]);
    const response = await request(app, path, "POST", {
      name: "Scoped",
      policy: { ...target, preset: "full", permissions: [...target.permissions, "sessions:read"] },
    });
    expect(response.status).toBe(201);
    expect((await response.json()).apiKey.policy).toEqual(target);
    expect(create.mock.calls[0]?.[1].policy).toEqual(target);
    expect(
      (
        await request(app, path, "POST", {
          name: "Invalid",
          policy: { ...target, workspaceScope: { kind: "selected", workspaceIds: [first, first] } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(app, path, "POST", { name: "Mixed", access: "read", policy: target })).status,
    ).toBe(400);
    expect(
      (await request(app, path, "POST", { name: "Mixed", access: "full", policy: target })).status,
    ).toBe(400);
    expect((await request(app, `${path}/${keyId}`, "PATCH", {})).status).toBe(400);
  });
  test("custom key managers cannot mint or PATCH a wider permission or workspace policy", async () => {
    const { app } = fixture(policy(["account:read", "workspace:read", "api_keys:manage"], [first]));
    expect(
      (
        await request(app, path, "POST", {
          name: "Wider",
          policy: policy(["sessions:control"], [first]),
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(app, path, "POST", { name: "All", policy: policy(["workspace:read"]) }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app, `${path}/${keyId}`, "PATCH", {
          policy: policy(["workspace:read"], [second]),
        })
      ).status,
    ).toBe(403);
    expect((await request(app, path, "POST", { name: "Legacy", access: "full" })).status).toBe(403);
  });
  test("selected workspace administration cannot delete another workspace", async () => {
    const { app } = fixture(policy(["workspace:read", "workspace:admin"], [first]));
    expect(
      (await request(app, `/v1/organizations/${accountId}/workspaces/${second}`, "DELETE")).status,
    ).toBe(403);
  });
  test("selected membership authority blocks keyed external update and cancellation in other workspaces", async () => {
    const { app } = fixture(policy(["workspace:read", "members:manage"], [first]));
    const update = track(spyOn(db, "updateExternalWorkspaceMemberOperation"));
    const cancel = track(spyOn(db, "cancelExternalWorkspaceMemberGrant"));
    const base = `/v1/organizations/${accountId}/workspaces/${second}`;
    expect(
      (
        await request(app, `${base}/external-members/${future}`, "PATCH", {
          permissions: ["workspace:read"],
          operationId: keyId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app, `${base}/members/${future}/revoke`, "POST", {
          operationId: keyId,
          cancelGrantOperationId: first,
        })
      ).status,
    ).toBe(403);
    expect(update).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
  test("custom membership managers cannot delegate an unheld permission or admin wildcard", async () => {
    const { app } = fixture(policy(["workspace:read", "workspace:admin", "members:manage"]));
    const mutate = track(
      spyOn(db, "upsertWorkspaceMemberAsWorkspaceManager").mockResolvedValue({} as never),
    );
    for (const permissions of [["sessions:control"], ["workspace:admin"]]) {
      expect(
        (
          await request(app, `/v1/workspaces/${first}/members`, "POST", {
            organizationMembershipId: future,
            permissions,
          })
        ).status,
      ).toBe(403);
      expect(
        (await request(app, `/v1/workspaces/${first}/members/user:other`, "PATCH", { permissions }))
          .status,
      ).toBe(403);
    }
    expect(mutate).not.toHaveBeenCalled();
  });
  test("linked asUser cannot use human membership to exceed the organization policy ceiling", async () => {
    const { app, deps } = fixture(policy(["workspace:read", "members:manage"], [first]));
    const nativeSubjectId = "user:linked-admin";
    track(
      spyOn(db, "ensureExternalIdentity").mockResolvedValue({
        id: second,
        accountId,
        subjectId: `external_user:${second}`,
        source: "fixture",
        externalId: "person",
        organizationMembershipId: future,
        personalWorkspaceId: future,
        authorizationRevision: 1,
      } as never),
    );
    track(
      spyOn(db, "resolveExternalIdentityLink").mockResolvedValue({
        link: { id: future, revision: 1, nativeSubjectId, permissions: ["workspace:admin"] },
        personalWorkspaceId: future,
      } as never),
    );
    track(
      spyOn(db, "withWorkspaceSubjectRls").mockImplementation(
        async (_db, _workspace, _subject, run) => run({} as never),
      ),
    );
    track(
      spyOn(db, "getWorkspaceGrant").mockResolvedValue({
        accountId,
        workspaceId: first,
        subjectId: nativeSubjectId,
        permissions: ["workspace:admin"],
        principalKind: "human_session",
      }),
    );
    const mutate = track(
      spyOn(db, "upsertWorkspaceMemberAsWorkspaceManager").mockResolvedValue({} as never),
    );
    const headers = {
      authorization: "Bearer ogk_policy_fixture",
      "content-type": "application/json",
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "linked_native",
          identity: { source: "fixture", externalId: "person" },
          linkId: future,
          expectedLinkRevision: 1,
        }),
      ),
    };
    track(
      spyOn(db, "withAccountRls").mockImplementation(async (_db, _account, callback) =>
        callback({} as never),
      ),
    );
    track(spyOn(db, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
    track(
      spyOn(db, "lockActiveExternalOrganizationKeyAuthority").mockResolvedValue({
        permissions: ["workspace:read", "members:manage"],
        permissionMode: "explicit",
      }),
    );
    const capture = track(
      spyOn(db, "captureExternalLinkTurnAuthority").mockResolvedValue(undefined),
    );
    app.get("/linked-capture", async (c) => {
      const authorization = await requireAccessGrantAuthorization(c, deps, first, "workspace:read");
      await prepareExternalLinkTurnAdmission(authorization)!({} as never, keyId, first);
      return c.json(capture.mock.calls[0]![1].snapshot);
    });
    const captured = await app.request("/linked-capture", { headers });
    expect(captured.status).toBe(200);
    expect((await captured.json()).permissionMode).toBe("explicit");
    expect((await app.request(`/guard/${first}/members:manage`, { headers })).status).toBe(200);
    for (const method of ["POST", "PATCH"]) {
      const url = `/v1/workspaces/${first}/members${method === "PATCH" ? "/user:other" : ""}`;
      expect(
        (
          await app.request(url, {
            method,
            headers,
            body: JSON.stringify({
              ...(method === "POST" ? { organizationMembershipId: future } : {}),
              permissions: ["sessions:control"],
            }),
          })
        ).status,
      ).toBe(403);
    }
    expect(mutate).not.toHaveBeenCalled();
  });
  test("selected external mapping lookup cannot reveal an excluded existing workspace", async () => {
    const { app } = fixture(policy(["workspace:read", "workspace:create"], [first]));
    track(spyOn(db, "findWorkspaceByExternalIdentity").mockResolvedValue(workspace(second)));
    const ensure = track(spyOn(db, "ensureWorkspaceByExternalIdentity"));
    expect(
      (
        await request(app, "/v1/workspaces/external", "PUT", {
          externalSource: "product",
          externalId: "second",
          name: "Second",
        })
      ).status,
    ).toBe(403);
    expect(ensure).not.toHaveBeenCalled();
  });
});
