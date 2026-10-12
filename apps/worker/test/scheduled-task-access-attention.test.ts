import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  createValidatedScheduledTask,
  listScheduledTaskAccessAttention,
  updateScheduledTaskForApi,
  validatedScheduledTaskUpdate,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import {
  appendSessionEventsForTurnAttempt,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  getScheduledTask,
  getScheduledTaskRunAcceptedExecution,
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
 * Connector accounts resolve live, end to end through the real scheduler. A
 * schedule without pins uses the owner's current accounts at every run. A
 * person's pinned account that can no longer be used never blocks the
 * schedule and is never replaced: the run goes without that connector and the
 * owner is told, unless the schedule requires its pinned accounts.
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

function settings(mcpServers: (typeof MAIL_SERVER)[] = [MAIL_SERVER]) {
  return testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    mcpServers,
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

function scheduler(mcpServers?: (typeof MAIL_SERVER)[]) {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(mcpServers),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function attentionFor(
  workspace: Fixture,
  grant: AccessGrant,
  mcpServers?: (typeof MAIL_SERVER)[],
) {
  const errors: unknown[] = [];
  const started = performance.now();
  const items = await listScheduledTaskAccessAttention({
    db: client.db,
    settings: settings(mcpServers),
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
  const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, taskId, 1);
  if (dispatched.action !== "start") {
    throw new Error(`dispatch ${JSON.stringify(dispatched)}; run error ${run?.error ?? "none"}`);
  }
  return { dispatched, runId: run!.id };
}

describe("the owner is told when a schedule cannot use a connector", () => {
  test("a revoked pinned account: the run goes without it, the owner is told, and re-pinning clears it", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const firstAccount = await connectPersonalMail(workspace);

    // The owner creates the schedule through the ordinary owner path, pinning
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
        runMode: "new_session_per_run",
        agentConfig: {
          prompt: "Summarize my unread mail",
          tools: [{ kind: "mcp", id: "mail" }],
        },
        pinnedAccounts: [{ serverId: "mail", connectionId: firstAccount }],
      }),
    });
    expect(task.ownerSubjectId).toBe(workspace.owner);
    expect(task.agentConfig.pinnedAccounts).toEqual([
      { serverId: "mail", connectionId: firstAccount },
    ]);
    expect(task.agentConfig).not.toHaveProperty("connectionAccounts");
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

    // 2. The owner revokes the pinned account and connects another. The next
    //    occurrence still runs, without the mail connector: it never falls
    //    back to the other account, and the run records what it went without.
    await admin`update connections set status = 'revoked' where id = ${firstAccount}`;
    const otherAccount = await connectPersonalMail(workspace);
    const degraded = await startRun(workspace, task.id);
    const [degradedRun] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 1);
    expect(degradedRun?.degradedAccounts).toEqual([
      { serverId: "mail", connectionId: firstAccount, reason: "account_not_visible" },
    ]);
    const degradedExecution = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: degraded.runId,
    });
    expect(degradedExecution?.mcpAccountBindings ?? []).toEqual([]);
    expect(degradedExecution?.resolvedTools.some((tool) => tool.id === "mail")).toBe(false);
    expect(JSON.stringify(degradedExecution)).not.toContain(otherAccount);
    // The occurrence the agent receives names the connector it runs without.
    const [occurrence] = await admin<{ payload: { unavailableConnectors?: string[] } }[]>`
      select payload from session_system_updates
      where scheduled_task_run_id = ${degraded.runId} and kind = 'scheduled_occurrence'`;
    expect(occurrence?.payload.unavailableConnectors).toEqual(["mail"]);
    await runTurn(workspace, degraded.dispatched, degraded.runId, []);
    const told = await attentionFor(workspace, person(workspace, workspace.owner));
    expect(told.items).toMatchObject([
      { taskId: task.id, unavailableAccounts: [{ id: "mail", name: "Mail" }] },
    ]);
    console.info(
      `[scheduled-task-access-attention] owner attention list with one stale pin: ${told.elapsedMs.toFixed(1)} ms`,
    );
    expect((await attentionFor(workspace, person(workspace, workspace.member))).items).toEqual([]);
    expect((await attentionFor(workspace, key)).items).toEqual([]);

    // 3. The owner pins the other account: the notice clears and the next run
    //    uses exactly that account.
    const grant = person(workspace, workspace.owner);
    const repinned = await updateScheduledTaskForApi(
      client.db,
      grant,
      task.id,
      await validatedScheduledTaskUpdate({
        settings: settings(),
        db: client.db,
        objectStorage: null,
        grant,
        authorization: signedIn(workspace, workspace.owner),
        existing: (await getScheduledTask(client.db, workspace.workspaceId, task.id))!,
        payload: UpdateScheduledTaskRequest.parse({
          pinnedAccounts: [{ serverId: "mail", connectionId: otherAccount }],
        }),
      }),
    );
    expect(repinned.agentConfig.pinnedAccounts).toEqual([
      { serverId: "mail", connectionId: otherAccount },
    ]);
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
    const second = await startRun(workspace, task.id);
    const [secondRun] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 1);
    expect(secondRun?.degradedAccounts ?? []).toEqual([]);
    expect(
      (
        await getScheduledTaskRunAcceptedExecution(client.db, {
          workspaceId: workspace.workspaceId,
          runId: second.runId,
        })
      )?.mcpAccountBindings?.map((binding) => binding.connectionId),
    ).toEqual([otherAccount]);
    await runTurn(workspace, second.dispatched, second.runId, []);
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
    expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
      "active",
    );
  }, 180_000);

  test("without pins a schedule follows the owner's current account after a reconnect", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const firstAccount = await connectPersonalMail(workspace);
    const task = await createValidatedScheduledTask({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      grant: person(workspace, workspace.owner),
      authorization: signedIn(workspace, workspace.owner),
      toolsProvided: true,
      payload: CreateScheduledTaskRequest.parse({
        name: "Default inbox digest",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize", tools: [{ kind: "mcp", id: "mail" }] },
      }),
    });
    // Saving never records the accounts the save could see.
    expect(task.agentConfig).not.toHaveProperty("pinnedAccounts");
    expect(task.agentConfig).not.toHaveProperty("connectionAccounts");
    await admin`update connections set status = 'revoked' where id = ${firstAccount}`;
    const reconnected = await connectPersonalMail(workspace);
    const run = await startRun(workspace, task.id);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run.runId,
    });
    expect(accepted?.mcpAccountBindings?.map((binding) => binding.connectionId)).toEqual([
      reconnected,
    ]);
    expect(accepted?.degradedAccounts ?? []).toEqual([]);
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
  }, 180_000);

  test("a default connector the workspace adds after saving reaches the next run", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    await admin`update workspaces set settings = settings || ${admin.json({
      sessionToolDefaults: { mcpServerIds: [] },
    })} where id = ${workspace.workspaceId}`;
    const task = await createValidatedScheduledTask({
      settings: settings(),
      db: client.db,
      objectStorage: null,
      grant: person(workspace, workspace.owner),
      authorization: signedIn(workspace, workspace.owner),
      toolsProvided: false,
      payload: CreateScheduledTaskRequest.parse({
        name: "Follows the defaults",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize" },
      }),
    });
    expect(task.agentConfig.tools.map((tool) => tool.id)).not.toContain("mail");
    // Later the workspace makes mail a default and the owner connects it.
    await admin`update workspaces set settings = settings || ${admin.json({
      sessionToolDefaults: { mcpServerIds: ["mail"] },
    })} where id = ${workspace.workspaceId}`;
    const account = await connectPersonalMail(workspace);
    const run = await startRun(workspace, task.id);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run.runId,
    });
    expect(accepted?.resolvedTools.map((tool) => tool.id)).toContain("mail");
    expect(accepted?.mcpAccountBindings?.map((binding) => binding.connectionId)).toEqual([account]);
  }, 180_000);

  test("a schedule that requires its pinned accounts skips the occurrence instead", async () => {
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
        name: "Strict inbox digest",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize", tools: [{ kind: "mcp", id: "mail" }] },
        pinnedAccounts: [{ serverId: "mail", connectionId: account }],
        pinnedAccountsRequired: true,
      }),
    });
    expect(task.agentConfig.pinnedAccountsRequired).toBe(true);
    await admin`update connections set status = 'revoked' where id = ${account}`;
    expect(
      await scheduler().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `scheduled-access-attention:${crypto.randomUUID()}`,
      }),
    ).toEqual({
      action: "blocked",
      reason: "connection_account_unavailable",
      runId: expect.any(String),
      diagnostic: {
        version: 1,
        reason: "selected_account_unavailable",
        accounts: [{ serverId: "mail", connectionId: account, reason: "account_not_visible" }],
      },
    });
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toMatchObject(
      [{ taskId: task.id, unavailableAccounts: [{ id: "mail", name: "Mail" }] }],
    );
  }, 180_000);

  test("a pin whose connector is no longer set up: the run goes without it and the owner is told", async () => {
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
        name: "Inbox digest",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize", tools: [{ kind: "mcp", id: "mail" }] },
        pinnedAccounts: [{ serverId: "mail", connectionId: account }],
      }),
    });
    // The workspace stops setting up the mail connector; the account itself is fine.
    const dispatched = await scheduler([]).dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `scheduled-access-attention:${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 1);
    expect(run?.degradedAccounts).toEqual([
      { serverId: "mail", connectionId: account, reason: "connector_unavailable" },
    ]);
    expect((await attentionFor(workspace, person(workspace, workspace.owner), [])).items).toEqual([
      {
        taskId: task.id,
        taskName: "Inbox digest",
        executionDigest: task.executionDigest,
        runId: null,
        firedAt: null,
        failures: [],
        unavailableAccounts: [{ id: "mail", name: "mail" }],
        awaitingHuman: null,
      },
    ]);
    expect((await attentionFor(workspace, person(workspace, workspace.member), [])).items).toEqual(
      [],
    );
  }, 180_000);

  test("a paused schedule with a revoked pinned account is not listed", async () => {
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
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Summarize", tools: [{ kind: "mcp", id: "mail" }] },
        pinnedAccounts: [{ serverId: "mail", connectionId: account }],
      }),
    });
    expect(task.status).toBe("paused");
    await admin`update connections set status = 'revoked' where id = ${account}`;
    expect((await attentionFor(workspace, person(workspace, workspace.owner))).items).toEqual([]);
  }, 180_000);
});
