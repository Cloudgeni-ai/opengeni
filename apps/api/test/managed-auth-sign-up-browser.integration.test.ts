import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { createManagedAuth, verifyManagedAuthPassword } from "../src/auth/managed-auth";

// Verifying an email address proves who controls it, not who chose the
// password stored on the account. A password becomes usable on verification
// only when the address is verified from the browser that chose it at sign-up;
// otherwise the address is verified with no usable password until a reset.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 10;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("managed-auth-sign-up-browser");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("sign-up browser verification tests require PostgreSQL");
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
  idempotency: { scope: "test:sign-up-browser", retentionSeconds: 86_400 },
  send: async (message) => {
    mail.push(message);
    return { status: "sent" as const, providerMessageId: null };
  },
};

const BROWSER_COOKIE = "opengeni.sign_up_browser";

/** A browser: its cookies persist across the requests it sends. */
class Browser {
  readonly cookies = new Map<string, string>();
  store(response: Response): Response {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";", 1);
      const separator = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
    }
    return response;
  }
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function requestHeaders(browser?: Browser): Record<string, string> {
  clientAddress += 1;
  const cookie = browser?.header();
  return {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": `198.51.100.${clientAddress % 250}`,
    ...(cookie ? { cookie } : {}),
  };
}

function linkIn(message: ManagedEmailMessage | undefined): URL {
  return new URL(message!.text.match(/https?:\/\/\S+/u)![0]);
}

function harness(managedAuthSessionSetMode: "legacy" | "dual" | "broker" = "legacy") {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-sign-up-browser-test-secret-at-least-32-bytes",
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
  /** Sign up in `browser`; returns the response and the verification link it mailed. */
  const signUp = async (
    browser: Browser,
    email: string,
    name: string,
    password: string,
    init: { headers?: Record<string, string | undefined>; body?: string } = {},
  ) => {
    const before = mail.length;
    const headers = Object.fromEntries(
      Object.entries({ ...requestHeaders(browser), ...init.headers }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const response = browser.store(
      await app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers,
        body: init.body ?? JSON.stringify({ name, email, password }),
      }),
    );
    const sent = mail
      .slice(before)
      .filter((message) => message.kind === "email_verification" && message.to === email);
    expect(sent).toHaveLength(1);
    return { response, link: linkIn(sent[0]) };
  };
  const follow = async (browser: Browser, link: URL) =>
    browser.store(
      await app.request(`${link.pathname}${link.search}`, { headers: requestHeaders(browser) }),
    );
  const signIn = (email: string, password: string) =>
    app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password }),
    });
  const resetPassword = async (email: string, newPassword: string) => {
    const before = mail.length;
    const requested = await app.request("/v1/auth/request-password-reset", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, redirectTo: "http://opengeni.test/reset-password" }),
    });
    expect(requested.status).toBe(200);
    const link = linkIn(
      mail
        .slice(before)
        .find((message) => message.kind === "password_reset" && message.to === email),
    );
    const reset = await app.request("/v1/auth/reset-password", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ token: link.pathname.split("/").at(-1), newPassword }),
    });
    expect(reset.status).toBe(200);
  };
  return { app, signUp, follow, signIn, resetPassword };
}

async function accountState(email: string) {
  const [row] = await shared!.admin<
    Array<{ users: number; verified: boolean | null; passwords: number; sessions: number }>
  >`
    select count(distinct u.id)::int as users,
           bool_and(u.email_verified) as verified,
           (select count(*)::int from auth_identities i
             join auth_users v on v.id = i.user_id
            where lower(v.email) = lower(${email}) and i.provider_id = 'credential'
              and i.password is not null) as passwords,
           (select count(*)::int from auth_sessions s
             join auth_users v on v.id = s.user_id
            where lower(v.email) = lower(${email})) as sessions
      from auth_users u
     where lower(u.email) = lower(${email})`;
  return row!;
}

function signedIn(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some((cookie) => cookie.startsWith("better-auth.session_token=") && !cookie.includes("=;"));
}

