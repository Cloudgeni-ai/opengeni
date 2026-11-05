import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createRealtimeVoiceBilling } from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createSession,
  getBillingBalance,
  listUsageEvents,
  renewSessionRealtimeInTransaction,
  upsertOrganizationPlan,
  withBillingOriginOverride,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";

import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { insufficientCreditsHttpError } from "../src/http/api-error";

const DELEGATION_SECRET = "realtime-voice-billing-secret-with-32-bytes";
const AZURE_MODEL = "opengeni-azure/gpt-live-1";
// 50,000 micros/minute + 5% margin = 52,500 credit micros per started minute.
const MINUTE = 52_500;

const pricedSettings = testSettings({
  productAccessMode: "managed",
  billingMode: "stripe",
  subscriptionPlansEnabled: true,
  byokPlatformFeeBps: 0,
  delegationSecret: DELEGATION_SECRET,
  vercelAiGatewayApiKey: "gateway-test-key",
  azureLiveEndpoint: "https://voice.example.test",
  azureLiveApiKey: "synthetic-azure-key",
  azureLivePricingJson: JSON.stringify({ microsPerMinute: 50_000, marginBps: 500 }),
  aiGatewayRealtimePricingJson: JSON.stringify({
    "openai/gpt-realtime-2.1": { microsPerMinute: 50_000, marginBps: 500 },
  }),
});

let shared: SharedTestDatabase;
let client: DbClient;
let providerCalls = 0;

setDefaultTimeout(60_000);

