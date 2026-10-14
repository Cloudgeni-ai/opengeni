import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createManagedAuth } from "../src/auth/managed-auth";
import { createApp } from "../src/app";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import { nativeAppSessionUserAgent } from "../src/routes/native-app-auth";

// Desktop sign-in: the system browser approves the device, the app redeems the
// code, then signs its own web window in with that same device session.

let shared: SharedTestDatabase | undefined;
let client: DbClient;
let admin: postgres.Sql;
const ORIGIN = "http://opengeni.test";

beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("native-app-desktop-sign-in")) ?? undefined;
  if (!shared) throw new Error("Native desktop sign-in integration requires PostgreSQL");
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function runtime(mode: "legacy" | "dual" | "broker" = "legacy") {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: mode,
    publicBaseUrl: ORIGIN,
    betterAuthSecret: "native-desktop-sign-in-test-secret-at-least-32-bytes",
  });
  const auth = createManagedAuth(settings, client.db, {
    sender: "auth@example.test",
    idempotency: { scope: "test:native-desktop", retentionSeconds: 86400 },
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
  return { app, adapter };
}

async function signedInBrowser(rt: ReturnType<typeof runtime>) {
  const userId = crypto.randomUUID();
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Desk Human',${`${userId}@example.test`},true)`;
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at) values(${crypto.randomUUID()},${userId},'credential',${userId},null,now(),now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find((b) => b.providerId === "credential")!;
  const token = randomBytes(24).toString("hex");
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { userId, cookie };
}

async function desktopCredential(rt: ReturnType<typeof runtime>, browserCookie: string) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await rt.app.request("/v1/native-app/authorize", {
    method: "POST",
    headers: {
      cookie: browserCookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      redirectUri: "opengeni://auth/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      platform: "macos",
      deviceName: "Studio Mac",
    }),
  });
  expect(authorize.status).toBe(200);
  const { redirectUrl } = (await authorize.json()) as { redirectUrl: string };
  const code = new URL(redirectUrl).searchParams.get("code")!;
  const token = await rt.app.request("/v1/native-app/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: "opengeni://auth/callback" }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { accessToken: string }).accessToken;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value) => !value.endsWith("="))
    .join("; ");
}

describe("desktop app sign-in", () => {
  test("a desktop device session signs its own web window in and labels the device", async () => {
    const rt = runtime();
    const browser = await signedInBrowser(rt);
    const credential = await desktopCredential(rt, browser.cookie);
    expect(credential.startsWith("ogapp_")).toBe(true);

    const handoff = await rt.app.request("/v1/native-app/web-session", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(handoff.status).toBe(200);
    const windowCookie = cookieHeader(handoff);
    expect(windowCookie).toContain(encodeURIComponent(credential.slice("ogapp_".length)));
    for (const value of handoff.headers.getSetCookie().filter((c) => !c.includes("=;"))) {
      expect(value).toContain("HttpOnly");
    }

    // The window's cookie is the device session itself.
    const [row] = await admin<{ userAgent: string; userId: string }[]>`
      select user_agent as "userAgent", user_id as "userId" from auth_sessions
      where token = ${credential.slice("ogapp_".length)}`;
    expect(row?.userId).toBe(browser.userId);
    expect(row?.userAgent).toBe(nativeAppSessionUserAgent("macos", "Studio Mac"));

    // Signing the device out ends the window's session too.
    const signOut = await rt.app.request("/v1/native-app/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(signOut.status).toBe(200);
    const again = await rt.app.request("/v1/native-app/web-session", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(again.status).toBe(401);
  }, 120_000);

  test("only a device credential can mint the window cookie", async () => {
    const rt = runtime();
    const browser = await signedInBrowser(rt);
    const ambient = await rt.app.request("/v1/native-app/web-session", {
      method: "POST",
      headers: { cookie: browser.cookie },
    });
    expect(ambient.status).toBe(401);
    expect(ambient.headers.getSetCookie()).toEqual([]);
    const forged = await rt.app.request("/v1/native-app/web-session", {
      method: "POST",
      headers: { authorization: `Bearer ogapp_${"a".repeat(32)}` },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.getSetCookie()).toEqual([]);
  }, 120_000);

  test("broker deployments refuse the legacy window cookie", async () => {
    const legacy = runtime();
    const browser = await signedInBrowser(legacy);
    const credential = await desktopCredential(legacy, browser.cookie);
    const response = await runtime("broker").app.request("/v1/native-app/web-session", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
  }, 120_000);

  test("names every desktop platform", () => {
    expect(nativeAppSessionUserAgent("windows", null)).toBe("Opengeni app (Windows)");
    expect(nativeAppSessionUserAgent("linux", "Box")).toBe("Opengeni app (Linux; Box)");
    expect(nativeAppSessionUserAgent("ios", null)).toBe("Opengeni app (iOS)");
  });
});
