import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant, type Permission } from "@opengeni/contracts";
import { createValidatedScheduledTask, listScheduledTaskAccessAttention } from "@opengeni/core";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  expireScheduledRunHumanWait,
  listScheduledTaskRuns,
  peekSessionWork,
  SCHEDULED_HUMAN_WAIT_TIMEOUT_CLIENT_EVENT_PREFIX,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * A scheduled run whose own turn waits on a person (a tool approval) is
 * visible on the run and on the attention list instead of looking merely
 * "dispatched", and an optional per-task approval timeout lets the scheduler
 * reject it as a labelled system decision once the deadline passes.
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-run-human-wait");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled run human-wait verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-run-human-wait] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function settings() {
  return testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
}

function scheduler() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

const KEY_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
];

async function fixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled human wait') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Team') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const key: AccessGrant = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `api_key:${crypto.randomUUID()}`,
    principalKind: "api_key",
    permissions: KEY_PERMISSIONS,
  };
  return { accountId: account!.id, workspaceId: workspace!.id, key };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Dispatch one run, claim its turn and settle it waiting on a tool approval. */
async function runWaitingOnApproval(workspace: Fixture, approvalTimeoutSeconds?: number) {
  const task = await createValidatedScheduledTask({
    settings: settings(),
    db: client.db,
    objectStorage: null,
    grant: workspace.key,
    payload: CreateScheduledTaskRequest.parse({
      name: "Deploy review",
      schedule: { type: "manual" },
      agentConfig: {
        prompt: "Review and deploy",
        ...(approvalTimeoutSeconds ? { approvalTimeoutSeconds } : {}),
      },
    }),
  });
  const dispatched = await scheduler().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId: task.id,
    triggerType: "manual",
    producerKey: `human-wait:${crypto.randomUUID()}`,
    initiator: { kind: "subject", subjectId: workspace.key.subjectId },
  });
  if (dispatched.action !== "start") throw new Error(JSON.stringify(dispatched));
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
    sessionId: dispatched.sessionId,
    workflowId: dispatched.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim ${JSON.stringify(claimed)}`);
  const approvals = [
    { id: "call-deploy", rawItem: { callId: "call-deploy", name: "deploy", arguments: "{}" } },
    { id: "call-notify", rawItem: { callId: "call-notify", name: "notify", arguments: "{}" } },
  ];
  const settled = await applySessionTurnSettlement(client.db, workspace.workspaceId, {
    sessionId: dispatched.sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claimed.turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: approvals,
      humanInputRequests: [],
    },
    events: [
      { type: "session.requiresAction", payload: { approvals } },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settled.action).toBe("settled");
  const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 1);
  return { task, run: run!, sessionId: dispatched.sessionId, turnId: claimed.turn.id };
}

describe("a scheduled run waiting on a person", () => {
  test("is visible on the run and the attention list, and waits indefinitely by default", async () => {
    if (!available) return;
    const workspace = await fixture();
    const { task, run, sessionId } = await runWaitingOnApproval(workspace);
    expect(run.status).toBe("dispatched");
    expect(run.awaitingHuman).toEqual({ since: expect.any(String), expiresAt: null });
    const attention = await listScheduledTaskAccessAttention({
      db: client.db,
      settings: settings(),
      grant: workspace.key,
    });
    expect(attention).toEqual([
      expect.objectContaining({
        taskId: task.id,
        runId: run.id,
        failures: [],
        unavailableAccounts: [],
        awaitingHuman: { since: run.awaitingHuman!.since, expiresAt: null },
      }),
    ]);
    // No timeout: the workflow waits on a signal only, with no timer.
    const peek = await peekSessionWork(client.db, workspace.workspaceId, sessionId);
    expect(peek).toEqual({ kind: "approval-wait" });
  }, 180_000);

  test("the task's approval timeout rejects every pending approval as a labelled system decision", async () => {
    if (!available) return;
    const workspace = await fixture();
    const { run, sessionId, turnId } = await runWaitingOnApproval(workspace, 600);
    const expiresAt = run.awaitingHuman!.expiresAt!;
    expect(Date.parse(expiresAt) - Date.parse(run.awaitingHuman!.since)).toBe(600_000);
    // The workflow sleeps on a durable timer until the frozen deadline.
    expect(await peekSessionWork(client.db, workspace.workspaceId, sessionId)).toEqual({
      kind: "approval-wait",
      scheduledRunTimeout: { runId: run.id, turnId },
      expiresAt,
    });
    const target = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId,
      turnId,
      runId: run.id,
    };
    // Never early.
    expect((await expireScheduledRunHumanWait(client.db, target)).action).toBe("stale");

    // Let the deadline pass.
    await admin`update session_events set occurred_at = occurred_at - interval '11 minutes'
      where session_id = ${sessionId} and type = 'session.requiresAction'`;
    const expired = await expireScheduledRunHumanWait(client.db, target);
    expect(expired.action).toBe("expired");
    expect(expired.events).toHaveLength(1);
    expect(expired.events[0]).toMatchObject({
      type: "user.approvalDecision",
      clientEventId: expect.stringMatching(
        new RegExp(`^${SCHEDULED_HUMAN_WAIT_TIMEOUT_CLIENT_EVENT_PREFIX}`),
      ),
      payload: {
        approvalId: "call-deploy",
        decision: "reject",
        message: expect.stringContaining("Rejected automatically by the scheduler"),
      },
    });
    // The workflow now resumes the turn like any decision.
    expect(await peekSessionWork(client.db, workspace.workspaceId, sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: expired.events[0]!.id,
    });
    // A replayed expiry does not add a second decision.
    expect((await expireScheduledRunHumanWait(client.db, target)).events).toHaveLength(0);
  }, 180_000);
});