describe("email verification keeps only the verifying browser's password", () => {
  test("the owner signs up after someone else and verifies in their own browser", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `owner-${crypto.randomUUID()}@example.test`;
    const other = new Browser();
    const owner = new Browser();

    const first = await h.signUp(other, email, "First", "first-password-123");
    expect(first.response.status).toBe(200);
    expect((await h.signIn(email, "first-password-123")).status).toBe(403);

    // The owner's sign-up for the same address answers exactly like a fresh
    // one: same status, body shape and browser cookie.
    const second = await h.signUp(owner, email, "Owner", "owner-password-456");
    expect(second.response.status).toBe(first.response.status);
    type SignUpBody = { token: unknown; user: Record<string, unknown> };
    const firstBody = (await first.response.json()) as SignUpBody;
    const secondBody = (await second.response.json()) as SignUpBody;
    expect(secondBody.token).toBeNull();
    expect(secondBody.user.emailVerified).toBe(false);
    expect(Object.keys(secondBody).sort()).toEqual(Object.keys(firstBody).sort());
    expect(Object.keys(secondBody.user).sort()).toEqual(Object.keys(firstBody.user).sort());
    for (const response of [first.response, second.response]) {
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${BROWSER_COOKIE}=`));
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/v1/auth");
    }
    expect(owner.cookies.get(BROWSER_COOKIE)).not.toBe(other.cookies.get(BROWSER_COOKIE));

    // Either mailed link, opened in the owner's browser, keeps the owner's password.
    const verified = await h.follow(owner, first.link);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    expect(signedIn(verified)).toBe(true);
    expect(await accountState(email)).toMatchObject({ users: 1, verified: true, passwords: 1 });
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);
    expect((await h.signIn(email, "owner-password-456")).status).toBe(200);

    // A later click elsewhere (a mail scanner, the other link) changes nothing.
    expect((await h.follow(new Browser(), second.link)).headers.get("location")).toBe("/");
    expect((await h.signIn(email, "owner-password-456")).status).toBe(200);

    // Once verified, a further sign-up changes nothing either.
    const later = await h.app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(other),
      body: JSON.stringify({ name: "Later", email, password: "later-password-789" }),
    });
    expect(later.status).toBe(200);
    expect((await h.signIn(email, "later-password-789")).status).toBe(401);
    expect((await h.signIn(email, "owner-password-456")).status).toBe(200);
  }, 120_000);

  test("the owner follows someone else's sign-up link in a different browser", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `unsolicited-${crypto.randomUUID()}@example.test`;
    const other = new Browser();
    const first = await h.signUp(other, email, "First", "first-password-123");

    // The owner never signed up; their browser has no sign-up for this address.
    const owner = new Browser();
    const verified = await h.follow(owner, first.link);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    expect(await accountState(email)).toMatchObject({ users: 1, verified: true, passwords: 0 });

    // No password signs in until the owner sets one with a reset.
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);
    await h.resetPassword(email, "owner-reset-password-1");
    expect((await h.signIn(email, "first-password-123")).status).toBe(401);
    expect((await h.signIn(email, "owner-reset-password-1")).status).toBe(200);
  }, 120_000);

  test("a new link requested in the sign-up browser keeps that browser's password", async () => {
    if (!shared || !client) return;
    const h = harness();
    const email = `resend-${crypto.randomUUID()}@example.test`;
    const browser = new Browser();
    await h.signUp(browser, email, "Resend", "resend-password-1");
    const before = mail.length;
    const resend = await h.app.request("/v1/auth/send-verification-email", {
      method: "POST",
      headers: requestHeaders(browser),
      body: JSON.stringify({ email }),
    });
    expect(resend.status).toBe(200);
    const link = linkIn(
      mail
        .slice(before)
        .find((message) => message.kind === "email_verification" && message.to === email),
    );
    expect((await h.follow(browser, link)).headers.get("location")).toBe("/");
    expect((await h.signIn(email, "resend-password-1")).status).toBe(200);
  }, 120_000);

  test("a sign-up another site makes the owner's browser send never keeps its password", async () => {
    if (!shared || !client) return;
    const h = harness();
    const owner = new Browser();
    const cases = [
      {
        label: "foreign-origin",
        headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      },
      { label: "no-origin", headers: { origin: undefined, "sec-fetch-site": undefined } },
    ];
    for (const { label, headers } of cases) {
      const email = `${label}-${crypto.randomUUID()}@example.test`;
      const planted = await h.signUp(owner, email, "Planted", "planted-password-1", { headers });
      expect(planted.response.status).toBe(200);
      expect(owner.cookies.get(BROWSER_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      // The owner later verifies in that same browser: the address is
      // verified, but the planted password never becomes usable.
      expect((await h.follow(owner, planted.link)).headers.get("location")).toBe("/");
      expect(await accountState(email)).toMatchObject({ verified: true, passwords: 0 });
      expect((await h.signIn(email, "planted-password-1")).status).toBe(401);
    }
  }, 120_000);

  for (const mode of ["dual", "broker"] as const) {
    test(`session-set ${mode} mode binds verification to the sign-up browser the same way`, async () => {
      if (!shared || !client) return;
      const h = harness(mode);
      const other = new Browser();
      const owner = new Browser();
      // Someone else signs up first; the owner signs up and verifies in their browser.
      const contested = `owner-${mode}-${crypto.randomUUID()}@example.test`;
      const first = await h.signUp(other, contested, "First", "first-password-123");
      await h.signUp(owner, contested, "Owner", "owner-password-456");
      expect((await h.follow(owner, first.link)).status).toBe(302);
      const [stored] = await shared!.admin<Array<{ password: string }>>`
        select i.password from auth_identities i join auth_users u on u.id = i.user_id
         where lower(u.email) = lower(${contested}) and i.provider_id = 'credential'`;
      expect(await verifyManagedAuthPassword("owner-password-456", stored!.password)).toBe(true);
      expect(await verifyManagedAuthPassword("first-password-123", stored!.password)).toBe(false);

      // An unsolicited link followed in another browser leaves no password.
      const unsolicited = `unsolicited-${mode}-${crypto.randomUUID()}@example.test`;
      const theirs = await h.signUp(other, unsolicited, "First", "first-password-123");
      expect((await h.follow(new Browser(), theirs.link)).status).toBe(302);
      expect(await accountState(unsolicited)).toMatchObject({ verified: true, passwords: 0 });
    }, 120_000);
  }
});
