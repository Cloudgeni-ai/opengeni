import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { isPasskeyOnlyAccountEmail } from "@opengeni/contracts/managed-sign-in-methods";
import { createManagedAuth, hashManagedAuthPassword } from "../src/auth/managed-auth";
import { createApp } from "../src/app";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import {
  createSoftwarePasskey,
  softwarePasskeyAssertion,
  softwarePasskeyRegistration,
  type SoftwarePasskey,
} from "./helpers/software-passkey";

const ORIGIN = "https://opengeni.test";
let shared: SharedTestDatabase | undefined;
let client: DbClient;
let admin: postgres.Sql;

beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("managed-passkeys")) ?? undefined;
  if (!shared) throw new Error("Managed passkey integration requires PostgreSQL");
  admin = shared.admin;
  // 0998 withholds passkey storage from the runtime for a release; these
  // tests run as the deployment will once a later migration grants it.
  await grantDeferredRuntimeAccess(admin);
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function runtime(overrides: Record<string, unknown> = {}, db: DbClient["db"] = client.db) {
  const messages: ManagedEmailMessage[] = [];
  const transport: ManagedEmailTransport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:passkeys", retentionSeconds: 86400 },
    send: async (message: ManagedEmailMessage) => {
      messages.push(message);
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    publicBaseUrl: ORIGIN,
    betterAuthSecret: "managed-passkey-test-secret-at-least-32-bytes",
    managedAuthRequireEmailVerification: false,
    managedAuthPasskeySignUpEnabled: true,
    ...overrides,
  });
  const auth = createManagedAuth(settings, db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, db);
  const app = createApp({
    settings,
    db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  return { app, auth, adapter, messages };
}
type Runtime = ReturnType<typeof runtime>;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...extra,
  };
}

