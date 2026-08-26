import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, getManagedAuthSessionSetAuthorityState, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  type ManagedAuthSessionSetProjection,
} from "@opengeni/contracts/managed-auth-session-sets";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_SESSION_SET_COOKIE,
  managedAuthSha256,
} from "@opengeni/core/managed-auth-session-sets";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("managed-auth-session-sets-api");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await migrate(shared.adminUrl);
  await provisionRoles(shared.adminUrl, {
    appPassword: decodeURIComponent(new URL(shared.appUrl).password),
  });
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function oneCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`response omitted ${name}`);
  return value.split(";", 1)[0]!;
}

function authorityValue(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function mutationHeaders(
  projection: ManagedAuthSessionSetProjection,
  cookies: string,
): Record<string, string> {
  return {
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": projection.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
    cookie: cookies,
  };
}

describe("managed session-set API with Better Auth and PostgreSQL", () => {
  test("converges two pre-bootstrap tabs, replays exactly, and exposes no provider token", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        managedAuthSessionSetMode: "dual",
        betterAuthSecret: "managed-session-set-integration-secret-32-bytes",
        publicBaseUrl: "http://opengeni.test",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `managed-session-set-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    expect(
      (
        await app.request("/v1/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Session Set User", email, password }),
        })
      ).status,
    ).toBeLessThan(300);
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const signIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);
    const signInBody = (await signIn.json()) as Record<string, unknown>;
    expect(signInBody).not.toHaveProperty("token");
    expect(signInBody).not.toHaveProperty("session");
    const ambient = oneCookie(signIn, "better-auth.session_token");

    const tabAGet = await app.request("/v1/auth/session-set", { headers: { cookie: ambient } });
    const tabBGet = await app.request("/v1/auth/session-set", { headers: { cookie: ambient } });
    const tabA = (await tabAGet.json()) as ManagedAuthSessionSetProjection;
    const tabB = (await tabBGet.json()) as ManagedAuthSessionSetProjection;
    const authorityA = oneCookie(tabAGet, MANAGED_AUTH_SESSION_SET_COOKIE);
    const authorityB = oneCookie(tabBGet, MANAGED_AUTH_SESSION_SET_COOKIE);
    expect(authorityA).not.toBe(authorityB);

    const operationA = crypto.randomUUID();
    const bootstrapA = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabA, `${ambient}; ${authorityA}`),
      body: JSON.stringify({ operationId: operationA, expectedGeneration: tabA.generation }),
    });
    expect(bootstrapA.status).toBe(200);

    const operationB = crypto.randomUUID();
    const bodyB = JSON.stringify({ operationId: operationB, expectedGeneration: tabB.generation });
    const bootstrapB = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabB, `${ambient}; ${authorityB}`),
      body: bodyB,
    });
    expect(bootstrapB.status).toBe(200);
    const projectionB = (await bootstrapB.json()) as ManagedAuthSessionSetProjection;
    expect(projectionB.selectedSlotId).not.toBeNull();
    expect(
      await getManagedAuthSessionSetAuthorityState(
        client.db,
        managedAuthSha256(authorityValue(authorityA)),
      ),
    ).not.toBe("active");

    const replay = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabB, `${ambient}; ${authorityB}`),
      body: bodyB,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(projectionB);

    const [before] = await shared.admin<Array<{ id: string; updatedAt: Date; expiresAt: Date }>>`
      select id, updated_at as "updatedAt", expires_at as "expiresAt"
      from auth_sessions where user_id = (select id from auth_users where email = ${email})
      order by created_at desc limit 1
    `;
    const selectedRead = await app.request("/v1/auth/get-session", {
      headers: {
        cookie: `${ambient}; ${authorityB}`,
        [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projectionB.actorEpoch,
      },
    });
    expect(selectedRead.status).toBe(200);
    expect(selectedRead.headers.get(MANAGED_AUTH_ACTOR_EPOCH_HEADER)).toBe(projectionB.actorEpoch);
    expect(selectedRead.headers.get("set-cookie")).toBeNull();
    const selectedBody = (await selectedRead.json()) as Record<string, unknown>;
    expect(JSON.stringify(selectedBody)).not.toContain("token");
    const [after] = await shared.admin<Array<{ id: string; updatedAt: Date; expiresAt: Date }>>`
      select id, updated_at as "updatedAt", expires_at as "expiresAt"
      from auth_sessions where id = ${before!.id}
    `;
    expect(after).toEqual(before);

    await shared.admin`
      update managed_auth_session_sets set actor_epoch = actor_epoch + 1
      where authority_hash = ${managedAuthSha256(authorityValue(authorityB))}
    `;
    const staleHeaderless = await app.request("/v1/auth/get-session", {
      headers: { cookie: `${ambient}; ${authorityB}` },
    });
    expect(staleHeaderless.status).toBe(409);
    expect(staleHeaderless.headers.get("x-opengeni-actor-state")).toBe("changed");
  }, 60_000);
});
