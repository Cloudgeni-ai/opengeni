import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  activateSessionRealtimeConnectionInTransaction,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  claimSessionWorkForAttempt,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createSession,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  getActiveSessionHistoryItems,
  setActiveCodexCredential,
  submitHumanPromptInTransaction,
  upsertCodexSubscriptionCredential,
  withWorkspaceSubjectRls,
  withWorkspaceRls,
  type Database,
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

const DELEGATION_SECRET = "session-realtime-routes-secret-with-32-bytes";
const encryptionKey = Buffer.alloc(32, 11);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  codexSubscriptionEnabled: true,
  vercelAiGatewayApiKey: "gateway-test-key",
});

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let bus: MemoryEventBus;
const wakes: Array<{ sessionId: string; wakeRevision: number }> = [];
let providerCalls = 0;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-session-realtime");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  bus = new MemoryEventBus();
  const noop = async () => undefined;
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: async (input: { sessionId: string; wakeRevision: number }) => {
      wakes.push({ sessionId: input.sessionId, wakeRevision: input.wakeRevision });
    },
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  app = new Hono();
  registerSessionRoutes(app, {
    settings,
    db: client.db,
    bus,
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    codexFetch: async (input, init) => {
      providerCalls += 1;
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/realtime/client-secrets")) {
        const body = (await request.json()) as { model?: string; expiresIn?: number };
        expect(request.headers.get("authorization")).toBe("Bearer gateway-test-key");
        expect(body).toEqual({ model: "openai/gpt-realtime-2.1", expiresIn: 120 });
        return Response.json({ token: "vcst_test_token", expiresAt: 2_000_000_000 });
      }
      const body = (await request.json()) as { sdp?: string };
      if (body.sdp?.includes("a=force-failure")) {
        throw new Error("forced provider transport failure");
      }
      return new Response(
        "v=0\r\na=answer:provider-fixture\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        {
          headers: { location: "/v1/live/rtc_api_test" },
        },
      );
    },
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `api-realtime-account-${suffix}`,
    accountName: "Realtime API",
    workspaceExternalSource: "test",
    workspaceExternalId: `api-realtime-workspace-${suffix}`,
    workspaceName: "Realtime API",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const credential = await upsertCodexSubscriptionCredential(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        id_token: "test-id-token",
      }),
    ),
    chatgptAccountId: `api-realtime-provider-${suffix}`,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    lastRefreshAt: new Date(),
    connectedBySubjectId: subjectId,
  });
  await ensureCodexRotationSettings(client.db, grant.accountId, grant.workspaceId!);
  await setActiveCodexCredential(client.db, grant.workspaceId!, credential.id);
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    subjectId,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
}

