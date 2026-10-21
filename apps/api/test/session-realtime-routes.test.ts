import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { freezeSessionRealtimeConnectionAccounts } from "@opengeni/core";
import {
  activateSessionRealtimeConnectionInTransaction,
  bootstrapWorkspace,
  claimSessionRealtimeConnectionInTransaction,
  completeSessionRealtimeConnectionInTransaction,
  createDb,
  createConnection,
  createSession,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  updateOrganizationModelDefaults,
  updateWorkspaceSettings,
  upsertOrganizationModelProviderConnection,
  withWorkspaceRls,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { connectSubscriptionCoreCodexConnection } from "@opengeni/db";
import { signDelegatedAccessToken, UpdateWorkspaceSettingsRequest } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import * as schema from "@opengeni/db/schema";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const DELEGATION_SECRET = "session-realtime-routes-secret-with-32-bytes";
const encryptionKey = Buffer.alloc(32, 11);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  codexSubscriptionEnabled: true,
  vercelAiGatewayApiKey: "gateway-test-key",
  azureLiveEndpoint: "https://voice.example.test",
  azureLiveApiKey: "synthetic-azure-key",
});

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let bus: MemoryEventBus;
const wakes: Array<{ sessionId: string; wakeRevision: number }> = [];
let providerCalls = 0;
const elevenLabsMints: Array<{ headers: Headers; body: Record<string, unknown> }> = [];

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
  const deps = {
    settings,
    db: client.db,
    bus,
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    codexFetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/wham/statsig/bootstrap")) {
        return Response.json({
          statsigPayload: JSON.stringify({
            dynamic_configs: {
              "3566525122": {
                value: { architecture: "avas", model: "gpt-live-1-codex", version: "v3" },
              },
            },
          }),
        });
      }
      providerCalls += 1;
      if (request.url === "https://api.elevenlabs.io/v1/convai/realtime/client_secrets") {
        const body = (await request.json()) as {
          session?: { audio?: { output?: { voice?: string } } };
        };
        elevenLabsMints.push({ headers: request.headers, body });
        if (body.session?.audio?.output?.voice === "unknown-voice-id") {
          return Response.json(
            {
              detail: {
                type: "validation_error",
                code: "invalid_voice_id",
                message: "Unknown voice",
              },
            },
            { status: 400 },
          );
        }
        return Response.json({ value: "ek_test_secret", expires_at: 2_000_000_000 });
      }
      if (request.url === "https://voice.example.test/openai/v1/live/sessions") {
        expect(request.headers.get("api-key")).toBe("synthetic-azure-key");
        return Response.json({
          transport: {
            sdp: "v=0\r\na=answer:provider-fixture\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
          },
        });
      }
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
  } as unknown as ApiRouteDeps;
  registerSessionRoutes(app, deps);
  // Voice settings are workspace settings, listed by the realtime model catalog.
  registerWorkspaceRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(withConnector = false) {
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
  // Current lifecycle tests use core operation leases and retain the core gate.
  const [personal] = await shared.admin`insert into workspaces(account_id, name)
    values (${grant.accountId}, 'Fixture owner Personal') returning id`;
  await shared.admin`insert into organization_memberships
    (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${subjectId}, 'owner', 'active', ${personal!.id})
    on conflict (account_id, subject_id) do nothing`;
  const credential = await connectSubscriptionCoreCodexConnection(client.db, {
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
    providerAccountId: `api-realtime-provider-${suffix}`,
    providerSubjectId: subjectId,
    accountEmail: null,
    label: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    lastRefreshAt: new Date(),
    subjectId,
  });
  if (credential.kind !== "connected") throw new Error(`fixture refused: ${credential.reason}`);
  const connector = withConnector
    ? await createConnection(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        providerDomain: "mcp.example.test",
        kind: "oauth2",
        credentialEncrypted: encryptEnvironmentValue(
          encryptionKey,
          JSON.stringify({ access_token: "fixture-only" }),
        ),
      })
    : null;
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
    ...(connector
      ? {
          tools: [{ kind: "mcp" as const, id: "test-connector" }],
          mcpServers: [
            {
              id: "test-connector",
              url: "https://mcp.example.test/",
              name: null,
              allowedTools: null,
              timeoutMs: null,
              cacheToolsList: false,
              requireApproval: null,
              headersEncrypted: {},
              connectionRef: {
                connectionId: connector.id,
                providerDomain: connector.providerDomain,
                kind: "oauth2" as const,
                subjectScope: "workspace" as const,
              },
            },
          ],
        }
      : {}),
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
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    subjectId,
    connector,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
}

