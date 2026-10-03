import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  ApiKey,
  SandboxRecoveryRequest,
  Workspace,
  signDelegatedAccessToken,
  type AccessContext,
  type Permission,
} from "@opengeni/contracts";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  accessGrantAuthorizationFromContext,
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  isVerifiedDelegatedHumanAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  requireAccessContext,
  requireAccessGrantAuthorization,
  requireAccountAdminAuthorizationStamp,
  requireFreshAccessGrant,
  requireResolvedAccessGrantAuthorization,
  requireVerifiedDelegatedHumanContext,
  requireWorkspaceSettingsGrant,
  stampDelegatedHumanAuthorization,
  verifiedDelegatedHumanAuthorizationForRequest,
  type AccessDeps,
  type AccessGrantAuthorization,
  type DelegatedHumanAuthorization,
} from "../src/access";
import {
  requireCanonicalManagedHuman,
  requireVerifiedOwningUser,
} from "../src/application/session-tenancy";
import {
  consentManagedHumanSandboxRecovery,
  getManagedHumanSandboxRecovery,
} from "../src/application/sandbox-recovery";
import { personalConnectionDelegationSourceForGrant } from "../src/domain/personal-connection-delegations";
import { isScheduledTaskAccessRefreshHuman } from "../src/domain/scheduled-task-access";
import * as sessionAuthorization from "../src/session-authorization";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const secondWorkspaceId = "33333333-3333-4333-8333-333333333333";
const otherOrganizationId = "44444444-4444-4444-8444-444444444444";
const otherWorkspaceId = "55555555-5555-4555-8555-555555555555";
const userId = "native-person";
const subjectId = `user:${userId}`;
const delegationSecret = "delegated-human-proof-test-secret";

function nativeAccess(): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [organizationId, otherOrganizationId].map((accountId) => ({
      accountId,
      subjectId,
      permissions: ["account:read"],
    })),
    workspaceGrants: [workspaceId, secondWorkspaceId, otherWorkspaceId].map((id) => ({
      accountId: id === otherWorkspaceId ? otherOrganizationId : organizationId,
      workspaceId: id,
      subjectId,
      principalKind: "human_session",
      permissions: ["workspace:read", "sessions:read", "sessions:create", "connections:write"],
    })),
    defaultAccountId: organizationId,
    defaultWorkspaceId: workspaceId,
  };
}

function bounds(overrides: Partial<DelegatedHumanAuthorization> = {}): DelegatedHumanAuthorization {
  return {
    organizationId,
    subjectId,
    permissions: ["workspace:admin", "secrets:read"],
    workspaceScope: { kind: "all" },
    ...overrides,
  };
}

function stampedRequest(
  overrides: Partial<DelegatedHumanAuthorization> = {},
  targetWorkspaceId = workspaceId,
  headers?: HeadersInit,
): Request {
  const request = new Request(`http://test/workspaces/${targetWorkspaceId}`, { headers });
  stampDelegatedHumanAuthorization(request, bounds(overrides));
  return request;
}

function recoveryRequest(sessionId: string): SandboxRecoveryRequest {
  return SandboxRecoveryRequest.parse({
    operationId: crypto.randomUUID(),
    acceptHistoricalCheckpoint: true,
    selection: {
      version: 1,
      sessionId,
      sandboxGroupId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      routeEpoch: 0,
      authorityEpoch: 1,
      leaseEpoch: 0,
      workspaceGeneration: 1,
      archiveGeneration: 1,
      artifactId: crypto.randomUUID(),
      revision: "checkpoint-revision",
      capturedAt: "2026-10-02T00:00:00.000Z",
    },
  });
}

