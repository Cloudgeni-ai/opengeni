import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  UNATTENDED_REQUEST_GOAL,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import { createDb, getSessionGoal, listSessionEvents, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// A top-level `unattended: true` API create with an initial message gets a
// goal standing for that message, set by the create itself (real PostgreSQL),
// so the run keeps going until the agent completes or pauses it without a
// goal_set model call. Everything else keeps today's goal behaviour.

const DELEGATION_SECRET = "session-unattended-goal-api-test-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: ReturnType<typeof createApp>;

class WorkflowStub implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-unattended-goal");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Unattended goal API tests require PostgreSQL");
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new WorkflowStub(),
    objectStorage: null,
    githubStateSecret: "session-unattended-goal-test-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used here");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspaceAuth(): Promise<{ workspaceId: string; auth: string }> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Unattended goal') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Unattended goal') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: "unattended-goal-service",
    subjectLabel: "unattended-goal-service",
    permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return { workspaceId: workspace!.id, auth: `Bearer ${token}` };
}

async function create(
  target: { workspaceId: string; auth: string },
  body: Record<string, unknown>,
): Promise<string> {
  const response = await app.request(`/v1/workspaces/${target.workspaceId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: target.auth },
    body: JSON.stringify({
      initialMessage: "Fix the failing parser test and commit the change.",
      model: "scripted-model",
      ...body,
    }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(202);
  return (JSON.parse(text) as { id: string }).id;
}

async function goalOf(workspaceId: string, sessionId: string) {
  return await getSessionGoal(client.db, workspaceId, sessionId);
}

describe("automatic goal for an unattended single request (real PostgreSQL)", () => {
  test("an unattended create gets the standing-request goal, frozen into its first turn", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const id = await create(target, { unattended: true });
    const goal = await goalOf(target.workspaceId, id);
    expect(goal?.status).toBe("active");
    expect(goal?.text).toBe(UNATTENDED_REQUEST_GOAL.text);
    expect(goal?.successCriteria).toBe(UNATTENDED_REQUEST_GOAL.successCriteria!);
    expect(goal?.createdBy).toBe("api");
    const events = await listSessionEvents(client.db, target.workspaceId, id);
    expect(events.filter((event) => event.type === "goal.set")).toHaveLength(1);
    const [turn] = await shared!.admin<{ goal_snapshot: { state?: string; text?: string } }[]>`
      select goal_snapshot from session_turns where session_id = ${id} order by created_at limit 1`;
    expect(turn?.goal_snapshot?.state).toBe("active");
    expect(turn?.goal_snapshot?.text).toBe(UNATTENDED_REQUEST_GOAL.text);
  }, 60_000);

  test("a keyed retry of the create resolves the same session and one goal", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const body = { unattended: true, idempotencyKey: `unattended-goal-${crypto.randomUUID()}` };
    const first = await create(target, body);
    const retry = await create(target, body);
    expect(retry).toBe(first);
    // A retry that flips whether anyone answers is a different request.
    const flipped = await app.request(`/v1/workspaces/${target.workspaceId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: target.auth },
      body: JSON.stringify({
        initialMessage: "Fix the failing parser test and commit the change.",
        model: "scripted-model",
        idempotencyKey: body.idempotencyKey,
      }),
    });
    expect(flipped.status).toBe(409);
    const events = await listSessionEvents(client.db, target.workspaceId, first);
    expect(events.filter((event) => event.type === "goal.set")).toHaveLength(1);
    expect((await goalOf(target.workspaceId, first))?.text).toBe(UNATTENDED_REQUEST_GOAL.text);
  }, 60_000);

  test("an explicit goal wins, and goal: null opts out", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const explicit = await create(target, {
      unattended: true,
      goal: { text: "Ship the parser fix.", successCriteria: "Tests pass." },
    });
    expect((await goalOf(target.workspaceId, explicit))?.text).toBe("Ship the parser fix.");
    const optedOut = await create(target, { unattended: true, goal: null });
    expect(await goalOf(target.workspaceId, optedOut)).toBeNull();
  }, 60_000);

  test("interactive sessions get no goal", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const interactive = await create(target, {});
    expect(await goalOf(target.workspaceId, interactive)).toBeNull();
    const attendedExplicitly = await create(target, { unattended: false });
    expect(await goalOf(target.workspaceId, attendedExplicitly)).toBeNull();
  }, 60_000);

  test("a session that cannot carry a goal is created without one instead of failing", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const noGoalTools = await create(target, {
      unattended: true,
      firstPartyMcpTools: ["wait_for_input"],
    });
    expect(await goalOf(target.workspaceId, noGoalTools)).toBeNull();
    const noGoalPermission = await create(target, {
      unattended: true,
      firstPartyMcpPermissions: ["sessions:read"],
    });
    expect(await goalOf(target.workspaceId, noGoalPermission)).toBeNull();
    const goalsOff = await create(target, {
      unattended: true,
      agent: { capabilities: { from: "all", goals: false } },
    });
    expect(await goalOf(target.workspaceId, goalsOff)).toBeNull();
  }, 60_000);
});
