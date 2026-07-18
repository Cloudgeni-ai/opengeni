import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessContext } from "@opengeni/contracts";
import {
  createDb,
  encryptEnvironmentValue,
  listCodexAccountStatuses,
  upsertCodexSubscriptionCredential,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let available = true;

const PUBLIC_ORIGIN = "http://opengeni.test";
const RUN_ID = crypto.randomUUID();
const OWNER_USER_ID = `owner-${RUN_ID}`;
const OTHER_USER_ID = `other-${RUN_ID}`;
const OWNER_COOKIE = `better-auth.session_token=${OWNER_USER_ID}`;
const OTHER_COOKIE = `better-auth.session_token=${OTHER_USER_ID}`;
const DELEGATION_SECRET = "ope24-api-delegation-secret";
const settings = testSettings({
  productAccessMode: "managed",
  publicBaseUrl: PUBLIC_ORIGIN,
  betterAuthSecret: "ope24-better-auth-secret-at-least-32-bytes",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 42).toString("base64"),
  codexSubscriptionEnabled: true,
});

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_OPE24_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_OPE24_POSTGRES_APP_URL;
  if (!adminUrl || !appUrl) return await acquireSharedTestDatabase("codex-redemption-routes");
  await migrate(adminUrl);
  const nativeAdmin = postgres(adminUrl, { max: 8 });
  await nativeAdmin.unsafe(`
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  `);
  return {
    admin: nativeAdmin,
    adminUrl,
    appUrl,
    release: async () => await nativeAdmin.end().catch(() => undefined),
  };
}

const provider = {
  consumeBodies: [] as Array<{ redeem_request_id: string; credit_id: string }>,
  ambiguousFailures: 0,
  calls: 0,
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    provider.calls += 1;
    const url = String(input);
    if (url.endsWith("/wham/rate-limit-reset-credits/consume")) {
      const body = JSON.parse(String(init?.body)) as {
        redeem_request_id: string;
        credit_id: string;
      };
      provider.consumeBodies.push(body);
      if (body.credit_id === "credit-ambiguous" && provider.ambiguousFailures++ === 0) {
        throw new Error("injected timeout after provider may have accepted request");
      }
      return json({
        code: body.credit_id === "credit-ambiguous" ? "already_redeemed" : "reset",
        windows_reset: 2,
      });
    }
    if (url.endsWith("/wham/rate-limit-reset-credits")) {
      const now = Date.now();
      return json({
        available_count: 2,
        credits: [
          {
            id: "credit-reset",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
            title: "Full reset",
          },
          {
            id: "credit-ambiguous",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 8 * 24 * 60 * 60_000).toISOString(),
            title: "Second reset",
          },
          // Upstream available_count counts only available rows; detail history
          // can also contain redeemed/redeeming rows and remains complete.
          {
            id: "credit-already-used",
            reset_type: "codex_rate_limits",
            status: "redeemed",
            granted_at: new Date(now - 2 * 60_000).toISOString(),
            expires_at: new Date(now + 6 * 24 * 60 * 60_000).toISOString(),
            title: "Earlier reset",
          },
        ],
      });
    }
    if (url.endsWith("/wham/usage")) {
      return json({
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 25,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 10,
            reset_at: Math.floor(Date.now() / 1000) + 86_400,
            limit_window_seconds: 604_800,
          },
        },
        rate_limit_reset_credits: { available_count: 2 },
      });
    }
    throw new Error(`unexpected provider request ${url}`);
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cookieSession(headers: Headers) {
  const cookie = headers.get("cookie");
  if (cookie === OWNER_COOKIE) {
    return {
      session: {
        id: `session-${OWNER_USER_ID}`,
        userId: OWNER_USER_ID,
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: OWNER_USER_ID,
        email: `${OWNER_USER_ID}@example.com`,
        name: "Owner",
      },
    };
  }
  if (cookie === OTHER_COOKIE) {
    return {
      session: {
        id: `session-${OTHER_USER_ID}`,
        userId: OTHER_USER_ID,
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: OTHER_USER_ID,
        email: `${OTHER_USER_ID}@example.com`,
        name: "Other admin",
      },
    };
  }
  return null;
}

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: {
      handler: async () => new Response("not used", { status: 404 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) => cookieSession(headers),
      },
    } as any,
    codexFetch: provider.fetch.bind(provider) as typeof fetch,
  });
}

