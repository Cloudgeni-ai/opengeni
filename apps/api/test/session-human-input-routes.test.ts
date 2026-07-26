import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectRls,
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

const DELEGATION_SECRET = "session-human-input-route-secret";
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let approvalSignals = 0;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-session-human-input");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const noop = async () => undefined;
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: async () => {
      approvalSignals += 1;
    },
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  app = new Hono();
  registerSessionRoutes(app, {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function frozenFixture() {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `human-input-api-account-${suffix}`,
    accountName: "Human input API",
    workspaceExternalSource: "test",
    workspaceExternalId: `human-input-api-workspace-${suffix}`,
    workspaceName: "Human input API",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "Ask first",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectRls(client.db, grant.workspaceId!, subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Proceed with my choice",
        resources: [],
        tools: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`fixture claim failed: ${claimed.reason}`);
  const requestId = crypto.randomUUID();
  const questions = [
    {
      id: "environment",
      kind: "single_select" as const,
      prompt: "Which environment?",
      options: [{ id: "staging", label: "Staging" }],
      required: true,
      allowOther: false,
    },
  ];
  await applySessionTurnSettlement(client.db, grant.workspaceId!, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claimed.turn.id,
    runState: {
      serializedRunState: "frozen-state",
      pendingApprovals: [],
      humanInputRequests: [
        {
          id: requestId,
          toolCallId: "human-call-api",
          questions,
          allowSkip: false,
        },
      ],
    },
    events: [
      {
        type: "session.humanInput.requested",
        payload: { request: { id: requestId, questions, allowSkip: false, expiresAt: null } },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
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
    requestId,
    authorization: `Bearer ${token}`,
  };
}

describe("structured human-input HTTP surface (real PostgreSQL)", () => {
  test("reads pending requests, rejects invalid responses, and signals one accepted settlement", async () => {
    const fixture = await frozenFixture();
    const base = `/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
    const headers = { authorization: fixture.authorization };

    const list = await app.request(`http://x${base}/human-input-requests?status=pending`, {
      headers,
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      requests: [{ id: fixture.requestId, status: "pending", toolCallId: "human-call-api" }],
    });
    const get = await app.request(`http://x${base}/human-input-requests/${fixture.requestId}`, {
      headers,
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ id: fixture.requestId, status: "pending" });

    const invalid = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: fixture.requestId,
          response: { outcome: "answered", answers: [] },
        },
      }),
    });
    expect(invalid.status).toBe(422);

    const beforeSignals = approvalSignals;
    const accepted = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: fixture.requestId,
          response: {
            outcome: "answered",
            answers: [{ questionId: "environment", values: ["staging"] }],
          },
        },
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      type: "user.humanInputResponse",
      payload: {
        requestId: fixture.requestId,
        response: { outcome: "answered" },
      },
    });
    expect(approvalSignals).toBe(beforeSignals + 1);

    const duplicate = await app.request(`http://x${base}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.humanInputResponse",
        clientEventId: crypto.randomUUID(),
        payload: {
          requestId: fixture.requestId,
          response: {
            outcome: "answered",
            answers: [{ questionId: "environment", values: ["staging"] }],
          },
        },
      }),
    });
    expect(duplicate.status).toBe(409);
  });
});
