import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE } from "@opengeni/contracts";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
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

import { createApp } from "../src/app";
import {
  createManagedAuth,
  MANAGED_AUTH_NEW_SIGNUPS_PAUSED_MESSAGE,
} from "../src/auth/managed-auth";
import { deriveOrganizationUserSetupToken } from "../src/auth/organization-user-setup";

// The launch-load safety switch: OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED=false
// must refuse every new account while existing humans keep working. Two apps
// share one database to model the operator flip plus API restart: accounts and
// sessions created before the flip must survive it.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-new-signups-paused");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("managed sign-up pause tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function runtimeSettings(newSignupsEnabled: boolean) {
  return testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-signups-paused-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthSessionSetMode: "legacy",
    managedAuthNewSignupsEnabled: newSignupsEnabled,
  });
}

const mail: ManagedEmailMessage[] = [];
const transport: ManagedEmailTransport = {
  sender: "auth@example.test",
  idempotency: { scope: "test:signups-paused", retentionSeconds: 86_400 },
  send: async (message) => {
    mail.push(message);
    return { status: "sent" as const, providerMessageId: null };
  },
};

function requestHeaders(cookie?: string): Record<string, string> {
  clientAddress += 1;
  return {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": `198.51.100.${clientAddress % 250}`,
    ...(cookie ? { cookie } : {}),
  };
}

function cookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

function linkIn(message: ManagedEmailMessage | undefined): URL {
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeDefined();
  return new URL(link!);
}

