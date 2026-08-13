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
  createApiKey,
  createDb,
  getSession,
  listSessionTurns,
  withRlsContext,
  type DbClient,
} from "@opengeni/db";
import * as dbSchema from "@opengeni/db/schema";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { and, eq } from "drizzle-orm";
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
  test("requires distinct host authority for create, Send, and Steer turn instructions", async () => {
    const suffix = crypto.randomUUID();
    const subjectId = `user:turn-instructions-${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "turn-instructions-authority-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Turn instructions authority test",
      workspaceExternalSource: "turn-instructions-authority-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Turn instructions authority test",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const primaryToken = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId,
      permissions: ["sessions:create", "sessions:read", "sessions:control"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const primaryHeaders = {
      authorization: `Bearer ${primaryToken}`,
      "content-type": "application/json",
    };
    const hostToken = randomApiKeyToken();
    await createApiKey(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      name: "Embedding host turn instructions",
      prefix: hostToken.slice(0, 14),
      keyHash: await sha256Hex(hostToken),
      permissions: ["sessions:turn_instructions"],
    });
    const trustedHeaders = {
      ...primaryHeaders,
      "x-opengeni-turn-instructions-key": hostToken,
    };
    const createBody = {
      initialMessage: "Create with exact host context",
      turnInstructions: "organization profile revision 7",
      resources: [],
      tools: [],
      metadata: {},
      sandboxBackend: "none",
      idempotencyKey: `turn-instructions-create:${suffix}`,
    };

    const deniedCreate = await app.request(`http://x/v1/workspaces/${grant.workspaceId}/sessions`, {
      method: "POST",
      headers: primaryHeaders,
      body: JSON.stringify(createBody),
    });
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.text()).toContain(
      "trusted host turn-instructions authority required",
    );

    const createdResponse = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions`,
      { method: "POST", headers: trustedHeaders, body: JSON.stringify(createBody) },
    );
    expect(createdResponse.status).toBe(202);
    const created = (await createdResponse.json()) as {
      id: string;
      initialTurnId: string | null;
    };
    expect(created.initialTurnId).not.toBeNull();
    expect(
      await getStoredTurnInstructions(
        grant.accountId,
        grant.workspaceId!,
        created.id,
        created.initialTurnId!,
      ),
    ).toBe("organization profile revision 7");

    const sendBody = {
      type: "user.message",
      clientEventId: crypto.randomUUID(),
      payload: {
        text: "Use the refreshed host context",
        turnInstructions: "organization profile revision 8",
      },
    };
    const deniedSend = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/events`,
      { method: "POST", headers: primaryHeaders, body: JSON.stringify(sendBody) },
    );
    expect(deniedSend.status).toBe(403);
    expect(await deniedSend.text()).toContain("trusted host turn-instructions authority required");

    const acceptedSend = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/events`,
      { method: "POST", headers: trustedHeaders, body: JSON.stringify(sendBody) },
    );
    expect(acceptedSend.status).toBe(202);
    const sent = (await acceptedSend.json()) as { id: string };
    expect(
      await getStoredTurnInstructionsForTriggerEvent(
        grant.accountId,
        grant.workspaceId!,
        created.id,
        sent.id,
      ),
    ).toBe("organization profile revision 8");

    const steerBody = {
      text: "Replace direction with the newest host context",
      turnInstructions: "organization profile revision 9",
      clientEventId: crypto.randomUUID(),
    };
    const deniedSteer = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/steer`,
      { method: "POST", headers: primaryHeaders, body: JSON.stringify(steerBody) },
    );
    expect(deniedSteer.status).toBe(403);
    expect(await deniedSteer.text()).toContain("trusted host turn-instructions authority required");

    const acceptedSteer = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions/${created.id}/steer`,
      { method: "POST", headers: trustedHeaders, body: JSON.stringify(steerBody) },
    );
    expect(acceptedSteer.status).toBe(202);
    const steered = (await acceptedSteer.json()) as { turn: { id: string } };
    expect(
      await getStoredTurnInstructions(
        grant.accountId,
        grant.workspaceId!,
        created.id,
        steered.turn.id,
      ),
    ).toBe("organization profile revision 9");

    const selfAuthorizingToken = randomApiKeyToken();
    await createApiKey(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      name: "Primary browser-facing key",
      prefix: selfAuthorizingToken.slice(0, 14),
      keyHash: await sha256Hex(selfAuthorizingToken),
      permissions: [
        "sessions:create",
        "sessions:read",
        "sessions:control",
        "sessions:turn_instructions",
      ],
    });
    const selfAuthorized = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/sessions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfAuthorizingToken}`,
          "content-type": "application/json",
          "x-opengeni-turn-instructions-key": selfAuthorizingToken,
        },
        body: JSON.stringify({
          ...createBody,
          idempotencyKey: `turn-instructions-self-authorize:${suffix}`,
        }),
      },
    );
    expect(selfAuthorized.status).toBe(403);
    expect(await selfAuthorized.text()).toContain(
      "trusted host turn-instructions authority required",
    );
  });

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
      principalKind: "service",
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
    const created = (await createdResponse.json()) as {
      id: string;
      initialTurnId: string | null;
    };
    const storedSession = await getSession(client.db, grant.workspaceId!, created.id);
    const [initialTurn] = await listSessionTurns(client.db, grant.workspaceId!, created.id);
    expect(created.initialTurnId).toBe(initialTurn?.id);
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
      principalKind: "service",
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

async function getStoredTurnInstructions(
  accountId: string,
  workspaceId: string,
  sessionId: string,
  turnId: string,
) {
  return await withRlsContext(client.db, { accountId, workspaceId }, async (scopedDb) => {
    const [turn] = await scopedDb
      .select({ turnInstructions: dbSchema.sessionTurns.turnInstructions })
      .from(dbSchema.sessionTurns)
      .where(
        and(
          eq(dbSchema.sessionTurns.workspaceId, workspaceId),
          eq(dbSchema.sessionTurns.sessionId, sessionId),
          eq(dbSchema.sessionTurns.id, turnId),
        ),
      )
      .limit(1);
    return turn?.turnInstructions ?? null;
  });
}

async function getStoredTurnInstructionsForTriggerEvent(
  accountId: string,
  workspaceId: string,
  sessionId: string,
  triggerEventId: string,
) {
  return await withRlsContext(client.db, { accountId, workspaceId }, async (scopedDb) => {
    const [turn] = await scopedDb
      .select({ turnInstructions: dbSchema.sessionTurns.turnInstructions })
      .from(dbSchema.sessionTurns)
      .where(
        and(
          eq(dbSchema.sessionTurns.workspaceId, workspaceId),
          eq(dbSchema.sessionTurns.sessionId, sessionId),
          eq(dbSchema.sessionTurns.triggerEventId, triggerEventId),
        ),
      )
      .limit(1);
    return turn?.turnInstructions ?? null;
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomApiKeyToken(): string {
  return `ogk_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}
