import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acceptSessionUserMessage,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import type { AccessGrant } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  getSession,
  listSessionTurns,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerSessionRoutes } from "../src/routes/sessions";

const DELEGATION_SECRET = crypto.randomUUID();
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  sandboxBackend: "none",
});

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let deps: ApiRouteDeps;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-delegated-service-initiator");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
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
  app = new Hono();
  deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
  registerSessionRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("delegated service initiator API", () => {
  test("uses signed service provenance for create and Send without changing grant authority", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "delegated-service-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Delegated service test",
      workspaceExternalSource: "delegated-service-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Delegated service test",
      subjectId: `user:workspace-owner-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const authorizationSubject = `host:automation-gateway-${suffix}`;
    const serviceInitiator = {
      kind: "service" as const,
      subjectId: "external-scheduler",
      label: "External scheduler",
    };
    const serviceInitiatorContext = {
      occurrenceId: `occurrence-${suffix}`,
      trigger: "cron",
    };
    const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: authorizationSubject,
      permissions: ["sessions:create", "sessions:read", "sessions:control"],
      serviceInitiator,
      serviceInitiatorContext,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const createdResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          initialMessage: "Run the scheduled check",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
          idempotencyKey: `external-occurrence:${suffix}`,
        }),
      },
    );
    expect(createdResponse.status).toBe(202);
    const created = (await createdResponse.json()) as { id: string };
    const storedSession = await getSession(client.db, grant.workspaceId!, created.id);
    const [initialTurn] = await listSessionTurns(client.db, grant.workspaceId!, created.id);
    expect(storedSession?.createdBy).toEqual(serviceInitiator);
    expect(initialTurn?.initiator).toEqual(serviceInitiator);
    expect(initialTurn?.initiatorContext).toEqual({
      ...serviceInitiatorContext,
      label: serviceInitiator.label,
    });
    expect(initialTurn?.initiator.subjectId).not.toBe(authorizationSubject);

    const followUpResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "user.message",
          clientEventId: crypto.randomUUID(),
          payload: {
            text: "Run the follow-up check",
            resources: [],
            tools: [],
          },
        }),
      },
    );
    expect(followUpResponse.status).toBe(202);
    const turns = await listSessionTurns(client.db, grant.workspaceId!, created.id);
    const followUp = turns.at(-1);
    expect(followUp?.source).toBe("api");
    expect(followUp?.initiator).toEqual(serviceInitiator);
    expect(followUp?.initiatorContext).toEqual({
      ...serviceInitiatorContext,
      label: serviceInitiator.label,
    });

    const pauseResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/control`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "pause",
          reason: "exercise service Steer auto-resume",
          clientEventId: crypto.randomUUID(),
        }),
      },
    );
    expect(pauseResponse.status).toBe(200);
    const steerClientEventId = crypto.randomUUID();
    const steerBody = JSON.stringify({
      text: "Replace queued work with the urgent service instruction",
      resources: [],
      tools: [],
      clientEventId: steerClientEventId,
    });
    const steerResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/steer`,
      { method: "POST", headers, body: steerBody },
    );
    expect(steerResponse.status).toBe(202);
    const steered = (await steerResponse.json()) as {
      turn: {
        id: string;
        source: string;
        initiator: unknown;
        initiatorContext: unknown;
      };
    };
    expect(steered.turn.source).toBe("api");
    expect(steered.turn.initiator).toEqual(serviceInitiator);
    expect(steered.turn.initiatorContext).toEqual({
      ...serviceInitiatorContext,
      label: serviceInitiator.label,
    });
    expect(
      (await getSession(client.db, grant.workspaceId!, created.id))?.effectiveControl.state,
    ).toBe("active");

    const steerReplayResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/steer`,
      { method: "POST", headers, body: steerBody },
    );
    expect(steerReplayResponse.status).toBe(202);
    const steerReplay = (await steerReplayResponse.json()) as { turn: { id: string } };
    expect(steerReplay.turn.id).toBe(steered.turn.id);

    const readOnlyToken = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: authorizationSubject,
      permissions: ["sessions:read"],
      serviceInitiator,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const denied = await app.request(`http://x/v1/workspaces/${grant.workspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readOnlyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initialMessage: "This service claim must not grant create access",
        resources: [],
        tools: [],
        metadata: {},
        sandboxBackend: "none",
      }),
    });
    expect(denied.status).toBe(403);

    const conflictingV2Grant: AccessGrant = {
      ...grant,
      serviceInitiator,
      metadata: {
        sessionId: created.id,
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
      },
    };
    await expect(
      acceptSessionUserMessage(deps, conflictingV2Grant, grant.workspaceId!, created.id, {
        text: "A service cannot replace exact agent authority",
        toolsProvided: false,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "a service initiator cannot replace an exact agent-attempt initiator",
    });
  });
});