async function post(rt: Runtime, path: string, body: unknown, extra: Record<string, string> = {}) {
  return await rt.app.request(path, {
    method: "POST",
    headers: headers(extra),
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

async function signUp(rt: Runtime, name = "Passkey Person") {
  const passkey = createSoftwarePasskey();
  const options = await post(rt, "/v1/auth/passkey/sign-up/options", { name });
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as {
    challengeId: string;
    options: Record<string, unknown>;
  };
  expect(ceremony.options).toMatchObject({
    rp: { id: "opengeni.test", name: "Opengeni" },
    attestation: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const response = await post(rt, "/v1/auth/passkey/sign-up", {
    challengeId: ceremony.challengeId,
    response: softwarePasskeyRegistration(passkey, ceremony.options, {
      origin: ORIGIN,
      aaguid: "d548826e-79b4-db40-a3d8-11116f7e8349",
      flags: { backedUp: true },
    }),
  });
  return { passkey, response };
}

async function signIn(
  rt: Runtime,
  passkey: SoftwarePasskey,
  input: { flags?: { userVerified?: boolean }; origin?: string; crossOrigin?: boolean } = {},
) {
  const options = await post(rt, "/v1/auth/passkey/sign-in/options", {});
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as {
    challengeId: string;
    options: Record<string, unknown>;
  };
  const response = await post(rt, "/v1/auth/passkey/sign-in", {
    challengeId: ceremony.challengeId,
    response: softwarePasskeyAssertion(passkey, ceremony.options, {
      origin: input.origin ?? ORIGIN,
      ...(input.flags ? { flags: input.flags } : {}),
      ...(input.crossOrigin ? { crossOrigin: true } : {}),
    }),
  });
  return { ceremony, response };
}

async function methods(rt: Runtime, cookie: string) {
  const response = await rt.app.request("/v1/auth/sign-in-methods", { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    email: string;
    identityId: string;
    identityRevision: number;
    methods: { provider: string; connected: boolean; available: boolean }[];
    passkeys: { id: string; name: string; backedUp: boolean; lastUsedAt: string | null }[];
    passkeysAvailable: boolean;
    canRemovePasskey: boolean;
  };
}

async function passwordFixture() {
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Password Person',${email},true)`;
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at)
    values(${crypto.randomUUID()},${userId},'credential',${userId},${await hashManagedAuthPassword("fixture-password-123")},now(),now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find((b) => b.providerId === "credential")!;
  const token = crypto.randomUUID();
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  return { userId, email, token };
}

async function legacyCookie(rt: Runtime, token: string) {
  return (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function addPasskey(rt: Runtime, cookie: string) {
  const before = await methods(rt, cookie);
  const options = await post(rt, "/v1/auth/sign-in-methods/passkey/options", {}, { cookie });
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as {
    challengeId: string;
    options: Record<string, unknown>;
  };
  const passkey = createSoftwarePasskey();
  const response = await post(
    rt,
    "/v1/auth/sign-in-methods/passkey",
    {
      operationId: crypto.randomUUID(),
      expectedIdentityId: before.identityId,
      expectedIdentityRevision: before.identityRevision,
      challengeId: ceremony.challengeId,
      response: softwarePasskeyRegistration(passkey, ceremony.options, { origin: ORIGIN }),
      name: "Work laptop",
    },
    { cookie },
  );
  return { passkey, response };
}

describe("passkey sign-in and passkey-only accounts", () => {
  test("the client config offers passkeys only on a secure address, and sign-up only when enabled", async () => {
    const config = async (rt: Runtime) =>
      (
        (await (await rt.app.request("/v1/config/client")).json()) as {
          auth: Record<string, unknown>;
        }
      ).auth;
    expect(await config(runtime())).toMatchObject({ passkeySignIn: true, passkeySignUp: true });
    expect(await config(runtime({ managedAuthPasskeySignUpEnabled: false }))).toMatchObject({
      passkeySignIn: true,
      passkeySignUp: false,
    });
    expect(await config(runtime({ allowedUserEmails: ["someone@example.test"] }))).toMatchObject({
      passkeySignIn: true,
      passkeySignUp: false,
    });
    const insecure = runtime({ publicBaseUrl: "http://opengeni.test" });
    expect(await config(insecure)).toMatchObject({ passkeySignIn: false, passkeySignUp: false });
    expect((await post(insecure, "/v1/auth/passkey/sign-in/options", {})).status).toBe(404);
  });

  test("creates an account with only a passkey, signs in with it, and never reuses a ceremony", async () => {
    const rt = runtime();
    const { passkey, response } = await signUp(rt);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: true });
    const cookie = sessionCookie(response);
    expect(cookie).toContain("session_token=");

    const account = await methods(rt, cookie);
    expect(isPasskeyOnlyAccountEmail(account.email)).toBe(true);
    expect(account.passkeysAvailable).toBe(true);
    expect(account.passkeys).toHaveLength(1);
    expect(account.passkeys[0]).toMatchObject({ name: "Bitwarden", backedUp: true });
    // The only passkey is the only way in, and an account without an email
    // address can't add a password or a provider account.
    expect(account.canRemovePasskey).toBe(false);
    expect(account.methods.every((method) => !method.available)).toBe(true);
    const [user] = await admin<{ name: string; emailVerified: boolean }[]>`
      select name, email_verified as "emailVerified" from auth_users where email = ${account.email}`;
    expect(user).toEqual({ name: "Passkey Person", emailVerified: true });

    const first = await signIn(rt, passkey);
    expect(first.response.status).toBe(200);
    expect(sessionCookie(first.response)).toContain("session_token=");
    const [stored] = await admin<{ counter: string; lastUsedAt: Date | null }[]>`
      select counter::text, last_used_at as "lastUsedAt" from auth_passkeys where credential_id = ${passkey.credentialId}`;
    expect(stored?.counter).toBe(String(passkey.counter));
    expect(stored?.lastUsedAt).not.toBeNull();

    // The same challenge answers once.
    const replay = await post(rt, "/v1/auth/passkey/sign-in", {
      challengeId: first.ceremony.challengeId,
      response: softwarePasskeyAssertion(passkey, first.ceremony.options, { origin: ORIGIN }),
    });
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ code: "PASSKEY_CEREMONY_EXPIRED" });
  });

  test("refuses foreign origins, unknown passkeys and passkeys without user verification", async () => {
    const rt = runtime();
    const { passkey, response } = await signUp(rt);
    expect(response.status).toBe(200);

    const foreign = await rt.app.request("/v1/auth/passkey/sign-in/options", {
      method: "POST",
      headers: { ...headers(), origin: "https://elsewhere.test" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);

    // A response signed for another origin fails verification.
    const phished = await signIn(rt, passkey, { origin: "https://elsewhere.test" });
    expect(phished.response.status).toBe(422);
    expect(await phished.response.json()).toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });

    // A ceremony another site ran in a frame of this page is refused.
    const framed = await signIn(rt, passkey, { crossOrigin: true });
    expect(framed.response.status).toBe(422);
    expect(await framed.response.json()).toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(sessionCookie(framed.response)).toBe("");

    const unverified = await signIn(rt, passkey, { flags: { userVerified: false } });
    expect(unverified.response.status).toBe(422);
    expect(await unverified.response.json()).toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(sessionCookie(unverified.response)).toBe("");

    const stranger = await signIn(rt, createSoftwarePasskey());
    expect(stranger.response.status).toBe(422);
    expect(await stranger.response.json()).toMatchObject({ code: "PASSKEY_UNKNOWN_CREDENTIAL" });
  });

  test("sign-up follows the deployment's switches", async () => {
    const disabled = runtime({ managedAuthPasskeySignUpEnabled: false });
    const refused = await post(disabled, "/v1/auth/passkey/sign-up/options", { name: "Nobody" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "PASSKEY_SIGN_UP_UNAVAILABLE" });

    const paused = runtime({ managedAuthNewSignupsEnabled: false });
    expect(
      (await post(paused, "/v1/auth/passkey/sign-up/options", { name: "Nobody" })).status,
    ).toBe(403);
  });

  test("a password account adds a passkey, signs in with it, and may remove it", async () => {
    const rt = runtime();
    const person = await passwordFixture();
    const cookie = await legacyCookie(rt, person.token);
    const { passkey, response } = await addPasskey(rt, cookie);
    expect(response.status).toBe(200);
    // The first passkey is a new sign-in method: every session ends, and the
    // person is told by email.
    expect(await response.json()).toEqual({ reauthenticationRequired: true, notification: "sent" });
    expect(rt.messages.at(-1)).toMatchObject({ to: person.email, kind: "sign_in_method_changed" });
    expect(rt.messages.at(-1)?.text).toContain("passkey");

    const signedIn = await signIn(rt, passkey);
    expect(signedIn.response.status).toBe(200);
    const fresh = sessionCookie(signedIn.response);
    const account = await methods(rt, fresh);
    expect(account.passkeys).toEqual([
      expect.objectContaining({ name: "Work laptop", backedUp: false }),
    ]);
    expect(account.canRemovePasskey).toBe(true);

    // A second passkey doesn't sign anyone out.
    const second = await addPasskey(rt, fresh);
    expect(await second.response.json()).toMatchObject({ reauthenticationRequired: false });

    const removed = await post(
      rt,
      "/v1/auth/sign-in-methods/passkey/remove",
      {
        operationId: crypto.randomUUID(),
        expectedIdentityId: account.identityId,
        expectedIdentityRevision: account.identityRevision,
        passkeyId: account.passkeys[0]!.id,
      },
      { cookie: fresh },
    );
    expect(removed.status).toBe(200);
    // Sessions don't record which passkey opened them, so removing one ends
    // every session, including the one the removed passkey opened.
    expect(await removed.json()).toMatchObject({ reauthenticationRequired: true });
    const stale = await rt.app.request("/v1/auth/sign-in-methods", { headers: { cookie: fresh } });
    expect(stale.status).toBe(401);
    const [{ sessions }] = await admin<{ sessions: number }[]>`
      select count(*)::int as sessions from auth_sessions where user_id=${person.userId}`;
    expect(sessions).toBe(0);

    const remaining = await signIn(rt, second.passkey);
    expect(remaining.response.status).toBe(200);
    expect((await methods(rt, sessionCookie(remaining.response))).passkeys).toHaveLength(1);
    const gone = await signIn(rt, passkey);
    expect(gone.response.status).toBe(422);
  });

  test("the last passkey of an account without an email address can't be removed", async () => {
    const rt = runtime();
    const { response } = await signUp(rt);
    const cookie = sessionCookie(response);
    const account = await methods(rt, cookie);
    const refused = await post(
      rt,
      "/v1/auth/sign-in-methods/passkey/remove",
      {
        operationId: crypto.randomUUID(),
        expectedIdentityId: account.identityId,
        expectedIdentityRevision: account.identityRevision,
        passkeyId: account.passkeys[0]!.id,
      },
      { cookie },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SIGN_IN_METHOD_LAST_USABLE_METHOD" });
    const password = await post(
      rt,
      "/v1/auth/sign-in-methods/password",
      {
        operationId: crypto.randomUUID(),
        expectedIdentityId: account.identityId,
        expectedIdentityRevision: account.identityRevision,
        newPassword: "a-new-password-123",
      },
      { cookie },
    );
    expect(password.status).toBe(409);
    expect(await password.json()).toMatchObject({ code: "SIGN_IN_METHOD_UNAVAILABLE" });
  });

  test("adding a passkey needs a recent sign-in before the browser makes one", async () => {
    const rt = runtime();
    const person = await passwordFixture();
    await admin`update auth_sessions set created_at = now() - interval '10 minutes'
      where token = ${person.token}`;
    const cookie = await legacyCookie(rt, person.token);
    const options = await post(rt, "/v1/auth/sign-in-methods/passkey/options", {}, { cookie });
    expect(options.status).toBe(403);
    expect(await options.json()).toMatchObject({
      code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED",
    });
  });

  test("passkeys stay off until the runtime is granted passkey storage", async () => {
    const person = await passwordFixture();
    await admin.unsafe(`
      REVOKE ALL ON TABLE auth_passkeys FROM opengeni_app;
      REVOKE EXECUTE ON FUNCTION mutate_managed_passkey(text, text, jsonb) FROM opengeni_app;
    `);
    // A fresh client: the grant check is cached per database client.
    const ungranted = createDb(shared!.appUrl, { max: 2, rlsStrategy: "force" });
    try {
      const rt = runtime({}, ungranted.db);
      const config = (await (await rt.app.request("/v1/config/client")).json()) as {
        auth: Record<string, unknown>;
      };
      expect(config.auth).toMatchObject({ passkeySignIn: false, passkeySignUp: false });
      expect((await post(rt, "/v1/auth/passkey/sign-in/options", {})).status).toBe(404);
      expect((await post(rt, "/v1/auth/passkey/sign-up/options", { name: "x" })).status).toBe(404);
      const cookie = await legacyCookie(rt, person.token);
      const listed = await methods(rt, cookie);
      expect(listed.passkeys).toEqual([]);
      expect(listed.passkeysAvailable).toBe(false);
      const options = await post(rt, "/v1/auth/sign-in-methods/passkey/options", {}, { cookie });
      expect(options.status).toBe(409);
      expect(await options.json()).toMatchObject({ code: "SIGN_IN_METHOD_UNAVAILABLE" });
      const remove = await post(
        rt,
        "/v1/auth/sign-in-methods/passkey/remove",
        {
          operationId: crypto.randomUUID(),
          expectedIdentityId: listed.identityId,
          expectedIdentityRevision: listed.identityRevision,
          passkeyId: crypto.randomUUID(),
        },
        { cookie },
      );
      expect(remove.status).toBe(409);
    } finally {
      await grantDeferredRuntimeAccess(admin);
      await ungranted.close();
    }
  });
});
