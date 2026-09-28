import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant, type Permission } from "@opengeni/contracts";
import {
  createValidatedScheduledTask,
  listScheduledTaskAccessAttention,
  refreshScheduledTaskAccess,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import {
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  getScheduledTask,
  listScheduledTaskRuns,
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
 * The owner of a schedule learns that it needs attention, end to end through
 * the real scheduler: a run of their own schedule that could not use a
 * connector, and a personal connector account they revoked, which makes the
 * scheduler refuse every fresh occurrence before it creates a run.
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-task-access-attention");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task access attention verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-task-access-attention] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const MAIL_SERVER = {
  id: "mail",
  name: "Mail",
  url: "https://mail.example.test/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

function settings() {
  return testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    mcpServers: [MAIL_SERVER],
  });
}

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled access attention') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Team') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const owner = `user:owner-${crypto.randomUUID()}`;
  const member = `user:member-${crypto.randomUUID()}`;
  for (const subject of [owner, member]) {
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`Personal ${subject}`}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${personal!.id}, ${account!.id})`;
    await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${account!.id}, ${subject}, 'active', ${personal!.id})`;
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${workspace!.id}, ${subject})`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id, owner, member };
}

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;

/** The owner connects their own mail account, exactly as the OAuth callback stores it. */
async function connectPersonalMail(workspace: Fixture): Promise<string> {
  return await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true),
      set_config('opengeni.workspace_id', ${workspace.workspaceId}, true),
      set_config('opengeni.subject_id', ${workspace.owner}, true)`;
    const [row] = await tx<{ id: string }[]>`insert into connections
      (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
      values (${workspace.accountId}, ${workspace.workspaceId}, ${workspace.owner},
        'mail.example.test', 'oauth2', 'fixture-ciphertext') returning id`;
    return row!.id;
  });
}

const PERSON_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
  "connections:read",
];

function person(workspace: Fixture, subjectId: string): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: PERSON_PERMISSIONS,
    metadata: {},
  };
}

function signedIn(workspace: Fixture, subjectId: string): AccessGrantAuthorization {
  return {
    grant: person(workspace, subjectId),
    accountGrant: null,
    authenticatedSubjectId: subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
  };
}

function scheduler() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function attentionFor(workspace: Fixture, grant: AccessGrant) {
  const errors: unknown[] = [];
  const started = performance.now();
  const items = await listScheduledTaskAccessAttention({
    db: client.db,
    settings: settings(),
    grant,
    onError: (error) => errors.push(error),
  });
  const elapsedMs = performance.now() - started;
  expect(errors).toEqual([]);
  return { items, elapsedMs };
}

/** Claim the run's own turn, optionally record access failures, and finish it. */
async function runTurn(
  workspace: Fixture,
  dispatched: { sessionId: string; workflowId: string },
  runId: string,
  authNeeded: Record<string, unknown>[],
) {
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
  const [turn] = await admin<{ scheduled_task_run_id: string | null }[]>`
    select scheduled_task_run_id from session_turns where id = ${claimed.turn.id}`;
  expect(turn?.scheduled_task_run_id).toBe(runId);
  if (authNeeded.length > 0) {
    const appended = await appendSessionEventsForTurnAttempt(
      client.db,
      workspace.workspaceId,
      dispatched.sessionId,
      claimed.turn.id,
      claimed.turn.executionGeneration,
      attemptId,
      authNeeded.map((payload) => ({ type: "tool.auth_needed", payload })),
    );
    expect(appended.accepted).toBe(true);
  }
  const settled = await applySessionTurnSettlement(client.db, workspace.workspaceId, {
    sessionId: dispatched.sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
}

async function startRun(workspace: Fixture, taskId: string) {
  const dispatched = await scheduler().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `scheduled-access-attention:${crypto.randomUUID()}`,
  });
  if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
  const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, taskId, 1);
  return { dispatched, runId: run!.id };
}

