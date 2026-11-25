import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, resetHeedeoSignupModeCache, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createManagedAuth, findManagedAuthOAuthState } from "../src/auth/managed-auth";

// Heedeo signup scoring (docs/signup-abuse-protection.md, "Heedeo shadow
// scoring") through the real auth routes: the browser's token reaches the
// one evaluation in the user-create hook for email and Google sign-up, shadow
// never refuses, enforce refuses a `block` signup with the generic refusal,
// and a Heedeo failure never stops a signup.
let shared: SharedTestDatabase | null;
let client: DbClient | null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("heedeo-signup");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("signups carry the browser's Heedeo token into one evaluation; only enforce refuses, and failures fail open", async () => {
  if (!shared || !client) return;
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "heedeo-signup-test-secret-at-least-32-bytes",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
    heedeoPublishableKey: "pk_test",
    heedeoSecretKey: "sk_test",
    heedeoApiUrl: "https://heedeo.example.test",
  });
  const transport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:heedeo", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  };
  const evaluations: Record<string, unknown>[] = [];
  let answer: () => Response = () => Response.json({ flagged: false, no_token: false, score: 0 });
  const heedeoFetcher = (async (_url: string, init: RequestInit) => {
    evaluations.push(JSON.parse(String(init.body)));
    return answer();
  }) as unknown as typeof fetch;
  const auth = createManagedAuth(settings, client.db, transport, { heedeoFetcher })!;
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  const [{ schema }] = (await client.db.execute(
    sql`select current_schema() as schema`,
  )) as unknown as [{ schema: string }];
  let modeRevision = 0;
  const setMode = async (mode: "off" | "shadow" | "enforce") => {
    modeRevision += 1;
    await shared!.admin`insert into opengeni_private.signup_heedeo_mode_revisions
      (data_schema, revision, mode, changed_by, reason)
      values (${schema}, ${modeRevision}, ${mode}, 'test', 'heedeo signup test')`;
    resetHeedeoSignupModeCache();
  };
  // Verdicts are written after the response, without delaying the signup:
  // wait for the expected number of rows.
  const verdicts = async (userId: string | null, expected = 1) => {
    const read = async () =>
      userId === null
        ? await shared!.admin`select * from opengeni_private.signup_heedeo_evaluations
            where data_schema = ${schema} and user_id is null order by created_at`
        : await shared!.admin`select * from opengeni_private.signup_heedeo_evaluations
            where data_schema = ${schema} and user_id = ${userId}`;
    const deadline = Date.now() + 5_000;
    let rows = await read();
    while (rows.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rows = await read();
    }
    return rows;
  };
  const userId = async (email: string) =>
    (await shared!.admin<{ id: string }[]>`select id from auth_users where email = ${email}`)[0]
      ?.id ?? null;
  const headers = {
    "content-type": "application/json",
    origin: "http://opengeni.test",
    "user-agent": "heedeo-test",
    cookie: "unrelated=secret-cookie",
  };
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const signUp = (email: string, heedeoToken?: string) =>
    post("/v1/auth/sign-up/email", {
      name: "Human",
      email,
      password: "long-password-123",
      ...(heedeoToken ? { heedeoToken } : {}),
    });
  const id = crypto.randomUUID();

  // Off: no call, no row, no script for the browser.
  const offEmail = `off-${id}@example.test`;
  expect((await signUp(offEmail, "tok-off")).status).toBe(200);
  expect(evaluations).toHaveLength(0);
  expect(await verdicts(await userId(offEmail), 0)).toHaveLength(0);
  const offConfig = (await (await app.request("/v1/config/client")).json()) as {
    auth: { heedeo?: unknown };
  };
  expect(offConfig.auth.heedeo).toBeUndefined();

  // Shadow: a flagged answer is recorded and never refuses.
  await setMode("shadow");
  const config = (await (await app.request("/v1/config/client")).json()) as {
    auth: { heedeo?: unknown };
  };
  expect(config.auth.heedeo).toEqual({
    publishableKey: "pk_test",
    scriptUrl: "https://heedeo.dev/i.js",
  });
  expect(JSON.stringify(config)).not.toContain("sk_test");
  answer = () =>
    Response.json({
      flagged: true,
      no_token: false,
      score: 150,
      suggested: "review",
      event_id: "evt_shadow",
      reasons: [{ code: "repeat_action", text: "never stored" }],
      visitor: { id: "vis_shadow" },
    });
  const shadowEmail = `shadow-${id}@example.test`;
  expect((await signUp(shadowEmail, "tok-email")).status).toBe(200);
  expect(evaluations).toHaveLength(1);
  expect(evaluations[0]).toMatchObject({
    action: "signup",
    token: "tok-email",
    email: shadowEmail,
    headers: { "user-agent": "heedeo-test" },
  });
  expect(JSON.stringify(evaluations[0])).not.toContain("secret-cookie");
  const shadowUser = await userId(shadowEmail);
  expect(shadowUser).not.toBeNull();
  expect(await verdicts(shadowUser)).toEqual([
    expect.objectContaining({
      signup_method: "email",
      mode: "shadow",
      outcome: "evaluated",
      token_present: true,
      flagged: true,
      band: "review",
      evaluation_id: "evt_shadow",
      visitor_id: "vis_shadow",
      reason_codes: ["repeat_action"],
    }),
  ]);

  // Google: the start keeps the token in server-owned OAuth state (a value
  // the browser forged in additionalData is replaced) and the callback that
  // creates the account sends it, with the provider's evidence.
  const google = (await auth.$context).socialProviders.find(
    (provider) => provider.id === "google",
  )!;
  google.validateAuthorizationCode = async () => ({ accessToken: "fake", tokenType: "Bearer" });
  const socialEmail = `social-${id}@example.test`;
  google.getUserInfo = async () => ({
    user: { name: "Human", email: socialEmail, emailVerified: true },
    data: { sub: id },
  });
  answer = () => Response.json({ flagged: false, no_token: false, score: 10, event_id: "evt_g" });
  const start = await post("/v1/auth/sign-in/social", {
    provider: "google",
    disableRedirect: true,
    callbackURL: "http://opengeni.test/",
    heedeoToken: "tok-google",
    additionalData: {
      opengeniHeedeo: { provider: "google", token: "forged", expiresAt: Date.now() + 60_000 },
    },
  });
  expect(start.status).toBe(200);
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
  const stored = JSON.parse((await findManagedAuthOAuthState(auth, state))!.value);
  expect(stored.opengeniHeedeo).toMatchObject({ provider: "google", token: "tok-google" });
  expect(stored).not.toHaveProperty("heedeoToken");
  const callback = await app.request(`/v1/auth/callback/google?state=${state}&code=simulated`, {
    headers: {
      ...headers,
      cookie: start.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    },
  });
  expect(callback.status).toBe(302);
  expect(evaluations.at(-1)).toMatchObject({
    token: "tok-google",
    email: socialEmail,
    evidence: { oauth: { provider: "google", email_verified: true } },
  });
  expect(await verdicts(await userId(socialEmail))).toEqual([
    expect.objectContaining({ signup_method: "google", outcome: "evaluated", flagged: false }),
  ]);

  // Enforce: a flagged `review` signup goes through; a `block` one is refused
  // with the generic answer and no account.
  await setMode("enforce");
  answer = () => Response.json({ flagged: true, no_token: false, score: 150, suggested: "review" });
  const reviewEmail = `review-${id}@example.test`;
  expect((await signUp(reviewEmail, "tok-review")).status).toBe(200);
  expect(await verdicts(await userId(reviewEmail))).toEqual([
    expect.objectContaining({
      outcome: "evaluated",
      mode: "enforce",
      band: "review",
      flagged: true,
    }),
  ]);
  answer = () => Response.json({ flagged: true, no_token: true, score: 200, suggested: "block" });
  const refusedEmail = `refused-${id}@example.test`;
  const refused = await signUp(refusedEmail);
  expect(refused.status).toBeLessThan(500);
  expect(await userId(refusedEmail)).toBeNull();
  expect(evaluations.at(-1)).not.toHaveProperty("token");
  expect((await verdicts(null)).at(-1)).toMatchObject({
    outcome: "refused",
    mode: "enforce",
    signup_method: "email",
    token_present: false,
    band: "block",
  });

  // Enforce: a Heedeo failure lets the signup through.
  for (const [index, failure] of [
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 401 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ].entries()) {
    answer = failure;
    const email = `failopen-${index}-${id}@example.test`;
    expect((await signUp(email, "tok-fail")).status).toBe(200);
    const created = await userId(email);
    expect(created).not.toBeNull();
    expect(await verdicts(created)).toEqual([
      expect.objectContaining({ outcome: "error", mode: "enforce" }),
    ]);
  }
  await setMode("off");
}, 180_000);
