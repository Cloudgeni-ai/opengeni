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
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const DELEGATION_SECRET = "realtime-voice-billing-secret-with-32-bytes";
const AZURE_MODEL = "opengeni-azure/gpt-live-1";
// 50,000 micros/minute + 5% margin = 52,500 credit micros per started minute.
const MINUTE = 52_500;

const pricedSettings = testSettings({
  productAccessMode: "managed",
  billingMode: "stripe",
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
  test("refuses unfunded starts with the voice-input code; workspace-funded voice is not gated", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(402);
    expect(await refused.response.json()).toMatchObject({ code: "insufficient_credits" });
    const gateway = await begin(app, value, "opengeni-gateway/openai/gpt-realtime-2.1");
    expect(gateway.response.status).toBe(402);
    // A connected subscription is paid by the workspace: admission is not credit-gated.
    const codex = await begin(app, value, "gpt-live-1-boulder-alpha");
    expect(codex.response.status).toBe(201);

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
  });

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

  test("a heartbeat at zero balance tells the client to stop, keeps the lease, and refuses re-mint", async () => {
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
    const minted = await app.request(`${value.base}/gateway`, {
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
    const rotated = await app.request(`${value.base}/gateway`, {
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
  });
});