describe("session realtime lifecycle HTTP routes (real PostgreSQL)", () => {
  test("starts, heartbeats, and ends one mode with live publication and an exact normal-mode wake", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };

    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    expect(startedResponse.status).toBe(201);
    expect(startedResponse.headers.get("cache-control")).toBe("private, no-store");
    const started = (await startedResponse.json()) as {
      mode: { id: string; version: number; state: string };
      replay: boolean;
    };
    expect(started).toMatchObject({ replay: false, mode: { state: "active", version: 1 } });
    expect(bus.published.flat().map((event) => event.type)).toContain("session.realtime.started");
    expect(wakes).toHaveLength(0);

    const heartbeatResponse = await app.request(`${base}/${started.mode.id}/heartbeat`, {
      method: "PATCH",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: 1,
      }),
    });
    expect(heartbeatResponse.status).toBe(200);
    const heartbeat = (await heartbeatResponse.json()) as {
      mode: { version: number; state: string };
    };
    expect(heartbeat.mode).toMatchObject({ state: "active", version: 2 });

    const endedResponse = await app.request(`${base}/${started.mode.id}`, {
      method: "DELETE",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: 2,
        reason: "user_stop",
      }),
    });
    expect(endedResponse.status).toBe(200);
    const ended = (await endedResponse.json()) as {
      mode: { version: number; state: string; endReason: string };
      replay: boolean;
    };
    expect(ended).toMatchObject({
      replay: false,
      mode: { state: "ended", version: 3, endReason: "user_stop" },
    });
    expect(bus.published.flat().map((event) => event.type)).toEqual(
      expect.arrayContaining(["session.realtime.started", "session.realtime.ended"]),
    );
    expect(wakes).toEqual([
      expect.objectContaining({ sessionId: value.sessionId, wakeRevision: expect.any(Number) }),
    ]);

    const replayResponse = await app.request(`${base}/${started.mode.id}`, {
      method: "DELETE",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: 2,
        reason: "user_stop",
      }),
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({ replay: true });
    expect(wakes).toHaveLength(1);
  });

  test("rejects malformed bodies and stale lifecycle versions without mutating the mode", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const malformed = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({ ownerKey: "short" }),
    });
    expect(malformed.status).toBe(400);

    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string } };
    const stale = await app.request(`${base}/${started.mode.id}/heartbeat`, {
      method: "PATCH",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: 99,
      }),
    });
    expect(stale.status).toBe(409);
  });

  test("rejects absent, wrong, and stale WebRTC owner proof before the provider broker", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string; version: number } };
    const webrtc = `${base}/webrtc`;
    const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const callsBefore = providerCalls;

    const absent = await app.request(webrtc, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({ sdp: offer, version: "v3" }),
    });
    expect(absent.status).toBe(422);

    const wrongOwner = await app.request(webrtc, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: started.mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: proof.browserInstanceId,
        ownerKey: `wrong-owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        expectedVersion: started.mode.version,
        expectedConnectionEpoch: 1,
        rotate: false,
        sdp: offer,
        version: "v3",
      }),
    });
    expect(wrongOwner.status).toBe(409);

    const staleVersion = await app.request(webrtc, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: started.mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: started.mode.version + 1,
        expectedConnectionEpoch: 1,
        rotate: false,
        sdp: offer,
        version: "v3",
      }),
    });
    expect(staleVersion.status).toBe(409);
    expect(providerCalls).toBe(callsBefore);
  });

  test("durably fails an unsuccessful negotiation and requires a fresh rotation operation", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string; version: number } };
    const request = {
      realtimeId: started.mode.id,
      operationId: crypto.randomUUID(),
      browserInstanceId: proof.browserInstanceId,
      ownerKey: proof.ownerKey,
      expectedVersion: started.mode.version,
      expectedConnectionEpoch: 1,
      rotate: false,
      sdp: "v=0\r\na=force-failure\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      version: "v3",
    };
    const first = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(502);
    const replay = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("rotate with a new operation");
  });

  test("durably completes a provider answer and replays it without a second provider call", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string; version: number } };
    const request = {
      realtimeId: started.mode.id,
      operationId: crypto.randomUUID(),
      browserInstanceId: proof.browserInstanceId,
      ownerKey: proof.ownerKey,
      expectedVersion: started.mode.version,
      expectedConnectionEpoch: 1,
      rotate: false,
      browserActivation: "required",
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      version: "v3",
    };
    const callsBefore = providerCalls;
    const first = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const answer = (await first.json()) as {
      sdp: string;
      connectionId: string;
      connectionEpoch: number;
      modeVersion: number;
      replay: boolean;
    };
    expect(answer).toMatchObject({
      sdp: "v=0\r\na=answer:provider-fixture\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      connectionEpoch: 1,
      modeVersion: started.mode.version,
      replay: false,
    });
    expect(providerCalls).toBe(callsBefore + 1);

    const replay = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      sdp: answer.sdp,
      connectionId: answer.connectionId,
      replay: true,
    });
    expect(providerCalls).toBe(callsBefore + 1);

    const activated = await app.request(
      `${base}/${started.mode.id}/connections/${answer.connectionId}/activate`,
      {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          operationId: request.operationId,
          expectedVersion: started.mode.version,
          expectedConnectionEpoch: 1,
          connectionEpoch: answer.connectionEpoch,
        }),
      },
    );
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      mode: { version: started.mode.version, connectionEpoch: 1 },
      replay: false,
    });
  });

  test("mints one single-use Gateway token behind the same owner and activation fences", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    await withWorkspaceSubjectRls(client.db, value.workspaceId, value.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: value.accountId,
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          subjectId: value.subjectId,
          actor: { type: "human", subjectId: value.subjectId },
          operationKey: `gateway-history-${crypto.randomUUID()}`,
          delivery: "send",
          text: "Gateway capability history fixture",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, value.workspaceId, {
      sessionId: value.sessionId,
      workflowId: `session-${value.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("Gateway history fixture was not claimed");
    const signedQueryKey = ["X", "Amz", "Signature"].join("-");
    const authHeader = ["Author", "ization"].join("");
    const accessKey = ["access", "Token"].join("");
    const authScheme = ["Bear", "er"].join("");
    const redactedMarker = ["[", "redacted", "]"].join("");
    const signatureValue = `gateway-signature-${crypto.randomUUID()}`;
    const authValue = `gateway-upload-${crypto.randomUUID()}`;
    const adjacentValue = ["s", "k"].join("-") + `-${crypto.randomUUID()}`;
    const historyText = [
      "Completed upload for the requested image.",
      `https://objects.example/uploads/image.png?${signedQueryKey}=${signatureValue}`,
      `${authHeader}: ${authScheme} ${authValue}`,
      `${accessKey}=${adjacentValue}`,
    ].join(" ");
    const existingHistory = await getActiveSessionHistoryItems(
      client.db,
      value.workspaceId,
      value.sessionId,
    );
    const nextPosition = Math.max(-1, ...existingHistory.map((row) => row.position)) + 1;
    expect(
      await appendSessionHistoryItems(client.db, {
        accountId: value.accountId,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        turnId: claimed.turn.id,
        expectedExecutionGeneration: claimed.turn.executionGeneration,
        expectedAttemptId: attemptId,
        items: [
          {
            position: nextPosition,
            item: {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: historyText }],
            },
          },
        ],
      }),
    ).toBe(true);
    const privateHistory = await getActiveSessionHistoryItems(
      client.db,
      value.workspaceId,
      value.sessionId,
    );
    const privateSerialized = JSON.stringify(privateHistory);
    expect(privateSerialized).toContain(signatureValue);
    expect(privateSerialized).toContain(authValue);
    expect(privateSerialized).toContain(adjacentValue);
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "opengeni-gateway/openai/gpt-realtime-2.1",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    expect(startedResponse.status).toBe(201);
    const started = (await startedResponse.json()) as {
      mode: { id: string; version: number; connectionEpoch: number };
    };
    const request = {
      realtimeId: started.mode.id,
      operationId: crypto.randomUUID(),
      browserInstanceId: proof.browserInstanceId,
      ownerKey: proof.ownerKey,
      expectedVersion: started.mode.version,
      expectedConnectionEpoch: started.mode.connectionEpoch,
      rotate: false,
    };
    const callsBefore = providerCalls;
    const response = await app.request(`${base}/gateway`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(signatureValue);
    expect(responseText).not.toContain(authValue);
    expect(responseText).not.toContain(adjacentValue);
    const connected = JSON.parse(responseText) as {
      token: string;
      url: string;
      upstreamModelId: string;
      connectionId: string;
      connectionEpoch: number;
      initialItems: unknown[];
      instructions: string;
      replay: boolean;
    };
    expect(connected).toMatchObject({
      token: "vcst_test_token",
      upstreamModelId: "openai/gpt-realtime-2.1",
      connectionEpoch: 1,
      replay: false,
    });
    expect(connected.url).toBe(
      "wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1",
    );
    expect(connected.initialItems).toBeArray();
    const assistantInitialItem = connected.initialItems.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { role?: unknown }).role === "assistant",
    ) as { role: string; text: string } | undefined;
    expect(assistantInitialItem).toEqual({
      role: "assistant",
      text: expect.stringContaining("Completed upload for the requested image."),
    });
    expect(assistantInitialItem?.text).toContain(`${signedQueryKey}=${redactedMarker}`);
    expect(assistantInitialItem?.text).toContain(`${authHeader}: ${authScheme} ${redactedMarker}`);
    expect(assistantInitialItem?.text).not.toContain(accessKey);
    expect(assistantInitialItem?.text).not.toContain(signatureValue);
    expect(assistantInitialItem?.text).not.toContain(authValue);
    expect(assistantInitialItem?.text).not.toContain(adjacentValue);
    expect(connected.instructions).toContain("realtime conversational interface");
    expect(providerCalls).toBe(callsBefore + 1);

    const replay = await app.request(`${base}/gateway`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(409);
    expect(providerCalls).toBe(callsBefore + 1);

    const activated = await app.request(
      `${base}/${started.mode.id}/connections/${connected.connectionId}/activate`,
      {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          operationId: request.operationId,
          expectedVersion: started.mode.version,
          expectedConnectionEpoch: 1,
          connectionEpoch: connected.connectionEpoch,
        }),
      },
    );
    expect(activated.status).toBe(200);
  });

  test("keeps omission-compatible clients on immediate idempotent activation during rollout", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string; version: number } };
    const firstRequest = {
      realtimeId: started.mode.id,
      operationId: crypto.randomUUID(),
      browserInstanceId: proof.browserInstanceId,
      ownerKey: proof.ownerKey,
      expectedVersion: started.mode.version,
      expectedConnectionEpoch: 1,
      rotate: false,
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      version: "v3",
    };
    const callsBefore = providerCalls;
    const initialResponse = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(firstRequest),
    });
    expect(initialResponse.status).toBe(200);
    const initial = (await initialResponse.json()) as {
      connectionEpoch: number;
      modeVersion: number;
    };
    expect(initial).toMatchObject({ connectionEpoch: 1, modeVersion: started.mode.version });

    const rotationRequest = {
      ...firstRequest,
      operationId: crypto.randomUUID(),
      expectedVersion: initial.modeVersion,
      expectedConnectionEpoch: initial.connectionEpoch,
      rotate: true,
    };
    const rotatedResponse = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(rotationRequest),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as {
      connectionId: string;
      connectionEpoch: number;
      modeVersion: number;
      replay: boolean;
    };
    expect(rotated).toMatchObject({
      connectionEpoch: 2,
      modeVersion: initial.modeVersion + 1,
      replay: false,
    });
    expect(providerCalls).toBe(callsBefore + 2);

    const replay = await app.request(`${base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(rotationRequest),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      connectionId: rotated.connectionId,
      connectionEpoch: rotated.connectionEpoch,
      modeVersion: rotated.modeVersion,
      replay: true,
    });
    expect(providerCalls).toBe(callsBefore + 2);
  });

  test("syncs finalized V3 ledger entries through the active epoch", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "gpt-live-1-boulder-alpha",
    };
    const startedResponse = await app.request(base, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(proof),
    });
    const started = (await startedResponse.json()) as { mode: { id: string; version: number } };
    const connectionOperationId = crypto.randomUUID();
    const claimed = await withWorkspaceRls(client.db, value.workspaceId, (scopedDb) =>
      scopedDb.transaction((tx) =>
        claimSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          realtimeId: started.mode.id,
          operationId: connectionOperationId,
          ownerSubjectId: value.subjectId,
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: started.mode.version,
          expectedConnectionEpoch: 1,
          rotate: false,
        }),
      ),
    );
    await withWorkspaceRls(client.db, value.workspaceId, (scopedDb) =>
      scopedDb.transaction((tx) =>
        completeSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          realtimeId: started.mode.id,
          connectionId: claimed.connection.id,
          operationId: connectionOperationId,
          connectionEpoch: 1,
          sdpAnswer: "v=0\r\na=answer:api-test\r\n",
        }),
      ),
    );
    await withWorkspaceRls(client.db, value.workspaceId, (scopedDb) =>
      scopedDb.transaction((tx) =>
        activateSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          realtimeId: started.mode.id,
          connectionId: claimed.connection.id,
          operationId: connectionOperationId,
          ownerSubjectId: value.subjectId,
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: started.mode.version,
          expectedConnectionEpoch: 1,
          connectionEpoch: 1,
        }),
      ),
    );
    const response = await app.request(`${base}/${started.mode.id}/sync`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: started.mode.version,
        connectionId: claimed.connection.id,
        connectionEpoch: 1,
        entries: [
          {
            operationId: crypto.randomUUID(),
            kind: "user_transcript",
            text: "finalized API voice input",
            payload: { turnId: "api-user-turn-1" },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: [{ replay: false, entry: { kind: "user_transcript" } }],
    });
  });
});
