import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";
let shared: SharedTestDatabase | null;
let client: DbClient | null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("signup-challenge");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("PostgreSQL required");
  if (shared) client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("email and OAuth creation require a single-use challenge, including direct API and forged state", async () => {
  if (!shared || !client) return;
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "signup-challenge-test-secret-at-least-32-bytes",
    signupChallengeEnabled: true,
    signupChallengeHostnames: "opengeni.test",
    signupChallengeSecretKey: "mock-secret",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
  });
  const transport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:captcha", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  };
  const auth = createManagedAuth(settings, client.db, transport)!;
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  const headers = { "content-type": "application/json", origin: "http://opengeni.test" };
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  const originalFetch = globalThis.fetch;
  const consumed = new Set<string>();
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify")
      return originalFetch(url, init);
    const token = JSON.parse(String(init?.body)).response;
    if (token === "provider-unavailable")
      return Response.json({ success: false, "error-codes": ["internal-error"] });
    const success = !consumed.has(token);
    consumed.add(token);
    return Response.json({
      success,
      action: "signup",
      hostname: "opengeni.test",
      challenge_ts: new Date().toISOString(),
    });
  }) as typeof fetch;
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    for (const [token, status, code, message] of [
      [undefined, 403, "SIGNUP_CHALLENGE_REQUIRED", "Complete the signup verification."],
      [
        "provider-unavailable",
        503,
        "SIGNUP_CHALLENGE_UNAVAILABLE",
        "Verification is unavailable. Please try again.",
      ],
    ] as const) {
      const refused = await post("/v1/auth/sign-up/email", {
        name: "Human",
        email,
        password: "long-password-123",
        signupChallengeToken: token,
      });
      expect(refused.status).toBe(status);
      expect(await refused.json()).toMatchObject({
        error: {
          status,
          code: status === 503 ? "upstream_unavailable" : "forbidden",
          message,
          retryable: status === 503,
          details: { managedAuthCode: code },
        },
      });
    }
    expect(
      (
        await post("/v1/auth/sign-up/email", {
          name: "Human",
          email,
          password: "long-password-123",
          signupChallengeToken: "first",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/v1/auth/sign-up/email", {
          name: "Human",
          email: `replay-${email}`,
          password: "long-password-123",
          signupChallengeToken: "first",
        })
      ).status,
    ).toBe(403);
    await expect(
      auth.api.signUpEmail({
        body: { name: "Bypass", email: `bypass-${email}`, password: "long-password-123" },
        headers: new Headers(headers),
      }),
    ).rejects.toThrow();
    const google = (await auth.$context).socialProviders.find(
      (provider) => provider.id === "google",
    )!;
    google.validateAuthorizationCode = async () => ({ accessToken: "fake", tokenType: "Bearer" });
    const socialEmail = `social-${email}`;
    google.getUserInfo = async () => ({
      user: { id, name: "Human", email: socialEmail, emailVerified: true },
      data: {},
    });
    async function oauth(token?: string) {
      const start = await post("/v1/auth/sign-in/social", {
        provider: "google",
        disableRedirect: true,
        callbackURL: "http://opengeni.test/",
        signupChallengeToken: token,
        additionalData: {
          opengeniSignupChallenge: { provider: "google", expiresAt: Date.now() + 600000 },
        },
      });
      expect(start.status).toBe(200);
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get(
        "state",
      );
      return await app.request(`/v1/auth/callback/google?state=${state}&code=simulated`, {
        headers: {
          ...headers,
          cookie: start.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        },
      });
    }
    const count = async () =>
      (
        await shared!.admin<
          { n: number }[]
        >`select count(*)::int n from auth_users where email = ${socialEmail}`
      )[0]!.n;
    const refused = await oauth();
    expect(await count()).toBe(0);
    expect(new URL(refused.headers.get("location")!).searchParams.get("error")).toBe(
      "signup_challenge_required",
    );
    await oauth("social");
    expect(await count()).toBe(1);
    // An existing human can sign in without another CAPTCHA.
    const login = await oauth();
    expect(await count()).toBe(1);
    expect(login.headers.get("location")).toBe("http://opengeni.test/");
    expect(login.headers.getSetCookie().some((value) => value.includes("session_token="))).toBe(
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 120_000);

