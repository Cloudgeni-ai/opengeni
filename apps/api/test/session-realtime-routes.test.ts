import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createDb, createSession, bootstrapWorkspace, type DbClient } from "@opengeni/db";
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
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
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
    codexFetch: async () => {
      providerCalls += 1;
      throw new Error("provider must not be called without valid realtime owner proof");
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
    permissions: ["sessions:read", "sessions:control"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
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
        browserInstanceId: proof.browserInstanceId,
        ownerKey: `wrong-owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        expectedVersion: started.mode.version,
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
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: started.mode.version + 1,
        sdp: offer,
        version: "v3",
      }),
    });
    expect(staleVersion.status).toBe(409);
    expect(providerCalls).toBe(callsBefore);
  });
});
