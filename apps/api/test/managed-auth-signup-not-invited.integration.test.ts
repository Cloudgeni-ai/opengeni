import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MANAGED_AUTH_SIGNUP_NOT_INVITED_CODE } from "@opengeni/contracts";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";

// An invite-only deployment (allowedUserEmails) refuses an uninvited address
// with a typed reason, so the sign-in page can say who to ask instead of a
// generic "try again" that can never succeed.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;
const INVITED = `invited-${crypto.randomUUID()}@example.test`;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-signup-not-invited");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("invite-only sign-up tests require PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const mail: ManagedEmailMessage[] = [];
const transport: ManagedEmailTransport = {
  sender: "auth@example.test",
  idempotency: { scope: "test:signup-not-invited", retentionSeconds: 86_400 },
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

async function authUserCount(email: string): Promise<number> {
  const [row] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from auth_users where lower(email) = lower(${email})`;
  return row!.count;
}

async function harness() {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-signup-not-invited-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthSessionSetMode: "legacy",
    allowedUserEmails: [INVITED],
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
  return {
    app,
    googleUser: (user: { id: string; email: string }) => {
      google.getUserInfo = async () => ({
        user: { id: user.id, name: "Provider Human", email: user.email, emailVerified: true },
        data: {},
      });
    },
  };
}

describe("invite-only sign-up", () => {
  test("email sign-up for an uninvited address is refused with a typed reason", async () => {
    if (!shared || !client) return;
    const h = await harness();
    const email = `uninvited-${crypto.randomUUID()}@example.test`;
    const mailBefore = mail.length;
    const refused = await h.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "New Human", email, password: "new-password-123" }),
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe(
      MANAGED_AUTH_SIGNUP_NOT_INVITED_CODE,
    );
    expect(mail.length).toBe(mailBefore);
    expect(await authUserCount(email)).toBe(0);

    const admitted = await h.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Invited Human", email: INVITED, password: "new-password-123" }),
    });
    expect(admitted.status).toBeLessThan(300);
    expect(await authUserCount(INVITED)).toBe(1);
  }, 120_000);

  test("Google sign-up for an uninvited address redirects with signup_not_invited", async () => {
    if (!shared || !client) return;
    const h = await harness();
    const id = crypto.randomUUID();
    const email = `uninvited-social-${id}@example.test`;
    h.googleUser({ id, email });
    const start = await h.app.request("/v1/auth/sign-in/social", {
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
    const callback = await h.app.request(
      `/v1/auth/callback/google?state=${authorization.searchParams.get("state")}&code=simulated-provider-code`,
      { headers: requestHeaders(cookiePairs(start)) },
    );
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!);
    expect(location.origin).toBe("http://opengeni.test");
    expect(location.searchParams.get("error")).toBe("signup_not_invited");
    expect(callback.headers.getSetCookie().some((value) => value.includes("session_token="))).toBe(
      false,
    );
    expect(await authUserCount(email)).toBe(0);
  }, 120_000);
});