test("passwordless negative probes cannot create an account or send email when challenge is disabled", async () => {
  if (!shared || !client) return;
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "signup-challenge-disabled-test-secret-32-bytes",
    signupChallengeEnabled: false,
  });
  let delivered = 0;
  const transport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:captcha-disabled", retentionSeconds: 86400 },
    send: async () => {
      delivered += 1;
      return { status: "sent" as const, providerMessageId: null };
    },
  };
  const auth = createManagedAuth(settings, client.db, transport)!;
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  const email = `turnstile-negative-${crypto.randomUUID()}@example.invalid`;
  for (const signupChallengeToken of [undefined, "invalid-negative-probe"]) {
    const response = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://opengeni.test" },
      body: JSON.stringify({ name: "Negative verification probe", email, signupChallengeToken }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  }
  const rows = await shared.admin<
    { n: number }[]
  >`select count(*)::int n from auth_users where email = ${email}`;
  expect(rows[0]!.n).toBe(0);
  expect(delivered).toBe(0);
}, 120_000);

test("broker OAuth persists the pass in server state and replays without consuming CAPTCHA twice", async () => {
  if (!shared || !client) return;
  const {
    MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
    MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  } = await import("@opengeni/contracts/managed-auth-session-sets");
  const { MANAGED_AUTH_ACTOR_EPOCH_HEADER } =
    await import("@opengeni/core/managed-auth-session-sets");
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: "broker",
    publicBaseUrl: "http://opengeni.test",
    betterAuthSecret: "signup-challenge-broker-test-secret-32-bytes",
    signupChallengeEnabled: true,
    signupChallengeHostnames: "opengeni.test",
    signupChallengeSecretKey: "mock-secret",
    managedAuthGoogleClientId: "google-test",
    managedAuthGoogleClientSecret: "google-secret",
  });
  const auth = createManagedAuth(settings, client.db, { send: async () => undefined } as never)!;
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const initialResponse = await app.request("/v1/auth/session-set");
  const initial = (await initialResponse.json()) as {
    generation: string;
    csrfToken: string;
    actorEpoch: string;
  };
  const authorityCookie = cookies(initialResponse);
  const headers = {
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": initial.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: initial.actorEpoch,
    cookie: authorityCookie,
  };
  const begin = await app.request("/v1/auth/session-set/transactions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      kind: "add",
    }),
  });
  expect(begin.status).toBe(200);
  const transaction = (await begin.json()) as { id: string };
  headers.cookie += `; ${cookies(begin)}`;
  const body = JSON.stringify({
    operationId: crypto.randomUUID(),
    expectedGeneration: initial.generation,
    transactionId: transaction.id,
    provider: "google",
    signupChallengeToken: "broker-token",
  });
  const originalFetch = globalThis.fetch;
  let verifications = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify")
      return originalFetch(url, init);
    verifications++;
    return Response.json({
      success: verifications === 1,
      action: "signup",
      hostname: "opengeni.test",
      challenge_ts: new Date().toISOString(),
    });
  }) as typeof fetch;
  try {
    const start = await app.request("/v1/auth/session-set/transactions/social", {
      method: "POST",
      headers,
      body,
    });
    expect(start.status).toBe(200);
    const started = (await start.json()) as { url: string };
    const replay = await app.request("/v1/auth/session-set/transactions/social", {
      method: "POST",
      headers,
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(started);
    expect(verifications).toBe(1);
    const state = new URL(started.url).searchParams.get("state")!;
    const stored = await (await auth.$context).internalAdapter.findVerificationValue(state);
    const data = JSON.parse(stored!.value);
    expect(data.opengeniSignupChallenge.provider).toBe("google");
    expect(stored!.value).not.toContain("broker-token");
    const google = (await auth.$context).socialProviders.find(
      (provider) => provider.id === "google",
    )!;
    const id = crypto.randomUUID();
    const email = `${id}@example.test`;
    google.validateAuthorizationCode = async () => ({ accessToken: "fake", tokenType: "Bearer" });
    google.getUserInfo = async () => ({
      user: { id, name: "Human", email, emailVerified: true },
      data: {},
    });
    await app.request(`/v1/auth/callback/google?state=${state}&code=simulated`, {
      headers: { ...headers, cookie: `${headers.cookie}; ${cookies(start)}` },
    });
    const rows = await shared.admin<
      { n: number }[]
    >`select count(*)::int n from auth_users where email = ${email}`;
    expect(rows[0]!.n).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 120_000);
