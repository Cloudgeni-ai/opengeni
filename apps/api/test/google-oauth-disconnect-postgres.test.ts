import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createConnection,
  createDb,
  createManagedOrganization,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { GOOGLE_OAUTH_REVOKE_URL } from "../src/integrations/google-oauth-revocation";

/* Disconnecting a Google OAuth connection ends the grant at Google and leaves
   no Google tokens in the revoked row, even when Google is unreachable. The
   grant stays at Google while another live connection may share it. Other
   providers keep status-only revocation. Through the real app and PostgreSQL. */

const origin = "http://opengeni.test";
const encryptionKey = randomBytes(32);
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
let shared: SharedTestDatabase;
let client: DbClient;
let app: ReturnType<typeof createApp>;
let revokeRequests: Array<{ url: string; body: string; method: string }> = [];
let revokeReply: () => Promise<Response> = async () => new Response("{}", { status: 200 });

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("google-oauth-disconnect");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  app = createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "google-oauth-disconnect-better-auth-secret-32",
      publicBaseUrl: origin,
      environmentsEncryptionKey: encryptionKey.toString("base64"),
      mcpOauthEnabled: true,
      integrationsEnabled: true,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    googleDriveFetch: async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      revokeRequests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return await revokeReply();
    },
  });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

beforeEach(() => {
  revokeRequests = [];
  revokeReply = async () => new Response("{}", { status: 200 });
});

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

type Person = { cookie: string; subjectId: string; workspaceId: string; accountId: string };

async function signedInPerson(): Promise<Person> {
  const email = `google-disconnect-${randomUUID()}@example.test`;
  const password = "password1234";
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const signin = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const setCookie = signin.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!setCookie) throw new Error("sign-in did not set a session cookie");
  const cookie = setCookie.split(";", 1)[0]!;
  const [authUser] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  await createManagedOrganization(client.db, {
    subjectId: `user:${authUser!.id}`,
    subjectLabel: email,
    name: "Google Org",
    operationId: randomUUID(),
  });
  const me = await app.request("/v1/access/me", { headers: { cookie } });
  expect(me.status).toBe(200);
  const access = (await me.json()) as {
    subjectId: string;
    workspaceGrants: Array<{ workspaceId: string }>;
  };
  const workspaceId = access.workspaceGrants[0]!.workspaceId;
  const [workspace] = await shared.admin<
    { account_id: string }[]
  >`select account_id from workspaces where id = ${workspaceId}`;
  return { cookie, subjectId: access.subjectId, workspaceId, accountId: workspace!.account_id };
}

async function storedCredential(connectionId: string): Promise<{ status: string; plain: string }> {
  const [row] = await shared.admin<{ status: string; credential_encrypted: string }[]>`
    select status, credential_encrypted from connections where id = ${connectionId}`;
  return {
    status: row!.status,
    plain: decryptEnvironmentValue(encryptionKey, row!.credential_encrypted),
  };
}

async function googleConnection(
  person: Person,
  personal: boolean,
  tokenEndpoint: string,
  options: { metadata?: Record<string, unknown>; refreshToken?: string } = {},
) {
  return await createConnection(client.db, {
    accountId: person.accountId,
    workspaceId: person.workspaceId,
    subjectId: personal ? person.subjectId : null,
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({
        access_token: "google-access-secret",
        refresh_token: options.refreshToken ?? "google-refresh-secret",
        token_type: "Bearer",
        token_endpoint: tokenEndpoint,
        client_id: "opengeni-client.apps.googleusercontent.com",
        client_secret: "google-client-secret",
      }),
    ),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    createdBySubjectId: person.subjectId,
  });
}

async function disconnect(person: Person, connectionId: string): Promise<void> {
  const removed = await app.request(
    `/v1/workspaces/${person.workspaceId}/connections/${connectionId}`,
    { method: "DELETE", headers: browser(person.cookie) },
  );
  expect(removed.status, await removed.clone().text()).toBe(200);
  const stored = await storedCredential(connectionId);
  expect(stored.status).toBe("revoked");
  expect(stored.plain).not.toContain("refresh-secret");
  expect(stored.plain).not.toContain("google-access-secret");
}

function revokedAtGoogle(): string[] {
  return revokeRequests.map((request) => new URLSearchParams(request.body).get("token") ?? "");
}