describe("the owner is told when a schedule cannot use a connector", () => {
  test("a revoked personal account notifies its owner, and a refresh clears it", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const firstAccount = await connectPersonalMail(workspace);

    // The owner creates the schedule through the ordinary owner path, choosing
    // their own mail account.
    const task = await createValidatedScheduledTask({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      grant: person(workspace, workspace.owner),
      authorization: signedIn(workspace, workspace.owner),
      toolsProvided: true,
      payload: CreateScheduledTaskRequest.parse({
        name: "Morning inbox digest",
        schedule: { type: "manual" },
        agentConfig: {
          prompt: "Summarize my unread mail",
          tools: [{ kind: "mcp", id: "mail" }],
        },
        connectionAccounts: [{ serverId: "mail", connectionId: firstAccount }],
      }),
    });
    expect(task.ownerSubjectId).toBe(workspace.owner);
    expect(task.agentConfig).toMatchObject({
      connectionAccounts: [{ serverId: "mail", connectionId: firstAccount }],
      connectionAccountsFrozen: true,
    });
    const key: AccessGrant = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: `api-key:${crypto.randomUUID()}`,
      principalKind: "api_key",
      permissions: ["workspace:read", "scheduled_tasks:manage", "scheduled_tasks:run"],
      metadata: {},
    };
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);

    // 1. A run of the owner's own schedule could not use its connector.
    const first = await startRun(workspace, task.id);
    await runTurn(workspace, first.dispatched, first.runId, [
      {
        serverId: "mail",
        providerDomain: "mail.example.test",
        reason: "expired",
        toolName: "mail_search",
      },
    ]);
    const failed = await attentionFor(workspace, person(workspace, workspace.owner));
    expect(failed.items).toMatchObject([
      {
        taskId: task.id,
        taskName: "Morning inbox digest",
        executionDigest: task.executionDigest,
        runId: first.runId,
        failures: [{ serverId: "mail", name: "Mail", reason: "expired", count: 1 }],
        unavailableAccounts: [],
      },
    ]);
    // Only the owner is told: not another member, and not a key that manages
    // schedules (it is told only about schedules without an owner).
    expect((await attentionFor(workspace, person(workspace, workspace.member))).items).toEqual([]);
    expect((await attentionFor(workspace, key)).items).toEqual([]);

    // 2. The owner revokes the account. The scheduler now refuses the next
    //    occurrence before it creates a run, and the owner is told why.
    await admin`update connections set status = 'revoked' where id = ${firstAccount}`;
    expect(
      await scheduler().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `scheduled-access-attention:${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "blocked", reason: "connection_account_unavailable" });
    expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).toHaveLength(
      1,
    );
    const blocked = await attentionFor(workspace, person(workspace, workspace.owner));
    expect(blocked.items).toEqual([
      {
        taskId: task.id,
        taskName: "Morning inbox digest",
        executionDigest: task.executionDigest,
        runId: first.runId,
        firedAt: expect.any(String),
        failures: [expect.objectContaining({ serverId: "mail", reason: "expired" })],
        unavailableAccounts: [{ id: "mail", name: "Mail" }],
      },
    ]);
    console.info(
      `[scheduled-task-access-attention] owner attention list with one blocked schedule: ${blocked.elapsedMs.toFixed(1)} ms`,
    );
    expect((await attentionFor(workspace, person(workspace, workspace.member))).items).toEqual([]);
    expect((await attentionFor(workspace, key)).items).toEqual([]);

    // 3. The owner reconnects and refreshes: the account notice clears and the
    //    scheduler starts runs again. The earlier failed run stays listed until
    //    a later run can use the connector.
    const secondAccount = await connectPersonalMail(workspace);
    const refreshed = await refreshScheduledTaskAccess({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      authorization: signedIn(workspace, workspace.owner),
      taskId: task.id,
      request: { executionDigest: task.executionDigest },
      permissionsRequiredByTools: () => [],
    });
    expect(refreshed.agentConfig.connectionAccounts).toEqual([
      { serverId: "mail", connectionId: secondAccount },
    ]);
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toMatchObject(
      [
        {
          taskId: task.id,
          executionDigest: refreshed.executionDigest,
          runId: first.runId,
          unavailableAccounts: [],
        },
      ],
    );
    const second = await startRun(workspace, task.id);
    await runTurn(workspace, second.dispatched, second.runId, []);
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
    expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
      "active",
    );
  }, 180_000);

  test("a paused schedule with a revoked account is not listed", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const account = await connectPersonalMail(workspace);
    const task = await createValidatedScheduledTask({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      grant: person(workspace, workspace.owner),
      authorization: signedIn(workspace, workspace.owner),
      toolsProvided: true,
      payload: CreateScheduledTaskRequest.parse({
        name: "Paused inbox digest",
        status: "paused",
        schedule: { type: "manual" },
        agentConfig: { prompt: "Summarize", tools: [{ kind: "mcp", id: "mail" }] },
        connectionAccounts: [{ serverId: "mail", connectionId: account }],
      }),
    });
    expect(task.status).toBe("paused");
    await admin`update connections set status = 'revoked' where id = ${account}`;
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
  }, 180_000);
});