describe("session realtime lifecycle HTTP routes (real PostgreSQL)", () => {
  test("verified human voice admission freezes personal accounts; delegated bearers cannot borrow them", async () => {
    const userId = `voice-personal-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Voice owner",
    });
    const grant = access.workspaceGrants[0]!;
    const connection = await createConnection(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId,
      providerDomain: "mcp.personal.test",
      kind: "oauth2",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ access_token: "fixture-only" }),
      ),
      createdBySubjectId: subjectId,
    });
    const session = await withSessionRlsActorContext({ subjectId }, () =>
      createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "Personal connector",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
        tools: [{ kind: "mcp", id: "personal-connector" }],
        mcpServers: [
          {
            id: "personal-connector",
            url: "https://mcp.personal.test/",
            name: null,
            allowedTools: null,
            timeoutMs: null,
            cacheToolsList: false,
            requireApproval: null,
            headersEncrypted: {},
            connectionRef: {
              connectionId: connection.id,
              providerDomain: connection.providerDomain,
              kind: "oauth2",
              subjectScope: "subject",
            },
          },
        ],
      }),
    );
    const input = {
      db: client.db,
      settings,
      grant,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
    };
    const accounts = await withSessionRlsActorContext({ subjectId }, () =>
      freezeSessionRealtimeConnectionAccounts(input),
    );
    expect(accounts.mcpAccountBindings).toMatchObject([
      { connectionId: connection.id, ownerSubjectId: subjectId, subjectScope: "subject" },
    ]);
    expect(accounts.personalConnectionDelegations).toMatchObject([
      {
        connectionId: connection.id,
        ownerSubjectId: subjectId,
        serverId: accounts.mcpAccountBindings![0]!.serverId,
      },
    ]);
    const delegated = await withSessionRlsActorContext({ subjectId }, () =>
      freezeSessionRealtimeConnectionAccounts({
        ...input,
        grant: { ...grant, metadata: { ...grant.metadata, delegated: true } },
      }),
    );
    expect(delegated.mcpAccountBindings).toEqual([]);
    expect(delegated.personalConnectionDelegations).toEqual([]);
  });

  test("voice start freezes native accounts from the verified request before delegation", async () => {
    const value = await fixture(true);
    const response = await app.request(
      `http://api.example.test/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`,
      {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          browserInstanceId: "browser-accounts",
          ownerKey: `owner-${crypto.randomUUID()}`,
          model: "gpt-live-1-boulder-alpha",
        }),
      },
    );
    expect(response.status).toBe(201);
    const result = (await response.json()) as { mode: { id: string } };
    const [mode] = await withWorkspaceRls(client.db, value.workspaceId, (db) =>
      db
        .select()
        .from(schema.sessionRealtimeModes)
        .where(
          and(
            eq(schema.sessionRealtimeModes.id, result.mode.id),
            eq(schema.sessionRealtimeModes.workspaceId, value.workspaceId),
          ),
        ),
    );
    expect(mode!.mcpAccountBindings).toMatchObject([
      { connectionId: value.connector!.id, subjectScope: "workspace", ownerSubjectId: null },
    ]);
    expect(mode!.personalConnectionDelegations).toEqual([]);
  });

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

  test.each(["gpt-live-1-boulder-alpha", "opengeni-azure/gpt-live-1"])(
    "durably completes %s and replays without a second provider call",
    async (model) => {
      const value = await fixture();
      const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
      const proof = {
        operationId: crypto.randomUUID(),
        browserInstanceId: `browser-${crypto.randomUUID()}`,
        ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        model,
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
    },
  );

  test("mints one single-use Gateway token behind the same owner and activation fences", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
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
    const connected = (await response.json()) as {
      token: string;
      url: string;
      upstreamModelId: string;
      connectionId: string;
      connectionEpoch: number;
      initialItems: unknown[];
      instructions: string;
      protocol: string;
      protocols: string[];
      sessionUpdate: Record<string, unknown> | null;
      replay: boolean;
    };
    expect(connected).toMatchObject({
      token: "vcst_test_token",
      upstreamModelId: "openai/gpt-realtime-2.1",
      connectionEpoch: 1,
      protocol: "ai-gateway",
      protocols: ["ai-gateway-realtime.v1", "ai-gateway-auth.vcst_test_token"],
      replay: false,
    });
    expect(connected.url).toBe(
      "wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1",
    );
    expect(connected.initialItems).toBeArray();
    expect(connected.instructions).toContain("realtime conversational interface");
    // The server now builds the session update; it must stay byte-identical to
    // the event clients sent before, so the provider sees the same prefix.
    expect(JSON.stringify(connected.sessionUpdate)).toBe(
      JSON.stringify({
        type: "session-update",
        config: {
          instructions: connected.instructions,
          outputModalities: ["audio"],
          inputAudioFormat: { type: "audio/pcm", rate: 24_000 },
          outputAudioFormat: { type: "audio/pcm", rate: 24_000 },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          turnDetection: { type: "server-vad", prefixPaddingMs: 300, silenceDurationMs: 500 },
          tools: [
            {
              type: "function",
              name: "delegate_to_session",
              description:
                "Pass execution work, actions, and session tasks to the underlying session agent. Include the complete standalone request and relevant conversational context.",
              parameters: {
                type: "object",
                properties: {
                  request: {
                    type: "string",
                    description: "Complete standalone task for the session agent",
                  },
                },
                required: ["request"],
                additionalProperties: false,
              },
            },
          ],
        },
      }),
    );
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

  test("mints an Eleven Realtime client secret with the workspace ElevenLabs key", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: "workspace-elevenlabs/eleven_realtime_v1_max",
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

    // Without a workspace key the broker refuses before calling ElevenLabs.
    const mintsBefore = elevenLabsMints.length;
    const missing = await app.request(`${base}/websocket`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify(request),
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(elevenLabsMints.length).toBe(mintsBefore);

    const [workspace] =
      await shared.admin`select account_id from workspaces where id = ${value.workspaceId}`;
    await createConnection(client.db, {
      accountId: workspace!.account_id as string,
      workspaceId: value.workspaceId,
      subjectId: null,
      providerDomain: "api.elevenlabs.io",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "elevenlabs-test-key" }),
      ),
      metadata: { credentialRole: "elevenlabs", credentialLabel: "ElevenLabs" },
      createdBySubjectId: value.subjectId,
    });

    const connectOperationId = crypto.randomUUID();
    const response = await app.request(`${base}/websocket`, {
      method: "POST",
      headers: value.headers,
      // The refused attempt durably failed epoch 1, so the client rotates.
      body: JSON.stringify({
        ...request,
        operationId: connectOperationId,
        expectedConnectionEpoch: 1,
        rotate: true,
      }),
    });
    expect(response.status).toBe(200);
    const connected = (await response.json()) as {
      provider: string;
      token: string;
      url: string;
      upstreamModelId: string;
      instructions: string;
      protocol: string;
      protocols: string[];
      sessionUpdate: Record<string, unknown> | null;
      transcriptAudioTags?: boolean;
    };
    expect(connected).toMatchObject({
      token: "ek_test_secret",
      upstreamModelId: "eleven_realtime_v1_max",
      protocol: "openai",
      protocols: ["realtime", "openai-insecure-api-key.ek_test_secret"],
      sessionUpdate: null,
      transcriptAudioTags: true,
    });
    expect(connected.url).toBe(
      "wss://api.elevenlabs.io/v1/convai/realtime?model=eleven_realtime_v1_max",
    );

    // The mint carries the whole session: ElevenLabs applies it at session.created.
    expect(elevenLabsMints.length).toBe(mintsBefore + 1);
    const mint = elevenLabsMints.at(-1)!;
    expect(mint.headers.get("xi-api-key")).toBe("elevenlabs-test-key");
    expect(mint.body).toMatchObject({
      session: {
        type: "realtime",
        model: "eleven_realtime_v1_max",
        instructions: connected.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: {},
            turn_detection: { type: "semantic_vad", eagerness: "high" },
          },
          output: { format: { type: "audio/pcm" } },
        },
        tools: [{ type: "function", name: "delegate_to_session" }],
        max_duration_seconds: 3600,
      },
    });

    // ElevenLabs does not detect the spoken language: the person's language
    // becomes the conversation language, mapped to ElevenLabs' code.
    let live = connected as unknown as {
      connectionId: string;
      connectionEpoch: number;
      modeVersion: number;
    };
    let operationId = connectOperationId;
    let expectedConnectionEpoch = 1;
    type MintedAudio = {
      input: { transcription: unknown; turn_detection: unknown };
      output: Record<string, unknown>;
    };
    const attemptRotation = async (extra: Record<string, unknown>): Promise<Response> => {
      const activated = await app.request(
        `${base}/${started.mode.id}/connections/${live.connectionId}/activate`,
        {
          method: "POST",
          headers: value.headers,
          body: JSON.stringify({
            browserInstanceId: proof.browserInstanceId,
            ownerKey: proof.ownerKey,
            operationId,
            expectedVersion: live.modeVersion,
            expectedConnectionEpoch,
            connectionEpoch: live.connectionEpoch,
          }),
        },
      );
      expect(activated.status).toBe(200);
      const activeMode = ((await activated.json()) as { mode: { version: number } }).mode;
      operationId = crypto.randomUUID();
      expectedConnectionEpoch = live.connectionEpoch;
      return await app.request(`${base}/websocket`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          ...request,
          operationId,
          expectedVersion: activeMode.version,
          expectedConnectionEpoch,
          rotate: true,
          ...extra,
        }),
      });
    };
    const rotate = async (extra: Record<string, unknown>): Promise<MintedAudio> => {
      const rotated = await attemptRotation(extra);
      expect(rotated.status).toBe(200);
      live = (await rotated.json()) as typeof live;
      return (elevenLabsMints.at(-1)!.body as { session: { audio: MintedAudio } }).session.audio;
    };
    for (const [language, transcription] of [
      ["nb-NO", { language: "no" }],
      ["pt-BR", { language: "pt-br" }],
      // A language ElevenLabs does not support keeps its default.
      ["eo", {}],
    ] as const) {
      const audio = await rotate({ language });
      expect(audio.input.transcription).toEqual(transcription);
      // Nothing chosen: ElevenLabs' default voice and Opengeni's quick turn-taking.
      expect(audio.output).toEqual({ format: { type: "audio/pcm" } });
      expect(audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high" });
    }

    const elevenMax = "workspace-elevenlabs/eleven_realtime_v1_max";
    const elevenMini = "workspace-elevenlabs/eleven_realtime_v1_mini";
    // The settings route merges through this, after its own settings authorization.
    const patchVoice = async (realtimeVoice: Record<string, unknown>) =>
      (await updateWorkspaceSettings(client.db, value.workspaceId, { realtimeVoice })).settings
        .realtimeVoice;
    // The workspace's saved settings apply to every voice session in it, over
    // the person's own language.
    expect(
      await patchVoice({
        [elevenMax]: { voice: "nb-voice-id", language: "no", turnEagerness: "medium" },
        [elevenMini]: { voice: "mini-voice-id" },
      }),
    ).toEqual({
      [elevenMax]: { voice: "nb-voice-id", language: "no", turnEagerness: "medium" },
      [elevenMini]: { voice: "mini-voice-id" },
    });
    let audio = await rotate({ language: "en-US" });
    expect(audio.input.transcription).toEqual({ language: "no" });
    expect(audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "medium" });
    expect(audio.output).toEqual({ format: { type: "audio/pcm" }, voice: "nb-voice-id" });

    // A connection's own settings (an embedding app, or the person's pick)
    // override the workspace's field by field.
    audio = await rotate({
      language: "en-US",
      voiceSettings: { language: "sv-SE", turnEagerness: "low" },
    });
    expect(audio.input.transcription).toEqual({ language: "sv" });
    expect(audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "low" });
    expect(audio.output.voice).toBe("nb-voice-id");

    // The catalog lists what each provider offers and the workspace's values.
    const catalogResponse = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      models: Array<Record<string, unknown> & { id: string }>;
    };
    const catalogModel = (id: string) => catalog.models.find((model) => model.id === id);
    expect(catalogModel(elevenMax)?.voices).toContainEqual({ id: "lily", label: "Lily" });
    expect(catalogModel(elevenMax)).toMatchObject({
      customVoice: true,
      turnEagerness: ["low", "medium", "high"],
      voiceDefaults: { voice: "brian", turnEagerness: "high" },
      workspaceVoiceSettings: { voice: "nb-voice-id", language: "no", turnEagerness: "medium" },
    });
    expect(catalogModel(elevenMax)?.languages).toContain("no");
    const gatewayModel = catalogModel("workspace-gateway/openai/gpt-realtime-2.1");
    expect(gatewayModel?.voices).toContainEqual({ id: "marin", label: "Marin" });
    expect(gatewayModel?.languages).toBeUndefined();
    expect(gatewayModel?.turnEagerness).toBeUndefined();
    expect(catalogModel("supergrok/grok-voice-think-fast-2.0")).toMatchObject({
      voiceDefaults: { voice: "eve" },
    });
    expect(catalogModel("gpt-live-1-boulder-alpha")?.voices).toBeUndefined();

    // Null removes one model's settings and keeps the others'.
    expect(await patchVoice({ [elevenMax]: null })).toEqual({
      [elevenMini]: { voice: "mini-voice-id" },
    });
    audio = await rotate({ language: "nb-NO" });
    expect(audio.input.transcription).toEqual({ language: "no" });
    expect(audio.output).toEqual({ format: { type: "audio/pcm" } });
    expect(audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high" });

    // A voice the ElevenLabs account cannot use gets a clear, non-retryable answer.
    const rejectedVoice = await attemptRotation({ voiceSettings: { voice: "unknown-voice-id" } });
    expect(rejectedVoice.status).toBe(409);
    expect(await rejectedVoice.json()).toMatchObject({
      error: {
        code: "ELEVENLABS_REALTIME_VOICE_UNAVAILABLE",
        message: expect.stringContaining("Add it to My Voices in ElevenLabs"),
        retryable: false,
      },
    });

    // Settings outside the contract, such as an unsupported speed, are rejected.
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ realtimeVoice: { [elevenMax]: { speed: 1.2 } } })
        .success,
    ).toBe(false);
  });

  test("an organization ElevenLabs key and voice defaults reach workspaces without their own", async () => {
    const value = await fixture();
    const base = `http://x/v1/workspaces/${value.workspaceId}/sessions/${value.sessionId}/realtime`;
    const elevenMax = "workspace-elevenlabs/eleven_realtime_v1_max";
    const [workspace] =
      await shared.admin`select account_id from workspaces where id = ${value.workspaceId}`;
    const organizationId = workspace!.account_id as string;
    const catalogModel = async () => {
      const response = await app.request(
        `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
        { headers: value.headers },
      );
      expect(response.status).toBe(200);
      const catalog = (await response.json()) as {
        models: Array<Record<string, unknown> & { id: string }>;
      };
      return catalog.models.find((model) => model.id === elevenMax)!;
    };
    expect(await catalogModel()).toMatchObject({
      available: false,
      unavailableReason: "Connect an ElevenLabs key",
    });

    // The organization connects one key and sets a default voice for the model.
    await upsertOrganizationModelProviderConnection(client.db, {
      organizationId,
      actorSubjectId: value.subjectId,
      providerKind: "elevenlabs",
      credentialEncrypted: encryptEnvironmentValue(encryptionKey, "organization-elevenlabs-key"),
      credentialDigest: "organization-elevenlabs-digest",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    await updateOrganizationModelDefaults(client.db, {
      organizationId,
      actorSubjectId: value.subjectId,
      patch: { realtimeVoice: { [elevenMax]: { voice: "org-voice-id", turnEagerness: "low" } } },
    });
    expect(await catalogModel()).toMatchObject({
      available: true,
      organizationVoiceSettings: { voice: "org-voice-id", turnEagerness: "low" },
    });
    expect((await catalogModel()).workspaceVoiceSettings).toBeUndefined();

    const proof = {
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model: elevenMax,
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
    let expectedConnectionEpoch = started.mode.connectionEpoch;
    let rotate = false;
    const connect = async () => {
      const response = await app.request(`${base}/websocket`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          realtimeId: started.mode.id,
          operationId: crypto.randomUUID(),
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: started.mode.version,
          expectedConnectionEpoch,
          rotate,
          language: "en-US",
        }),
      });
      expect(response.status).toBe(200);
      const connected = (await response.json()) as { connectionEpoch: number };
      expectedConnectionEpoch = connected.connectionEpoch;
      rotate = true;
      const mint = elevenLabsMints.at(-1)!;
      const audio = (
        mint.body as {
          session: { audio: { input: { turn_detection: unknown }; output: { voice?: string } } };
        }
      ).session.audio;
      return { key: mint.headers.get("xi-api-key"), audio };
    };

    // No workspace key or settings: the organization's key and voice.
    let minted = await connect();
    expect(minted.key).toBe("organization-elevenlabs-key");
    expect(minted.audio.output.voice).toBe("org-voice-id");
    expect(minted.audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "low" });

    // The workspace's own key and settings win over the organization's.
    await createConnection(client.db, {
      accountId: organizationId,
      workspaceId: value.workspaceId,
      subjectId: null,
      providerDomain: "api.elevenlabs.io",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "workspace-elevenlabs-key" }),
      ),
      metadata: { credentialRole: "elevenlabs", credentialLabel: "ElevenLabs" },
      createdBySubjectId: value.subjectId,
    });
    await updateWorkspaceSettings(client.db, value.workspaceId, {
      realtimeVoice: { [elevenMax]: { voice: "workspace-voice-id" } },
    });
    minted = await connect();
    expect(minted.key).toBe("workspace-elevenlabs-key");
    expect(minted.audio.output.voice).toBe("workspace-voice-id");
    // Settings replace the organization's per model, not field by field.
    expect(minted.audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high" });
    expect(await catalogModel()).toMatchObject({
      workspaceVoiceSettings: { voice: "workspace-voice-id" },
      organizationVoiceSettings: { voice: "org-voice-id", turnEagerness: "low" },
    });
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
