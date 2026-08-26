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
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
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
  test("starts the first isolated Add from a read-only empty broker projection", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        managedAuthSessionSetMode: "broker",
        betterAuthSecret: "managed-session-set-integration-secret-32-bytes",
        publicBaseUrl: "http://opengeni.test",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `managed-session-set-broker-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    const initialResponse = await app.request("/v1/auth/session-set");
    expect(initialResponse.status).toBe(200);
    const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
    const authorityCookie = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
    const authorityHash = managedAuthSha256(authorityValue(authorityCookie));
    expect(initial).toMatchObject({
      mode: "broker",
      generation: "1",
      actorEpoch: "1",
      selectedSlotId: null,
      slots: [],
    });
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("absent");

    const signUp = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authorityCookie },
      body: JSON.stringify({ name: "Broker Session Set User", email, password }),
    });
    expect(signUp.status).toBeLessThan(300);
    expect(
      signUp.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("better-auth.session_token=")),
    ).toBe(true);
    expect(oneCookie(signUp, "better-auth.session_token")).toBe("better-auth.session_token=");
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("absent");
    const [sessionsAfterSignup] = await shared.admin<Array<{ count: number }>>`
      select count(*)::integer as count from auth_sessions
      where user_id = (select id from auth_users where email = ${email})
    `;
    expect(sessionsAfterSignup).toEqual({ count: 0 });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;

    const unselectedSignIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authorityCookie },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(unselectedSignIn.status).toBe(200);
    expect(oneCookie(unselectedSignIn, "better-auth.session_token")).toBe(
      "better-auth.session_token=",
    );
    const [sessionsAfterUnselectedSignIn] = await shared.admin<Array<{ count: number }>>`
      select count(*)::integer as count from auth_sessions
      where user_id = (select id from auth_users where email = ${email})
    `;
    expect(sessionsAfterUnselectedSignIn).toEqual({ count: 0 });

    const body = JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      kind: "add",
    });
    const begin = await app.request("/v1/auth/session-set/transactions", {
      method: "POST",
      headers: mutationHeaders(initial, authorityCookie),
      body,
    });
    expect(begin.status).toBe(200);
    const transaction = (await begin.json()) as Record<string, unknown>;
    expect(transaction).toMatchObject({ kind: "add", returnIntentId: null });
    expect(transaction.id).toBeString();
    const transactionCookie = oneCookie(begin, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
    expect(transactionCookie).toContain(String(transaction.id));
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("active");

    const replay = await app.request("/v1/auth/session-set/transactions", {
      method: "POST",
      headers: mutationHeaders(initial, authorityCookie),
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(transaction);

    const completionBody = JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      transactionId: transaction.id,
      email,
      password,
    });
    const completion = await app.request("/v1/auth/session-set/transactions/email-password", {
      method: "POST",
      headers: mutationHeaders(initial, `${authorityCookie}; ${transactionCookie}`),
      body: completionBody,
    });
    expect(completion.status).toBe(200);
    const completed = (await completion.json()) as {
      projection: ManagedAuthSessionSetProjection;
      returnIntent: string | null;
    };
    expect(completed).toMatchObject({
      projection: {
        generation: "2",
        actorEpoch: "1",
        selectedSlotId: null,
        slots: [{ displayName: "Broker Session Set User", state: "active" }],
      },
      returnIntent: null,
    });
    expect(oneCookie(completion, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE)).toBe(
      `${MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE}=`,
    );
    const [sessionsAfterCompletion] = await shared.admin<Array<{ count: number }>>`
      select count(*)::integer as count from auth_sessions
      where user_id = (select id from auth_users where email = ${email})
    `;
    expect(sessionsAfterCompletion).toEqual({ count: 1 });

    const completionReplay = await app.request("/v1/auth/session-set/transactions/email-password", {
      method: "POST",
      headers: mutationHeaders(initial, authorityCookie),
      body: completionBody,
    });
    expect(completionReplay.status).toBe(200);
    expect(await completionReplay.json()).toEqual(completed);
    const [sessionsAfterReplay] = await shared.admin<Array<{ count: number }>>`
      select count(*)::integer as count from auth_sessions
      where user_id = (select id from auth_users where email = ${email})
    `;
    expect(sessionsAfterReplay?.count).toBe(sessionsAfterCompletion?.count);

    const logoutBody = JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: completed.projection.generation,
    });
    const logout = await app.request("/v1/auth/session-set/logout-all", {
      method: "POST",
      headers: mutationHeaders(completed.projection, authorityCookie),
      body: logoutBody,
    });
    expect(logout.status).toBe(200);
    const logoutReceipt = await logout.json();
    expect(logoutReceipt).toMatchObject({
      actorEpoch: "2",
      state: "logged_out",
    });
    expect(BigInt((logoutReceipt as { generation: string }).generation)).toBeGreaterThan(
      BigInt(completed.projection.generation),
    );
    expect(
      logout.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${MANAGED_AUTH_SESSION_SET_COOKIE}=`)),
    ).toBe(false);
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("retired");

    // Model a lost response body after the browser retained the response
    // headers. The retired cookie is deliberately still present, so the exact
    // command can recover its append-only receipt without reviving authority.
    const logoutReplay = await app.request("/v1/auth/session-set/logout-all", {
      method: "POST",
      headers: mutationHeaders(completed.projection, authorityCookie),
      body: logoutBody,
    });
    expect(logoutReplay.status).toBe(200);
    expect(await logoutReplay.json()).toEqual(logoutReceipt);
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("retired");

    const distinctLogout = await app.request("/v1/auth/session-set/logout-all", {
      method: "POST",
      headers: mutationHeaders(completed.projection, authorityCookie),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: completed.projection.generation,
      }),
    });
    expect(distinctLogout.status).toBe(401);
    expect(await distinctLogout.json()).toMatchObject({
      error: { details: { managedAuthCode: "browser_session_set_required" } },
    });

    const fresh = await app.request("/v1/auth/session-set", {
      headers: { cookie: authorityCookie },
    });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({
      generation: "1",
      actorEpoch: "1",
      selectedSlotId: null,
      state: "ready",
      slots: [],
    });
    expect(oneCookie(fresh, MANAGED_AUTH_SESSION_SET_COOKIE)).not.toBe(authorityCookie);
  });

  test("scrubs dual signup state and adopts the first account through isolated sign-in", async () => {
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
    for (const [label, presentedAuthority, clientAddress] of [
      ["empty", "", "198.51.100.21"],
      ["malformed", "not-a-session-set-authority", "198.51.100.22"],
    ] as const) {
      const unselectedEmail = `managed-session-set-dual-${label}-${crypto.randomUUID()}@example.test`;
      const unselectedSignup = await app.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${MANAGED_AUTH_SESSION_SET_COOKIE}=${presentedAuthority}`,
          "x-forwarded-for": clientAddress,
        },
        body: JSON.stringify({
          name: `Dual ${label} authority user`,
          email: unselectedEmail,
          password: "password1234",
        }),
      });
      expect(unselectedSignup.status).toBeLessThan(300);
      expect(oneCookie(unselectedSignup, "better-auth.session_token")).toBe(
        "better-auth.session_token=",
      );
      const [unselectedSessions] = await shared.admin<Array<{ count: number }>>`
        select count(*)::integer as count from auth_sessions
        where user_id = (select id from auth_users where email = ${unselectedEmail})
      `;
      expect(unselectedSessions).toEqual({ count: 0 });
    }
    const initialResponse = await app.request("/v1/auth/session-set");
    const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
    const authority = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
    const email = `managed-session-set-dual-empty-${crypto.randomUUID()}@example.test`;
    const password = "password1234";

    const signUp = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authority },
      body: JSON.stringify({ name: "Dual Empty User", email, password }),
    });
    expect(signUp.status).toBeLessThan(300);
    expect(oneCookie(signUp, "better-auth.session_token")).toBe("better-auth.session_token=");
    expect(
      await getManagedAuthSessionSetAuthorityState(
        client.db,
        managedAuthSha256(authorityValue(authority)),
      ),
    ).toBe("absent");
    const [sessionsAfterSignup] = await shared.admin<Array<{ count: number }>>`
      select count(*)::integer as count from auth_sessions
      where user_id = (select id from auth_users where email = ${email})
    `;
    expect(sessionsAfterSignup).toEqual({ count: 0 });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;

    const begin = await app.request("/v1/auth/session-set/transactions", {
      method: "POST",
      headers: mutationHeaders(initial, authority),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: initial.generation,
        kind: "add",
      }),
    });
    expect(begin.status).toBe(200);
    const transaction = (await begin.json()) as { id: string };
    const transactionCookie = oneCookie(begin, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
    const completion = await app.request("/v1/auth/session-set/transactions/email-password", {
      method: "POST",
      headers: mutationHeaders(initial, `${authority}; ${transactionCookie}`),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: initial.generation,
        transactionId: transaction.id,
        email,
        password,
      }),
    });
    expect(completion.status).toBe(200);
    const completed = (await completion.json()) as {
      projection: ManagedAuthSessionSetProjection;
    };
    expect(completed.projection).toMatchObject({
      selectedSlotId: null,
      slots: [{ verifiedClaim: { value: email }, state: "active" }],
    });
    expect(completion.headers.getSetCookie().join("\n")).not.toContain(
      "better-auth.session_token=ey",
    );

    const select = await app.request("/v1/auth/session-set/select", {
      method: "POST",
      headers: mutationHeaders(completed.projection, authority),
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedGeneration: completed.projection.generation,
        slotId: completed.projection.slots[0]!.id,
      }),
    });
    expect(select.status).toBe(200);
    const projection = (await select.json()) as ManagedAuthSessionSetProjection;
    expect(projection.selectedSlotId).not.toBeNull();
    const selectedCookie = oneCookie(select, "better-auth.session_token");
    expect(selectedCookie).not.toBe("better-auth.session_token=");
    const selectedRead = await app.request("/v1/auth/get-session", {
      headers: {
        cookie: `${authority}; ${selectedCookie}`,
        [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
      },
    });
    expect(selectedRead.status).toBe(200);
    expect(await selectedRead.json()).toMatchObject({ user: { email } });
  });

  test("denies stale-tab authority transfer, replays exactly, and exposes no provider token", async () => {
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
    const bodyA = JSON.stringify({ operationId: operationA, expectedGeneration: tabA.generation });
    const bootstrapA = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabA, `${ambient}; ${authorityA}`),
      body: bodyA,
    });
    expect(bootstrapA.status).toBe(200);
    const projectionA = (await bootstrapA.json()) as ManagedAuthSessionSetProjection;
    expect(projectionA.selectedSlotId).not.toBeNull();

    const operationB = crypto.randomUUID();
    const bodyB = JSON.stringify({ operationId: operationB, expectedGeneration: tabB.generation });
    const bootstrapB = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabB, `${ambient}; ${authorityB}`),
      body: bodyB,
    });
    expect(bootstrapB.status).toBe(401);
    expect(await bootstrapB.json()).toMatchObject({
      error: { details: { managedAuthCode: "browser_session_set_required" } },
    });
    expect(
      await getManagedAuthSessionSetAuthorityState(
        client.db,
        managedAuthSha256(authorityValue(authorityA)),
      ),
    ).toBe("active");
    expect(
      await getManagedAuthSessionSetAuthorityState(
        client.db,
        managedAuthSha256(authorityValue(authorityB)),
      ),
    ).toBe("absent");

    const replay = await app.request("/v1/auth/session-set/bootstrap", {
      method: "POST",
      headers: mutationHeaders(tabA, `${ambient}; ${authorityA}`),
      body: bodyA,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(projectionA);

    const legacyEpochOneRead = await app.request("/v1/auth/get-session", {
      headers: { cookie: `${ambient}; ${authorityA}` },
    });
    expect(legacyEpochOneRead.status).toBe(200);
    expect(await legacyEpochOneRead.json()).toMatchObject({ user: { email } });

    const [before] = await shared.admin<Array<{ id: string; updatedAt: Date; expiresAt: Date }>>`
      select id, updated_at as "updatedAt", expires_at as "expiresAt"
      from auth_sessions where user_id = (select id from auth_users where email = ${email})
      order by created_at desc limit 1
    `;
    const selectedRead = await app.request("/v1/auth/get-session", {
      headers: {
        cookie: `${ambient}; ${authorityA}`,
        [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projectionA.actorEpoch,
      },
    });
    expect(selectedRead.status).toBe(200);
    expect(selectedRead.headers.get(MANAGED_AUTH_ACTOR_EPOCH_HEADER)).toBe(projectionA.actorEpoch);
    expect(selectedRead.headers.get("set-cookie")).toBeNull();
    const selectedBody = (await selectedRead.json()) as Record<string, unknown>;
    expect(JSON.stringify(selectedBody)).not.toContain("token");
    const [after] = await shared.admin<Array<{ id: string; updatedAt: Date; expiresAt: Date }>>`
      select id, updated_at as "updatedAt", expires_at as "expiresAt"
      from auth_sessions where id = ${before!.id}
    `;
    expect(after).toEqual(before);

    await shared.admin`
      update auth_sessions set expires_at = now() - interval '1 second'
      where id = ${before!.id}
    `;
    const expiredProjectionResponse = await app.request("/v1/auth/session-set", {
      headers: { cookie: authorityA },
    });
    expect(expiredProjectionResponse.status).toBe(200);
    expect(await expiredProjectionResponse.json()).toMatchObject({
      generation: projectionA.generation,
      actorEpoch: projectionA.actorEpoch,
      selectedSlotId: null,
      state: "actor_change_required",
      slots: [{ id: projectionA.selectedSlotId, state: "reauth_required" }],
    });
    const expiredSelectedRead = await app.request("/v1/auth/get-session", {
      headers: {
        cookie: `${ambient}; ${authorityA}`,
        [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projectionA.actorEpoch,
      },
    });
    expect(expiredSelectedRead.status).toBe(409);
    expect(expiredSelectedRead.headers.get("x-opengeni-actor-state")).toBe("changed");
    const [readOnlyState] = await shared.admin<
      Array<{
        generation: string;
        actorEpoch: string;
        state: string;
        slotStatus: string;
        authSessionId: string | null;
      }>
    >`
      select session_set.generation::text as generation,
        session_set.actor_epoch::text as "actorEpoch", session_set.state,
        slot.status as "slotStatus", slot.auth_session_id as "authSessionId"
      from managed_auth_session_sets session_set
      inner join managed_auth_login_slots slot on slot.id = session_set.selected_slot_id
      where session_set.authority_hash = ${managedAuthSha256(authorityValue(authorityA))}
    `;
    expect(readOnlyState).toEqual({
      generation: projectionA.generation,
      actorEpoch: projectionA.actorEpoch,
      state: "ready",
      slotStatus: "active",
      authSessionId: before!.id,
    });

    await shared.admin`
      update managed_auth_session_sets set actor_epoch = actor_epoch + 1
      where authority_hash = ${managedAuthSha256(authorityValue(authorityA))}
    `;
    const staleHeaderless = await app.request("/v1/auth/get-session", {
      headers: { cookie: `${ambient}; ${authorityA}` },
    });
    expect(staleHeaderless.status).toBe(409);
    expect(staleHeaderless.headers.get("x-opengeni-actor-state")).toBe("changed");
  }, 60_000);
});
