import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { OPENGENI_USER_ACTIVITY_ACTIVE, OPENGENI_USER_ACTIVITY_HEADER } from "@opengeni/contracts";
import { createUserPresenceRecorder } from "@opengeni/core";

import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";

// The same Better Auth writes that drive the sign-up funnel counters must each
// leave exactly one durable, content-free lifecycle fact for the host export.

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let clientAddress = 40;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("product-lifecycle-facts-api");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("product lifecycle fact tests require PostgreSQL");
  }
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
  await shared.admin`
    select opengeni_host_export.register_host_export_consumer(
      'lifecycle_fact', 'lifecycle-facts-api-test'
    )`;
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function runtimeSettings() {
  return testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "product-lifecycle-facts-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    managedAuthSessionSetMode: "legacy",
  });
}

function captureTransport() {
  const messages: ManagedEmailMessage[] = [];
  const transport: ManagedEmailTransport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:lifecycle-facts", retentionSeconds: 86_400 },
    send: async (message) => {
      messages.push(message);
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  return { messages, transport };
}

function quietObservability(): Observability {
  const observability = createObservability(runtimeSettings(), { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  observability.error = () => undefined;
  return observability;
}

function requestHeaders(cookie?: string): Record<string, string> {
  clientAddress += 1;
  return {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": `198.51.100.${clientAddress % 250}`,
    ...(cookie ? { cookie } : {}),
  };
}

function cookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

type FactRow = {
  event_type: string;
  account_id: string | null;
  workspace_id: string | null;
  initiator: { kind: string; subjectId: string } | null;
  payload: { factType: string; attribute: string | null; subjectKind: string };
};

async function subjectFor(email: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    select id from auth_users where email = ${email}`;
  if (!row) throw new Error("auth user was not created");
  return `user:${row.id}`;
}

async function factsFor(subjectId: string): Promise<FactRow[]> {
  return await shared!.admin<FactRow[]>`
    select event_type, account_id::text, workspace_id::text, initiator, payload
    from host_export_outbox
    where export_kind = 'lifecycle_fact' and initiator ->> 'subjectId' = ${subjectId}
    order by enqueued_at, id`;
}

function summary(rows: FactRow[]): Array<[string, string | null, string | null]> {
  return rows.map((row) => [row.event_type, row.payload.attribute, row.account_id]);
}

describe("product lifecycle facts from managed auth", () => {
  test("email sign-up, verification, sign-in and organization setup each write one fact", async () => {
    if (!shared || !client) return;
    const { messages, transport } = captureTransport();
    // A long flush delay: the test flushes explicitly, like a process tick.
    const userPresence = createUserPresenceRecorder({ db: client.db, flushDelayMs: 600_000 });
    const app = createApp({
      settings: runtimeSettings(),
      db: client.db,
      observability: quietObservability(),
      userPresence,
      managedEmailTransport: transport,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `lifecycle-${crypto.randomUUID()}@example.test`;
    const password = "lifecycle-password-123";
    const signUp = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Lifecycle Human", email, password }),
    });
    expect(signUp.status).toBeLessThan(300);
    const subjectId = await subjectFor(email);
    expect(summary(await factsFor(subjectId))).toEqual([["auth.sign_up", "email", null]]);

    // A duplicate sign-up for the same address is not another sign-up.
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ name: "Lifecycle Human", email, password }),
    });
    expect(await factsFor(subjectId)).toHaveLength(1);

    const verification = messages.find((message) => message.kind === "email_verification");
    const link = new URL(verification!.text.match(/https?:\/\/\S+/)![0]);
    const verificationPath = `${link.pathname}${link.search}`;
    const verified = await app.request(verificationPath, { headers: requestHeaders() });
    expect(verified.status).toBeLessThan(400);
    // Legacy mode signs the new user in from the first verification click.
    expect(summary(await factsFor(subjectId))).toEqual([
      ["auth.sign_up", "email", null],
      ["auth.email_verified", null, null],
      ["auth.sign_in", "email", null],
    ]);
    // A reused link neither verifies again nor signs in.
    await app.request(verificationPath, { headers: requestHeaders() });
    expect(await factsFor(subjectId)).toHaveLength(3);

    const setup = await app.request("/v1/auth/organization-onboarding", {
      method: "POST",
      headers: requestHeaders(cookiePairs(verified)),
      body: JSON.stringify({
        organizationName: "Lifecycle Org",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(setup.status).toBe(200);
    const { organizationId } = (await setup.json()) as { organizationId: string };

    const signIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signIn.status).toBe(200);
    const facts = await factsFor(subjectId);
    expect(summary(facts)).toEqual([
      ["auth.sign_up", "email", null],
      ["auth.email_verified", null, null],
      ["auth.sign_in", "email", null],
      ["organization.setup", "created", organizationId],
      ["auth.sign_in", "email", null],
    ]);
    // A request the console did not mark as human activity (background
    // polling, an idle tab, a stream) records no presence.
    const idle = await app.request("/v1/workspaces", {
      headers: requestHeaders(cookiePairs(signIn)),
    });
    expect(idle.status).toBe(200);
    await userPresence.flush();
    expect(
      await shared.admin`
        select 1 from opengeni_private.user_activity_presence where subject_id = ${subjectId}`,
    ).toHaveLength(0);
    // An active browser request records presence once per throttle window,
    // and the first activity of the UTC day is one `user.active` fact.
    for (let index = 0; index < 3; index += 1) {
      const workspaces = await app.request("/v1/workspaces", {
        headers: {
          ...requestHeaders(cookiePairs(signIn)),
          [OPENGENI_USER_ACTIVITY_HEADER]: OPENGENI_USER_ACTIVITY_ACTIVE,
        },
      });
      expect(workspaces.status).toBe(200);
      await userPresence.flush();
    }
    const presence = await shared.admin<{ subject_id: string }[]>`
      select subject_id from opengeni_private.user_activity_presence
      where subject_id = ${subjectId}`;
    expect(presence).toHaveLength(1);
    expect(summary((await factsFor(subjectId)).slice(5))).toEqual([["user.active", null, null]]);

    // Nothing that identifies the person beyond the opaque subject id.
    const exported = JSON.stringify(await factsFor(subjectId));
    expect(exported).not.toContain(email);
    expect(exported).not.toContain("Lifecycle Human");
    expect(exported).not.toContain("Lifecycle Org");
    expect(exported).not.toContain("198.51.100.");
  }, 120_000);

  test("a Google sign-up is verified at creation and signs in with its own method", async () => {
    if (!shared || !client) return;
    const settings = runtimeSettings();
    const { transport } = captureTransport();
    const observability = quietObservability();
    const auth = createManagedAuth(settings, client.db, transport, { observability })!;
    const app = createApp({
      settings,
      db: client.db,
      observability,
      managedAuth: auth,
      managedEmailTransport: transport,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const context = await auth.$context;
    const google = context.socialProviders.find((provider) => provider.id === "google")!;
    google.validateAuthorizationCode = async () => ({
      accessToken: "test-provider-token",
      tokenType: "Bearer",
    });
    const accountId = crypto.randomUUID();
    const email = `social-lifecycle-${accountId}@example.test`;
    google.getUserInfo = async () => ({
      user: { id: accountId, name: "Provider Human", email, emailVerified: true },
      data: {},
    });
    const start = await app.request("/v1/auth/sign-in/social", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        provider: "google",
        callbackURL: "http://opengeni.test/",
        disableRedirect: true,
      }),
    });
    expect(start.status).toBe(200);
    const authorization = new URL(((await start.json()) as { url: string }).url);
    const callback = await app.request(
      `/v1/auth/callback/google?state=${authorization.searchParams.get("state")}&code=simulated-provider-code`,
      { headers: requestHeaders(cookiePairs(start)) },
    );
    expect(callback.status).toBe(302);

    const facts = await factsFor(await subjectFor(email));
    expect(facts.map((row) => row.event_type).sort()).toEqual([
      "auth.email_verified",
      "auth.sign_in",
      "auth.sign_up",
    ]);
    expect(
      facts
        .filter((row) => row.event_type !== "auth.email_verified")
        .map((row) => row.payload.attribute),
    ).toEqual(["google", "google"]);
    expect(JSON.stringify(facts)).not.toContain(email);
    expect(JSON.stringify(facts)).not.toContain(accountId);
  }, 120_000);
});
