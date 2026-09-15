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
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { deliverManagedSignInNotification } from "../src/auth/managed-sign-in-notifications";
import { assertRuntimeDatabasePosture } from "@opengeni/db";
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
    const ownerUrl = process.env.OPENGENI_SIGN_IN_TEST_OWNER_URL ?? local;
    const owner = new URL(ownerUrl);
    if (
      owner.hostname !== url.hostname ||
      owner.port !== url.port ||
      owner.pathname !== url.pathname
    )
      throw new Error("Migration owner must target the same disposable database");
    await migrate(ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
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
  return {
    sessionId,
    token,
    identityId: projection.activeIdentity.id,
    revision: projection.activeIdentity.identityRevision,
  };
}
async function mutate(user: Awaited<ReturnType<typeof fixture>>, request: Record<string, unknown>) {
  return appSql`select mutate_managed_sign_in_method(${user.userId},${user.sessionId},${appSql.json({ operationId: crypto.randomUUID(), requestDigest: managedAuthSha256(JSON.stringify(request)), expectedIdentityId: user.identityId, expectedIdentityRevision: user.revision, usableProviders: ["credential", "google", "github"], ...request } as postgres.JSONValue)}::jsonb) result`;
}
function runtime(mode: "legacy" | "dual" | "broker" = "legacy") {
  const messages: ManagedEmailMessage[] = [];
  const transport: ManagedEmailTransport = {
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
  return { app, auth, adapter, messages, transport };
}
async function cookie(rt: ReturnType<typeof runtime>, token: string) {
  return (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((c) => c.split(";", 1)[0])
    .join("; ");
}
async function oauth(
  rt: ReturnType<typeof runtime>,
  email: string,
  verified: boolean | undefined,
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
  test("callback stale age, revoked proof, wrong state cookie and email mismatch never connect", async () => {
    for (const condition of [
      "stale",
      "revoked",
      "wrong_cookie",
      "email_mismatch",
      "actor_changed",
    ] as const) {
      const user = await fixture();
      const rt = runtime();
      const start = await rt.app.request("/v1/auth/sign-in-methods/connect", {
        method: "POST",
        headers: {
          cookie: await cookie(rt, user.token),
          origin: "http://opengeni.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedIdentityId: user.identityId,
          expectedIdentityRevision: user.revision,
          provider: "google",
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
        user: {
          id: crypto.randomUUID(),
          name: "Test",
          email: condition === "email_mismatch" ? "different@example.test" : user.email,
          emailVerified: true,
        },
        data: {},
      });
      if (condition === "stale")
        await admin`update auth_sessions set created_at=now()-interval '6 minutes' where id=${user.sessionId}`;
      if (condition === "revoked")
        await admin`delete from auth_sessions where id=${user.sessionId}`;
      const browserCookie =
        condition === "actor_changed"
          ? await cookie(rt, (await fixture()).token)
          : await cookie(rt, user.token);
      const response = await rt.app.request(
        `/v1/auth/callback/google?state=${url.searchParams.get("state")}&code=simulated-provider-code`,
        {
          headers: {
            cookie:
              browserCookie +
              "; " +
              (condition === "wrong_cookie"
                ? "better-auth.state=wrong"
                : start.headers
                    .getSetCookie()
                    .map((c) => c.split(";", 1)[0])
                    .join("; ")),
          },
        },
      );
      expect(response.headers.get("location")).not.toContain("signInMethod=connected");
      expect(
        (
          await admin`select id from auth_identities where user_id=${user.userId} and provider_id='google'`
        ).length,
      ).toBe(0);
    }
  });
  test("configured-off survivors do not count and refreshing does not renew authentication age", async () => {
    const user = await fixture(true, "google");
    const rt = runtime();
    await appSql`insert into auth_identities(id,user_id,provider_id,account_id,created_at,updated_at) values(${crypto.randomUUID()},${user.userId},'github',${crypto.randomUUID()},now(),now())`;
    Object.assign(user, await session(user.userId, "google"));
    await expect(
      mutate(user, { kind: "disconnect", provider: "google", usableProviders: ["google"] }),
    ).rejects.toThrow("SIGN_IN_METHOD_LAST_USABLE_METHOD");
    await admin`update auth_sessions set created_at=now()-interval '6 minutes' where id=${user.sessionId}`;
    await rt.adapter.refreshSelectedSession({ token: user.token } as never);
    const result = await rt.app.request("/v1/auth/sign-in-methods", {
      headers: { cookie: await cookie(rt, user.token) },
    });
    expect(result.status).toBe(200);
    expect((await result.json()).freshAuthenticationRequired).toBe(true);
  });
  test("normalized verified provider email matches without transferring another human", async () => {
    const user = await fixture();
    const rt = runtime();
    expect((await oauth(rt, user.email.toUpperCase(), true, "google")).error).toBeNull();
    expect(
      (
        await admin`select user_id from auth_identities where user_id=${user.userId} and provider_id='google'`
      ).length,
    ).toBe(1);
  });
  test("legacy stale view cannot mutate another human at the same revision", async () => {
    const first = await fixture(),
      second = await fixture();
    const rt = runtime();
    expect(first.revision).toBe(second.revision);
    const view = await rt.app.request("/v1/auth/sign-in-methods", {
      headers: { cookie: await cookie(rt, first.token) },
    });
    const projection = await view.json();
    expect(projection.identityId).toBe(first.identityId);
    const headers = {
      cookie: await cookie(rt, second.token),
      origin: "http://opengeni.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    for (const [kind, body] of [
      ["connect", { provider: "google" }],
      ["disconnect", { provider: "google" }],
      ["password", { currentPassword: password, newPassword: "must-not-change-123" }],
    ] as const) {
      const response = await rt.app.request(`/v1/auth/sign-in-methods/${kind}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedIdentityId: projection.identityId,
          expectedIdentityRevision: projection.identityRevision,
          ...body,
        }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("SIGN_IN_METHOD_IDENTITY_CHANGED");
    }
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, second.userId)).activeIdentity
        .identityRevision,
    ).toBe(second.revision);
  });
  test("raw mixed-case binding, recovery and ID-token paths cannot bypass product policy", async () => {
    const user = await fixture();
    const rt = runtime();
    const cookies = await cookie(rt, user.token);
    await admin`update auth_sessions set created_at=now()-interval '6 minutes' where id=${user.sessionId}`;
    const headers = {
      cookie: cookies,
      origin: "http://opengeni.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    for (const providerId of ["credential", "CREDENTIAL", "Google", "GOOGLE", "GitHub"]) {
      const result = await rt.app.request("/v1/identity/login-bindings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId,
          providerAccountId: user.userId,
          expectedIdentityRevision: user.revision,
          reason: "Bypass attempt",
        }),
      });
      expect(result.status).toBe(403);
    }
    const binding = (await getCanonicalHumanIdentityProjection(client.db, user.userId))
      .loginBindings[0]!;
    for (const suffix of ["recovery", "recovery/complete"]) {
      const result = await rt.app.request(`/v1/identity/login-bindings/${binding.id}/${suffix}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedIdentityRevision: user.revision, reason: "Bypass attempt" }),
      });
      expect(result.status).toBe(403);
    }
    for (const provider of ["google", "github"]) {
      const result = await rt.app.request("/v1/auth/sign-in/social", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider, idToken: { token: "replayed-id-token" } }),
      });
      expect(result.status).toBe(403);
      expect((await result.json()).code).toBe("SIGN_IN_METHOD_OAUTH_REDIRECT_REQUIRED");
    }
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, user.userId)).activeIdentity
        .identityRevision,
    ).toBe(user.revision);
  });
  test("maintenance drain aborts on a live runtime login and helper ACLs stay closed", async () => {
    await appSql`select 1`;
    const migration = await Bun.file(
      new URL("../../../packages/db/drizzle/0475_managed_sign_in_methods.sql", import.meta.url),
    ).text();
    await expect(
      (async () =>
        await admin.begin(async (tx) => {
          await tx`select set_config('opengeni.migration_application_roles','["opengeni_app"]',true)`;
          await tx.unsafe(migration);
        }))(),
    ).rejects.toThrow("requires stopped application roles");
    const [privileges] =
      await admin`select has_function_privilege('opengeni_app','managed_sign_in_method_authority(text,text,jsonb)','EXECUTE') helper,
      has_function_privilege('opengeni_app','guard_managed_social_account()','EXECUTE') trigger,
      has_function_privilege('opengeni_app','mutate_managed_sign_in_method(text,text,jsonb)','EXECUTE') command`;
    expect(privileges).toEqual({ helper: false, trigger: false, command: true });
  });
  test("runtime role retains the reviewed FORCE-RLS and no-direct-DML posture", async () => {
    await assertRuntimeDatabasePosture(client.db, { rlsStrategy: "force" });
    await expect(
      (async () => await appSql`select * from managed_sign_in_method_operations`)(),
    ).rejects.toThrow("permission denied");
  });
  test("committed password response replays only for same fresh human and exact payload", async () => {
    const user = await fixture();
    const rt = runtime();
    const request = {
      operationId: crypto.randomUUID(),
      expectedIdentityId: user.identityId,
      expectedIdentityRevision: user.revision,
      currentPassword: password,
      newPassword: "replay-password-123",
    };
    const headers = {
      cookie: await cookie(rt, user.token),
      origin: "http://opengeni.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const first = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const result = await first.json();
    const revision = (await getCanonicalHumanIdentityProjection(client.db, user.userId))
      .activeIdentity.identityRevision;
    Object.assign(user, await session(user.userId));
    headers.cookie = await cookie(rt, user.token);
    const replay = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, user.userId)).activeIdentity
        .identityRevision,
    ).toBe(revision);
    expect(
      rt.messages.filter(
        (message) => message.idempotencyKey === `sign-in-method:${request.operationId}`,
      ).length,
    ).toBe(1);
    const changed = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, newPassword: "altered-password-123" }),
    });
    expect(changed.status).toBe(409);
    const other = await fixture();
    headers.cookie = await cookie(rt, other.token);
    expect(
      (
        await rt.app.request("/v1/auth/sign-in-methods/password", {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(409);
  });
  test("notification outage retains one durable obligation and retries with exact idempotency key", async () => {
    const user = await fixture();
    const rt = runtime();
    const operationId = crypto.randomUUID();
    const sent: ManagedEmailMessage[] = [];
    rt.transport.send = async (message) => {
      sent.push(message);
      throw new Error("simulated delivery acknowledgement lost");
    };
    const response = await rt.app.request("/v1/auth/sign-in-methods/password", {
      method: "POST",
      headers: {
        cookie: await cookie(rt, user.token),
        origin: "http://opengeni.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId,
        expectedIdentityId: user.identityId,
        expectedIdentityRevision: user.revision,
        currentPassword: password,
        newPassword: "notification-password-123",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reauthenticationRequired: true,
      notification: "outcome_unknown",
    });
    const [obligation] =
      await admin`select notification_status,request_digest,provider from managed_sign_in_method_operations where operation_id=${operationId}`;
    expect(obligation!.notification_status).toBe("outcome_unknown");
    expect(obligation!.request_digest).not.toContain(password);
    await admin`update managed_sign_in_method_operations set available_at=now()-interval '1 second' where operation_id=${operationId}`;
    rt.transport.send = async (message) => {
      sent.push(message);
      return { status: "sent", providerMessageId: "simulated-provider-deduplicated" };
    };
    expect(await deliverManagedSignInNotification(client.db, rt.transport, operationId)).toBe(
      "sent",
    );
    expect(sent.length).toBe(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(
      (
        await admin`select notification_status from managed_sign_in_method_operations where operation_id=${operationId}`
      )[0]!.notification_status,
    ).toBe("sent");
    await deliverManagedSignInNotification(client.db, rt.transport, operationId);
    expect(sent.length).toBe(2);
  });
  test("crash-recovery notification claims reject provider changes and expired idempotency windows", async () => {
    const user = await fixture();
    const operationId = crypto.randomUUID();
    const [credential] =
      await admin`select password from auth_identities where user_id=${user.userId} and provider_id='credential'`;
    await mutate(user, {
      kind: "password",
      operationId,
      expectedPasswordHash: credential!.password,
      passwordHash: await hashPassword("crash-password-123"),
    });
    const [claimed] =
      await appSql`select claim_managed_sign_in_notification(${operationId}::uuid,'auth@example.test','original-provider',600) claim`;
    expect(claimed!.claim.operationId).toBe(operationId);
    await admin`update managed_sign_in_method_operations set lease_until=now()-interval '1 second',available_at=now()-interval '1 second' where operation_id=${operationId}`;
    const [wrongProvider] =
      await appSql`select claim_managed_sign_in_notification(${operationId}::uuid,'auth@example.test','changed-provider',600) claim`;
    expect(wrongProvider!.claim).toBeNull();
    await admin`update managed_sign_in_method_operations set retry_until=now()-interval '1 second' where operation_id=${operationId}`;
    const [expired] =
      await appSql`select claim_managed_sign_in_notification(${operationId}::uuid,'auth@example.test','original-provider',600) claim`;
    expect(expired!.claim).toBeNull();
  });
  test("concurrent removals leave one usable method and a social-only human can set a password", async () => {
    const user = await fixture(true, "google");
    await appSql`insert into auth_identities(id,user_id,provider_id,account_id,created_at,updated_at) values(${crypto.randomUUID()},${user.userId},'github',${crypto.randomUUID()},now(),now())`;
    Object.assign(user, await session(user.userId, "google"));
    const outcomes = await Promise.allSettled([
      mutate(user, { kind: "disconnect", provider: "google" }),
      mutate(user, { kind: "disconnect", provider: "github" }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    const [remaining] =
      await admin`select provider_id from auth_identities where user_id=${user.userId}`;
    expect(remaining).toBeDefined();
    Object.assign(user, await session(user.userId, remaining!.provider_id));
    await mutate(user, {
      kind: "password",
      expectedPasswordHash: null,
      passwordHash: await hashPassword("new-social-password-123"),
    });
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, user.userId)).loginBindings.some(
        (b) => b.providerId === "credential" && b.status === "active",
      ),
    ).toBe(true);
  });
  test("requires BOTH provider and local email verification, without trusted-provider bypass", async () => {
    const rt = runtime();
    for (const provider of ["google", "github"] as const)
      for (const local of [true, false])
        for (const incoming of [true, false, undefined]) {
          const user = await fixture(local);
          const result = await oauth(rt, user.email, incoming, provider);
          expect(result.error === null).toBe(Boolean(local && incoming));
          const accounts =
            await admin`select user_id from auth_identities where user_id=${user.userId} and provider_id=${provider}`;
          expect(accounts.length).toBe(local && incoming ? 1 : 0);
          expect(
            (await admin`select email_verified from auth_users where id=${user.userId}`)[0]!
              .email_verified,
          ).toBe(local);
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
      expectedIdentityId: user.identityId,
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
        expectedIdentityId: user.identityId,
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
    const stateCookies =
      (await cookie(rt, user.token)) +
      "; " +
      start.headers
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
        expectedIdentityId: user.identityId,
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
          cookie:
            (await cookie(rt, user.token)) +
            "; " +
            start.headers
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
        expectedIdentityId: user.identityId,
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
        expectedIdentityId: user.identityId,
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
