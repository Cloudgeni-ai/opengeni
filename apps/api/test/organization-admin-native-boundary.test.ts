import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ApiKey,
  OrganizationAdministrationOverview,
  signDelegatedAccessToken,
  type AccessContext,
  type Permission,
} from "@opengeni/contracts";
import {
  requireAccessContext,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import * as db from "@opengeni/db";
import * as canonical from "@opengeni/db/canonical-human-identities";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationRouteAdministrator } from "../src/http/human-route-authorization";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";

const organizationId = "11111111-1111-4111-8111-111111111111";
const foreignOrganizationId = "22222222-2222-4222-8222-222222222222";
const missingOrganizationId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const userId = "native-organization-owner";
const subjectId = `user:${userId}`;
const serviceSubjectId = `api_key:${keyId}`;
const nativeCookie = "better-auth.session_token=organization-owner-fixture";
const serviceToken = "organization-administrator-fixture-key";
const delegationSecret = "organization-administrator-fixture-delegation-secret";
const timestamp = "2026-10-03T00:00:00.000Z";
const storedSession = {
  session: { id: "native-owner-auth-session" },
  user: { id: userId, name: "Native owner", email: "owner@example.test", emailVerified: true },
};

function liveAccess(): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [
      { accountId: organizationId, subjectId, permissions: ["account:read", "account:admin"] },
    ],
    workspaceGrants: [
      {
        accountId: organizationId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ["workspace:admin", "connections:write"],
      },
    ],
    defaultAccountId: organizationId,
    defaultWorkspaceId: workspaceId,
  };
}

function overviewPath(target = organizationId): string {
  return `/v1/organizations/${target}/overview`;
}