describe("request-local verified delegated native human", () => {
  let live: AccessContext;
  let profiles: ReturnType<typeof spyOn<typeof db, "getManagedUserProfilesByIds">>;
  let native: ReturnType<typeof spyOn<typeof db, "ensureManagedAccessForUser">>;
  let fallback: ReturnType<typeof spyOn<typeof db, "getWorkspaceGrant">>;
  let personal: ReturnType<typeof spyOn<typeof db, "resolveNamedManagedPersonalWorkspaceGrant">>;
  let deps: AccessDeps;
  let observed: AccessGrantAuthorization[];

  beforeEach(() => {
    live = nativeAccess();
    profiles = spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: userId, name: "Native person", email: "native@example.test" },
    ]);
    native = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () =>
      structuredClone(live),
    );
    fallback = spyOn(db, "getWorkspaceGrant").mockImplementation(async () => {
      throw new Error("delegated human must never use unbounded workspace fallback");
    });
    personal = spyOn(db, "resolveNamedManagedPersonalWorkspaceGrant").mockImplementation(
      async (_, input) =>
        input.subjectId === subjectId &&
        input.accountId === organizationId &&
        input.workspaceId === workspaceId
          ? { ...live.workspaceGrants[0]! }
          : null,
    );
    deps = {
      db: {} as db.Database,
      settings: testSettings({ productAccessMode: "managed", delegationSecret }),
    };
    observed = [];
  });

  afterEach(() => {
    profiles.mockRestore();
    native.mockRestore();
    fallback.mockRestore();
    personal.mockRestore();
  });

  function app(permission?: Permission): Hono {
    const harness = new Hono();
    harness.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    harness.get("/workspaces/:workspaceId", async (c) => {
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        c.req.param("workspaceId"),
        permission,
      );
      observed.push(authorization);
      return c.json({ authorization, context: await requireAccessContext(c, deps) });
    });
    return harness;
  }

  test("proof is immutable, exact-request-local, and never follows clone or wrapping", async () => {
    const permissions: Permission[] = ["sessions:read"];
    const workspaceIds = [workspaceId];
    const request = stampedRequest({
      permissions,
      workspaceScope: { kind: "selected", workspaceIds },
    });
    permissions.push("workspace:admin");
    workspaceIds.push(secondWorkspaceId);
    const proof = verifiedDelegatedHumanAuthorizationForRequest(request)!;
    expect(proof.permissions).toEqual(["sessions:read"]);
    expect(proof.workspaceScope).toEqual({ kind: "selected", workspaceIds: [workspaceId] });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.permissions)).toBe(true);
    expect(Object.isFrozen(proof.workspaceScope)).toBe(true);
    if (proof.workspaceScope.kind === "selected")
      expect(Object.isFrozen(proof.workspaceScope.workspaceIds)).toBe(true);
    expect(verifiedDelegatedHumanAuthorizationForRequest(request.clone())).toBeNull();
    expect(verifiedDelegatedHumanAuthorizationForRequest(new Request(request))).toBeNull();
    expect((await app().fetch(request.clone())).status).toBe(401);
    expect((await app().fetch(request)).status).toBe(200);
    expect(native).toHaveBeenCalledTimes(1);
    expect(() => stampDelegatedHumanAuthorization(request, bounds())).toThrow();
  });

  test("optional request binding accepts only the exact originating dispatch, never identical bounds", async () => {
    const request = stampedRequest();
    const otherRequest = stampedRequest();
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toEqual(
      verifiedDelegatedHumanAuthorizationForRequest(otherRequest),
    );
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)).not.toBe(
      verifiedDelegatedHumanAuthorizationForRequest(otherRequest),
    );
    expect((await app().fetch(request)).status).toBe(200);
    const authorization = observed[0]!;
    expect(isVerifiedDelegatedHumanAuthorization(authorization)).toBe(true);
    expect(isVerifiedDelegatedHumanAuthorization(authorization, request)).toBe(true);
    for (const differentRequest of [
      request.clone(),
      new Request(request),
      new Request(request.url),
      otherRequest,
    ]) {
      expect(isVerifiedDelegatedHumanAuthorization(authorization, differentRequest)).toBe(false);
    }
    expect(isVerifiedDelegatedHumanAuthorization({ ...authorization }, request)).toBe(false);
    expect((await app().fetch(otherRequest)).status).toBe(200);
    const otherAuthorization = observed[1]!;
    expect(isVerifiedDelegatedHumanAuthorization(otherAuthorization)).toBe(true);
    expect(isVerifiedDelegatedHumanAuthorization(otherAuthorization, otherRequest)).toBe(true);
    expect(isVerifiedDelegatedHumanAuthorization(otherAuthorization, request)).toBe(false);
    expect(isVerifiedDelegatedHumanAuthorization(authorization, otherRequest)).toBe(false);
  });

  test("a raw request already resolved without proof cannot change authentication through a late stamp", async () => {
    const request = new Request(`http://test/workspaces/${workspaceId}`);
    const harness = new Hono().get("/workspaces/:workspaceId", async (c) => {
      await expect(requireFreshAccessGrant(c, deps, workspaceId)).rejects.toThrow();
      expect(() => stampDelegatedHumanAuthorization(c.req.raw, bounds())).toThrow();
      return c.json({ lateStampDenied: true });
    });
    expect((await harness.fetch(request)).status).toBe(200);
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  test("live delegated identity helper exposes exact profile and scope, never an invented session or verification bit", async () => {
    const harness = new Hono().get("/workspaces/:workspaceId", async (c) => {
      const verified = await requireVerifiedDelegatedHumanContext(c, deps);
      expect(verified.user).toEqual({
        id: userId,
        name: "Native person",
        email: "native@example.test",
      });
      expect("emailVerified" in verified.user).toBe(false);
      expect("session" in verified).toBe(false);
      expect("sessionId" in verified).toBe(false);
      expect(verified.subjectId).toBe(subjectId);
      expect(verified.authorization).toBe(verifiedDelegatedHumanAuthorizationForRequest(c.req.raw));
      expect(verified.context).toBe(await requireAccessContext(c, deps));
      expect(verified.context.accountGrants).toHaveLength(1);
      expect(verified.context.workspaceGrants.map((grant) => grant.workspaceId)).toEqual([
        workspaceId,
      ]);
      expect(Object.isFrozen(verified.user)).toBe(true);
      return c.json(verified);
    });
    expect(
      (
        await harness.fetch(
          stampedRequest({ workspaceScope: { kind: "selected", workspaceIds: [workspaceId] } }),
        )
      ).status,
    ).toBe(200);
    expect(profiles).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
  });

  test("delegated identity helper forwards only native email verification and rejects unstamped or cloned requests", async () => {
    profiles.mockResolvedValue([
      { id: userId, name: null, email: "native@example.test", emailVerified: true },
    ] as Awaited<ReturnType<typeof db.getManagedUserProfilesByIds>>);
    const harness = new Hono().get("/workspaces/:workspaceId", async (c) =>
      c.json(await requireVerifiedDelegatedHumanContext(c, deps)),
    );
    const request = stampedRequest({}, workspaceId, {
      "x-opengeni-email-verified": "false",
    });
    const response = await harness.fetch(request);
    expect(response.status).toBe(200);
    expect((await response.json()).user).toEqual({
      id: userId,
      name: null,
      email: "native@example.test",
      emailVerified: true,
    });
    expect((await harness.fetch(request.clone())).status).toBe(401);
    expect((await harness.request(`/workspaces/${workspaceId}`)).status).toBe(401);
    profiles.mockResolvedValue([
      { id: userId, name: null, email: "native@example.test", emailVerified: false },
    ] as Awaited<ReturnType<typeof db.getManagedUserProfilesByIds>>);
    const unverified = await harness.fetch(
      stampedRequest({}, workspaceId, { "x-opengeni-email-verified": "true" }),
    );
    expect((await unverified.json()).user.emailVerified).toBe(false);
    profiles.mockResolvedValue([]);
    expect((await harness.fetch(stampedRequest())).status).toBe(403);
  });

  test("only the exact native owning-person authorization carries proof, never cookie or service proof", async () => {
    let presence = 0;
    deps.userPresence = { touch: () => presence++ } as never;
    const response = await app().fetch(
      stampedRequest({}, workspaceId, { "x-opengeni-user-activity": "active" }),
    );
    expect(response.status).toBe(200);
    const authorization = observed[0]!;
    expect(isVerifiedDelegatedHumanAuthorization(authorization)).toBe(true);
    expect(hasVerifiedOwningUserAuthorization(authorization)).toBe(true);
    expect(isVerifiedOrganizationServiceAuthorization(authorization)).toBe(false);
    expect(authorization.canonicalManagedHumanSession).toBe(false);
    expect(authorization.canonicalLocalHumanSession).toBe(false);
    expect(presence).toBe(0);
    expect(() => requireCanonicalManagedHuman(authorization, workspaceId)).toThrow();
    expect(() => requireVerifiedOwningUser(authorization, workspaceId)).not.toThrow();
    expect(() => requireVerifiedOwningUser(authorization, secondWorkspaceId)).toThrow();
    expect(personalConnectionDelegationSourceForGrant(authorization.grant)).toEqual({
      kind: "subject",
      accountId: organizationId,
      subjectId,
    });
    expect(isScheduledTaskAccessRefreshHuman(authorization, workspaceId)).toBe(true);
    expect(isScheduledTaskAccessRefreshHuman({ ...authorization }, workspaceId)).toBe(false);
    expect(isVerifiedDelegatedHumanAuthorization({ ...authorization })).toBe(false);
    expect(hasVerifiedOwningUserAuthorization(structuredClone(authorization))).toBe(false);
    expect(profiles).toHaveBeenCalledWith(deps.db, [userId]);
    expect(native).toHaveBeenCalledWith(deps.db, {
      userId,
      email: "native@example.test",
      name: "Native person",
      provisionFallbackOrganization: false,
      bindPendingInvitations: false,
    });
  });

  test("context or grant cloning and authorization identity changes cannot transplant owner proof", async () => {
    const harness = new Hono().get("/workspaces/:workspaceId", async (c) => {
      const context = await requireAccessContext(c, deps);
      const grant = context.workspaceGrants[0]!;
      expect(
        isVerifiedDelegatedHumanAuthorization(
          accessGrantAuthorizationFromContext(structuredClone(context), grant),
        ),
      ).toBe(false);
      expect(
        isVerifiedDelegatedHumanAuthorization(
          accessGrantAuthorizationFromContext(context, { ...grant }),
        ),
      ).toBe(false);
      const authorization = accessGrantAuthorizationFromContext(context, grant);
      const changedSubject = { ...authorization, authenticatedSubjectId: "user:someone-else" };
      const changedWorkspace = {
        ...authorization,
        grant: { ...grant, workspaceId: secondWorkspaceId },
      };
      const changedOrganization = {
        ...authorization,
        grant: { ...grant, accountId: otherOrganizationId },
      };
      for (const forged of [changedSubject, changedWorkspace, changedOrganization]) {
        expect(isVerifiedDelegatedHumanAuthorization(forged)).toBe(false);
        expect(hasVerifiedOwningUserAuthorization(forged)).toBe(false);
      }
      expect(Object.isFrozen(grant)).toBe(true);
      expect(Object.isFrozen(grant.permissions)).toBe(true);
      return c.json({ ok: true });
    });
    expect((await harness.fetch(stampedRequest())).status).toBe(200);
  });

  test("exact delegated authorization cannot mutate cookie flags, subject or grant in place", async () => {
    expect((await app().fetch(stampedRequest())).status).toBe(200);
    const authorization = observed[0]!;
    const originalGrant = authorization.grant;
    const originalAccountGrant = authorization.accountGrant;
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(() => {
      authorization.canonicalManagedHumanSession = true;
    }).toThrow(TypeError);
    expect(() => {
      authorization.authenticatedSubjectId = "user:someone-else";
    }).toThrow(TypeError);
    expect(() => {
      authorization.grant = { ...originalGrant, workspaceId: secondWorkspaceId };
    }).toThrow(TypeError);
    const replacements: Array<[keyof AccessGrantAuthorization, unknown]> = [
      ["canonicalManagedHumanSession", true],
      ["canonicalLocalHumanSession", true],
      ["contextIntegrity", false],
      ["authenticatedSubjectId", "user:someone-else"],
      ["grant", { ...originalGrant, subjectId: "user:someone-else" }],
      ["accountGrant", { ...originalAccountGrant, subjectId: "user:someone-else" }],
    ];
    for (const [key, value] of replacements)
      expect(Reflect.set(authorization, key, value)).toBe(false);
    expect(authorization.canonicalManagedHumanSession).toBe(false);
    expect(authorization.canonicalLocalHumanSession).toBe(false);
    expect(authorization.contextIntegrity).toBe(true);
    expect(authorization.authenticatedSubjectId).toBe(subjectId);
    expect(authorization.grant).toBe(originalGrant);
    expect(authorization.accountGrant).toBe(originalAccountGrant);
    expect(isVerifiedDelegatedHumanAuthorization(authorization)).toBe(true);
    expect(requireResolvedAccessGrantAuthorization(authorization, workspaceId)).toBe(originalGrant);
    expect(() => requireCanonicalManagedHuman(authorization, workspaceId)).toThrow();
    expect(() =>
      requireResolvedAccessGrantAuthorization(
        { ...authorization, canonicalManagedHumanSession: true },
        workspaceId,
      ),
    ).toThrow();
    expect(
      Object.isFrozen(accessGrantAuthorizationFromContext(live, live.workspaceGrants[0]!)),
    ).toBe(false);
  });

  test("a verified organization service cannot preview or acknowledge filesystem loss", async () => {
    const timestamp = "2026-10-02T00:00:00.000Z";
    const key = spyOn(db, "findActiveApiKeyByHash").mockResolvedValue({
      ...ApiKey.parse({
        id: crypto.randomUUID(),
        accountId: organizationId,
        workspaceId: null,
        name: "Organization service",
        description: null,
        prefix: "opengeni-test",
        permissions: ["workspace:read", "sessions:read", "sessions:control"],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      credentialKind: "organization",
    });
    const workspace = spyOn(db, "requireWorkspace").mockResolvedValue(
      Workspace.parse({
        id: workspaceId,
        accountId: organizationId,
        kind: "shared",
        name: "Shared workspace",
        slug: null,
        externalSource: null,
        externalId: null,
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
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    fallback.mockResolvedValue(null);
    const sessionFence = spyOn(
      sessionAuthorization,
      "requireSessionAuthorization",
    ).mockResolvedValue(null);
    const read = spyOn(db, "readPublicSandboxRecovery");
    const consent = spyOn(db, "consentPublicSandboxRecovery");
    try {
      expect(
        (
          await app().request(`/workspaces/${workspaceId}`, {
            headers: { authorization: "Bearer organization-recovery-test-key" },
          })
        ).status,
      ).toBe(200);
      const authorization = observed[0]!;
      expect(isVerifiedOrganizationServiceAuthorization(authorization)).toBe(true);
      expect(hasVerifiedOwningUserAuthorization(authorization)).toBe(false);
      const sessionId = crypto.randomUUID();
      await expect(
        getManagedHumanSandboxRecovery(deps, authorization, workspaceId, sessionId),
      ).rejects.toThrow("managed-human");
      await expect(
        consentManagedHumanSandboxRecovery(
          deps,
          authorization,
          workspaceId,
          sessionId,
          recoveryRequest(sessionId),
        ),
      ).rejects.toThrow("managed-human");
      expect(sessionFence).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(consent).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    } finally {
      key.mockRestore();
      workspace.mockRestore();
      sessionFence.mockRestore();
      read.mockRestore();
      consent.mockRestore();
    }
  });

  test("selected and all workspace scope never cross organization or fall back to stored grants", async () => {
    const selected = { kind: "selected" as const, workspaceIds: [workspaceId] };
    expect((await app().fetch(stampedRequest({ workspaceScope: selected }))).status).toBe(200);
    expect(
      (await app().fetch(stampedRequest({ workspaceScope: selected }, secondWorkspaceId))).status,
    ).toBe(403);
    expect((await app().fetch(stampedRequest({}, secondWorkspaceId))).status).toBe(200);
    expect((await app().fetch(stampedRequest({}, otherWorkspaceId))).status).toBe(403);
    expect((await app().fetch(stampedRequest({}, crypto.randomUUID()))).status).toBe(403);
    const response = await app().fetch(stampedRequest({ workspaceScope: selected }));
    const body = await response.json();
    expect(body.context.accountGrants).toHaveLength(1);
    expect(body.context.workspaceGrants).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("effective grants intersect OAuth and live native ceilings without admin or secret widening", async () => {
    live.workspaceGrants[0]!.permissions = ["workspace:admin"];
    const response = await app("sessions:read").fetch(
      stampedRequest({ permissions: ["sessions:read", "secrets:read"] }),
    );
    expect(response.status).toBe(200);
    const authorization = observed[0]!;
    expect(authorization.grant.permissions).toEqual(["sessions:read"]);
    expect(authorization.accountGrant?.permissions).toEqual([]);
    expect(hasPermission(authorization.grant.permissions, "sessions:control")).toBe(false);
    expect(hasPermission(authorization.grant.permissions, "secrets:read")).toBe(false);
    expect(
      (await app("sessions:control").fetch(stampedRequest({ permissions: ["sessions:read"] })))
        .status,
    ).toBe(403);
    live.workspaceGrants[0]!.permissions = ["sessions:read", "secrets:read"];
    expect(
      (await app("secrets:read").fetch(stampedRequest({ permissions: ["workspace:admin"] })))
        .status,
    ).toBe(403);
    expect(
      (await app("secrets:read").fetch(stampedRequest({ permissions: ["secrets:read"] }))).status,
    ).toBe(200);
  });

  test("account permissions intersect literally: workspace admin never implies account admin or billing", async () => {
    live.accountGrants[0]!.permissions = [
      "account:read",
      "account:admin",
      "billing:read",
      "billing:manage",
      "members:manage",
      "workspace:create",
      "api_keys:manage",
    ];
    expect((await app().fetch(stampedRequest({ permissions: ["workspace:admin"] }))).status).toBe(
      200,
    );
    const workspaceOnly = observed[0]!;
    expect(workspaceOnly.accountGrant?.permissions).toEqual([]);
    for (const permission of ["account:admin", "billing:read", "billing:manage"] as const)
      expect(hasPermission(workspaceOnly.accountGrant!.permissions, permission)).toBe(false);
    expect(() => requireAccountAdminAuthorizationStamp(workspaceOnly)).toThrow();

    expect(
      (
        await app().fetch(
          stampedRequest({ permissions: ["workspace:admin", "account:read", "billing:read"] }),
        )
      ).status,
    ).toBe(200);
    expect(observed[1]!.accountGrant?.permissions).toEqual(["account:read", "billing:read"]);
    expect(() => requireAccountAdminAuthorizationStamp(observed[1]!)).toThrow();

    // A live account grant must not acquire account powers through its own
    // workspace wildcard either, even when the dispatch explicitly names them.
    live.accountGrants[0]!.permissions = ["workspace:admin"];
    expect(
      (
        await app().fetch(
          stampedRequest({ permissions: ["account:admin", "billing:read", "billing:manage"] }),
        )
      ).status,
    ).toBe(200);
    expect(observed[2]!.accountGrant?.permissions).toEqual([]);
    expect(() => requireAccountAdminAuthorizationStamp(observed[2]!)).toThrow();

    live.accountGrants[0]!.permissions = ["account:admin", "billing:manage"];
    expect(
      (
        await app().fetch(
          stampedRequest({ permissions: ["account:admin", "billing:read", "billing:manage"] }),
        )
      ).status,
    ).toBe(200);
    expect(observed[3]!.accountGrant?.permissions).toEqual(["account:admin", "billing:manage"]);
    expect(() => requireAccountAdminAuthorizationStamp(observed[3]!)).not.toThrow();
  });

  test("live organization suspension, missing profile, mismatched subject and service authority fail closed", async () => {
    for (const corrupt of [
      (context: AccessContext) => (context.accountGrants = []),
      (context: AccessContext) => (context.subjectId = "user:other"),
      (context: AccessContext) => (context.accountGrants[0]!.subjectId = "user:other"),
      (context: AccessContext) => (context.workspaceGrants[0]!.subjectId = "user:other"),
      (context: AccessContext) => (context.workspaceGrants[0]!.principalKind = "service"),
      (context: AccessContext) =>
        (context.workspaceGrants[0]!.serviceInitiator = { kind: "service", subjectId: "job" }),
    ]) {
      live = nativeAccess();
      corrupt(live);
      expect((await app().fetch(stampedRequest())).status).toBe(403);
    }
    live = nativeAccess();
    profiles.mockResolvedValue([]);
    expect((await app().fetch(stampedRequest())).status).toBe(403);
    profiles.mockResolvedValue([{ id: "other", email: "other@example.test", name: null }]);
    expect((await app().fetch(stampedRequest())).status).toBe(403);
    profiles.mockResolvedValue([{ id: userId, email: "native@example.test", name: null }]);
    expect(
      (await app().fetch(stampedRequest({ organizationId: crypto.randomUUID() }))).status,
    ).toBe(403);
  });

  test("new requests and same-request fresh reauthorization reload permissions and live membership", async () => {
    const request = stampedRequest({ permissions: ["sessions:read", "sessions:create"] });
    expect((await app("sessions:create").fetch(request)).status).toBe(200);
    live.workspaceGrants[0]!.permissions = ["sessions:read"];
    expect(
      (await app("sessions:create").fetch(stampedRequest({ permissions: ["sessions:create"] })))
        .status,
    ).toBe(403);
    expect(native).toHaveBeenCalledTimes(2);
    const stream = new Hono().get("/workspaces/:workspaceId", async (c) => {
      const first = await requireAccessGrantAuthorization(c, deps, workspaceId, "sessions:read");
      expect(isVerifiedDelegatedHumanAuthorization(first)).toBe(true);
      live.accountGrants = [];
      await expect(
        requireFreshAccessGrant(c, deps, workspaceId, "sessions:read"),
      ).rejects.toThrow();
      return c.json({ revoked: true });
    });
    expect((await stream.fetch(stampedRequest())).status).toBe(200);
    expect(native).toHaveBeenCalledTimes(4);
    expect((await app().fetch(stampedRequest())).status).toBe(403);
  });

  test("headers, grant metadata and signed human-shaped bearer claims never create proof", async () => {
    const forged = nativeAccess();
    forged.workspaceGrants[0]!.metadata = {
      verifiedDelegatedHumanAuthorization: bounds(),
      delegatedHumanAuthorization: true,
      canonicalManagedHumanSession: true,
    };
    const authorization = accessGrantAuthorizationFromContext(forged, forged.workspaceGrants[0]!);
    expect(isVerifiedDelegatedHumanAuthorization(authorization)).toBe(false);
    expect(hasVerifiedOwningUserAuthorization(authorization)).toBe(false);
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: organizationId,
      workspaceId,
      subjectId,
      principalKind: "human_session",
      permissions: ["sessions:read"],
      exp: Math.floor(Date.now() / 1_000) + 60,
    });
    const request = new Request(`http://test/workspaces/${workspaceId}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-delegated-human": JSON.stringify(bounds()),
        "x-opengeni-subject": subjectId,
      },
    });
    expect((await app().fetch(request)).status).toBe(200);
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toBeNull();
    expect(isVerifiedDelegatedHumanAuthorization(observed[0]!)).toBe(false);
    expect(hasVerifiedOwningUserAuthorization(observed[0]!)).toBe(false);
    expect(native).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
  });

  test("service principals and malformed scope cannot be stamped as people", () => {
    for (const subject of [
      "api_key:key",
      "external:person",
      "service:job",
      "dev",
      "user:",
      "user:bad\n",
    ]) {
      expect(() => stampedRequest({ subjectId: subject })).toThrow();
    }
    expect(() => stampedRequest({ organizationId: "not-an-organization" })).toThrow();
    expect(() =>
      stampedRequest({ workspaceScope: { kind: "selected", workspaceIds: ["not-a-workspace"] } }),
    ).toThrow();
    expect(() => stampedRequest({ permissions: ["invented"] as Permission[] })).toThrow();
  });

  test("workspace scope accepts the shared kind discriminant only, never the retired mode shape", () => {
    const request = new Request(`http://test/workspaces/${workspaceId}`);
    for (const workspaceScope of [
      { mode: "all" },
      { mode: "selected", workspaceIds: [workspaceId] },
      { kind: "unknown" },
      { kind: "all", workspaceIds: [workspaceId] },
      { kind: "selected", workspaceIds: [workspaceId], unverifiedScope: true },
    ]) {
      expect(() =>
        stampDelegatedHumanAuthorization(request, {
          ...bounds(),
          workspaceScope,
        } as unknown as DelegatedHumanAuthorization),
      ).toThrow();
      expect(verifiedDelegatedHumanAuthorizationForRequest(request)).toBeNull();
    }
  });

  test("shared selected scope takes up to 500 unique UUIDs, canonicalizes case, and empty reaches nothing", () => {
    const uppercaseWorkspaceId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const request = stampedRequest({
      workspaceScope: { kind: "selected", workspaceIds: [uppercaseWorkspaceId] },
    });
    expect(verifiedDelegatedHumanAuthorizationForRequest(request)!.workspaceScope).toEqual({
      kind: "selected",
      workspaceIds: [uppercaseWorkspaceId.toLowerCase()],
    });
    const workspaceIds = Array.from({ length: 500 }, () => crypto.randomUUID());
    const maximum = stampedRequest({ workspaceScope: { kind: "selected", workspaceIds } });
    expect(verifiedDelegatedHumanAuthorizationForRequest(maximum)!.workspaceScope).toEqual({
      kind: "selected",
      workspaceIds,
    });
    expect(
      verifiedDelegatedHumanAuthorizationForRequest(
        stampedRequest({ workspaceScope: { kind: "selected", workspaceIds: [] } }),
      )!.workspaceScope,
    ).toEqual({ kind: "selected", workspaceIds: [] });
    for (const invalidWorkspaceIds of [
      [workspaceId, workspaceId],
      [uppercaseWorkspaceId, uppercaseWorkspaceId.toLowerCase()],
      [...workspaceIds, crypto.randomUUID()],
    ]) {
      const invalid = new Request(`http://test/workspaces/${workspaceId}`);
      expect(() =>
        stampDelegatedHumanAuthorization(
          invalid,
          bounds({ workspaceScope: { kind: "selected", workspaceIds: invalidWorkspaceIds } }),
        ),
      ).toThrow();
      expect(verifiedDelegatedHumanAuthorizationForRequest(invalid)).toBeNull();
    }
  });

  test("shared selected-scope UUID normalization resolves the exact live native workspace", async () => {
    const uppercaseWorkspaceId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const nativeWorkspaceId = uppercaseWorkspaceId.toLowerCase();
    live.workspaceGrants[0]!.workspaceId = nativeWorkspaceId;
    live.defaultWorkspaceId = nativeWorkspaceId;
    const request = stampedRequest(
      { workspaceScope: { kind: "selected", workspaceIds: [uppercaseWorkspaceId] } },
      nativeWorkspaceId,
    );
    expect((await app().fetch(request)).status).toBe(200);
    const authorization = observed[0]!;
    expect(authorization.grant.workspaceId).toBe(nativeWorkspaceId);
    expect(isVerifiedDelegatedHumanAuthorization(authorization, request)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  test("Personal settings exception is exact-owner only and never expands shared or service ownership", async () => {
    const settings = new Hono();
    settings.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    settings.get("/workspaces/:workspaceId", async (c) =>
      c.json(await requireWorkspaceSettingsGrant(c, deps, c.req.param("workspaceId"))),
    );
    expect((await settings.fetch(stampedRequest())).status).toBe(200);
    expect(personal).toHaveBeenCalledWith(deps.db, {
      accountId: organizationId,
      workspaceId,
      subjectId,
    });
    expect((await settings.fetch(stampedRequest({}, secondWorkspaceId))).status).toBe(403);
    expect((await settings.fetch(stampedRequest({ permissions: [] }))).status).toBe(403);
    expect(
      (await settings.fetch(stampedRequest({ permissions: ["workspace:read", "sessions:read"] })))
        .status,
    ).toBe(403);
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: organizationId,
      workspaceId,
      subjectId,
      permissions: ["workspace:read"],
      principalKind: "service",
      exp: Math.floor(Date.now() / 1_000) + 60,
    });
    expect(
      (
        await settings.request(`/workspaces/${workspaceId}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    profiles.mockResolvedValue([{ id: "other", email: "other@example.test", name: null }]);
    live.subjectId = "user:other";
    for (const grant of [...live.accountGrants, ...live.workspaceGrants])
      grant.subjectId = "user:other";
    expect((await settings.fetch(stampedRequest({ subjectId: "user:other" }))).status).toBe(403);
  });
});
