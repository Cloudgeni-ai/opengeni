import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { createManagedAuth, verifyManagedAuthPassword } from "../src/auth/managed-auth";

// Verifying an email address proves who controls it, not who chose the
// password stored on the account. While the address is unverified the newest
// sign-up's password replaces any earlier one, and only the newest sign-up's
// verification link verifies the address, from any browser or device.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-sign-up-verification");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("sign-up verification tests require PostgreSQL");
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
  idempotency: { scope: "test:sign-up-verification", retentionSeconds: 86_400 },
  send: async (message) => {
    mail.push(message);
    return { status: "sent" as const, providerMessageId: null };
  },
};

/** Headers of a request from a browser of its own: no cookies carry over. */
function requestHeaders(): Record<string, string> {
  clientAddress += 1;
  return {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": `198.51.100.${clientAddress % 250}`,
  };
}

function linkIn(message: ManagedEmailMessage | undefined): URL {
  return new URL(message!.text.match(/https?:\/\/\S+/u)![0]);
}

function verificationMailTo(email: string, since: number): ManagedEmailMessage[] {
  return mail
    .slice(since)
    .filter((message) => message.kind === "email_verification" && message.to === email);
}

function harness(managedAuthSessionSetMode: "legacy" | "dual" | "broker" = "legacy") {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-sign-up-verification-test-secret-32-bytes",
    managedAuthRequireEmailVerification: true,
    managedAuthSessionSetMode,
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
  /** Sign up; returns the response and the verification link it mailed. */
  const signUp = async (email: string, name: string, password: string) => {
    const before = mail.length;
    const response = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name, email, password }),
    });
    const sent = verificationMailTo(email, before);
    expect(sent).toHaveLength(1);
    return { response, link: linkIn(sent[0]) };
  };
  /** Follow a link from a fresh browser or device. */
  const follow = (link: URL) =>
    app.request(`${link.pathname}${link.search}`, { headers: requestHeaders() });
  const signIn = (email: string, password: string) =>
    app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password }),
    });
  const resend = async (email: string) => {
    const before = mail.length;
    const response = await app.request("/v1/auth/send-verification-email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(response.status).toBe(200);
    const sent = verificationMailTo(email, before);
    expect(sent).toHaveLength(1);
    return linkIn(sent[0]);
  };
  return { app, signUp, follow, signIn, resend };
}

async function accountState(email: string) {
  const [row] = await shared!.admin<Array<{ users: number; verified: boolean | null }>>`
    select count(*)::int as users, bool_and(email_verified) as verified
      from auth_users where lower(email) = lower(${email})`;
  return row!;
}

async function storedPassword(email: string): Promise<string> {
  const [row] = await shared!.admin<Array<{ password: string }>>`
    select i.password from auth_identities i join auth_users u on u.id = i.user_id
     where lower(u.email) = lower(${email}) and i.provider_id = 'credential'`;
  return row!.password;
}

function signedIn(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some((cookie) => cookie.startsWith("better-auth.session_token=") && !cookie.includes("=;"));
}