function appFor(settings: Settings): Hono {
  const noop = async () => undefined;
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    codexFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      providerCalls += 1;
      if (request.url === "https://voice.example.test/openai/v1/live/sessions") {
        return Response.json({
          session: { id: "live_session_fixture" },
          transport: {
            sdp: "v=0\r\na=answer:azure-fixture\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
          },
        });
      }
      if (request.url.endsWith("/v1/realtime/client-secrets")) {
        return Response.json({ token: "vcst_test_token", expiresAt: 2_000_000_000 });
      }
      throw new Error(`unexpected provider request ${request.url}`);
    },
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((error, c) => {
    const refusal = insufficientCreditsHttpError(error);
    if (refusal)
      return c.json(
        { error: { code: refusal.code, message: refusal.message, details: refusal.details } },
        refusal.status,
      );
    throw error;
  });
  registerSessionRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  return app;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-realtime-voice-billing");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(credits = 0) {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-billing-account-${suffix}`,
    accountName: "Realtime billing",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-billing-workspace-${suffix}`,
    workspaceName: "Realtime billing",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  if (credits > 0) {
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      amountMicros: credits,
      type: "grant",
      idempotencyKey: `grant:${suffix}`,
    });
  }
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control", "workspace:read"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    subjectId,
    base: `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/realtime`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

function ownerProof(model: string) {
  return {
    operationId: crypto.randomUUID(),
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model,
  };
}

async function begin(app: Hono, value: Awaited<ReturnType<typeof fixture>>, model: string) {
  const proof = ownerProof(model);
  const response = await app.request(value.base, {
    method: "POST",
    headers: value.headers,
    body: JSON.stringify(proof),
  });
  return { proof, response };
}

async function costEvents(value: Awaited<ReturnType<typeof fixture>>) {
  const rows = await listUsageEvents(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    limit: 100,
  });
  return rows.filter(
    (row) => row.eventType === "model.cost" && row.sourceResourceType === "voice_realtime",
  );
}

describe("deployment-funded realtime voice credits (real PostgreSQL)", () => {
  test("refuses unfunded hosted starts and API subscription starts", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(402);
    expect(await refused.response.json()).toMatchObject({ code: "insufficient_credits" });
    const gateway = await begin(app, value, "opengeni-gateway/openai/gpt-realtime-2.1");
    expect(gateway.response.status).toBe(402);
    // Connected subscriptions cannot fund an API-origin call, regardless of credits.
    const codex = await begin(app, value, "gpt-live-1-boulder-alpha");
    expect(codex.response.status).toBe(403);
    expect(await codex.response.json()).toMatchObject({
      error: { details: { code: "subscription_api_unavailable" } },
    });

    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    expect(catalog.status).toBe(200);
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    const hosted = models.filter((model) => model.provider === "OpenGeni");
    expect(hosted.map((model) => model.id)).toEqual([AZURE_MODEL]);
    expect(hosted[0]).toMatchObject({
      available: false,
      unavailableCode: "insufficient_credits",
    });
    for (const model of models.filter((entry) => String(entry.provider).startsWith("Connected "))) {
      expect(model).toMatchObject({
        available: false,
        unavailableCode: "subscription_api_unavailable",
      });
    }
  });

  test.each(["gpt-live-1-boulder-alpha", "supergrok/grok-voice-think-fast-2.0"])(
    "%s requires a paid app plan without charging credits",
    async (model) => {
      const app = appFor(pricedSettings);
      for (const [key, status, allowed] of [
        [null, "active", false],
        ["free", "active", false],
        ["pro", "past_due", false],
        ["pro", "active", true],
        ["max", "active", true],
      ] as const) {
        const value = await fixture(0);
        if (key)
          await upsertOrganizationPlan(client.db, {
            accountId: value.accountId,
            planKey: key,
            status,
            ...(key === "free" ? {} : { stripeSubscriptionId: `sub_${crypto.randomUUID()}` }),
            currentPeriodStart: new Date(Date.now() - 1000),
            currentPeriodEnd: new Date(Date.now() + 3_600_000),
          });
        const callsBefore = providerCalls;
        const started = await withBillingOriginOverride("app", () => begin(app, value, model));
        expect(started.response.status).toBe(allowed ? 201 : 402);
        if (!allowed)
          expect(await started.response.json()).toMatchObject({
            error: {
              details: { code: "subscription_plan_required", action: { type: "upgrade_plan" } },
            },
          });
        expect(providerCalls).toBe(callsBefore);
        expect(await costEvents(value)).toEqual([]);
        expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(0);
        const api = await begin(app, value, model);
        expect(api.response.status).toBe(403);
      }
    },
  );

  test("promotional chat-only credits are named instead of reported as no credits", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    await applyCreditLedgerEntry(client.db, {
      accountId: value.accountId,
      amountMicros: 10_000_000,
      type: "grant",
      eligibleModelIds: ["gpt-chat-only"],
      idempotencyKey: `promo:${value.accountId}`,
    });
    // A person in the app (the app's own sign-in fixes this scope in production).
    const refused = await withBillingOriginOverride("app", () => begin(app, value, AZURE_MODEL));
    expect(refused.response.status).toBe(402);
    expect(await refused.response.json()).toMatchObject({
      code: "insufficient_credits",
      message: "Promotional credits don't cover live voice. Add credits to use it.",
    });
    // The fixture's own delegated token is API use: it is told credits pay.
    const api = await begin(app, value, AZURE_MODEL);
    expect(api.response.status).toBe(402);
    expect(await api.response.json()).toMatchObject({
      code: "insufficient_credits",
      message: "API usage uses credits, not your plan credit.",
    });
    const catalog = await withBillingOriginOverride("app", () =>
      app.request(`http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`, {
        headers: value.headers,
      }),
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      available: false,
      unavailableCode: "insufficient_credits",
      unavailableReason: "Promotional credits don't cover live voice. Add credits to use it.",
    });
  });

  test.each(["gpt-live-1-boulder-alpha", "supergrok/grok-voice-think-fast-2.0"])(
    "%s rechecks API origin and plan before negotiating an already-started app call",
    async (model) => {
      const app = appFor(pricedSettings);
      for (const origin of ["api", "app"] as const) {
        const value = await fixture(0);
        const plan = {
          accountId: value.accountId,
          planKey: "pro",
          stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
          currentPeriodStart: new Date(Date.now() - 1000),
          currentPeriodEnd: new Date(Date.now() + 3_600_000),
        };
        await upsertOrganizationPlan(client.db, { ...plan, status: "active" });
        const started = await withBillingOriginOverride("app", () => begin(app, value, model));
        expect(started.response.status).toBe(201);
        const { mode } = (await started.response.json()) as {
          mode: { id: string; version: number; connectionEpoch: number };
        };
        if (origin === "app")
          await upsertOrganizationPlan(client.db, { ...plan, status: "past_due" });
        const webrtc = model === "gpt-live-1-boulder-alpha";
        const callsBefore = providerCalls;
        const refused = await withBillingOriginOverride(origin, () =>
          app.request(`${value.base}/${webrtc ? "webrtc" : "websocket"}`, {
            method: "POST",
            headers: value.headers,
            body: JSON.stringify({
              realtimeId: mode.id,
              operationId: crypto.randomUUID(),
              browserInstanceId: started.proof.browserInstanceId,
              ownerKey: started.proof.ownerKey,
              expectedVersion: mode.version,
              expectedConnectionEpoch: mode.connectionEpoch,
              rotate: false,
              ...(webrtc ? { sdp: "v=0\r\na=offer:fixture\r\n", version: "v3" } : {}),
            }),
          }),
        );
        expect(refused.status).toBe(origin === "api" ? 403 : 402);
        expect(await refused.json()).toMatchObject({
          error: {
            details: {
              code:
                origin === "api" ? "subscription_api_unavailable" : "subscription_plan_required",
            },
          },
        });
        expect(providerCalls).toBe(callsBefore);
        const rows =
          await shared.admin`select state from session_realtime_connections where realtime_id = ${mode.id}::uuid`;
        expect(rows.map((row) => row.state)).toEqual(["failed"]);
        await upsertOrganizationPlan(client.db, { ...plan, status: "active" });
        const [current] =
          await shared.admin`select version, connection_epoch from session_realtime_modes where id = ${mode.id}::uuid`;
        const retry = await withBillingOriginOverride("app", () =>
          app.request(`${value.base}/${webrtc ? "webrtc" : "websocket"}`, {
            method: "POST",
            headers: value.headers,
            body: JSON.stringify({
              realtimeId: mode.id,
              operationId: crypto.randomUUID(),
              browserInstanceId: started.proof.browserInstanceId,
              ownerKey: started.proof.ownerKey,
              expectedVersion: current!.version,
              expectedConnectionEpoch: current!.connection_epoch,
              rotate: true,
              ...(webrtc ? { sdp: "v=0\r\na=offer:fixture\r\n", version: "v3" } : {}),
            }),
          }),
        );
        // This fixture has no provider connection. Its corrected retry must
        // pass admission and claim a new operation, not remain wedged in the old one.
        expect(await retry.text()).not.toContain("REALTIME_CONNECTION_ACTIVE");
        expect(
          (
            await shared.admin`select id from session_realtime_connections where realtime_id = ${mode.id}::uuid`
          ).length,
        ).toBe(2);
      }
    },
  );

  test("an API caller cannot spend signup credits on live voice", async () => {
    // The fixture's delegated token is a product on the SDK: API use, which
    // spends credits only.
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    await applyCreditLedgerEntry(client.db, {
      accountId: value.accountId,
      amountMicros: 2 * MINUTE,
      type: "grant",
      eligibleModelIds: ["gpt-chat-only"],
      sourceType: "verified_signup_trial",
      sourceId: value.subjectId,
      idempotencyKey: `verified-signup-trial:v1:${value.accountId}`,
      metadata: { campaign: "verified_signup_trial_v1", creditOfferLabel: "Signup credits" },
    });
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(402);
    expect(await costEvents(value)).toHaveLength(0);
  });

  test("signup trial credits make live voice available and pay for its minutes", async () => {
    // A person in the app (the app's own sign-in fixes this scope in production).
    await withBillingOriginOverride("app", () => signupTrialVoice());
  });

  async function signupTrialVoice() {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    // Signup credits stay scoped to chat models for model usage, yet pay for voice.
    await applyCreditLedgerEntry(client.db, {
      accountId: value.accountId,
      amountMicros: 2 * MINUTE,
      type: "grant",
      eligibleModelIds: ["gpt-chat-only"],
      sourceType: "verified_signup_trial",
      sourceId: value.subjectId,
      idempotencyKey: `verified-signup-trial:v1:${value.accountId}`,
      metadata: { campaign: "verified_signup_trial_v1", creditOfferLabel: "Signup credits" },
    });
    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      id: AZURE_MODEL,
      available: true,
      unavailableReason: null,
      unavailableCode: null,
      recommended: true,
    });

    const started = await begin(app, value, AZURE_MODEL);
    expect(started.response.status).toBe(201);
    const mode = (
      (await started.response.json()) as {
        mode: { id: string; version: number; connectionEpoch: number };
      }
    ).mode;
    const negotiated = await app.request(`${value.base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: started.proof.browserInstanceId,
        ownerKey: started.proof.ownerKey,
        expectedVersion: mode.version,
        expectedConnectionEpoch: mode.connectionEpoch,
        rotate: false,
        sdp: "v=0\r\na=offer:fixture\r\n",
        version: "v3",
      }),
    });
    expect(negotiated.status).toBe(200);
    // The first started minute is charged to the signup grant, not general credit.
    const balance = await getBillingBalance(client.db, value.accountId);
    expect(balance.balanceMicros).toBe(MINUTE);
    expect(balance.generalBalanceMicros).toBe(0);
    expect(balance.promotionalCredits).toEqual([
      expect.objectContaining({ remainingMicros: MINUTE, coversVoice: true }),
    ]);
    expect(await costEvents(value)).toHaveLength(1);
  }

  test("an enabled provider without pricing is neither offered nor startable", async () => {
    const app = appFor({ ...pricedSettings, azureLivePricingJson: undefined });
    const value = await fixture(1_000_000);
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toMatchObject({
      error: { code: "realtime_voice_unavailable", details: { reason: "pricing_unconfigured" } },
    });
    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    // Azure is unpriced, so the priced managed Gateway model is offered instead.
    expect(
      models.filter((model) => model.provider === "OpenGeni").map((model) => model.id),
    ).toEqual(["opengeni-gateway/openai/gpt-realtime-2.1"]);
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      available: true,
    });
  });

  test("bills each started minute once per connection and stops at a zero balance", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(3 * MINUTE);
    const started = await begin(app, value, AZURE_MODEL);
    expect(started.response.status).toBe(201);
    const mode = (
      (await started.response.json()) as {
        mode: { id: string; version: number; connectionEpoch: number };
      }
    ).mode;
    const proof = started.proof;
    const negotiated = await app.request(`${value.base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: mode.version,
        expectedConnectionEpoch: mode.connectionEpoch,
        rotate: false,
        sdp: "v=0\r\na=offer:fixture\r\n",
        version: "v3",
      }),
    });
    expect(negotiated.status).toBe(200);
    // The first started minute is billed when the provider connection is issued.
    expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(2 * MINUTE);
    expect(await costEvents(value)).toHaveLength(1);

    // A heartbeat in the same minute bills nothing new and extends the lease.
    const heartbeat = await app.request(`${value.base}/${mode.id}/heartbeat`, {
      method: "PATCH",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: mode.version,
      }),
    });
    expect(heartbeat.status).toBe(200);
    const renewed = (await heartbeat.json()) as {
      mode: { version: number };
      stop?: unknown;
    };
    expect(renewed.stop).toBeUndefined();
    expect(renewed.mode.version).toBe(mode.version + 1);
    expect(await costEvents(value)).toHaveLength(1);

    // Two more minutes observed through owner heartbeats (server clock).
    let version = renewed.mode.version;
    const base = Date.now();
    for (const offset of [25_000, 50_000, 75_000, 100_000, 125_000]) {
      const result = await withWorkspaceSessionActivityRls(client.db, value.workspaceId, (db) =>
        renewSessionRealtimeInTransaction(db, {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          realtimeId: mode.id,
          ownerSubjectId: value.subjectId,
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: version,
          now: new Date(base + offset),
        }),
      );
      version = result.mode.version;
    }
    const billing = createRealtimeVoiceBilling({ db: client.db, settings: pricedSettings });
    const settleInput = {
      workspaceId: value.workspaceId,
      sessionId: value.sessionId,
      realtimeId: mode.id,
      callerSubjectId: value.subjectId,
      attribution: { kind: "human" as const, initiatingHumanSubjectId: value.subjectId },
      now: new Date(base + 125_000),
    };
    const [first, second] = await Promise.all([
      billing.settle(settleInput),
      billing.settle(settleInput),
    ]);
    // Concurrent settlement charges each (connection, minute) exactly once.
    expect(first.debitedMicros + second.debitedMicros).toBe(2 * MINUTE);
    expect(await costEvents(value)).toHaveLength(3);
    expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(0);
    expect(first.stop?.code ?? second.stop?.code).toBe("insufficient_credits");
  });

  test.each(["gateway", "websocket"])(
    "%s settles before responding; a zero-balance heartbeat stops without renewing the lease or re-minting",
    async (route) => {
      const app = appFor(pricedSettings);
      const value = await fixture(MINUTE);
      const started = await begin(app, value, "opengeni-gateway/openai/gpt-realtime-2.1");
      expect(started.response.status).toBe(201);
      const mode = (
        (await started.response.json()) as {
          mode: { id: string; version: number; connectionEpoch: number; leaseExpiresAt: string };
        }
      ).mode;
      const proof = started.proof;
      const minted = await app.request(`${value.base}/${route}`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          realtimeId: mode.id,
          operationId: crypto.randomUUID(),
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
          expectedConnectionEpoch: mode.connectionEpoch,
          rotate: false,
        }),
      });
      expect(minted.status).toBe(200);
      // No heartbeat or polling wait is needed to persist the first-minute debit.
      expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(0);

      const heartbeat = await app.request(`${value.base}/${mode.id}/heartbeat`, {
        method: "PATCH",
        headers: value.headers,
        body: JSON.stringify({
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
        }),
      });
      expect(heartbeat.status).toBe(200);
      const body = (await heartbeat.json()) as {
        mode: { version: number; leaseExpiresAt: string; state: string };
        stop?: { code: string; message: string };
      };
      expect(body.stop).toMatchObject({ code: "insufficient_credits" });
      expect(body.mode.state).toBe("active");
      expect(body.mode.version).toBe(mode.version);
      expect(body.mode.leaseExpiresAt).toBe(mode.leaseExpiresAt);

      const calls = providerCalls;
      const rotated = await app.request(`${value.base}/${route}`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          realtimeId: mode.id,
          operationId: crypto.randomUUID(),
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
          expectedConnectionEpoch: mode.connectionEpoch,
          rotate: true,
        }),
      });
      expect(rotated.status).toBe(402);
      expect(await rotated.json()).toMatchObject({ code: "insufficient_credits" });
      expect(providerCalls).toBe(calls);

      const ended = await app.request(`${value.base}/${mode.id}`, {
        method: "DELETE",
        headers: value.headers,
        body: JSON.stringify({
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
          reason: "user_stop",
        }),
      });
      expect(ended.status).toBe(200);
      // One connection, observed for under a minute: exactly one minute billed.
      expect(await costEvents(value)).toHaveLength(1);
    },
  );
});
