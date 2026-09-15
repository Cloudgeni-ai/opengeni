import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
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
import {
  createManagedAuth,
  hashManagedAuthPassword as hashPassword,
} from "../src/auth/managed-auth";
import { createApp } from "../src/app";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import type { ManagedEmailMessage } from "@opengeni/core";
import {
  bootstrapManagedAuthSessionSet,
  acquireManagedAuthActorMutationLease,
  releaseManagedAuthActorMutationLease,
  getManagedAuthSessionSetSnapshot,
} from "@opengeni/db/managed-auth-session-sets";
import {
  managedAuthSha256,
  managedAuthCsrfHash,
  managedAuthCsrfToken,
  MANAGED_AUTH_SESSION_SET_COOKIE,
} from "@opengeni/core/managed-auth-session-sets";

let shared: SharedTestDatabase | undefined;
let client: DbClient;
let admin: postgres.Sql;
let appSql: postgres.Sql;
let appUrl: string;
const password = "fixture-password-123";

beforeAll(async () => {
  // Explicit loopback-only escape hatch for sandboxes without Docker. The normal
  // CI path remains the shared migrated restricted-role fixture and never skips.
  const local = process.env.OPENGENI_SIGN_IN_TEST_DATABASE_URL;
  if (local) {
    const url = new URL(local);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw new Error("Disposable loopback test database required");
    await migrate(local, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(local, { appPassword: "sign-in-test-app", rlsStrategy: "force" });
    admin = postgres(local, { max: 2 });
    url.username = "opengeni_app";
    url.password = "sign-in-test-app";
    appUrl = url.toString();
  } else {
    shared = (await acquireSharedTestDatabase("managed-sign-in-methods")) ?? undefined;
    if (!shared) throw new Error("Managed sign-in security integration requires PostgreSQL");
    admin = shared.admin;
    appUrl = shared.appUrl;
  }
  client = createDb(appUrl, { max: 8, rlsStrategy: "force" });
  appSql = postgres(appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await appSql?.end();
  if (shared) await shared.release();
  else await admin?.end();
}, 180_000);

async function fixture(verified = true, provider = "credential") {
  const userId = crypto.randomUUID(),
    email = `${userId}@example.test`;
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Test Human',${email},${verified})`;
  const hash = provider === "credential" ? await hashPassword(password) : null;
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at) values(${crypto.randomUUID()},${userId},${provider},${userId},${hash},now(),now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  return { userId, email, ...(await session(userId, provider)) };
}
async function session(userId: string, provider = "credential") {
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find(
    (b) => b.providerId === provider && b.status === "active",
  )!;
  const sessionId = crypto.randomUUID(),
    token = crypto.randomUUID();
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${sessionId},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  return { sessionId, token, revision: projection.activeIdentity.identityRevision };
}
async function mutate(user: Awaited<ReturnType<typeof fixture>>, request: Record<string, unknown>) {
  return appSql`select mutate_managed_sign_in_method(${user.userId},${user.sessionId},${appSql.json({ operationId: crypto.randomUUID(), expectedIdentityRevision: user.revision, usableProviders: ["credential", "google", "github"], ...request } as postgres.JSONValue)}::jsonb) result`;
}
function runtime(mode: "legacy" | "dual" | "broker" = "legacy") {
  const messages: ManagedEmailMessage[] = [];
  const transport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:sign-in-methods", retentionSeconds: 86400 },
    send: async (message: ManagedEmailMessage) => {
      messages.push(message);
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  const settings = testSettings({
    databaseUrl: appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: mode,
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "managed-sign-in-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthGithubClientId: "github-test",
    managedAuthGithubClientSecret: "github-secret",
  });
  const auth = createManagedAuth(settings, client.db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  return { app, auth, adapter, messages };
}
async function cookie(rt: ReturnType<typeof runtime>, token: string) {
  return (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((c) => c.split(";", 1)[0])
    .join("; ");
}
async function oauth(
  rt: ReturnType<typeof runtime>,
  email: string,
  verified: boolean,
  provider: "google" | "github",
  accountId = crypto.randomUUID(),
) {
  const context = await rt.auth.$context;
  const configured = context.socialProviders.find((p) => p.id === provider)!;
  configured.validateAuthorizationCode = async () => ({
    accessToken: "test-provider-token",
    tokenType: "Bearer",
  });
  configured.getUserInfo = async () => ({
    user: { id: accountId, name: "Provider Human", email, emailVerified: verified },
    data: {},
  });
  const start = await rt.auth.api.signInSocial({
    returnHeaders: true,
    body: {
      provider,
      callbackURL: "http://opengeni.test/?oauth=success",
      errorCallbackURL: "http://opengeni.test/?oauth=error",
      disableRedirect: true,
    },
  });
  const url = new URL(start.response.url!);
  const result = await rt.app.request(
    `/v1/auth/callback/${provider}?state=${url.searchParams.get("state")}&code=simulated-provider-code`,
    {
      headers: {
        cookie: start.headers
          .getSetCookie()
          .map((c) => c.split(";", 1)[0])
          .join("; "),
      },
    },
  );
  return {
    error:
      result.headers.get("location") === "http://opengeni.test/?oauth=success"
        ? null
        : "oauth rejected",
  };
}

describe("managed sign-in methods restricted PostgreSQL and Better Auth", () => {
  test("requires BOTH provider and local email verification, without trusted-provider bypass", async () => {
    const rt = runtime();
    for (const provider of ["google", "github"] as const)
      for (const local of [true, false])
        for (const incoming of [true, false]) {
          const user = await fixture(local);
          const result = await oauth(rt, user.email, incoming, provider);
          expect(result.error === null).toBe(local && incoming);
          const accounts =
            await admin`select user_id from auth_identities where user_id=${user.userId} and provider_id=${provider}`;
          expect(accounts.length).toBe(local && incoming ? 1 : 0);
        }
    expect((await rt.auth.$context).trustedProviders).toEqual([]);
  });
  test("disconnect suppresses implicit relinking and session synchronization never revives revocation", async () => {
    const user = await fixture();
    const rt = runtime();
    expect((await oauth(rt, user.email, true, "google")).error).toBeNull();
    Object.assign(user, await session(user.userId));
    await mutate(user, { kind: "disconnect", provider: "google" });
    expect((await oauth(rt, user.email, true, "google")).error).not.toBeNull();
    await synchronizeCanonicalHumanLoginBindings(client.db, user.userId);
    const projection = await getCanonicalHumanIdentityProjection(client.db, user.userId);
    expect(projection.loginBindings.find((b) => b.providerId === "google")?.status).toBe("revoked");
    expect((await admin`select id from auth_sessions where user_id=${user.userId}`).length).toBe(0);
  });
  test("last usable method and stale authentication are rejected transactionally", async () => {
    const single = await fixture(true, "google");
    await expect(mutate(single, { kind: "disconnect", provider: "google" })).rejects.toThrow(
      "SIGN_IN_METHOD_LAST_USABLE_METHOD",
    );
    await admin`update auth_sessions set created_at=now()-interval '6 minutes' where id=${single.sessionId}`;
    await expect(mutate(single, { kind: "connect", provider: "github" })).rejects.toThrow(
      "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED",
    );
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, single.userId)).activeIdentity.status,
    ).toBe("active");
  });
  test("password updates fence concurrent old-hash proof and revoke every session", async () => {
    const user = await fixture();
    await session(user.userId);
    const [credential] =
      await admin`select password from auth_identities where user_id=${user.userId} and provider_id='credential'`;
    await expect(
      mutate(user, {
        kind: "password",
        expectedPasswordHash: "stale",
        passwordHash: await hashPassword("replacement-password"),
      }),
    ).rejects.toThrow("SIGN_IN_METHOD_PASSWORD_CHANGED");
    const hash = await hashPassword("replacement-password");
    const outcomes = await Promise.allSettled([
      mutate(user, {
        kind: "password",
        expectedPasswordHash: credential!.password,
        passwordHash: hash,
      }),
      mutate(user, {
        kind: "password",
        expectedPasswordHash: credential!.password,
        passwordHash: hash,
      }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    expect((await admin`select id from auth_sessions where user_id=${user.userId}`).length).toBe(0);
  });
  test("provider account collisions never merge or dispute unrelated humans", async () => {
    const first = await fixture();
    const second = await fixture();
    const account = crypto.randomUUID();
    await appSql`insert into auth_identities(id,user_id,provider_id,account_id,created_at,updated_at) values(${crypto.randomUUID()},${first.userId},'google',${account},now(),now())`;
    await expect(
      (async () =>
        await appSql`insert into auth_identities(id,user_id,provider_id,account_id,created_at,updated_at) values(${crypto.randomUUID()},${second.userId},'google',${account},now(),now())`)(),
    ).rejects.toThrow("SIGN_IN_METHOD_ACCOUNT_COLLISION");
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, first.userId)).activeIdentity.status,
    ).toBe("active");
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, second.userId)).activeIdentity.status,
    ).toBe("active");
  });
  test("personal API lists no tokens, blocks raw provider mutations, checks current password and sends notification", async () => {
    const user = await fixture();
    const rt = runtime();
    const cookies = await cookie(rt, user.token);
    const list = await rt.app.request("/v1/auth/sign-in-methods", { headers: { cookie: cookies } });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.methods.find((m: any) => m.provider === "credential").connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain(user.token);
    const headers = {
      cookie: cookies,
      origin: "http://opengeni.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    for (const path of [
      "link-social",
      "unlink-account",
      "set-password",
      "change-password",
      "list-accounts",
    ]) {
      expect(
        (await rt.app.request(`/v1/auth/${path}`, { method: "POST", headers, body: "{}" })).status,
      ).toBe(403);
    }
    const request = {
      operationId: crypto.randomUUID(),
      expectedIdentityRevision: user.revision,
      newPassword: "updated-password-123",
    };
    const wrong = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(wrong.status).toBe(403);
    const result = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, currentPassword: password }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ reauthenticationRequired: true, notification: "sent" });
    expect(rt.messages.filter((m) => m.kind === "sign_in_method_changed").length).toBe(1);
  });
  test("explicit reconnect requires consumed OAuth state and provider proof", async () => {
    const user = await fixture();
    const rt = runtime();
    const providerAccountId = crypto.randomUUID();
    await oauth(rt, user.email, true, "google", providerAccountId);
    Object.assign(user, await session(user.userId));
    await mutate(user, { kind: "disconnect", provider: "google" });
    Object.assign(user, await session(user.userId));
    rt.messages.length = 0;
    const cookies = await cookie(rt, user.token);
    const start = await rt.app.request("/v1/auth/sign-in-methods/connect", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: "http://opengeni.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "google",
        operationId: crypto.randomUUID(),
        expectedIdentityRevision: user.revision,
      }),
    });
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).url);
    const provider = (await rt.auth.$context).socialProviders.find((p) => p.id === "google")!;
    provider.validateAuthorizationCode = async () => ({
      accessToken: "test-provider-token",
      tokenType: "Bearer",
    });
    provider.getUserInfo = async () => ({
      user: { id: providerAccountId, name: "Test", email: user.email, emailVerified: true },
      data: {},
    });
    const stateCookies = start.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    const callback = `/v1/auth/callback/google?state=${url.searchParams.get("state")}&code=simulated-provider-code`;
    const response = await rt.app.request(callback, { headers: { cookie: stateCookies } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("signInMethod=connected");
    expect(
      (
        await admin`select id from auth_identities where user_id=${user.userId} and provider_id='google'`
      ).length,
    ).toBe(1);
    const binding = (
      await getCanonicalHumanIdentityProjection(client.db, user.userId)
    ).loginBindings.find((b) => b.providerId === "google");
    expect(binding?.providerAccountId).toBe(providerAccountId);
    expect(binding?.status).toBe("active");
    expect((await admin`select id from auth_sessions where user_id=${user.userId}`).length).toBe(0);
    expect(rt.messages.filter((m) => m.kind === "sign_in_method_changed").length).toBe(1);
    const replay = await rt.app.request(callback, { headers: { cookie: stateCookies } });
    expect(replay.headers.get("location")).not.toContain("signInMethod=connected");
  });
  test("unverified explicit OAuth proof cannot clear suppression", async () => {
    const user = await fixture();
    const rt = runtime();
    await oauth(rt, user.email, true, "github");
    Object.assign(user, await session(user.userId));
    await mutate(user, { kind: "disconnect", provider: "github" });
    Object.assign(user, await session(user.userId));
    const start = await rt.app.request("/v1/auth/sign-in-methods/connect", {
      method: "POST",
      headers: {
        cookie: await cookie(rt, user.token),
        origin: "http://opengeni.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        operationId: crypto.randomUUID(),
        expectedIdentityRevision: user.revision,
      }),
    });
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).url);
    const provider = (await rt.auth.$context).socialProviders.find((p) => p.id === "github")!;
    provider.validateAuthorizationCode = async () => ({
      accessToken: "test-provider-token",
      tokenType: "Bearer",
    });
    provider.getUserInfo = async () => ({
      user: { id: crypto.randomUUID(), name: "Test", email: user.email, emailVerified: false },
      data: {},
    });
    const result = await rt.app.request(
      `/v1/auth/callback/github?state=${url.searchParams.get("state")}&code=simulated-provider-code`,
      {
        headers: {
          cookie: start.headers
            .getSetCookie()
            .map((c) => c.split(";", 1)[0])
            .join("; "),
        },
      },
    );
    expect(result.headers.get("location")).toContain("signInMethod=error");
    expect(
      (
        await admin`select id from auth_identities where user_id=${user.userId} and provider_id='github'`
      ).length,
    ).toBe(0);
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, user.userId)).loginBindings.find(
        (b) => b.providerId === "github",
      )?.status,
    ).toBe("revoked");
  });
  for (const mode of ["dual", "broker"] as const)
    test(`${mode}: selected actor proof, CSRF and session-set invalidation`, async () => {
      const user = await fixture();
      const rt = runtime(mode);
      const authority = crypto.randomUUID() + crypto.randomUUID(),
        authorityHash = managedAuthSha256(authority);
      const projection = await bootstrapManagedAuthSessionSet(client.db, {
        authorityHash,
        csrfHash: managedAuthCsrfHash(authority),
        authSessionId: user.sessionId,
        mode,
        operationId: crypto.randomUUID(),
        requestDigest: managedAuthSha256(crypto.randomUUID()),
        expectedGeneration: "1",
        expectedActorEpoch: "1",
      });
      const headers = {
        cookie: `${MANAGED_AUTH_SESSION_SET_COOKIE}=${authority}`,
        origin: "http://opengeni.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-opengeni-actor-epoch": projection.actorEpoch,
        "x-opengeni-session-csrf": managedAuthCsrfToken(
          "managed-sign-in-test-secret-at-least-32-bytes",
          authority,
          projection.generation,
        ),
      };
      const body = JSON.stringify({
        provider: "google",
        operationId: crypto.randomUUID(),
        expectedIdentityRevision: user.revision,
      });
      const csrf = await rt.app.request("/v1/auth/sign-in-methods/connect", {
        method: "POST",
        headers: { ...headers, "x-opengeni-session-csrf": "wrong" },
        body,
      });
      expect(csrf.status).toBe(403);
      const start = await rt.app.request("/v1/auth/sign-in-methods/connect", {
        method: "POST",
        headers,
        body,
      });
      expect(start.status).toBe(200);
      const url = new URL((await start.json()).url);
      const provider = (await rt.auth.$context).socialProviders.find((p) => p.id === "google")!;
      provider.validateAuthorizationCode = async () => ({
        accessToken: "test-provider-token",
        tokenType: "Bearer",
      });
      provider.getUserInfo = async () => ({
        user: { id: crypto.randomUUID(), name: "Test", email: user.email, emailVerified: true },
        data: {},
      });
      const result = await rt.app.request(
        `/v1/auth/callback/google?state=${url.searchParams.get("state")}&code=simulated-provider-code`,
        {
          headers: {
            cookie: [
              headers.cookie,
              ...start.headers.getSetCookie().map((c) => c.split(";", 1)[0]),
            ].join("; "),
          },
        },
      );
      expect(result.headers.get("location")).toContain("signInMethod=connected");
      const snapshot = await getManagedAuthSessionSetSnapshot(client.db, {
        authorityHash,
        mode,
        readOnly: true,
      });
      expect(snapshot?.projection.slots[0]?.state).toBe("reauth_required");
      expect(snapshot?.projection.actorEpoch).not.toBe(projection.actorEpoch);
    });
  test("an in-flight selected-actor mutation fences an OAuth connect callback", async () => {
    const user = await fixture();
    const rt = runtime("broker");
    const authority = crypto.randomUUID() + crypto.randomUUID(),
      authorityHash = managedAuthSha256(authority);
    const projection = await bootstrapManagedAuthSessionSet(client.db, {
      authorityHash,
      csrfHash: managedAuthCsrfHash(authority),
      authSessionId: user.sessionId,
      mode: "broker",
      operationId: crypto.randomUUID(),
      requestDigest: managedAuthSha256(crypto.randomUUID()),
      expectedGeneration: "1",
      expectedActorEpoch: "1",
    });
    const headers = {
      cookie: `${MANAGED_AUTH_SESSION_SET_COOKIE}=${authority}`,
      origin: "http://opengeni.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-opengeni-actor-epoch": projection.actorEpoch,
      "x-opengeni-session-csrf": managedAuthCsrfToken(
        "managed-sign-in-test-secret-at-least-32-bytes",
        authority,
        projection.generation,
      ),
    };
    const start = await rt.app.request("/v1/auth/sign-in-methods/connect", {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "github",
        operationId: crypto.randomUUID(),
        expectedIdentityRevision: user.revision,
      }),
    });
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).url);
    const requestId = crypto.randomUUID();
    await acquireManagedAuthActorMutationLease(client.db, {
      authorityHash,
      actorEpoch: projection.actorEpoch,
      requestId,
      leaseSeconds: 30,
    });
    try {
      const provider = (await rt.auth.$context).socialProviders.find((p) => p.id === "github")!;
      provider.validateAuthorizationCode = async () => ({
        accessToken: "test-provider-token",
        tokenType: "Bearer",
      });
      provider.getUserInfo = async () => ({
        user: { id: crypto.randomUUID(), name: "Test", email: user.email, emailVerified: true },
        data: {},
      });
      await rt.app.request(
        `/v1/auth/callback/github?state=${url.searchParams.get("state")}&code=simulated-provider-code`,
        {
          headers: {
            cookie: [
              headers.cookie,
              ...start.headers.getSetCookie().map((c) => c.split(";", 1)[0]),
            ].join("; "),
          },
        },
      );
      expect(
        (
          await admin`select id from auth_identities where user_id=${user.userId} and provider_id='github'`
        ).length,
      ).toBe(0);
      expect(
        (await getCanonicalHumanIdentityProjection(client.db, user.userId)).activeIdentity
          .identityRevision,
      ).toBe(user.revision);
    } finally {
      await releaseManagedAuthActorMutationLease(client.db, { authorityHash, requestId });
    }
  });
});
