import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyCanonicalHumanIdentityOperation,
  createDb,
  getCanonicalHumanIdentityProjection,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_CANONICAL_HUMAN_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_CANONICAL_HUMAN_TEST_APP_URL;
  if ((explicitAdminUrl === undefined) !== (explicitAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_CANONICAL_HUMAN_TEST_ADMIN_URL and OPENGENI_CANONICAL_HUMAN_TEST_APP_URL",
    );
  }
  if (explicitAdminUrl && explicitAppUrl) {
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, {
      appPassword: decodeURIComponent(new URL(explicitAppUrl).password),
    });
    const admin = postgres(explicitAdminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    const acquired = await acquireSharedTestDatabase("canonical-human-recovery-auth");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

describe("canonical human recovery through managed Better Auth", () => {
  test("ordinary sign-in stays recovery-only until explicit CAS-fenced completion", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "canonical-human-recovery-secret-32-bytes",
        publicBaseUrl: "http://opengeni.test",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `managed-recovery-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Managed Recovery User", email, password }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(200);
    expect(signup.status).toBeLessThan(300);
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;

    const firstSignin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(firstSignin.status).toBeGreaterThanOrEqual(200);
    expect(firstSignin.status).toBeLessThan(300);
    sessionCookie(firstSignin);

    const [authUser] = await shared.admin<{ id: string }[]>`
      select id from auth_users where email = ${email}
    `;
    expect(authUser).toBeTruthy();
    const linked = await getCanonicalHumanIdentityProjection(client.db, authUser!.id);
    expect(linked.loginBindings).toHaveLength(1);
    const onlyBinding = linked.loginBindings[0]!;
    const lostFactor = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: authUser!.id,
      expectedIdentityRevision: linked.activeIdentity.identityRevision,
      operationType: "unlink",
      bindingId: onlyBinding.id,
      reason: "Exercise last-factor recovery through managed sign-in",
    });
    expect(lostFactor.outcome).toBe("lost_factor");

    const recoverySignin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(recoverySignin.status).toBeGreaterThanOrEqual(200);
    expect(recoverySignin.status).toBeLessThan(300);
    const recoveryCookie = sessionCookie(recoverySignin);
    expect(await getCanonicalHumanIdentityProjection(client.db, authUser!.id)).toEqual(
      lostFactor.identity,
    );

    const ordinaryAccess = await app.request("/v1/access/me", {
      headers: { cookie: recoveryCookie },
    });
    expect(ordinaryAccess.status).toBe(401);
    expect(await getCanonicalHumanIdentityProjection(client.db, authUser!.id)).toEqual(
      lostFactor.identity,
    );

    const completed = await app.request(
      `/v1/identity/login-bindings/${onlyBinding.id}/recovery/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: recoveryCookie },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedIdentityRevision: lostFactor.identity.activeIdentity.identityRevision,
          reason: "Explicitly complete the verified recovery",
        }),
      },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      outcome: "applied",
      identity: {
        activeIdentity: {
          status: "active",
          recoveryState: "ready",
          activeLoginBindingId: onlyBinding.id,
        },
      },
    });

    const activeSignin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(activeSignin.status).toBeGreaterThanOrEqual(200);
    expect(activeSignin.status).toBeLessThan(300);
    const activeCookie = sessionCookie(activeSignin);
    expect(
      (
        await app.request("/v1/access/me", {
          headers: { cookie: activeCookie },
        })
      ).status,
    ).toBe(200);
  }, 60_000);
});
