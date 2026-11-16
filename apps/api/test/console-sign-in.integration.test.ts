import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createManagedAuth } from "../src/auth/managed-auth";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import { createApp } from "../src/app";
import {
  CONSOLE_SIGN_IN_CODES_PER_MINUTE,
  consoleSignInChallenge,
  consoleSignInStateCookie,
} from "../src/routes/console-sign-in";
import { hasRecentManagedSignIn } from "../src/routes/managed-sign-in-methods";

// Opengeni Console's sign-in handoff end to end against PostgreSQL: Console's
// host starts it, the app host's signed-in browser authorizes it, and Console
// redeems the one-time code for its own host-only session.

let shared: SharedTestDatabase | undefined;
let client: DbClient;
let admin: postgres.Sql;

const APP = "https://app.opengeni.test";
const CONSOLE = "https://console.opengeni.test";
const STAGING_CONSOLE = "https://staging.console.opengeni.test";
const ORG = "4f9c2a51-7d3e-4b8a-9c61-2e5f8a7b9d10";

beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("console-sign-in")) ?? undefined;
  if (!shared) throw new Error("Console sign-in integration requires PostgreSQL");
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function runtime(
  options: {
    mode?: "legacy" | "dual" | "broker";
    allowedUserEmails?: string[];
  } = {},
) {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: options.mode ?? "legacy",
    publicBaseUrl: APP,
    betterAuthAllowedHosts:
      "app.opengeni.test,console.opengeni.test,staging.console.opengeni.test,consolex.opengeni.test",
    betterAuthTrustedOrigins: `${APP},${CONSOLE},${STAGING_CONSOLE}`,
    betterAuthCookiePrefix: "opengeni-staging",
    betterAuthSecret: "console-sign-in-test-secret-at-least-32-bytes-long",
    ...(options.allowedUserEmails ? { allowedUserEmails: options.allowedUserEmails } : {}),
  });
  const auth = createManagedAuth(settings, client.db, {
    sender: "auth@example.test",
    idempotency: { scope: "test:console-sign-in", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  })!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  return { app, adapter, settings };
}
type Runtime = ReturnType<typeof runtime>;