describe("organization administrator native-cookie boundary (mock auth/DB ports)", () => {
  const restores: Array<() => void> = [];
  let live: AccessContext;
  let sessionActive: boolean;
  let servicePermissions: Permission[];
  let organizationRoles: Set<string>;
  let deps: ApiRouteDeps;
  let app: Hono;
  let sessions: ReturnType<typeof mock>;
  let validation: ReturnType<typeof spyOn<typeof canonical, "validateCanonicalHumanSession">>;
  let profiles: ReturnType<typeof spyOn<typeof db, "getManagedUserProfilesByIds">>;
  let nativeAccess: ReturnType<typeof spyOn<typeof db, "ensureManagedAccessForUser">>;
  let overview: ReturnType<typeof spyOn<typeof db, "getOrganizationAdministrationOverview">>;
  let update: ReturnType<typeof spyOn<typeof db, "updateOrganizationName">>;

  function requireStoredOrganizationRole(target: string, actor: string): void {
    if (![organizationId, foreignOrganizationId].includes(target))
      throw Object.assign(new Error("organization does not exist"), { code: "P0002" });
    if (!organizationRoles.has(`${target}/${actor}`))
      throw Object.assign(new Error("actor is not an organization administrator"), {
        code: "42501",
      });
  }

  beforeEach(() => {
    live = liveAccess();
    sessionActive = true;
    servicePermissions = ["account:read", "account:admin", "connections:write"];
    organizationRoles = new Set([
      `${organizationId}/${subjectId}`,
      `${organizationId}/${serviceSubjectId}`,
    ]);
    // Only the auth-provider port resolves this fixture cookie. The production
    // getManagedSession resolver must then validate its exact stored user/session.
    sessions = mock(
      async ({ headers, returnHeaders }: { headers: Headers; returnHeaders: boolean }) => {
        expect(returnHeaders).toBe(true);
        return {
          headers: new Headers(),
          response: headers.get("cookie") === nativeCookie ? structuredClone(storedSession) : null,
        };
      },
    );
    validation = spyOn(canonical, "validateCanonicalHumanSession").mockImplementation(
      async (_, input) =>
        sessionActive &&
        input.authSessionId === storedSession.session.id &&
        input.authUserId === storedSession.user.id,
    );
    profiles = spyOn(db, "getManagedUserProfilesByIds").mockImplementation(async (_, ids) =>
      ids.length === 1 && ids[0] === userId
        ? [{ id: userId, name: storedSession.user.name, email: storedSession.user.email }]
        : [],
    );
    nativeAccess = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async (_, input) => {
      expect(input.userId).toBe(userId);
      expect(input.email).toBe(storedSession.user.email);
      expect(input.provisionFallbackOrganization).toBe(false);
      expect(input.bindPendingInvitations).toBe(false);
      return structuredClone(live);
    });
    const keys = spyOn(db, "findActiveApiKeyByHash").mockImplementation(async (_, hash) =>
      hash === createHash("sha256").update(serviceToken).digest("hex")
        ? {
            ...ApiKey.parse({
              id: keyId,
              accountId: organizationId,
              workspaceId: null,
              name: "Organization service",
              description: null,
              prefix: "fixture-key",
              permissions: servicePermissions,
              expiresAt: null,
              revokedAt: null,
              lastUsedAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
            credentialKind: "organization" as const,
          }
        : null,
    );
    overview = spyOn(db, "getOrganizationAdministrationOverview").mockImplementation(
      async (_, input) => {
        requireStoredOrganizationRole(input.organizationId, input.actorSubjectId);
        return OrganizationAdministrationOverview.parse({
          organization: {
            id: input.organizationId,
            name: "Fixture organization",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          roles: ["viewer", "member", "admin"].map((role) => ({
            role,
            label: role,
            description: "Fixture role",
            permissions: ["workspace:read"],
          })),
          workspaces: [],
        });
      },
    );
    update = spyOn(db, "updateOrganizationName").mockImplementation(async (_, input) => {
      requireStoredOrganizationRole(input.organizationId, input.actorSubjectId);
      return {
        id: input.organizationId,
        name: input.name,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    for (const spy of [validation, profiles, nativeAccess, keys, overview, update])
      restores.push(() => spy.mockRestore());
    deps = {
      db: {} as db.Database,
      settings: testSettings({
        productAccessMode: "managed",
        managedAuthSessionSetMode: "legacy",
        publicBaseUrl: "https://console.example.test",
        delegationSecret,
      }),
      managedAuth: { api: { getSession: sessions } },
    } as unknown as ApiRouteDeps;
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerOrganizationMembershipRoutes(app, deps);
    app.on(["GET", "POST"], "/fixture/connections/:organizationId", async (c) => {
      const actor = await requireOrganizationRouteAdministrator(
        c,
        deps,
        c.req.param("organizationId"),
        "connections:write",
      );
      requireStoredOrganizationRole(c.req.param("organizationId"), actor.subjectId);
      return c.json(actor);
    });
  });
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function delegatedRequest(
    path: string,
    permissions: Permission[],
    options: {
      organization?: string;
      cookie?: boolean;
      method?: string;
      body?: Record<string, unknown>;
    } = {},
  ): Request {
    const raw = new Request(`https://api.example.test${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.cookie ? { cookie: nativeCookie } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const proof: DelegatedHumanAuthorization = {
      organizationId: options.organization ?? organizationId,
      subjectId,
      permissions,
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
    };
    stampDelegatedHumanAuthorization(raw, proof);
    return raw;
  }

  test("a genuine native cookie reaches the downstream unknown-organization 404", async () => {
    const response = await app.request(overviewPath(missingOrganizationId), {
      headers: { cookie: nativeCookie },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("organization resource not found");
    expect(validation).toHaveBeenCalledWith(deps.db, {
      authSessionId: storedSession.session.id,
      authUserId: userId,
    });
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith(deps.db, {
      organizationId: missingOrganizationId,
      actorSubjectId: subjectId,
    });
    expect(nativeAccess).toHaveBeenCalledTimes(1);
    expect(nativeAccess).toHaveBeenCalledWith(deps.db, {
      userId,
      email: storedSession.user.email,
      name: storedSession.user.name,
      emailVerified: true,
      provisionFallbackOrganization: false,
      bindPendingInvitations: false,
    });
    expect(profiles).not.toHaveBeenCalled();
  });

  test("native identity admission never bypasses the foreign organization's DB role check", async () => {
    const response = await app.request(overviewPath(foreignOrganizationId), {
      headers: { cookie: nativeCookie },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("organization administration is not authorized");
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith(deps.db, {
      organizationId: foreignOrganizationId,
      actorSubjectId: subjectId,
    });
    expect(validation).toHaveBeenCalledTimes(2);
    expect(nativeAccess).toHaveBeenCalledTimes(1);
  });

  test("the same native cookie succeeds only while the downstream role remains live", async () => {
    expect((await app.request(overviewPath(), { headers: { cookie: nativeCookie } })).status).toBe(
      200,
    );
    organizationRoles.delete(`${organizationId}/${subjectId}`);
    expect((await app.request(overviewPath(), { headers: { cookie: nativeCookie } })).status).toBe(
      403,
    );
    expect(overview).toHaveBeenCalledTimes(2);
    expect(validation).toHaveBeenCalledTimes(4);
    expect(nativeAccess).toHaveBeenCalledTimes(2);
  });

  test.each([null, "", "better-auth.session_token=invalid"])(
    "missing or invalid cookie %p cannot reach organization authority",
    async (cookie) => {
      const response = await app.request(overviewPath(missingOrganizationId), {
        headers: cookie === null ? {} : { cookie },
      });
      expect(response.status).toBe(401);
      expect(overview).not.toHaveBeenCalled();
      expect(validation).not.toHaveBeenCalled();
    },
  );

  test("a revoked canonical session fails before the organization DB port", async () => {
    sessionActive = false;
    expect(
      (
        await app.request(overviewPath(missingOrganizationId), {
          headers: { cookie: nativeCookie },
        })
      ).status,
    ).toBe(401);
    expect(validation).toHaveBeenCalledTimes(1);
    expect(overview).not.toHaveBeenCalled();
  });

  test("invalid Authorization plus a valid cookie cannot take the native fallback", async () => {
    const response = await app.request(overviewPath(missingOrganizationId), {
      headers: { authorization: "Bearer invalid", cookie: nativeCookie },
    });
    expect(response.status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
    expect(nativeAccess).toHaveBeenCalledTimes(1);
    expect(validation).toHaveBeenCalledTimes(1);
  });

  test("a cached service cannot borrow native authority after its transport header is removed", async () => {
    organizationRoles.add(`${foreignOrganizationId}/${subjectId}`);
    const cachedApp = new Hono();
    cachedApp.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    cachedApp.use("*", async (c, next) => {
      const access = await requireAccessContext(c, deps);
      expect(access.subjectId).toBe(serviceSubjectId);
      c.req.raw.headers.delete("authorization");
      await next();
    });
    registerOrganizationMembershipRoutes(cachedApp, deps);
    const response = await cachedApp.fetch(
      new Request(`https://api.example.test${overviewPath(foreignOrganizationId)}`, {
        headers: { authorization: `Bearer ${serviceToken}`, cookie: nativeCookie },
      }),
    );
    expect(response.status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(nativeAccess).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
  });

  test("a legacy human-shaped bearer cannot substitute a cookie or forged provenance", async () => {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: organizationId,
      workspaceId,
      subjectId,
      principalKind: "human_session",
      permissions: ["workspace:admin", "account:read", "account:admin"],
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    for (const target of [organizationId, foreignOrganizationId, missingOrganizationId]) {
      const response = await app.request(overviewPath(target), {
        headers: {
          authorization: `Bearer ${token}`,
          cookie: nativeCookie,
          "x-opengeni-canonical-human": "true",
          "x-opengeni-delegated-human": subjectId,
          "x-opengeni-browser-session": storedSession.session.id,
        },
      });
      expect(response.status).toBe(403);
    }
    expect(sessions).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
    expect(overview).not.toHaveBeenCalled();
  });

  test("an organization service remains exact-org and keeps its own actor despite a cookie", async () => {
    const headers = { authorization: `Bearer ${serviceToken}`, cookie: nativeCookie };
    for (const target of [foreignOrganizationId, missingOrganizationId])
      expect((await app.request(overviewPath(target), { headers })).status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
    expect((await app.request(overviewPath(), { headers })).status).toBe(200);
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith(deps.db, {
      organizationId,
      actorSubjectId: serviceSubjectId,
    });
    expect(sessions).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
  });

  test("service workspace admin does not imply a literal account permission", async () => {
    servicePermissions = ["workspace:admin", "connections:write"];
    expect(
      (
        await app.request(overviewPath(), {
          headers: { authorization: `Bearer ${serviceToken}`, cookie: nativeCookie },
        })
      ).status,
    ).toBe(403);
    expect(sessions).not.toHaveBeenCalled();
    expect(overview).not.toHaveBeenCalled();
  });

  test("typed foreign scope never falls through to the real native cookie", async () => {
    for (const target of [foreignOrganizationId, missingOrganizationId]) {
      expect(
        (
          await app.fetch(
            delegatedRequest(overviewPath(target), ["account:read"], { cookie: true }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.fetch(
            delegatedRequest(overviewPath(target), ["account:read"], {
              organization: target,
              cookie: true,
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect(sessions).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
    expect(overview).not.toHaveBeenCalled();
  });

  test("typed own-org account read works without a cookie or unrelated workspace", async () => {
    live.workspaceGrants = [];
    const response = await app.fetch(delegatedRequest(overviewPath(), ["account:read"]));
    expect(response.status).toBe(200);
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(profiles).toHaveBeenCalledWith(deps.db, [userId]);
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith(deps.db, {
      organizationId,
      actorSubjectId: subjectId,
    });
    expect(sessions).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
  });

  test.each(
    (["workspace:admin", "connections:write", "account:admin"] as Permission[]).map(
      (permission) => ({ permissions: [permission] }),
    ),
  )(
    "typed read requires literal account:read, not %p or a native cookie",
    async ({ permissions }) => {
      expect(
        (await app.fetch(delegatedRequest(overviewPath(), permissions, { cookie: true }))).status,
      ).toBe(403);
      expect(sessions).not.toHaveBeenCalled();
      expect(overview).not.toHaveBeenCalled();
    },
  );

  test("typed account permission must also remain live at the resolver and DB role port", async () => {
    const request = () => delegatedRequest(overviewPath(), ["account:read"], { cookie: true });
    live.accountGrants[0]!.permissions = ["account:admin"];
    expect((await app.fetch(request())).status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
    live.accountGrants[0]!.permissions = ["account:read", "account:admin"];
    organizationRoles.delete(`${organizationId}/${subjectId}`);
    expect((await app.fetch(request())).status).toBe(403);
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith(deps.db, {
      organizationId,
      actorSubjectId: subjectId,
    });
    expect(sessions).not.toHaveBeenCalled();
  });

  test("typed connection administration retains both the literal account ceiling and connection permission", async () => {
    const path = `/fixture/connections/${organizationId}`;
    for (const permissions of [
      ["connections:write"],
      ["workspace:admin", "connections:write"],
      ["account:read"],
    ] as Permission[][])
      expect((await app.fetch(delegatedRequest(path, permissions, { cookie: true }))).status).toBe(
        403,
      );
    expect(
      (await app.fetch(delegatedRequest(path, ["account:read", "connections:write"]))).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          delegatedRequest(path, ["account:read", "connections:write"], {
            cookie: true,
            method: "POST",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          delegatedRequest(path, ["account:admin", "connections:write"], { method: "POST" }),
        )
      ).status,
    ).toBe(200);
    expect(sessions).not.toHaveBeenCalled();
    expect(validation).not.toHaveBeenCalled();
  });

  test("typed account:read cannot authorize an organization mutation even alongside its owner's cookie", async () => {
    const path = `/v1/organizations/${organizationId}`;
    const body = {
      name: "New organization name",
      expectedUpdatedAt: timestamp,
      operationId: "66666666-6666-4666-8666-666666666666",
    };
    const raw = delegatedRequest(path, ["account:read"], {
      cookie: true,
      method: "PATCH",
      body,
    });
    expect((await app.fetch(raw)).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    expect(
      (await app.fetch(delegatedRequest(path, ["account:admin"], { method: "PATCH", body })))
        .status,
    ).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(deps.db, {
      organizationId,
      actorSubjectId: subjectId,
      ...body,
    });
    expect(sessions).not.toHaveBeenCalled();
  });
});
