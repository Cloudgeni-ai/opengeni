import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type AccessContext,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  accessGrantAuthorizationFromContext,
  isVerifiedDelegatedHumanAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  requireAccessContext,
  requireAccessGrantAuthorization,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as managedSession from "../../../packages/core/src/managed-session";
import {
  assertPersonalConnectionOwnerPrincipal,
  requireLegacyOAuthActor,
} from "../src/connection-ownership";
import { registerSlackInteractionRoutes } from "../src/integrations/slack-interactions";
import {
  registerCompanyProfileRoutes,
  requireDirectAccountAdmin,
} from "../src/routes/company-profile";
import { registerSlackTaskPolicyRoutes } from "../src/routes/slack-task-policy";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const targetWorkspaceId = "33333333-3333-4333-8333-333333333333";
const keyId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:native-owner";
const secret = "phase2-human-route-test-secret";
const permissions: Permission[] = [
  "account:admin",
  "workspace:read",
  "workspace:admin",
  "connections:write",
];
type Actor =
  | "native"
  | "local"
  | "delegated"
  | "organization-service"
  | "legacy-human"
  | "legacy-service";

let live: AccessContext;
const restores: (() => void)[] = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeEach(() => {
  live = {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId, subjectId, role: "owner", permissions: [...permissions] }],
    workspaceGrants: [
      {
        accountId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: [...permissions],
      },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  track(
    spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: "native-owner", name: "Native owner", email: "owner@example.test" },
    ]),
  );
  track(
    spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () => structuredClone(live)),
  );
  track(
    spyOn(db, "bootstrapWorkspace").mockImplementation(async () => ({
      ...structuredClone(live),
      mode: "local",
      subjectId: "dev",
      accountGrants: live.accountGrants.map((grant) => ({ ...grant, subjectId: "dev" })),
      workspaceGrants: live.workspaceGrants.map((grant) => ({ ...grant, subjectId: "dev" })),
    })),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  track(
    spyOn(db, "withAccountRls").mockImplementation(async (database, _accountId, callback) =>
      callback(database),
    ),
  );
  track(
    spyOn(db, "getWorkspace").mockResolvedValue({
      id: targetWorkspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  track(
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  track(
    spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      id: keyId,
      accountId,
      workspaceId: null,
      credentialKind: "organization",
      permissions,
      name: "Organization service",
    } as never),
  );
  track(
    spyOn(managedSession, "getManagedSession").mockImplementation(async (context) =>
      context.req.header("cookie") === "native-cookie=fixture"
        ? ({
            session: { id: "native-session" },
            user: {
              id: "native-owner",
              name: "Native owner",
              email: "owner@example.test",
              emailVerified: true,
            },
          } as never)
        : null,
    ),
  );
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function deps(actor: Actor): ApiRouteDeps {
  return {
    db: {} as db.Database,
    settings: testSettings({
      productAccessMode: actor === "local" ? "local" : "managed",
      delegationSecret: secret,
    }),
    managedAuth: actor === "native" || actor === "delegated" ? {} : null,
  } as ApiRouteDeps;
}

async function request(
  actor: Actor,
  path: string,
  method = "GET",
  body?: unknown,
  delegatedPermissions: Permission[] = permissions,
  workspaceScope: DelegatedHumanAuthorization["workspaceScope"] = { kind: "all" },
): Promise<Request> {
  const headers = new Headers();
  if (actor === "native" || actor === "delegated") headers.set("cookie", "native-cookie=fixture");
  if (actor === "organization-service")
    headers.set("authorization", "Bearer organization-service-fixture");
  if (actor === "legacy-human" || actor === "legacy-service") {
    headers.set(
      "authorization",
      `Bearer ${await signDelegatedAccessToken(secret, {
        accountId,
        workspaceId,
        subjectId,
        permissions,
        principalKind: actor === "legacy-human" ? "human_session" : "service",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`,
    );
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const result = new Request(`http://test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (actor === "delegated") {
    stampDelegatedHumanAuthorization(result, {
      organizationId: accountId,
      subjectId,
      permissions: delegatedPermissions,
      workspaceScope,
    });
  }
  return result;
}

function app(actor: Actor): Hono {
  const harness = new Hono();
  harness.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const services = deps(actor);
  registerCompanyProfileRoutes(harness, services);
  registerSlackTaskPolicyRoutes(harness, services);
  registerSlackInteractionRoutes(harness, services);
  return harness;
}

describe("Phase2 shared policy route authorization", () => {
  test.each(["native", "local", "delegated", "organization-service"] as const)(
    "admits verified %s authority and rejects cloned authorization",
    async (actor) => {
      const harness = new Hono().get("/authorization", async (context) => {
        const authorization = await requireAccessGrantAuthorization(
          context,
          deps(actor),
          workspaceId,
        );
        expect(isVerifiedDelegatedHumanAuthorization(authorization)).toBe(actor === "delegated");
        expect(isVerifiedOrganizationServiceAuthorization(authorization)).toBe(
          actor === "organization-service",
        );
        requireDirectAccountAdmin(authorization);
        expect(() => requireDirectAccountAdmin({ ...authorization })).toThrow();
        return context.json({ ok: true });
      });
      expect((await harness.fetch(await request(actor, "/authorization"))).status).toBe(200);
    },
  );

  test.each(["native", "local", "delegated", "organization-service"] as const)(
    "%s reaches validation on every shared-policy mutation route",
    async (actor) => {
      const harness = app(actor);
      for (const [method, suffix] of [
        ["PUT", "/company-profile"],
        ["POST", "/company-profile/rollback"],
        ["POST", `/company-profile/revisions/${keyId}/activate`],
        ["PATCH", "/company-profile/agent-policy"],
        ["PUT", "/slack-task-policy"],
      ]) {
        const response = await harness.fetch(
          await request(actor, `/v1/workspaces/${workspaceId}${suffix}`, method, {}),
        );
        expect(response.status, await response.clone().text()).toBe(422);
      }
    },
  );

  test.each(["legacy-human", "legacy-service"] as const)(
    "refuses %s tokens despite human-shaped subjects and admin claims",
    async (actor) => {
      const harness = app(actor);
      for (const [method, suffix] of [
        ["PUT", "/company-profile"],
        ["POST", "/company-profile/rollback"],
        ["POST", `/company-profile/revisions/${keyId}/activate`],
        ["GET", "/company-profile/agent-policy"],
        ["PATCH", "/company-profile/agent-policy"],
        ["PUT", "/slack-task-policy"],
      ]) {
        const response = await harness.fetch(
          await request(
            actor,
            `/v1/workspaces/${workspaceId}${suffix}`,
            method,
            method === "GET" ? undefined : {},
          ),
        );
        expect(response.status).toBe(403);
      }
    },
  );

  test("does not substitute metadata or a constructed human context for verified authority", () => {
    for (const metadata of [undefined, {}, { delegated: true }, { delegated: false }]) {
      const grant: AccessGrant = { ...live.workspaceGrants[0]!, ...(metadata ? { metadata } : {}) };
      const authorization = accessGrantAuthorizationFromContext(
        { ...live, workspaceGrants: [grant] },
        grant,
      );
      expect(() => requireDirectAccountAdmin(authorization)).toThrow(
        "Verified user or organization authority required",
      );
    }
    for (const override of [
      { contextIntegrity: false },
      { authenticatedSubjectId: "user:other" },
      { canonicalManagedHumanSession: true },
      { canonicalLocalHumanSession: true },
    ]) {
      const authorization = accessGrantAuthorizationFromContext(live, live.workspaceGrants[0]!);
      expect(() => requireDirectAccountAdmin({ ...authorization, ...override })).toThrow();
    }
  });

  test("delegation still needs live account authority and workspace admin for Slack policy", async () => {
    live.accountGrants[0]!.permissions = ["account:read"];
    const harness = app("delegated");
    const profile = await harness.fetch(
      await request("delegated", `/v1/workspaces/${workspaceId}/company-profile`, "PUT", {}),
    );
    expect(profile.status).toBe(403);
    expect(await profile.text()).toContain("missing permission: account:admin");
    live.workspaceGrants[0]!.permissions = ["workspace:read"];
    const policy = await harness.fetch(
      await request("delegated", `/v1/workspaces/${workspaceId}/slack-task-policy`, "PUT", {}),
    );
    expect(policy.status).toBe(403);
    expect(await policy.text()).toContain("workspace:admin");
  });

  test.each(["native", "local", "delegated"] as const)(
    "%s account authority never expands workspace admin into literal account admin",
    async (actor) => {
      live.accountGrants[0]!.permissions = ["account:read", "workspace:admin"];
      const response = await app(actor).fetch(
        await request(actor, `/v1/workspaces/${workspaceId}/company-profile`, "PUT", {}),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("missing permission: account:admin");
    },
  );

  test("typed delegation requires literal account admin on the proof ceiling too", async () => {
    const response = await app("delegated").fetch(
      await request("delegated", `/v1/workspaces/${workspaceId}/company-profile`, "PUT", {}, [
        "workspace:read",
        "workspace:admin",
      ]),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("missing permission: account:admin");
  });

  test("verified service admission leaves the database owner lifecycle authoritative", async () => {
    const lifecycle = track(
      spyOn(db, "getCompanyProfileAgentPolicy").mockRejectedValue(
        new db.CompanyProfileAgentPolicyError(
          "authority_unavailable",
          "An active organization owner is required",
        ),
      ),
    );
    const response = await app("organization-service").fetch(
      await request(
        "organization-service",
        `/v1/workspaces/${workspaceId}/company-profile/agent-policy`,
      ),
    );
    expect(response.status).toBe(403);
    expect(lifecycle.mock.calls[0]![1]).toMatchObject({
      actorSubjectId: `api_key:${keyId}`,
      accountId,
      workspaceId,
    });
  });
});

describe("Phase2 Slack identity consent and delegated request management", () => {
  const base = `/v1/workspaces/${targetWorkspaceId}/integrations/slack/user-link-intents`;
  const paths = [
    ["POST", base],
    ["GET", `${base}/${keyId}`],
    ["POST", `${base}/${keyId}/request-access`],
    ["POST", `${base}/${keyId}/cancel`],
  ] as const;

  test.each([
    "delegated",
    "local",
    "organization-service",
    "legacy-human",
    "legacy-service",
  ] as const)(
    "identity-binding create rejects %s before link storage or payload validation",
    async (actor) => {
      const harness = app(actor);
      const prepare = track(spyOn(db, "prepareSlackUserLinkAccessRequest"));
      const cookieLookup = track(spyOn(managedSession, "getManagedSession"));
      const raw = await request(actor, base, "POST", {});
      if (actor === "delegated") {
        expect(raw.headers.has("authorization")).toBe(false);
        expect(raw.headers.has("cookie")).toBe(true);
      }
      const response = await harness.fetch(raw);
      expect(response.status).toBe(actor === "delegated" ? 403 : 401);
      expect(prepare).not.toHaveBeenCalled();
      if (actor === "delegated") expect(cookieLookup).not.toHaveBeenCalled();
    },
  );

  test.each(["organization-service", "legacy-human", "legacy-service"] as const)(
    "request management rejects %s even with human-shaped identity claims",
    async (actor) => {
      const completion = track(
        spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
      );
      const access = track(spyOn(db, "requestSlackUserLinkWorkspaceAccess"));
      const cancel = track(spyOn(db, "cancelSlackUserLinkAccessRequest"));
      const harness = app(actor);
      for (const [method, path] of paths.slice(1)) {
        const response = await harness.fetch(
          await request(actor, path, method, method === "GET" ? undefined : {}),
        );
        expect(response.status).toBe(actor === "organization-service" ? 401 : 403);
      }
      expect(completion).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  test.each(["native", "local", "delegated"] as const)(
    "verified %s may inspect, request access, and cancel only its own Slack request",
    async (actor) => {
      const completion = track(
        spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
      );
      const access = track(
        spyOn(db, "requestSlackUserLinkWorkspaceAccess").mockRejectedValue(
          new db.SlackUserLinkAccessPersistenceError("state_conflict"),
        ),
      );
      const cancel = track(
        spyOn(db, "cancelSlackUserLinkAccessRequest").mockRejectedValue(
          new db.SlackUserLinkAccessPersistenceError("state_conflict"),
        ),
      );
      const cookieLookup = track(spyOn(managedSession, "getManagedSession"));
      const harness = app(actor);
      const ownSubject = actor === "local" ? "dev" : subjectId;
      for (const [method, path] of paths.slice(1)) {
        const raw = await request(
          actor,
          path,
          method,
          method === "GET" ? undefined : { expectedVersion: 1, idempotencyKey: keyId },
        );
        if (actor === "delegated") {
          raw.headers.delete("cookie");
          expect(raw.headers.has("authorization")).toBe(false);
        }
        expect((await harness.fetch(raw)).status).toBe(method === "GET" ? 400 : 409);
      }
      expect(completion.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        subjectId: ownSubject,
      });
      expect(access.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        actorSubjectId: ownSubject,
      });
      expect(cancel.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        actorSubjectId: ownSubject,
      });
      if (actor === "delegated") expect(cookieLookup).not.toHaveBeenCalled();
    },
  );

  test("delegation with no live grant cannot fall back to an attached native cookie", async () => {
    live.workspaceGrants = [];
    const completion = track(
      spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
    );
    const access = track(spyOn(db, "requestSlackUserLinkWorkspaceAccess"));
    const cancel = track(spyOn(db, "cancelSlackUserLinkAccessRequest"));
    const harness = app("delegated");
    for (const [method, path] of paths) {
      const raw = await request("delegated", path, method, method === "GET" ? undefined : {});
      expect(raw.headers.has("cookie")).toBe(true);
      expect((await harness.fetch(raw)).status).toBe(403);
    }
    expect(completion).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test.each(["outside-workspace-scope", "other-organization", "missing-workspace"] as const)(
    "delegated Slack management rejects %s before reading or mutating a request",
    async (scopeFailure) => {
      if (scopeFailure === "other-organization") {
        track(
          spyOn(db, "getWorkspace").mockResolvedValue({
            id: targetWorkspaceId,
            accountId: keyId,
            kind: "shared",
          } as never),
        );
      } else if (scopeFailure === "missing-workspace") {
        track(spyOn(db, "getWorkspace").mockResolvedValue(null));
      }
      const completion = track(
        spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
      );
      const access = track(spyOn(db, "requestSlackUserLinkWorkspaceAccess"));
      const cancel = track(spyOn(db, "cancelSlackUserLinkAccessRequest"));
      const harness = app("delegated");
      for (const [method, path] of paths.slice(1)) {
        const raw = await request(
          "delegated",
          path,
          method,
          method === "GET" ? undefined : {},
          permissions,
          scopeFailure === "outside-workspace-scope"
            ? { kind: "selected", workspaceIds: [workspaceId] }
            : { kind: "all" },
        );
        expect((await harness.fetch(raw)).status).toBe(403);
      }
      expect(completion).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  test("selected delegation can manage an in-scope request without target membership", async () => {
    const completion = track(
      spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
    );
    const scope = track(spyOn(db, "withAccountRls"));
    const raw = await request("delegated", paths[1][1], "GET", undefined, permissions, {
      kind: "selected",
      workspaceIds: [workspaceId, targetWorkspaceId],
    });
    raw.headers.delete("cookie");
    expect((await app("delegated").fetch(raw)).status).toBe(400);
    expect(scope.mock.calls[0]![1]).toBe(accountId);
    expect(completion.mock.calls[0]![1]).toMatchObject({
      workspaceId: targetWorkspaceId,
      subjectId,
    });
  });

  test("request cloning does not transplant delegated Slack authorization", async () => {
    const completion = track(
      spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
    );
    const raw = await request("delegated", paths[1][1]);
    raw.headers.delete("cookie");
    const harness = app("delegated");
    expect((await harness.fetch(raw.clone())).status).toBe(401);
    expect(completion).not.toHaveBeenCalled();
    expect((await harness.fetch(raw)).status).toBe(400);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])(
    "native cookie can request target access without target membership (organization setup: %s)",
    async (provisioned) => {
      if (!provisioned) {
        live.accountGrants = [];
        live.workspaceGrants = [];
        live.defaultAccountId = null;
        live.defaultWorkspaceId = null;
      }
      const completion = track(
        spyOn(db, "completeSlackUserLinkAccessIfGranted").mockResolvedValue(null),
      );
      const access = track(
        spyOn(db, "requestSlackUserLinkWorkspaceAccess").mockRejectedValue(
          new db.SlackUserLinkAccessPersistenceError("state_conflict"),
        ),
      );
      const cancel = track(
        spyOn(db, "cancelSlackUserLinkAccessRequest").mockRejectedValue(
          new db.SlackUserLinkAccessPersistenceError("state_conflict"),
        ),
      );
      const harness = app("native");
      const get = await harness.fetch(await request("native", paths[1][1]));
      expect(get.status).toBe(400);
      expect(completion.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        subjectId,
      });
      const prepare = await harness.fetch(
        await request("native", base, "POST", { linkToken: "invalid" }),
      );
      expect(prepare.status).toBe(400);
      const payload = { expectedVersion: 1, idempotencyKey: keyId };
      for (const path of [paths[2][1], paths[3][1]]) {
        expect((await harness.fetch(await request("native", path, "POST", payload))).status).toBe(
          409,
        );
      }
      expect(access.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        actorSubjectId: subjectId,
      });
      expect(cancel.mock.calls[0]![1]).toMatchObject({
        workspaceId: targetWorkspaceId,
        actorSubjectId: subjectId,
      });
    },
  );

  test("request-local service context without Authorization cannot borrow native cookie proof", async () => {
    const serviceGrant = { ...live.workspaceGrants[0]!, principalKind: "service" as const };
    const context = { ...live, workspaceGrants: [serviceGrant] };
    // Inject only a context shape, never a cookie resolver stamp.
    const core = await import("@opengeni/core");
    track(spyOn(core, "requireAccessContext").mockResolvedValue(context));
    const harness = app("native");
    for (const [method, path] of paths) {
      const raw = await request("native", path, method, method === "GET" ? undefined : {});
      expect((await harness.fetch(raw)).status).toBe(403);
    }
  });

  test.each(["organization-service", "legacy-human", "legacy-service"] as const)(
    "cached %s authentication without Authorization cannot borrow an attached native cookie",
    async (actor) => {
      const services = deps(actor);
      services.managedAuth = deps("native").managedAuth ?? null;
      const harness = new Hono();
      harness.use("*", async (context, next) => {
        const authorization = await requireAccessGrantAuthorization(context, services, workspaceId);
        expect(isVerifiedOrganizationServiceAuthorization(authorization)).toBe(
          actor === "organization-service",
        );
        expect(await requireAccessContext(context, services)).toBe(
          await requireAccessContext(context, services),
        );
        context.req.raw.headers.delete("authorization");
        context.req.raw.headers.set("cookie", "native-cookie=fixture");
        await next();
      });
      registerSlackInteractionRoutes(harness, services);
      for (const [method, path] of paths) {
        const raw = await request(actor, path, method, method === "GET" ? undefined : {});
        expect((await harness.fetch(raw)).status).toBe(403);
        expect(raw.headers.has("authorization")).toBe(false);
      }
    },
  );
});

describe("Phase2 legacy OAuth browser actor", () => {
  test.each([
    "native",
    "local",
    "delegated",
    "organization-service",
    "legacy-human",
    "legacy-service",
  ] as const)("%s provider-flow start requires verified owning-person proof", async (actor) => {
    const harness = new Hono().get("/authorization", async (context) => {
      const authorization = await requireAccessGrantAuthorization(
        context,
        deps(actor),
        workspaceId,
      );
      if (actor === "native" || actor === "local" || actor === "delegated") {
        // Noninteractive ownership admission remains independent of OAuth.
        expect(() => assertPersonalConnectionOwnerPrincipal(authorization)).not.toThrow();
      }
      if (actor === "native" || actor === "local" || actor === "delegated") {
        expect(() => requireLegacyOAuthActor(authorization)).not.toThrow();
      } else {
        expect(() => requireLegacyOAuthActor(authorization)).toThrow(
          "Verified owning-user authority required",
        );
      }
      expect(() => requireLegacyOAuthActor({ ...authorization })).toThrow();
      return context.json({ ok: true });
    });
    expect((await harness.fetch(await request(actor, "/authorization"))).status).toBe(200);
  });

  test("verified external actors retain the provider-specific continuation refusal", async () => {
    track(
      spyOn(db, "ensureExternalIdentity").mockResolvedValue({
        id: keyId,
        accountId,
        subjectId: `external_user:${keyId}`,
        source: "host",
        externalId: "external-person",
        personalWorkspaceId: workspaceId,
        organizationMembershipId: targetWorkspaceId,
        authorizationRevision: 1,
      } as never),
    );
    const harness = new Hono().get("/authorization", async (context) => {
      const authorization = await requireAccessGrantAuthorization(
        context,
        deps("organization-service"),
        workspaceId,
      );
      expect(authorization.canonicalManagedHumanSession).toBe(false);
      expect(isVerifiedOrganizationServiceAuthorization(authorization)).toBe(false);
      try {
        requireLegacyOAuthActor(authorization);
        throw new Error("external OAuth actor was admitted");
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPException);
        expect((error as HTTPException).status).toBe(422);
        expect((error as Error).message).toContain("external-user OAuth continuation");
      }
      return context.json({ ok: true });
    });
    const raw = await request("organization-service", "/authorization");
    raw.headers.set(
      "x-opengeni-external-actor",
      encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { source: "host", externalId: "external-person" },
        }),
      ),
    );
    expect((await harness.fetch(raw)).status).toBe(200);
  });
});
