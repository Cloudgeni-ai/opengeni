import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("display-identity-api");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await migrate(shared.adminUrl);
  await provisionRoles(shared.adminUrl, {
    appPassword: decodeURIComponent(new URL(shared.appUrl).password),
  });
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

const LANDING = "https://www.opengeni.test";

describe("display identity with Better Auth and PostgreSQL (legacy session mode)", () => {
  test("a signed-in browser reads only its display identity from the landing origin", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        managedAuthSessionSetMode: "legacy",
        betterAuthSecret: "display-identity-integration-secret-32-bytes",
        publicBaseUrl: "http://opengeni.test",
        corsAllowOriginRegex: "http://opengeni[.]test",
        landingOrigins: LANDING,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `display-identity-${crypto.randomUUID()}@example.test`;
    const password = "password1234";

    const signedOut = await app.request("/v1/auth/display-identity", {
      headers: { origin: LANDING },
    });
    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({ signedIn: false });
    expect(signedOut.headers.get("access-control-allow-origin")).toBe(LANDING);
    expect(signedOut.headers.get("access-control-allow-credentials")).toBe("true");

    const signUp = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://opengeni.test" },
      body: JSON.stringify({ name: "Display Identity User", email, password }),
    });
    expect(signUp.status).toBeLessThan(300);
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const signIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://opengeni.test" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);
    const sessionCookie = signIn.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("better-auth.session_token="))
      ?.split(";", 1)[0];
    expect(sessionCookie).toBeDefined();

    const signedIn = await app.request("/v1/auth/display-identity", {
      headers: { origin: LANDING, cookie: sessionCookie! },
    });
    expect(signedIn.status).toBe(200);
    const body = await signedIn.json();
    expect(body).toEqual({ signedIn: true, name: "Display Identity User", image: null });
    expect(JSON.stringify(body)).not.toContain(email);
    expect(signedIn.headers.get("access-control-allow-origin")).toBe(LANDING);
    expect(signedIn.headers.get("access-control-allow-credentials")).toBe("true");
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");

    const otherOrigin = await app.request("/v1/auth/display-identity", {
      headers: { origin: "https://evil.example", cookie: sessionCookie! },
    });
    expect(otherOrigin.headers.get("access-control-allow-origin")).toBe("*");
    expect(otherOrigin.headers.get("access-control-allow-credentials")).toBeNull();

    // get-session keeps answering the landing origin without credentialed CORS.
    const getSession = await app.request("/v1/auth/get-session", {
      headers: { origin: LANDING, cookie: sessionCookie! },
    });
    expect(getSession.headers.get("access-control-allow-origin")).toBe("*");
    expect(getSession.headers.get("access-control-allow-credentials")).toBeNull();
  }, 60_000);
});