async function authUserCount(email: string): Promise<number> {
  const [row] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from auth_users where lower(email) = lower(${email})`;
  return row!.count;
}

type Harness = {
  app: ReturnType<typeof createApp>;
  googleUser: (user: { id: string; email: string }) => void;
};

async function harness(newSignupsEnabled: boolean): Promise<Harness> {
  const settings = runtimeSettings(newSignupsEnabled);
  const auth = createManagedAuth(settings, client!.db, transport)!;
  const app = createApp({
    settings,
    db: client!.db,
    managedAuth: auth,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  const context = await auth.$context;
  const google = context.socialProviders.find((provider) => provider.id === "google")!;
  google.validateAuthorizationCode = async () => ({
    accessToken: "test-provider-token",
    tokenType: "Bearer",
  });
  return {
    app,
    googleUser: (user) => {
      google.getUserInfo = async () => ({
        user: { id: user.id, name: "Provider Human", email: user.email, emailVerified: true },
        data: {},
      });
    },
  };
}

async function googleCallback(
  h: Harness,
  user: { id: string; email: string },
  extra: Record<string, unknown> = {},
): Promise<Response> {
  h.googleUser(user);
  const start = await h.app.request("/v1/auth/sign-in/social", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      provider: "google",
      callbackURL: "http://opengeni.test/",
      errorCallbackURL: "http://opengeni.test/",
      disableRedirect: true,
      ...extra,
    }),
  });
  expect(start.status).toBe(200);
  const authorization = new URL(((await start.json()) as { url: string }).url);
  return await h.app.request(
    `/v1/auth/callback/google?state=${authorization.searchParams.get("state")}&code=simulated-provider-code`,
    { headers: requestHeaders(cookiePairs(start)) },
  );
}

async function verifiedEmailUser(h: Harness, email: string, password: string): Promise<string> {
  const signUp = await h.app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ name: "Existing Human", email, password }),
  });
  expect(signUp.status).toBeLessThan(300);
  const verification = linkIn(
    mail.findLast((message) => message.kind === "email_verification" && message.to === email),
  );
  const verified = await h.app.request(`${verification.pathname}${verification.search}`, {
    headers: requestHeaders(),
  });
  expect(verified.status).toBeLessThan(400);
  const signIn = await h.app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  expect(signIn.status).toBe(200);
  return cookiePairs(signIn);
}

describe("paused new account sign-ups", () => {
  test("client config advertises the switch for the sign-up screen", async () => {
    if (!shared || !client) return;
    for (const enabled of [true, false]) {
      const h = await harness(enabled);
      const response = await h.app.request("/v1/config/client", { headers: requestHeaders() });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { auth: unknown }).auth).toMatchObject({
        mode: "managedSession",
        socialProviders: ["google"],
        newSignupsEnabled: enabled,
      });
    }
  }, 120_000);

  test("email sign-up is refused with a typed error and creates nothing", async () => {
    if (!shared || !client) return;
    const open = await harness(true);
    const paused = await harness(false);
    const existingEmail = `paused-existing-${crypto.randomUUID()}@example.test`;
    await verifiedEmailUser(open, existingEmail, "existing-password-1");

    for (const email of [`paused-new-${crypto.randomUUID()}@example.test`, existingEmail]) {
      const mailBefore = mail.length;
      const refused = await paused.app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ name: "New Human", email, password: "new-password-123" }),
      });
      // Same answer for a new and an existing address: no account enumeration.
      expect(refused.status).toBe(403);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(await refused.json()).toEqual({
        code: MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE,
        message: MANAGED_AUTH_NEW_SIGNUPS_PAUSED_MESSAGE,
      });
      expect(mail.length).toBe(mailBefore);
    }
    expect(await authUserCount(existingEmail)).toBe(1);
  }, 120_000);

  test("Better Auth's own sign-up flag and create hook are a backstop behind the route", async () => {
    if (!shared || !client) return;
    const settings = runtimeSettings(false);
    const auth = createManagedAuth(settings, client.db, transport)!;
    const email = `paused-direct-${crypto.randomUUID()}@example.test`;
    const error = await auth.api
      .signUpEmail({ body: { name: "Direct", email, password: "direct-password-1" } })
      .then(
        () => null,
        (caught: unknown) => caught as { body?: { code?: string } },
      );
    expect(error?.body?.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    const context = await auth.$context;
    expect(await context.internalAdapter.createUser({ name: "Hook", email })).toBeNull();
    expect(await authUserCount(email)).toBe(0);
  }, 120_000);

  test("implicit Google sign-up is refused, even when the client requests sign-up", async () => {
    if (!shared || !client) return;
    const paused = await harness(false);
    for (const extra of [{}, { requestSignUp: true }]) {
      const id = crypto.randomUUID();
      const email = `paused-social-${id}@example.test`;
      const callback = await googleCallback(paused, { id, email }, extra);
      expect(callback.status).toBe(302);
      const location = new URL(callback.headers.get("location")!);
      expect(location.origin).toBe("http://opengeni.test");
      expect(location.searchParams.get("error")).toBe("signup_disabled");
      expect(
        callback.headers.getSetCookie().some((value) => value.includes("session_token=")),
      ).toBe(false);
      expect(await authUserCount(email)).toBe(0);
    }
  }, 120_000);

  test("existing humans keep signing in, keep sessions, reset passwords, and verify email", async () => {
    if (!shared || !client) return;
    const open = await harness(true);

    // Accounts that exist before the flip.
    const email = `paused-signin-${crypto.randomUUID()}@example.test`;
    const password = "existing-password-1";
    const sessionBeforeFlip = await verifiedEmailUser(open, email, password);
    const googleHuman = { id: crypto.randomUUID(), email: "" };
    googleHuman.email = `paused-google-${googleHuman.id}@example.test`;
    const firstGoogle = await googleCallback(open, googleHuman);
    expect(firstGoogle.headers.get("location")).toBe("http://opengeni.test/");
    const unverifiedEmail = `paused-unverified-${crypto.randomUUID()}@example.test`;
    const unverifiedSignUp = await open.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        name: "Unverified",
        email: unverifiedEmail,
        password: "unverified-pass-1",
      }),
    });
    expect(unverifiedSignUp.status).toBeLessThan(300);

    const paused = await harness(false);

    // A session issued before the flip still reads after the restart.
    const sessionRead = await paused.app.request("/v1/auth/get-session", {
      headers: requestHeaders(sessionBeforeFlip),
    });
    expect(sessionRead.status).toBe(200);
    expect(await sessionRead.json()).toMatchObject({ user: { email } });

    // Email sign-in.
    const signIn = await paused.app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);

    // Social sign-in for an existing Google human.
    const googleSignIn = await googleCallback(paused, googleHuman);
    expect(googleSignIn.status).toBe(302);
    expect(googleSignIn.headers.get("location")).toBe("http://opengeni.test/");
    expect(
      googleSignIn.headers.getSetCookie().some((value) => value.includes("session_token=")),
    ).toBe(true);
    expect(await authUserCount(googleHuman.email)).toBe(1);

    // A verified email/password human may still sign in with Google (verified
    // linking adds a method; it creates no user).
    const linked = await googleCallback(paused, { id: crypto.randomUUID(), email });
    expect(linked.headers.get("location")).toBe("http://opengeni.test/");
    expect(await authUserCount(email)).toBe(1);

    // Password reset.
    const resetRequest = await paused.app.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, redirectTo: "http://opengeni.test/reset-password" }),
    });
    expect(resetRequest.status).toBe(200);
    const resetLink = linkIn(
      mail.findLast((message) => message.kind === "password_reset" && message.to === email),
    );
    const resetToken = resetLink.pathname.split("/").at(-1)!;
    const reset = await paused.app.request("/v1/auth/reset-password", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ token: resetToken, newPassword: "reset-password-2" }),
    });
    expect(reset.status).toBe(200);
    const signInAfterReset = await paused.app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password: "reset-password-2" }),
    });
    expect(signInAfterReset.status).toBe(200);

    // Email verification of an account created before the flip.
    const resend = await paused.app.request("/v1/auth/send-verification-email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email: unverifiedEmail }),
    });
    expect(resend.status).toBe(200);
    const verification = linkIn(
      mail.findLast(
        (message) => message.kind === "email_verification" && message.to === unverifiedEmail,
      ),
    );
    const verified = await paused.app.request(`${verification.pathname}${verification.search}`, {
      headers: requestHeaders(),
    });
    expect(verified.status).toBeLessThan(400);
    const [row] = await shared.admin<{ verified: boolean }[]>`
      select email_verified as verified from auth_users where email = ${unverifiedEmail}`;
    expect(row!.verified).toBe(true);
  }, 180_000);

  test("an invited person can still create their account from the invitation link", async () => {
    if (!shared || !client) return;
    const settings = runtimeSettings(false);
    const paused = await harness(false);
    const ownerId = crypto.randomUUID();
    const ownerEmail = `paused-owner-${ownerId}@example.test`;
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerId}, 'Paused owner', ${ownerEmail}, true)`;
    const owner = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId: ownerId,
      email: ownerEmail,
      name: "Paused owner",
      emailVerified: true,
    });
    const ownerSubject = `user:${ownerId}`;
    const [membership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    const operationId = crypto.randomUUID();
    const invitedEmail = `paused-invite-${crypto.randomUUID()}@example.test`;
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

    // Ordinary sign-up for the invited address is still refused...
    const refused = await paused.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Invited", email: invitedEmail, password: "password1234" }),
    });
    expect(refused.status).toBe(403);

    // ...but the invitation-bound setup creates the account and joins.
    const password = "password1234";
    const complete = await paused.app.request("/v1/auth/organization-setup", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        token: setup.token,
        name: "Invited teammate",
        password,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ status: "complete" });

    const signIn = await paused.app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email: invitedEmail, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);
    const access = await paused.app.request("/v1/access/me", {
      headers: requestHeaders(cookiePairs(signIn)),
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      defaultAccountId: membership!.organizationId,
      workspaceGrants: expect.arrayContaining([
        expect.objectContaining({ workspaceId: owner.accessContext.defaultWorkspaceId }),
      ]),
    });
  }, 180_000);
});
