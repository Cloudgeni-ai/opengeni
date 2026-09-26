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
import { createManagedAuth, hashManagedAuthPassword } from "../src/auth/managed-auth";
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
  organizationUserSetupEmailTokenTransport: "query",
  organizationUserSetupQueryEdgeSanitizationConfirmed: true,
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
      deliveryId: operationId,
    });
    const retry = await deriveOrganizationUserSetupToken(settings, {
      invitationId,
      deliveryId: operationId,
    });
    expect(retry).toEqual(first);
    expect(first.token).not.toBe(first.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.url).toBe(
      `http://opengeni.test/setup-account?token=${encodeURIComponent(first.token)}`,
    );
    const compatibilityDefault = await deriveOrganizationUserSetupToken(
      testSettings({
        productAccessMode: "managed",
        publicBaseUrl: "http://opengeni.test",
        betterAuthSecret: "managed-onboarding-test-secret-at-least-32-bytes",
      }),
      { invitationId, deliveryId: operationId },
    );
    expect(compatibilityDefault.token).toBe(first.token);
    expect(compatibilityDefault.url).toBe(
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
      deliveryId: operationId,
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
      deliveryId: expiredInvitationOperationId,
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

  test("the first verification click signs the new user in once, straight into setup", async () => {
    if (!shared || !client) return;
    const sent: Array<{ kind: string; to: string; text: string }> = [];
    const app = createApp({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
      managedEmailTransport: {
        sender: "OpenGeni <auth@mail.opengeni.ai>",
        idempotency: { scope: "test-provider-v1:verify-sign-in", retentionSeconds: 86_400 },
        send: async (message) => {
          sent.push({ kind: message.kind, to: message.to, text: message.text });
          return { status: "sent", providerMessageId: `test-${sent.length}` };
        },
      },
    });
    const email = `verify-signin-${crypto.randomUUID()}@example.test`;
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mary Jackson", email, password: "password1234" }),
    });
    expect(signup.status).toBe(200);
    expect(
      signup.headers.getSetCookie().some((value) => value.includes("better-auth.session_token=")),
    ).toBe(false);

    // Follow the exact link the user receives.
    const verification = sent.find(
      (message) => message.kind === "email_verification" && message.to === email,
    );
    expect(verification).toBeTruthy();
    const link = new URL(verification!.text.match(/https?:\/\/\S+/u)![0]);
    expect(link.pathname).toBe("/v1/auth/verify-email");
    const verificationPath = `${link.pathname}${link.search}`;
    const verified = await app.request(verificationPath);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    const cookie = verified.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="));
    expect(cookie).toBeTruthy();
    const onboarding = await app.request("/v1/auth/organization-onboarding", {
      headers: { cookie: cookie!.split(";", 1)[0]! },
    });
    expect(onboarding.status).toBe(200);
    expect(await onboarding.json()).toEqual({ state: "required" });

    // A second click (or a mail scanner that already followed the link) only
    // redirects; the link never mints a second session.
    const replay = await app.request(verificationPath);
    expect(replay.status).toBe(302);
    expect(
      replay.headers.getSetCookie().some((value) => value.includes("better-auth.session_token=")),
    ).toBe(false);
    const [sessions] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from auth_sessions session
      join auth_users auth_user on auth_user.id = session.user_id
      where lower(auth_user.email) = lower(${email})`;
    expect(sessions?.count).toBe(1);
  }, 120_000);

  test("session-set modes keep verification sign-in inside the isolated browser transaction", () => {
    const transport = { send: async () => undefined } as never;
    for (const mode of ["dual", "broker"] as const) {
      const auth = createManagedAuth(
        { ...settings, managedAuthSessionSetMode: mode },
        {} as never,
        transport,
      )!;
      expect(auth.options.emailVerification?.autoSignInAfterVerification).toBe(false);
    }
    const legacy = createManagedAuth(settings, {} as never, transport)!;
    expect(legacy.options.emailVerification?.autoSignInAfterVerification).toBe(true);
  });

  test("every verification email tells an unsolicited recipient to ignore it", async () => {
    // The link signs its clicker in, so a recipient who never signed up must
    // be told not to use it.
    const sent: Array<{ kind: string; to: string; text: string; html?: string }> = [];
    const auth = createManagedAuth(settings, {} as never, {
      sender: "OpenGeni <auth@mail.opengeni.ai>",
      idempotency: { scope: "test-provider-v1:verify-ignore", retentionSeconds: 86_400 },
      send: async (message) => {
        sent.push(message);
        return { status: "sent", providerMessageId: `test-${sent.length}` };
      },
    })!;
    const user = {
      id: crypto.randomUUID(),
      email: "unsolicited@example.test",
      emailVerified: false,
      name: "Unsolicited",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await auth.options.emailVerification!.sendVerificationEmail!({
      user,
      url: "http://opengeni.test/v1/auth/verify-email?token=signup",
      token: "signup",
    });
    // A repeated sign-up for the same unverified email re-sends verification.
    await auth.options.emailAndPassword!.onExistingUserSignUp!({ user });
    expect(sent.map((message) => message.kind)).toEqual([
      "email_verification",
      "email_verification",
    ]);
    const ignore = "If you did not create an OpenGeni account, ignore this email.";
    for (const message of sent) {
      expect(message.to).toBe(user.email);
      expect(message.text).toContain(ignore);
      expect(message.html).toContain(ignore);
      // The link stays the first whitespace-delimited URL in the text body.
      const link = new URL(message.text.match(/https?:\/\/\S+/u)![0]);
      expect(link.pathname).toBe("/v1/auth/verify-email");
    }
  });
});