async function signedInAppBrowser(
  rt: Runtime,
  providerId: "credential" | "passkey" = "credential",
) {
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Console Human',${email},true)`;
  // A passkey account's login binding is its `passkey` identity, as passkey sign-up creates it.
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at) values(${crypto.randomUUID()},${userId},${providerId},${userId},null,now(),now())`;
  if (providerId === "passkey") {
    await admin`insert into auth_passkeys(user_id,credential_id,public_key,device_type,name,rp_id)
      values(${userId},${randomBytes(24).toString("base64url")},${randomBytes(32).toString("base64url")},'singleDevice','Laptop','app.opengeni.test')`;
  }
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find((b) => b.providerId === providerId)!;
  const token = randomBytes(24).toString("hex");
  const sessionId = crypto.randomUUID();
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${sessionId},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { userId, email, sessionId, cookie };
}

function onHost(host: string, headers: Record<string, string> = {}): Record<string, string> {
  return { "x-forwarded-host": host, ...headers };
}

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]!)
    .filter((value) => !value.endsWith("="))
    .join("; ");
}

/** Console host: begin the handoff. Returns the verifier cookie and the app URL. */
async function start(rt: Runtime, returnPath: string, host = "console.opengeni.test") {
  const response = await rt.app.request(
    `/v1/console-sign-in/start?${new URLSearchParams({ return: returnPath })}`,
    { headers: onHost(host) },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  return { response, location, stateCookie: cookies(response) };
}

/** App host: the signed-in browser asks for a code. */
function authorize(
  rt: Runtime,
  appCookie: string,
  body: { consoleOrigin: string; returnPath: string; codeChallenge: string },
) {
  return rt.app.request("/v1/console-sign-in/authorize", {
    method: "POST",
    headers: onHost("app.opengeni.test", {
      cookie: appCookie,
      origin: APP,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    }),
    body: JSON.stringify(body),
  });
}

/** Console host: redeem the code with whatever verifier cookie the browser holds. */
function callback(rt: Runtime, redirectUrl: string, stateCookie: string) {
  const url = new URL(redirectUrl);
  return rt.app.request(`${url.pathname}${url.search}`, {
    headers: onHost(url.host, {
      ...(stateCookie ? { cookie: stateCookie } : {}),
      "user-agent": "Console Browser",
    }),
  });
}

async function handoff(rt: Runtime, appCookie: string, returnPath: string) {
  const started = await start(rt, returnPath);
  const granted = await authorize(rt, appCookie, {
    consoleOrigin: started.location.searchParams.get("console")!,
    returnPath: started.location.searchParams.get("return")!,
    codeChallenge: started.location.searchParams.get("challenge")!,
  });
  expect(granted.status).toBe(200);
  const { redirectUrl } = (await granted.json()) as { redirectUrl: string };
  return { started, redirectUrl };
}

async function consoleSession(rt: Runtime, cookie: string) {
  const response = await rt.app.request("/v1/auth/get-session", {
    headers: onHost("console.opengeni.test", { cookie }),
  });
  return (await response.json()) as { user?: { id: string } } | null;
}

function failedOutcome(response: Response, path = "/console"): void {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin).toBe(CONSOLE);
  expect(location.pathname).toBe(path);
  expect(location.searchParams.get("console_sign_in")).toBe("failed");
  expect(
    response.headers
      .getSetCookie()
      .some((value) => value.includes("session_token=") && !value.includes("session_token=;")),
  ).toBe(false);
}

describe("Console sign-in handoff", () => {
  test("a person signed in to the app reaches the Console page and organization they asked for, signed in", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const returnPath = `/console/sessions?org=${ORG}`;
    const { started, redirectUrl } = await handoff(rt, browser.cookie, returnPath);

    // Console sends the browser to the app's own sign-in page with a challenge, never the verifier.
    expect(started.location.origin).toBe(APP);
    expect(started.location.pathname).toBe("/console-sign-in");
    expect(started.location.searchParams.get("console")).toBe(CONSOLE);
    expect(started.location.searchParams.get("return")).toBe(returnPath);
    const stateCookie = consoleSignInStateCookie(rt.settings);
    expect(stateCookie.name).toBe("__Host-opengeni-staging.console_sign_in");
    const setState = started.response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${stateCookie.name}=`))!;
    expect(setState).toContain("HttpOnly");
    expect(setState).toContain("Secure");
    expect(setState).toContain("Path=/");
    expect(setState).not.toContain("Domain");
    const verifier = setState.split(";", 1)[0]!.split("=")[1]!;
    expect(started.location.searchParams.get("challenge")).toBe(consoleSignInChallenge(verifier));
    expect(started.location.toString()).not.toContain(verifier);

    // The code goes only to the Console host's callback, and only its hash is stored.
    const code = new URL(redirectUrl).searchParams.get("code")!;
    expect(new URL(redirectUrl).origin).toBe(CONSOLE);
    const stored = await admin<{ identifier: string; value: string }[]>`
      select identifier, value from auth_verifications where value like ${`%${browser.sessionId}%`}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.identifier).not.toContain(code);
    expect(stored[0]!.value).not.toContain(code);

    const redeemed = await callback(rt, redirectUrl, started.stateCookie);
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe(`${CONSOLE}${returnPath}`);
    const sessionCookie = redeemed.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-opengeni-staging.session_token="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).not.toContain("Domain");
    // The verifier is spent.
    expect(
      redeemed.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${stateCookie.name}=;`) && value.includes("Max-Age=0")),
    ).toBe(true);

    // Console's own session for the same person, separate from the app's.
    const session = await consoleSession(rt, cookies(redeemed));
    expect(session?.user?.id).toBe(browser.userId);
    const rows = await admin<{ id: string; userAgent: string }[]>`
      select id, user_agent as "userAgent" from auth_sessions where user_id = ${browser.userId} order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== browser.sessionId)?.userAgent).toBe("Console Browser");

    const [audit] = await admin<
      { action: string; subjectId: string; targetId: string; metadata: Record<string, string> }[]
    >`
      select action, subject_id as "subjectId", target_id as "targetId", metadata from audit_events
      where subject_id = ${`user:${browser.userId}`} and action = 'auth.console_sign_in_handoff'`;
    expect(audit?.targetId).toBe(rows.find((row) => row.id !== browser.sessionId)!.id);
    expect(JSON.stringify(audit?.metadata)).toContain("signed_in");
    expect(JSON.stringify(audit?.metadata)).toContain(browser.sessionId);
    expect(JSON.stringify(audit?.metadata)).not.toContain(code);
  }, 120_000);

  test("a passkey session hands off too, and its admin step-up carries over", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt, "passkey");
    await admin`update auth_sessions set mfa_verified_at = now() where id = ${browser.sessionId}`;
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console/members");
    const redeemed = await callback(rt, redirectUrl, started.stateCookie);
    expect(redeemed.headers.get("location")).toBe(`${CONSOLE}/console/members`);
    const [row] = await admin<{ verified: boolean }[]>`
      select mfa_verified_at is not null as verified from auth_sessions
      where user_id = ${browser.userId} and id <> ${browser.sessionId}`;
    expect(row?.verified).toBe(true);
  }, 120_000);

  test("without a step-up on the app session, Console's session has none", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console");
    await callback(rt, redirectUrl, started.stateCookie);
    const [row] = await admin<{ verified: boolean }[]>`
      select mfa_verified_at is not null as verified from auth_sessions
      where user_id = ${browser.userId} and id <> ${browser.sessionId}`;
    expect(row?.verified).toBe(false);
  }, 120_000);

  test("the handoff is not a fresh sign-in: Console keeps the app session's sign-in time", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    await admin`update auth_sessions set created_at = now() - interval '1 hour' where id = ${browser.sessionId}`;
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console");
    expect((await callback(rt, redirectUrl, started.stateCookie)).status).toBe(302);
    const [consoleRow] = await admin<{ id: string; inherited: boolean }[]>`
      select console.id, console.created_at = app.created_at as inherited
      from auth_sessions console, auth_sessions app
      where console.user_id = ${browser.userId} and console.id <> ${browser.sessionId}
        and app.id = ${browser.sessionId}`;
    expect(consoleRow?.inherited).toBe(true);
    // Re-authentication-gated changes on Console still ask for a real sign-in.
    expect(
      await hasRecentManagedSignIn(
        { db: client.db },
        { authSessionId: consoleRow!.id, authUserId: browser.userId },
      ),
    ).toBe(false);
  }, 120_000);

  test("Console can't mint codes for itself, and a new handoff replaces Console's old session", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const first = await handoff(rt, browser.cookie, "/console");
    const firstConsole = cookies(await callback(rt, first.redirectUrl, first.started.stateCookie));
    const fromConsole = await rt.app.request("/v1/console-sign-in/authorize", {
      method: "POST",
      headers: onHost("console.opengeni.test", {
        cookie: firstConsole,
        origin: CONSOLE,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        consoleOrigin: CONSOLE,
        returnPath: "/console",
        codeChallenge: consoleSignInChallenge(randomBytes(32).toString("base64url")),
      }),
    });
    expect(fromConsole.status).toBe(404);

    const second = await handoff(rt, browser.cookie, "/console");
    const redeemed = await callback(
      rt,
      second.redirectUrl,
      `${second.started.stateCookie}; ${firstConsole}`,
    );
    expect(redeemed.status).toBe(302);
    const sessions = await admin`select 1 from auth_sessions where user_id = ${browser.userId}`;
    expect(sessions).toHaveLength(2);
    expect((await consoleSession(rt, firstConsole))?.user).toBeUndefined();
    expect((await consoleSession(rt, cookies(redeemed)))?.user?.id).toBe(browser.userId);
  }, 120_000);

  test("asking for codes is rate limited per person", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const body = {
      consoleOrigin: CONSOLE,
      returnPath: "/console",
      codeChallenge: consoleSignInChallenge(randomBytes(32).toString("base64url")),
    };
    for (let attempt = 0; attempt < CONSOLE_SIGN_IN_CODES_PER_MINUTE; attempt += 1) {
      expect((await authorize(rt, browser.cookie, body)).status).toBe(200);
    }
    expect((await authorize(rt, browser.cookie, body)).status).toBe(429);
  }, 120_000);

  test("a code works once", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console/usage");
    expect((await callback(rt, redirectUrl, started.stateCookie)).status).toBe(302);
    failedOutcome(await callback(rt, redirectUrl, started.stateCookie));
  }, 120_000);

  test("an expired code is refused", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console");
    await admin`update auth_verifications set expires_at = now() - interval '1 second'
      where value like ${`%${browser.sessionId}%`}`;
    failedOutcome(await callback(rt, redirectUrl, started.stateCookie));
    const rows = await admin`select 1 from auth_sessions where user_id = ${browser.userId}`;
    expect(rows).toHaveLength(1);
  }, 120_000);

  test("a code is refused without this browser's verifier, and is spent by the attempt", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console/api-keys");
    // Another browser (no verifier, or its own) can't redeem a code it was given.
    failedOutcome(await callback(rt, redirectUrl, ""), "/console/api-keys");
    const other = await start(rt, "/console");
    failedOutcome(await callback(rt, redirectUrl, other.stateCookie));
    // The rightful browser can't redeem it after that either: start again.
    failedOutcome(await callback(rt, redirectUrl, started.stateCookie));
    const rows = await admin`select 1 from auth_sessions where user_id = ${browser.userId}`;
    expect(rows).toHaveLength(1);
    const refusals = await admin<{ metadata: unknown }[]>`
      select metadata from audit_events where subject_id = ${`user:${browser.userId}`}
        and action = 'auth.console_sign_in_handoff'`;
    expect(JSON.stringify(refusals[0]?.metadata)).toContain("state_mismatch");
  }, 120_000);

  test("a code for one Console host doesn't sign in another", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console");
    const elsewhere = new URL(redirectUrl);
    elsewhere.host = "staging.console.opengeni.test";
    const response = await callback(rt, elsewhere.toString(), started.stateCookie);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(STAGING_CONSOLE);
    expect(location.searchParams.get("console_sign_in")).toBe("failed");
  }, 120_000);

  test("signing out of the app before the code is redeemed cancels it", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const { started, redirectUrl } = await handoff(rt, browser.cookie, "/console");
    await admin`delete from auth_sessions where id = ${browser.sessionId}`;
    failedOutcome(await callback(rt, redirectUrl, started.stateCookie));
  }, 120_000);

  test("an address taken off the allowed list is refused, not a server error", async () => {
    const open = runtime();
    const browser = await signedInAppBrowser(open);
    const { started, redirectUrl } = await handoff(open, browser.cookie, "/console");
    const restricted = runtime({ allowedUserEmails: ["someone-else@example.test"] });
    failedOutcome(await callback(restricted, redirectUrl, started.stateCookie));
  }, 120_000);

  test("redirects never leave the configured Console origins or Console's pages", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    for (const unsafe of [
      "https://evil.test/console",
      "//evil.test/console",
      "/\\evil.test",
      "/console/../workspaces",
      "/consolex",
      "/settings",
      "javascript:alert(1)",
    ]) {
      const { location } = await start(rt, unsafe);
      expect(location.searchParams.get("return")).toBe("/console");
    }

    // Only a configured Console origin can receive a code.
    for (const consoleOrigin of [
      "https://evil.test",
      "https://console.evil.test",
      "https://consolex.opengeni.test",
      APP,
      "http://console.opengeni.test",
    ]) {
      const refused = await authorize(rt, browser.cookie, {
        consoleOrigin,
        returnPath: "/console",
        codeChallenge: consoleSignInChallenge(randomBytes(32).toString("base64url")),
      });
      expect(refused.status).toBe(400);
    }
    // A crafted return path is narrowed to Console's own pages.
    const granted = await authorize(rt, browser.cookie, {
      consoleOrigin: CONSOLE,
      returnPath: "//evil.test/x",
      codeChallenge: consoleSignInChallenge(randomBytes(32).toString("base64url")),
    });
    expect(granted.status).toBe(200);
    const stored = await admin<{ value: string }[]>`
      select value from auth_verifications where value like ${`%${browser.sessionId}%`}`;
    expect(JSON.parse(stored[0]!.value).returnPath).toBe("/console");

    // Start and callback answer only on a Console host.
    for (const host of ["app.opengeni.test", "consolex.opengeni.test", "evil.test"]) {
      const startElsewhere = await rt.app.request("/v1/console-sign-in/start?return=/console", {
        headers: onHost(host),
      });
      expect(startElsewhere.status).toBe(404);
      const callbackElsewhere = await rt.app.request(
        `/v1/console-sign-in/callback?code=${"a".repeat(43)}`,
        { headers: onHost(host) },
      );
      expect(callbackElsewhere.status).toBe(404);
    }
  }, 120_000);

  test("only a signed-in, same-origin app browser can ask for a code", async () => {
    const rt = runtime();
    const browser = await signedInAppBrowser(rt);
    const body = JSON.stringify({
      consoleOrigin: CONSOLE,
      returnPath: "/console",
      codeChallenge: consoleSignInChallenge(randomBytes(32).toString("base64url")),
    });
    const signedOut = await rt.app.request("/v1/console-sign-in/authorize", {
      method: "POST",
      headers: onHost("app.opengeni.test", {
        origin: APP,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }),
      body,
    });
    expect(signedOut.status).toBe(401);
    const crossSite = await rt.app.request("/v1/console-sign-in/authorize", {
      method: "POST",
      headers: onHost("app.opengeni.test", {
        cookie: browser.cookie,
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      }),
      body,
    });
    expect(crossSite.status).toBe(403);
  }, 120_000);

  test("deployments with browser login session sets keep Console's own sign-in", async () => {
    const rt = runtime({ mode: "broker" });
    const { location } = await start(rt, `/console?org=${ORG}`);
    expect(location.origin).toBe(CONSOLE);
    expect(location.searchParams.get("console_sign_in")).toBe("unavailable");
    expect(location.searchParams.get("org")).toBe(ORG);
  }, 120_000);
});
