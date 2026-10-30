import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MANAGED_AUTH_SIGN_IN_EMAIL_NOT_ALLOWED_CODE } from "@opengeni/contracts";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";

// A deployment restricted to allowedUserEmails used to answer an unlisted
// address's correct password with Better Auth's generic 401
// FAILED_TO_CREATE_SESSION, which reads like an outage, and a wrong password
// with INVALID_EMAIL_OR_PASSWORD. It now refuses with one typed reason before
// the password is checked, and OAuth sign-in redirects with the same reason.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;
const PASSWORD = "sign-in-password-123";
const KEPT = `kept-${crypto.randomUUID()}@example.test`;
const REMOVED = `removed-${crypto.randomUUID()}@example.test`;
const SOCIAL_ID = crypto.randomUUID();
const REMOVED_SOCIAL = `removed-social-${SOCIAL_ID}@example.test`;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-sign-in-email-not-allowed");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("allowed-email sign-in tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const transport: ManagedEmailTransport = {
  sender: "auth@example.test",
  idempotency: { scope: "test:sign-in-email-not-allowed", retentionSeconds: 86_400 },
  send: async (_message: ManagedEmailMessage) => ({
    status: "sent" as const,
    providerMessageId: null,
  }),
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

function setsSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((value) => value.includes("session_token="));
}

async function harness(allowedUserEmails: string[]) {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-sign-in-email-not-allowed-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthSessionSetMode: "legacy",
    managedAuthRequireEmailVerification: false,
    allowedUserEmails,
  });
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
  google.getUserInfo = async () => ({
    user: { name: "Provider Human", email: REMOVED_SOCIAL, emailVerified: true },
    data: { sub: SOCIAL_ID },
  });
  const googleCallback = async () => {
    const start = await app.request("/v1/auth/sign-in/social", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        provider: "google",
        callbackURL: "http://opengeni.test/",
        errorCallbackURL: "http://opengeni.test/",
        disableRedirect: true,
      }),
    });
    expect(start.status).toBe(200);
    const authorization = new URL(((await start.json()) as { url: string }).url);
    return app.request(
      `/v1/auth/callback/google?state=${authorization.searchParams.get("state")}&code=simulated-provider-code`,
      { headers: requestHeaders(cookiePairs(start)) },
    );
  };
  const signIn = (email: string, password: string) =>
    app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password }),
    });
  return { app, googleCallback, signIn };
}

describe("sign-in restricted to allowed emails", () => {
  // Accounts are created while every address is allowed; the restricted
  // deployment then drops two of them, as a staging list edit did.
  beforeAll(async () => {
    if (!shared || !client) return;
    const open = await harness([KEPT, REMOVED, REMOVED_SOCIAL]);
    for (const email of [KEPT, REMOVED]) {
      const created = await open.app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ name: "Test Human", email, password: PASSWORD }),
      });
      expect(created.status).toBeLessThan(300);
    }
    await shared.admin`
      update auth_users set email_verified = true where email in (${KEPT}, ${REMOVED})`;
    const social = await open.googleCallback();
    expect(social.status).toBe(302);
    expect(new URL(social.headers.get("location")!).searchParams.get("error")).toBeNull();
  }, 180_000);

  test("email sign-in for an unlisted address is refused before the password is checked", async () => {
    if (!shared || !client) return;
    const h = await harness([KEPT]);
    const [{ now }] = await shared.admin<{ now: Date }[]>`select clock_timestamp() as now`;
    const answers = [];
    for (const [email, password] of [
      [REMOVED, PASSWORD],
      [REMOVED, "wrong-password-123"],
      [`never-${crypto.randomUUID()}@example.test`, PASSWORD],
      [REMOVED.toUpperCase(), PASSWORD],
    ] as const) {
      const refused = await h.signIn(email, password);
      expect(refused.status).toBe(403);
      expect(setsSessionCookie(refused)).toBe(false);
      answers.push(await refused.json());
    }
    // The same answer for a right, wrong or unknown password says nothing about it.
    for (const answer of answers) {
      expect(answer).toEqual({
        code: MANAGED_AUTH_SIGN_IN_EMAIL_NOT_ALLOWED_CODE,
        message: "sign in email not allowed",
      });
    }
    const [sessions] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from auth_sessions s
      join auth_users u on u.id = s.user_id
      where u.email = ${REMOVED} and s.created_at >= ${now}`;
    expect(sessions!.count).toBe(0);
  }, 120_000);

  test("a listed address still signs in, and a wrong password is still reported as such", async () => {
    if (!shared || !client) return;
    const h = await harness([KEPT]);
    const admitted = await h.signIn(KEPT, PASSWORD);
    expect(admitted.status).toBe(200);
    expect(setsSessionCookie(admitted)).toBe(true);
    const wrong = await h.signIn(KEPT, "wrong-password-123");
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code?: string }).code).toBe("INVALID_EMAIL_OR_PASSWORD");
  }, 120_000);

  test("Google sign-in for an unlisted existing account redirects with sign_in_email_not_allowed", async () => {
    if (!shared || !client) return;
    const h = await harness([KEPT]);
    const callback = await h.googleCallback();
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!);
    expect(location.origin).toBe("http://opengeni.test");
    expect(location.searchParams.get("error")).toBe("sign_in_email_not_allowed");
    expect(setsSessionCookie(callback)).toBe(false);
  }, 120_000);
});
