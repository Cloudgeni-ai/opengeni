import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AccessContext, Permission } from "@opengeni/contracts";
import {
  accessGrantAuthorizationFromContext,
  requireAccessGrantAuthorization,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  requireManagedHumanRouteIdentity,
  requireDelegableHumanRouteAuthorization,
  requireNonCookieOrSameOriginMutation,
  requireOrganizationRouteAdministrator,
  requirePersonPresentRouteAuthorization,
  requireUserOrOrganizationRouteAuthorization,
} from "../src/http/human-route-authorization";
import { requireSameOriginBrowserMutation } from "../src/routes/codex";
import {
  prepareWorkspaceToolGateway,
  requireWorkspaceToolGatewayAuthorization,
} from "../src/workspace-tool-gateway";
import {
  registerOrganizationRecoveryRoutes,
  type OrganizationRecoveryRouteServices,
} from "../src/routes/organization-recovery";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const subjectId = "user:consenting-person";

function nativeAccess(): AccessContext {
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

describe("verified human route gates", () => {
  let live: AccessContext;
  let profiles: ReturnType<typeof spyOn<typeof db, "getManagedUserProfilesByIds">>;
  let native: ReturnType<typeof spyOn<typeof db, "ensureManagedAccessForUser">>;
  let deps: ApiRouteDeps;
  beforeEach(() => {
    live = nativeAccess();
    profiles = spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: "consenting-person", name: "Person", email: "person@example.test" },
    ]);
    native = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () =>
      structuredClone(live),
    );
    deps = {
      db: {} as db.Database,
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl: "https://console.example.test",
      }),
    } as ApiRouteDeps;
  });
  afterEach(() => {
    profiles.mockRestore();
    native.mockRestore();
  });

  function request(
    path: string,
    permissions: Permission[] = ["workspace:admin", "account:read", "account:admin"],
    method = "POST",
  ): Request {
    const raw = new Request(`https://api.example.test${path}`, { method });
    const proof: DelegatedHumanAuthorization = {
      organizationId,
      subjectId,
      permissions,
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
    };
    stampDelegatedHumanAuthorization(raw, proof);
    return raw;
  }

  function harness(): Hono {
    const app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    app.post("/csrf", async (c) => {
      await requireNonCookieOrSameOriginMutation(c, deps);
      return c.text("ok");
    });
    app.post("/browser", (c) => {
      requireSameOriginBrowserMutation(c, deps);
      return c.text("ok");
    });
    app.post("/organization/:organizationId", async (c) => {
      await requireOrganizationRouteAdministrator(
        c,
        deps,
        c.req.param("organizationId"),
        "account:admin",
      );
      return c.text("ok");
    });
    app.post("/identity", async (c) => {
      const identity = await requireManagedHumanRouteIdentity(c, deps);
      return c.json(identity);
    });
    app.post("/organization-connections/:organizationId", async (c) => {
      await requireOrganizationRouteAdministrator(
        c,
        deps,
        c.req.param("organizationId"),
        "connections:write",
      );
      return c.text("ok");
    });
    app.post("/presence", async (c) => {
      requirePersonPresentRouteAuthorization(
        await requireAccessGrantAuthorization(c, deps, workspaceId),
      );
      return c.text("ok");
    });
    app.post("/delegable-decision", async (c) => {
      requireDelegableHumanRouteAuthorization(
        await requireAccessGrantAuthorization(c, deps, workspaceId),
      );
      return c.text("ok");
    });
    app.post("/shared-policy", async (c) => {
      requireUserOrOrganizationRouteAuthorization(
        await requireAccessGrantAuthorization(c, deps, workspaceId),
      );
      return c.text("ok");
    });
    app.post("/tools", async (c) => {
      requireWorkspaceToolGatewayAuthorization(
        await requireAccessGrantAuthorization(c, deps, workspaceId),
      );
      return c.text("ok");
    });
    return app;
  }

  test("a verified in-process person needs no forged Origin for CSRF-only transport", async () => {
    expect((await harness().fetch(request("/csrf"))).status).toBe(200);
  });
  test("a proof does not become browser presence even with same-origin headers", async () => {
    const raw = request("/browser");
    raw.headers.set("origin", "https://console.example.test");
    raw.headers.set("sec-fetch-site", "same-origin");
    raw.headers.set("content-type", "application/json");
    expect((await harness().fetch(raw)).status).toBe(403);
    expect((await harness().fetch(request("/presence"))).status).toBe(403);
  });
  test("headers cannot stamp delegation or bypass strict browser CSRF", async () => {
    const response = await harness().request("https://api.example.test/browser", {
      method: "POST",
      headers: { authorization: "Bearer unverified", "x-opengeni-delegated-human": subjectId },
    });
    expect(response.status).toBe(403);
  });
  test("organization administration stays inside exact organization and literal account ceiling", async () => {
    expect((await harness().fetch(request(`/organization/${organizationId}`))).status).toBe(200);
    expect((await harness().fetch(request(`/organization/${otherOrganizationId}`))).status).toBe(
      403,
    );
    expect(
      (await harness().fetch(request(`/organization/${organizationId}`, ["workspace:admin"])))
        .status,
    ).toBe(403);
    live.accountGrants[0]!.permissions = ["account:read"];
    expect(
      (await harness().fetch(request(`/organization/${organizationId}`, ["account:admin"]))).status,
    ).toBe(403);
  });
  test("identity resolves the native person, without fabricating session fields or verified email", async () => {
    const response = await harness().fetch(request("/identity"));
    expect(response.status).toBe(200);
    const identity = await response.json();
    expect(identity.subjectId).toBe(subjectId);
    expect(identity.user.id).toBe("consenting-person");
    expect(identity.user.emailVerified).toBe(false);
    expect(identity.session).toBeUndefined();
    expect(identity.browserSessionHash).toBeUndefined();
  });

  test("organization connection management requires a literal account ceiling as well as connection permission", async () => {
    const path = `/organization-connections/${organizationId}`;
    expect((await harness().fetch(request(path, ["workspace:admin"]))).status).toBe(403);
    expect((await harness().fetch(request(path, ["connections:write"]))).status).toBe(403);
    expect(
      (await harness().fetch(request(path, ["account:admin", "connections:write"]))).status,
    ).toBe(200);
  });

  test("literal account-only administration does not require an unrelated workspace grant", async () => {
    live.workspaceGrants = [];
    const path = `/organization/${organizationId}`;
    expect((await harness().fetch(request(path, ["account:admin"]))).status).toBe(200);
    expect((await harness().fetch(request(path, ["workspace:admin"]))).status).toBe(403);
    live.accountGrants[0]!.permissions = ["account:read"];
    expect((await harness().fetch(request(path, ["account:admin"]))).status).toBe(403);
  });
  test("delegated shared policy and tool access are allowed without browser approval authority", async () => {
    expect((await harness().fetch(request("/shared-policy"))).status).toBe(200);
    expect((await harness().fetch(request("/tools"))).status).toBe(200);
    live.workspaceGrants = [];
    expect((await harness().fetch(request("/tools"))).status).toBe(403);
  });

  test("a delegated gateway authorization cannot be transplanted onto another verified request", async () => {
    const app = new Hono();
    app.post("/originating-request", async (origin) => {
      const authorization = await requireAccessGrantAuthorization(
        origin,
        deps,
        workspaceId,
        "workspace:read",
      );
      const other = new Hono();
      other.onError((error) => {
        if (error instanceof HTTPException) return error.getResponse();
        throw error;
      });
      other.post("/other-request", async (context) => {
        await prepareWorkspaceToolGateway(deps, authorization, context);
        return context.text("unexpected gateway access");
      });
      return other.fetch(request("/other-request"));
    });
    const response = await app.fetch(request("/originating-request"));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("verified request");
  });

  test("a verified consenting person may make user decisions without acquiring browser-authentication proof", async () => {
    expect((await harness().fetch(request("/delegable-decision"))).status).toBe(200);
    expect((await harness().fetch(request("/presence"))).status).toBe(403);
    const context = nativeAccess();
    expect(() =>
      requireDelegableHumanRouteAuthorization(
        accessGrantAuthorizationFromContext(context, context.workspaceGrants[0]!),
      ),
    ).toThrow();
  });

  test("delegated recovery status is scoped and never fabricates a browser session, fresh-auth proof or mutation capabilities", async () => {
    let captured: unknown;
    const app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerOrganizationRecoveryRoutes(app, deps, {
      getOrganizationRecoveryOverview: async (_db, input) => {
        captured = input;
        return {
          organizationId,
          availability: "recovery_unavailable",
          unavailableReason: "no_policy",
          recentReauthenticationAt: null,
          eligibleMembers: [],
          policy: null,
          operation: null,
          capabilities: {
            configure: true,
            accept: false,
            disable: false,
            start: false,
            approve: false,
            cancel: false,
            execute: false,
          },
        };
      },
    } as OrganizationRecoveryRouteServices);
    const path = `/v1/organizations/${organizationId}/recovery`;
    const response = await app.fetch(request(path, ["account:read"], "GET"));
    expect(response.status).toBe(200);
    expect(captured).toEqual({
      organizationId,
      actorSubjectId: subjectId,
      actorAuthUserId: "consenting-person",
      actorAuthSessionId: null,
      actorFence: null,
    });
    const result = await response.json();
    expect(result.recentReauthenticationAt).toBeNull();
    expect(Object.values(result.capabilities).every((value) => value === false)).toBe(true);
    expect(
      (
        await app.fetch(
          request(`/v1/organizations/${otherOrganizationId}/recovery`, ["account:read"], "GET"),
        )
      ).status,
    ).toBe(403);
    expect((await app.fetch(request(`${path}/operations`))).status).toBe(401);
  });
  test("human-shaped context and copied booleans cannot manufacture route authority", () => {
    const context = nativeAccess();
    const authorization = accessGrantAuthorizationFromContext(context, context.workspaceGrants[0]!);
    expect(() => requireUserOrOrganizationRouteAuthorization(authorization)).toThrow();
    expect(() =>
      requirePersonPresentRouteAuthorization({
        ...authorization,
        canonicalManagedHumanSession: true,
      }),
    ).toThrow();
    expect(() => requireWorkspaceToolGatewayAuthorization(authorization)).toThrow();
  });
});