function browserHeaders(cookie = OWNER_COOKIE): Record<string, string> {
  return {
    cookie,
    origin: PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function prepare(
  api: ReturnType<typeof app>,
  workspaceId: string,
  credentialId: string,
  creditId: string,
  attemptId = crypto.randomUUID(),
  headers = browserHeaders(),
) {
  const response = await api.request(
    `/v1/workspaces/${workspaceId}/codex/accounts/${credentialId}/reset-credits/prepare`,
    { method: "POST", headers, body: JSON.stringify({ attemptId, creditId }) },
  );
  return {
    response,
    attemptId,
    body: (await response.json().catch(() => ({}))) as any,
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_OPE24_POSTGRES === "1") {
      throw new Error("OPE-24 API security tests require real PostgreSQL");
    }
    console.warn("[codex-redemption-routes] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 16 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("OPE-24 managed-cookie-only reset redemption API", () => {
  test("an actual Better Auth sign-in cookie can prepare its owning credential", async () => {
    if (!available) return;
    const actualSettings = testSettings({
      databaseUrl: shared!.adminUrl,
      productAccessMode: "managed",
      publicBaseUrl: PUBLIC_ORIGIN,
      betterAuthSecret: "ope24-real-better-auth-secret-32-bytes",
      environmentsEncryptionKey: settings.environmentsEncryptionKey,
      codexSubscriptionEnabled: true,
    });
    const actual = createApp({
      settings: actualSettings,
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      codexFetch: provider.fetch.bind(provider) as typeof fetch,
    });
    const email = `ope24-real-${crypto.randomUUID()}@example.com`;
    const password = "password1234";
    const signup = await actual.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Real OPE-24 Owner", email, password }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(200);
    expect(signup.status).toBeLessThan(300);
    await admin`update auth_users set email_verified = true where email = ${email}`;
    const signin = await actual.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBeGreaterThanOrEqual(200);
    expect(signin.status).toBeLessThan(300);
    const cookie = signin.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    const access = await actual.request("/v1/access/me", {
      headers: { cookie: cookie! },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    const ownerSubject = context.workspaceGrants[0]!.subjectId;
    expect(ownerSubject).toStartWith("user:");
    const key = Buffer.from(actualSettings.environmentsEncryptionKey!, "base64");
    const connected = await upsertCodexSubscriptionCredential(client.db, {
      accountId: context.defaultAccountId!,
      workspaceId: context.defaultWorkspaceId!,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "token",
          refresh_token: "refresh",
          id_token: "id",
        }),
      ),
      chatgptAccountId: `real-cookie-${crypto.randomUUID()}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: ownerSubject,
    });
    const consumeBefore = provider.consumeBodies.length;
    const prepared = await prepare(
      actual,
      context.defaultWorkspaceId!,
      connected.id,
      "credit-reset",
      crypto.randomUUID(),
      browserHeaders(cookie!),
    );
    expect(prepared.response.status).toBe(200);
    expect(prepared.body.confirmationToken).toBeString();
    expect(provider.consumeBodies).toHaveLength(consumeBefore);
  }, 60_000);

  test("owner cookie works; overview/allocator never consume; another admin and nonhuman auth fail closed", async () => {
    if (!available) return;
    provider.calls = 0;
    provider.consumeBodies = [];
    provider.ambiguousFailures = 0;
    const api = app();
    const access = await api.request("/v1/access/me", {
      headers: { cookie: OWNER_COOKIE },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    const workspaceId = context.defaultWorkspaceId!;
    const accountId = context.defaultAccountId!;
    const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
    const connected = await upsertCodexSubscriptionCredential(client.db, {
      accountId,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "token",
          refresh_token: "refresh",
          id_token: "id",
        }),
      ),
      chatgptAccountId: `api-${crypto.randomUUID()}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: `user:${OWNER_USER_ID}`,
    });
    await admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${accountId}, ${workspaceId}, ${`user:${OTHER_USER_ID}`}, 'Other admin', 'admin',
        ${admin.json(["workspace:admin"])}
      ) on conflict (subject_id, workspace_id) do update
        set permissions = excluded.permissions, role = excluded.role`;

    const overview = await api.request(`/v1/workspaces/${workspaceId}/codex/overview`, {
      headers: { cookie: OWNER_COOKIE },
    });
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as any;
    expect(overviewBody.accounts[connected.id].canRedeem).toBe(true);
    expect(overviewBody.accounts[connected.id].resetCredits).toMatchObject({
      detailState: "detailed",
      detailsComplete: true,
      availableCount: 2,
    });
    expect(
      overviewBody.accounts[connected.id].resetCredits.credits.map(
        (credit: { status: string; actionable: boolean }) => ({
          status: credit.status,
          actionable: credit.actionable,
        }),
      ),
    ).toEqual([
      { status: "redeemed", actionable: false },
      { status: "available", actionable: true },
      { status: "available", actionable: true },
    ]);
    expect(provider.consumeBodies).toHaveLength(0);

    const unhealthy = await upsertCodexSubscriptionCredential(client.db, {
      accountId,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "token", refresh_token: "refresh", id_token: "id" }),
      ),
      chatgptAccountId: `unhealthy-${crypto.randomUUID()}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: `user:${OWNER_USER_ID}`,
    });
    await admin`
      update codex_subscription_credentials
      set status = 'error', last_error = 'injected unhealthy credential'
      where workspace_id = ${workspaceId} and id = ${unhealthy.id}`;
    const unhealthyOverview = await api.request(`/v1/workspaces/${workspaceId}/codex/overview`, {
      headers: { cookie: OWNER_COOKIE },
    });
    expect(unhealthyOverview.status).toBe(200);
    expect(((await unhealthyOverview.json()) as any).accounts[unhealthy.id]).toMatchObject({
      canRedeem: false,
      canResumeRedemption: true,
    });

    const allocator = await api.request(
      `/v1/workspaces/${workspaceId}/codex/accounts/${connected.id}/allocator`,
      {
        method: "PATCH",
        headers: { cookie: OWNER_COOKIE, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, expectedVersion: 1 }),
      },
    );
    expect(allocator.status).toBe(200);
    expect(provider.consumeBodies).toHaveLength(0);

    const ownerPrepared = await prepare(api, workspaceId, connected.id, "credit-reset");
    expect(ownerPrepared.response.status).toBe(200);
    expect(ownerPrepared.response.headers.get("cache-control")).toBe("no-store");
    const redeemed = await api.request(
      `/v1/workspaces/${workspaceId}/codex/accounts/${connected.id}/reset-credits/redeem`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          attemptId: ownerPrepared.attemptId,
          creditId: "credit-reset",
          confirmationToken: ownerPrepared.body.confirmationToken,
          confirmation: "REDEEM_USAGE_LIMIT_RESET",
        }),
      },
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    expect((await redeemed.json()) as any).toMatchObject({
      status: "completed",
      outcome: "reset",
    });
    expect(provider.consumeBodies).toHaveLength(1);
    expect((await listCodexAccountStatuses(client.db, workspaceId))[0]?.allocatorEnabled).toBe(
      false,
    );

    const otherOverview = await api.request(`/v1/workspaces/${workspaceId}/codex/overview`, {
      headers: { cookie: OTHER_COOKIE },
    });
    expect(otherOverview.status).toBe(200);
    expect(((await otherOverview.json()) as any).accounts[connected.id].canRedeem).toBe(false);
    const otherPrepared = await prepare(
      api,
      workspaceId,
      connected.id,
      "credit-reset",
      crypto.randomUUID(),
      browserHeaders(OTHER_COOKIE),
    );
    expect(otherPrepared.response.status).toBe(403);

    const [foreignAccount] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values (${`ope24-foreign-${RUN_ID}`}) returning id`;
    const [foreignWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${foreignAccount!.id}, ${`ope24-foreign-${RUN_ID}`}) returning id`;
    const foreignCredential = await upsertCodexSubscriptionCredential(client.db, {
      accountId: foreignAccount!.id,
      workspaceId: foreignWorkspace!.id,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({
          access_token: "foreign",
          refresh_token: "foreign",
          id_token: "foreign",
        }),
      ),
      chatgptAccountId: `foreign-${RUN_ID}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: `user:${OWNER_USER_ID}`,
    });
    const providerCallsBeforeForeign = provider.calls;
    const foreignPrepared = await prepare(
      api,
      foreignWorkspace!.id,
      foreignCredential.id,
      "credit-reset",
    );
    expect([403, 404]).toContain(foreignPrepared.response.status);
    expect(provider.calls).toBe(providerCallsBeforeForeign);

    const keyResponse = await api.request(`/v1/workspaces/${workspaceId}/api-keys`, {
      method: "POST",
      headers: { cookie: OWNER_COOKIE, "content-type": "application/json" },
      body: JSON.stringify({
        name: "OPE-24 product key",
        permissions: ["workspace:admin"],
      }),
    });
    expect(keyResponse.status).toBe(201);
    const productToken = ((await keyResponse.json()) as any).token as string;
    const productKeyAttempt = await prepare(
      api,
      workspaceId,
      connected.id,
      "credit-reset",
      crypto.randomUUID(),
      { ...browserHeaders(), authorization: `Bearer ${productToken}` },
    );
    expect(productKeyAttempt.response.status).toBe(403);

    const delegated = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId,
      workspaceId,
      subjectId: `user:${OWNER_USER_ID}`,
      permissions: ["workspace:admin"],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const delegatedAttempt = await prepare(
      api,
      workspaceId,
      connected.id,
      "credit-reset",
      crypto.randomUUID(),
      { ...browserHeaders(), authorization: `Bearer ${delegated}` },
    );
    expect(delegatedAttempt.response.status).toBe(403);
    expect(provider.consumeBodies).toHaveLength(1);
  }, 60_000);

  test("missing/wrong content type, origin, fetch metadata, cookie, CSRF and explicit confirmation make zero provider calls", async () => {
    if (!available) return;
    const api = app();
    const access = await api.request("/v1/access/me", {
      headers: { cookie: OWNER_COOKIE },
    });
    const context = (await access.json()) as AccessContext;
    const workspaceId = context.defaultWorkspaceId!;
    const account = (await listCodexAccountStatuses(client.db, workspaceId))[0]!;
    const callsBefore = provider.calls;
    const missingOrigin = browserHeaders();
    delete missingOrigin.origin;
    const missingContentType = browserHeaders();
    delete missingContentType["content-type"];
    const missingFetchMetadata = browserHeaders();
    delete missingFetchMetadata["sec-fetch-site"];
    for (const headers of [
      missingContentType,
      { ...browserHeaders(), "content-type": "text/plain" },
      missingOrigin,
      { ...browserHeaders(), origin: "http://evil.test" },
      missingFetchMetadata,
      { ...browserHeaders(), "sec-fetch-site": "cross-site" },
      { ...browserHeaders(), cookie: "" },
    ]) {
      const result = await prepare(
        api,
        workspaceId,
        account.id,
        "credit-reset",
        crypto.randomUUID(),
        headers,
      );
      expect([401, 403]).toContain(result.response.status);
    }
    expect(provider.calls).toBe(callsBefore);

    const prepared = await prepare(api, workspaceId, account.id, "credit-reset");
    expect(prepared.response.status).toBe(200);
    const afterPrepare = provider.calls;
    for (const body of [
      {
        attemptId: prepared.attemptId,
        creditId: "credit-reset",
        confirmationToken: `${prepared.body.confirmationToken}x`,
        confirmation: "REDEEM_USAGE_LIMIT_RESET",
      },
      {
        attemptId: prepared.attemptId,
        creditId: "credit-reset",
        confirmationToken: prepared.body.confirmationToken,
        confirmation: "CONFIRM",
      },
    ]) {
      const response = await api.request(
        `/v1/workspaces/${workspaceId}/codex/accounts/${account.id}/reset-credits/redeem`,
        {
          method: "POST",
          headers: browserHeaders(),
          body: JSON.stringify(body),
        },
      );
      expect([400, 403]).toContain(response.status);
    }
    expect(provider.calls).toBe(afterPrepare);

    const unavailable = await prepare(api, workspaceId, account.id, "missing-credit");
    expect(unavailable.response.status).toBe(200);
    const consumeBeforeUnavailable = provider.consumeBodies.length;
    const unavailableResponse = await api.request(
      `/v1/workspaces/${workspaceId}/codex/accounts/${account.id}/reset-credits/redeem`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          attemptId: unavailable.attemptId,
          creditId: "missing-credit",
          confirmationToken: unavailable.body.confirmationToken,
          confirmation: "REDEEM_USAGE_LIMIT_RESET",
        }),
      },
    );
    expect(unavailableResponse.status).toBe(409);
    expect((await unavailableResponse.json()) as any).toMatchObject({
      status: "not_actionable",
      retryable: false,
    });
    expect(provider.consumeBodies).toHaveLength(consumeBeforeUnavailable);
  });

  test("a lost completed HTTP response replays its durable outcome without another consume", async () => {
    if (!available) return;
    const api = app();
    const access = await api.request("/v1/access/me", {
      headers: { cookie: OWNER_COOKIE },
    });
    const context = (await access.json()) as AccessContext;
    const workspaceId = context.defaultWorkspaceId!;
    const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
    const account = await upsertCodexSubscriptionCredential(client.db, {
      accountId: context.defaultAccountId!,
      workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "token", refresh_token: "refresh", id_token: "id" }),
      ),
      chatgptAccountId: `completed-replay-${crypto.randomUUID()}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      lastRefreshAt: new Date(),
      connectedBySubjectId: `user:${OWNER_USER_ID}`,
    });
    const attemptId = crypto.randomUUID();
    const prepared = await prepare(api, workspaceId, account.id, "credit-reset", attemptId);
    expect(prepared.response.status).toBe(200);
    const consumeBefore = provider.consumeBodies.length;
    const first = await api.request(
      `/v1/workspaces/${workspaceId}/codex/accounts/${account.id}/reset-credits/redeem`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          attemptId,
          creditId: "credit-reset",
          confirmationToken: prepared.body.confirmationToken,
          confirmation: "REDEEM_USAGE_LIMIT_RESET",
        }),
      },
    );
    expect(first.status).toBe(200);
    // Treat the successful response as lost by not relying on its body. A reload
    // obtains a fresh session-bound confirmation for the same logical attempt.
    // Even a later token-health transition cannot erase durable completion.
    await admin`
      update codex_subscription_credentials
      set status = 'needs_relogin', last_error = 'injected after durable completion'
      where workspace_id = ${workspaceId} and id = ${account.id}`;
    const replayPreparation = await prepare(
      api,
      workspaceId,
      account.id,
      "credit-reset",
      attemptId,
    );
    expect(replayPreparation.body.resumable).toBe(true);
    const replay = await api.request(
      `/v1/workspaces/${workspaceId}/codex/accounts/${account.id}/reset-credits/redeem`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          attemptId,
          creditId: "credit-reset",
          confirmationToken: replayPreparation.body.confirmationToken,
          confirmation: "REDEEM_USAGE_LIMIT_RESET",
        }),
      },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()) as any).toMatchObject({
      status: "completed",
      outcome: "reset",
    });
    expect(provider.consumeBodies).toHaveLength(consumeBefore + 1);
  }, 60_000);

  test("timeout ambiguity survives reload/prepare and retries the same upstream key", async () => {
    if (!available) return;
    provider.ambiguousFailures = 0;
    const api = app();
    const access = await api.request("/v1/access/me", {
      headers: { cookie: OWNER_COOKIE },
    });
    const context = (await access.json()) as AccessContext;
    const workspaceId = context.defaultWorkspaceId!;
    const account = (await listCodexAccountStatuses(client.db, workspaceId))[0]!;
    const attemptId = crypto.randomUUID();
    const firstPreparation = await prepare(
      api,
      workspaceId,
      account.id,
      "credit-ambiguous",
      attemptId,
    );
    const redeem = (confirmationToken: string) =>
      api.request(
        `/v1/workspaces/${workspaceId}/codex/accounts/${account.id}/reset-credits/redeem`,
        {
          method: "POST",
          headers: browserHeaders(),
          body: JSON.stringify({
            attemptId,
            creditId: "credit-ambiguous",
            confirmationToken,
            confirmation: "REDEEM_USAGE_LIMIT_RESET",
          }),
        },
      );
    const first = await redeem(firstPreparation.body.confirmationToken);
    expect(first.status).toBe(503);
    expect((await first.json()) as any).toMatchObject({
      status: "ambiguous",
      retryable: true,
    });

    // A browser reload asks for a fresh five-minute confirmation but preserves
    // the same logical attempt. The durable provider_started state skips a new
    // availability preflight and reuses the one server key.
    const resumedPreparation = await prepare(
      api,
      workspaceId,
      account.id,
      "credit-ambiguous",
      attemptId,
    );
    expect(resumedPreparation.body.resumable).toBe(true);
    const second = await redeem(resumedPreparation.body.confirmationToken);
    expect(second.status).toBe(200);
    expect((await second.json()) as any).toMatchObject({
      status: "completed",
      outcome: "alreadyRedeemed",
    });
    const bodies = provider.consumeBodies.filter((body) => body.credit_id === "credit-ambiguous");
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((body) => body.redeem_request_id)).size).toBe(1);
  }, 60_000);
});