describe("email verification keeps the newest sign-up's password", () => {
  test("verifying from another browser keeps the sign-up's password", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `device-${crypto.randomUUID()}@example.test`;
    const signUp = await h.signUp(email, "Device", "device-password-1");
    expect(signUp.response.status).toBe(200);
    expect(
      signUp.response.headers.getSetCookie().filter((cookie) => !cookie.includes("=;")),
    ).toEqual([]);
    expect((await h.signIn(email, "device-password-1")).status).toBe(403);

    // A mail scanner, or the person on another device, opens the link.
    const verified = await h.follow(signUp.link);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    expect(signedIn(verified)).toBe(true);
    expect(await accountState(email)).toEqual({ users: 1, verified: true });
    expect((await h.signIn(email, "device-password-1")).status).toBe(200);

    // Opening it again only redirects and changes nothing.
    const again = await h.follow(signUp.link);
    expect(again.headers.get("location")).toBe("/");
    expect(signedIn(again)).toBe(false);
    expect((await h.signIn(email, "device-password-1")).status).toBe(200);
  }, 120_000);

  test("someone else signs up first; the owner signs up later and verifies", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `owner-${crypto.randomUUID()}@example.test`;
    const first = await h.signUp(email, "First", "first-password-123");
    const second = await h.signUp(email, "Owner", "owner-password-456");

    // The repeated sign-up answers exactly like a fresh one.
    expect(second.response.status).toBe(first.response.status);
    type SignUpBody = { token: unknown; user: Record<string, unknown> };
    const firstBody = (await first.response.json()) as SignUpBody;
    const secondBody = (await second.response.json()) as SignUpBody;
    expect(secondBody.token).toBeNull();
    expect(secondBody.user.emailVerified).toBe(false);
    expect(Object.keys(secondBody).sort()).toEqual(Object.keys(firstBody).sort());
    expect(Object.keys(secondBody.user).sort()).toEqual(Object.keys(firstBody.user).sort());

    // The owner's password replaced the earlier one.
    expect(await verifyManagedAuthPassword("owner-password-456", await storedPassword(email))).toBe(
      true,
    );

    const verified = await h.follow(second.link);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    expect(await accountState(email)).toEqual({ users: 1, verified: true });
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);
    expect((await h.signIn(email, "owner-password-456")).status).toBe(200);

    // Once verified, a further sign-up changes nothing and sends nothing.
    const before = mail.length;
    const later = await h.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Later", email, password: "later-password-789" }),
    });
    expect(later.status).toBe(200);
    expect(verificationMailTo(email, before)).toHaveLength(0);
    expect((await h.signIn(email, "later-password-789")).status).toBe(401);
    expect((await h.signIn(email, "owner-password-456")).status).toBe(200);
  }, 120_000);

  test("an earlier sign-up's link stops working after a newer sign-up", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `superseded-${crypto.randomUUID()}@example.test`;
    const first = await h.signUp(email, "First", "first-password-123");
    const second = await h.signUp(email, "Second", "second-password-456");

    // The earlier link is refused like any invalid link and verifies nothing.
    const stale = await h.follow(first.link);
    expect(stale.status).toBe(302);
    expect(stale.headers.get("location")).toBe("/?error=INVALID_TOKEN");
    expect(signedIn(stale)).toBe(false);
    const withoutCallback = new URL(first.link);
    withoutCallback.searchParams.delete("callbackURL");
    const staleJson = await h.follow(withoutCallback);
    expect(staleJson.status).toBe(401);
    expect(((await staleJson.json()) as { code?: string }).code).toBe("INVALID_TOKEN");
    expect(await accountState(email)).toEqual({ users: 1, verified: false });
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);

    // The newest link still verifies with the newest password.
    expect((await h.follow(second.link)).headers.get("location")).toBe("/");
    expect(await accountState(email)).toEqual({ users: 1, verified: true });
    expect((await h.signIn(email, "second-password-456")).status).toBe(200);
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);
  }, 120_000);

  test("a requested new email carries a link for the newest sign-up", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `resend-${crypto.randomUUID()}@example.test`;
    const first = await h.signUp(email, "Resend", "resend-password-1");
    const resent = await h.resend(email);

    // A newer sign-up invalidates the resent link too.
    await h.signUp(email, "Resend", "resend-password-2");
    expect((await h.follow(resent)).headers.get("location")).toBe("/?error=INVALID_TOKEN");
    expect((await h.follow(first.link)).headers.get("location")).toBe("/?error=INVALID_TOKEN");

    const current = await h.resend(email);
    expect((await h.follow(current)).headers.get("location")).toBe("/");
    expect((await h.signIn(email, "resend-password-2")).status).toBe(200);
    expect((await h.signIn(email, "resend-password-1")).status).toBe(401);
  }, 120_000);

  for (const mode of ["dual", "broker"] as const) {
    test(`session-set ${mode} mode keeps the newest sign-up's password the same way`, async () => {
      if (!shared || !client) return;
      const h = harness(mode);
      const email = `owner-${mode}-${crypto.randomUUID()}@example.test`;
      const first = await h.signUp(email, "First", "first-password-123");
      const second = await h.signUp(email, "Owner", "owner-password-456");
      expect((await h.follow(first.link)).headers.get("location")).toBe("/?error=INVALID_TOKEN");
      expect((await h.follow(second.link)).status).toBe(302);
      expect(await accountState(email)).toEqual({ users: 1, verified: true });
      const stored = await storedPassword(email);
      expect(await verifyManagedAuthPassword("owner-password-456", stored)).toBe(true);
      expect(await verifyManagedAuthPassword("first-password-123", stored)).toBe(false);
    }, 120_000);
  }
});
