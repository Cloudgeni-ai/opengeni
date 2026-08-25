import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  ensureOrganizationUserSetupIntent,
  listSelfOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { createApp } from "../src/app";
import {
  deriveOrganizationUserSetupToken,
  organizationUserSetupRequestFingerprint,
} from "../src/auth/organization-user-setup";
import { hashManagedAuthPassword } from "../src/auth/managed-auth";
import {
  PublicSetupRateLimiter,
  registerManagedOnboardingRoutes,
} from "../src/routes/managed-onboarding";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: "http://opengeni.test",
  betterAuthSecret: "managed-onboarding-test-secret-at-least-32-bytes",
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-onboarding-api");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("managed onboarding API tests require PostgreSQL");
  }
  if (shared) {
    settings.databaseUrl = shared.adminUrl;
    client = createDb(shared.appUrl, { max: 8 });
  }
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("managed organization onboarding", () => {
  test("setup tokens are deterministic, stored as digests, and bind request content", async () => {
    const invitationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const first = await deriveOrganizationUserSetupToken(settings, {
      invitationId,
      operationId,
    });
    const retry = await deriveOrganizationUserSetupToken(settings, {
      invitationId,
      operationId,
    });
    expect(retry).toEqual(first);
    expect(first.token).not.toBe(first.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.url).toBe(
      `http://opengeni.test/setup-account#token=${encodeURIComponent(first.token)}`,
    );
    const fingerprint = await organizationUserSetupRequestFingerprint(settings, {
      tokenDigest: first.digest,
      name: "Invited teammate",
      password: "a secure password",
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await organizationUserSetupRequestFingerprint(settings, {
        tokenDigest: first.digest,
        name: "Invited teammate",
        password: "a different password",
      }),
    ).not.toBe(fingerprint);
  });

  test("a setup link creates no session until completion, then signs into only the inviting organization", async () => {
    if (!shared || !client) return;
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const ownerId = crypto.randomUUID();
    const ownerEmail = `setup-owner-${ownerId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerId}, 'Setup owner', ${ownerEmail}, true)`;
    const owner = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: ownerEmail,
      name: "Setup owner",
      emailVerified: true,
    });
    const ownerSubject = `user:${ownerId}`;
    const [membership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const operationId = crypto.randomUUID();
    const invitedEmail = `setup-invite-${crypto.randomUUID()}@example.test`;
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: ownerSubject,
      operationId,
      targetSubjectId: null,
      targetEmail: invitedEmail,
      targetName: "Invited teammate",
      initialWorkspaceIds: [owner.accessContext.defaultWorkspaceId!],
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const setup = await deriveOrganizationUserSetupToken(settings, {
      invitationId: invitation.id,
      operationId,
    });
    await ensureOrganizationUserSetupIntent(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: ownerSubject,
      invitationId: invitation.id,
      tokenDigest: setup.digest,
      expiresAt: invitation.expiresAt,
    });
    let passwordHashCalls = 0;
    const setupApp = new Hono();
    registerManagedOnboardingRoutes(
      setupApp,
      { settings, db: client.db, managedAuth: {} } as never,
      {
        accountSetupLimiter: new PublicSetupRateLimiter({
          globalCapacity: 20,
          globalRefillPerSecond: 0,
          clientCapacity: 20,
          clientRefillPerSecond: 0,
        }),
        hashPassword: async (value) => {
          passwordHashCalls += 1;
          return await hashManagedAuthPassword(value);
        },
      },
    );

    const password = "password1234";
    const before = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: invitedEmail, password }),
    });
    expect(before.status).toBe(401);

    const invalid = await setupApp.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "invalid-token".padEnd(43, "x"),
        name: "Invited teammate",
        password,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(invalid.status).toBe(404);
    expect(passwordHashCalls).toBe(0);

    const expiredInvitationOperationId = crypto.randomUUID();
    const expiredInvitation = await createOrganizationInvitation(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: ownerSubject,
      operationId: expiredInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `expired-setup-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const expiredSetup = await deriveOrganizationUserSetupToken(settings, {
      invitationId: expiredInvitation.id,
      operationId: expiredInvitationOperationId,
    });
    await ensureOrganizationUserSetupIntent(client.db, {
      organizationId: membership!.organizationId,
      actorSubjectId: ownerSubject,
      invitationId: expiredInvitation.id,
      tokenDigest: expiredSetup.digest,
      expiresAt: expiredInvitation.expiresAt,
    });
    await shared.admin`
      update organization_user_setup_intents
      set expires_at = clock_timestamp() - interval '1 minute'
      where token_digest = ${expiredSetup.digest}`;
    const expired = await setupApp.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: expiredSetup.token,
        name: "Expired teammate",
        password,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(expired.status).toBe(404);
    expect(passwordHashCalls).toBe(0);

    const completionBody = {
      token: setup.token,
      name: "Invited teammate",
      password,
      operationId: crypto.randomUUID(),
    };
    const complete = await setupApp.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completionBody),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ status: "complete" });
    expect(complete.headers.get("set-cookie")).toBeNull();
    expect(passwordHashCalls).toBe(1);

    const exactReplay = await setupApp.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completionBody),
    });
    expect(exactReplay.status).toBe(200);
    expect(passwordHashCalls).toBe(1);
    const changedReplay = await setupApp.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...completionBody, password: "password5678" }),
    });
    expect(changedReplay.status).toBe(409);
    expect(passwordHashCalls).toBe(1);

    const limitedApp = new Hono();
    registerManagedOnboardingRoutes(
      limitedApp,
      { settings, db: client.db, managedAuth: {} } as never,
      {
        accountSetupLimiter: new PublicSetupRateLimiter({
          globalCapacity: 1,
          globalRefillPerSecond: 0,
          clientCapacity: 1,
          clientRefillPerSecond: 0,
          now: () => 0,
        }),
        hashPassword: async (value) => {
          passwordHashCalls += 1;
          return await hashManagedAuthPassword(value);
        },
      },
    );
    const limitedBody = JSON.stringify({
      token: "rate-limited-invalid-token".padEnd(43, "x"),
      name: "Rate limited",
      password,
      operationId: crypto.randomUUID(),
    });
    expect(
      (
        await limitedApp.request("/v1/auth/organization-setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: limitedBody,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await limitedApp.request("/v1/auth/organization-setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: limitedBody,
        })
      ).status,
    ).toBe(429);
    expect(passwordHashCalls).toBe(1);

    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: invitedEmail, password, rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="));
    expect(cookie).toBeTruthy();

    const access = await app.request("/v1/access/me", {
      headers: { cookie: cookie!.split(";", 1)[0]! },
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      defaultAccountId: membership!.organizationId,
      workspaceGrants: expect.arrayContaining([
        expect.objectContaining({
          workspaceId: owner.accessContext.defaultWorkspaceId,
        }),
      ]),
    });
    const [counts] = await shared.admin<
      Array<{ organizations: number; authSessions: number; verified: boolean }>
    >`
      select
        (select count(*)::int from organization_memberships organization_membership
          where organization_membership.subject_id = 'user:' || auth_user.id
            and organization_membership.status = 'active') as organizations,
        (select count(*)::int from auth_sessions auth_session
          where auth_session.user_id = auth_user.id) as "authSessions",
        auth_user.email_verified as verified
      from auth_users auth_user
      where lower(auth_user.email) = lower(${invitedEmail})`;
    expect(counts).toEqual({
      organizations: 1,
      authSessions: 1,
      verified: true,
    });
  }, 120_000);

  test("ordinary signup defers organization creation until authenticated setup", async () => {
    if (!shared || !client) return;
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `named-signup-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Katherine Johnson",
        email,
        password,
      }),
    });
    expect(signup.status).toBe(200);
    const [beforeOrganization] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from managed_accounts account
      join auth_users auth_user on account.external_source = 'better-auth:user'
        and account.external_id = auth_user.id
      where lower(auth_user.email) = lower(${email})`;
    expect(beforeOrganization?.count).toBe(0);

    await shared.admin`update auth_users set email_verified = true where lower(email) = lower(${email})`;
    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="))!;
    const sessionCookie = cookie.split(";", 1)[0]!;
    const status = await app.request("/v1/auth/organization-onboarding", {
      headers: { cookie: sessionCookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ state: "required" });

    const operationId = crypto.randomUUID();
    const complete = await app.request("/v1/auth/organization-onboarding", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationName: "Orbital Mechanics",
        operationId,
      }),
    });
    expect(complete.status).toBe(200);
    const completion = (await complete.json()) as {
      organizationId: string;
      personalWorkspaceId: string;
    };
    const [provisioned] = await shared.admin<
      Array<{
        organizationName: string;
        workspaces: number;
        sharedWorkspaceMemberships: number;
      }>
    >`
      select account.name as "organizationName",
        (select count(*)::int from workspaces where account_id = account.id) as workspaces,
        (select count(*)::int from workspace_memberships where account_id = account.id)
          as "sharedWorkspaceMemberships"
      from managed_accounts account where account.id = ${completion.organizationId}`;
    expect(provisioned?.organizationName).toBe("Orbital Mechanics");
    expect(provisioned?.workspaces).toBe(1);
    expect(provisioned?.sharedWorkspaceMemberships).toBe(0);
    expect(completion.personalWorkspaceId).toBeTruthy();

    const compatibilityReplay = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Orbital Mechanics",
        operationId,
      }),
    });
    expect(compatibilityReplay.status).toBe(201);
    expect(await compatibilityReplay.json()).toMatchObject({
      organization: { id: completion.organizationId, name: "Orbital Mechanics" },
      workspaceId: completion.personalWorkspaceId,
    });
    const changedCompatibilityReplay = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Changed organization",
        operationId,
      }),
    });
    expect(changedCompatibilityReplay.status).toBe(409);

    await shared.admin`update managed_accounts set name = 'Orbital Operations'
      where id = ${completion.organizationId}`;
    expect(
      (
        await app.request("/v1/auth/organization-onboarding", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            organizationName: "Orbital Mechanics",
            operationId,
          }),
        })
      ).status,
    ).toBe(200);
    const [renamed] = await shared.admin<Array<{ organizationName: string }>>`
      select account.name as "organizationName"
      from managed_accounts account
      where account.id = ${completion.organizationId}`;
    expect(renamed?.organizationName).toBe("Orbital Operations");

    const [signupUser] = await shared.admin<Array<{ id: string }>>`
      select id from auth_users where lower(email) = lower(${email})`;
    await shared.admin`
      update organization_memberships set
        status = 'suspended',
        authorization_revision = authorization_revision + 1,
        updated_at = clock_timestamp()
      where account_id = ${completion.organizationId}
        and subject_id = ${`user:${signupUser!.id}`}`;
    const unavailable = await app.request("/v1/auth/organization-onboarding", {
      headers: { cookie: sessionCookie },
    });
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toEqual({ state: "unavailable" });
  }, 120_000);
});