describe("Google OAuth disconnect", () => {
  test("revokes the grant at Google and destroys the stored tokens", async () => {
    const person = await signedInPerson();
    for (const personal of [true, false]) {
      revokeRequests = [];
      const connection = await googleConnection(person, personal, GOOGLE_TOKEN_ENDPOINT);
      const removed = await app.request(
        `/v1/workspaces/${person.workspaceId}/connections/${connection.id}`,
        { method: "DELETE", headers: browser(person.cookie) },
      );
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect(revokeRequests).toEqual([
        {
          url: GOOGLE_OAUTH_REVOKE_URL,
          method: "POST",
          body: new URLSearchParams({ token: "google-refresh-secret" }).toString(),
        },
      ]);
      const stored = await storedCredential(connection.id);
      expect(stored.status).toBe("revoked");
      for (const secret of [
        "google-access-secret",
        "google-refresh-secret",
        "google-client-secret",
      ])
        expect(stored.plain).not.toContain(secret);
      expect(JSON.parse(stored.plain)).toMatchObject({ token_endpoint: GOOGLE_TOKEN_ENDPOINT });
      expect(JSON.stringify(await removed.json())).not.toContain("google-refresh-secret");

      // A repeated disconnect is idempotent and calls Google no more.
      const repeated = await app.request(
        `/v1/workspaces/${person.workspaceId}/connections/${connection.id}`,
        { method: "DELETE", headers: browser(person.cookie) },
      );
      expect(repeated.status).toBe(200);
      expect(revokeRequests).toHaveLength(1);
    }
  });

  test("still destroys the stored tokens when Google is unreachable or refuses", async () => {
    const person = await signedInPerson();
    for (const reply of [
      async (): Promise<Response> => {
        throw new TypeError("network down");
      },
      async () => new Response("unavailable", { status: 503 }),
      async () => Response.json({ error: "invalid_token" }, { status: 400 }),
    ]) {
      revokeReply = reply;
      const connection = await googleConnection(person, true, GOOGLE_TOKEN_ENDPOINT);
      const removed = await app.request(
        `/v1/workspaces/${person.workspaceId}/connections/${connection.id}`,
        { method: "DELETE", headers: browser(person.cookie) },
      );
      expect(removed.status, await removed.clone().text()).toBe(200);
      const stored = await storedCredential(connection.id);
      expect(stored.status).toBe("revoked");
      expect(stored.plain).not.toContain("google-refresh-secret");
      expect(stored.plain).not.toContain("google-access-secret");
    }
  });

  test("other OAuth providers keep status-only revocation and are never sent to Google", async () => {
    const person = await signedInPerson();
    const connection = await googleConnection(person, true, "https://auth.example.test/token");
    const removed = await app.request(
      `/v1/workspaces/${person.workspaceId}/connections/${connection.id}`,
      { method: "DELETE", headers: browser(person.cookie) },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(revokeRequests).toEqual([]);
    const stored = await storedCredential(connection.id);
    expect(stored.status).toBe("revoked");
    expect(stored.plain).toContain("google-refresh-secret");
  });

  test("keeps the grant at Google while another live connection of the account may use it", async () => {
    const person = await signedInPerson();
    // Gmail and Drive of one Google account share Opengeni's Google client, so
    // revoking one grant at Google would cut off the other.
    const gmail = await googleConnection(person, true, GOOGLE_TOKEN_ENDPOINT, {
      metadata: { googleSubject: "google-sub-1", gmailEmail: "ada@example.test" },
      refreshToken: "gmail-refresh-secret",
    });
    const drive = await googleConnection(person, false, GOOGLE_TOKEN_ENDPOINT, {
      metadata: { googleSubject: "google-sub-1", googleDriveEmail: "ada@example.test" },
      refreshToken: "drive-refresh-secret",
    });
    // Another Google account and another provider never hold this grant.
    const otherAccount = await googleConnection(person, true, GOOGLE_TOKEN_ENDPOINT, {
      metadata: { googleSubject: "google-sub-2" },
      refreshToken: "other-account-refresh-secret",
    });
    await googleConnection(person, true, "https://auth.example.test/token", {
      refreshToken: "other-provider-refresh-secret",
    });

    await disconnect(person, gmail.id);
    expect(revokedAtGoogle()).toEqual([]);

    await disconnect(person, drive.id);
    expect(revokedAtGoogle()).toEqual(["drive-refresh-secret"]);

    // A connection without verified account identity may be the same account.
    const unidentified = await googleConnection(person, true, GOOGLE_TOKEN_ENDPOINT, {
      refreshToken: "unidentified-refresh-secret",
    });
    revokeRequests = [];
    await disconnect(person, otherAccount.id);
    expect(revokedAtGoogle()).toEqual([]);
    await disconnect(person, unidentified.id);
    expect(revokedAtGoogle()).toEqual(["unidentified-refresh-secret"]);
  });
});
