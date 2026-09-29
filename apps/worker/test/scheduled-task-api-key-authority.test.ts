import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant, type Permission } from "@opengeni/contracts";
import {
  assertScheduledTaskMutationOwner,
  createValidatedScheduledTask,
  scheduledTaskAttentionScope,
} from "@opengeni/core";
import {
  createDb,
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
 * An embedding product's backend manages schedules with an organization API
 * key. A key is a machine principal, never a person: its schedules have no
 * owner, run under service authority, and a refused occurrence is a visible
 * terminal run rather than an invisible retried activity failure.
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-task-api-key-authority");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task API-key authority verification requires PostgreSQL");
    }
    console.warn("[worker-scheduled-task-api-key-authority] PostgreSQL unavailable, skipping");
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

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled api key authority') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Embedded team') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>;

const KEY_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
];

/** The workspace grant `resolveWorkspaceAccess` derives for an organization key. */
function organizationKey(workspace: Fixture, keyId = crypto.randomUUID()): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: `api_key:${keyId}`,
    subjectLabel: "Embedding backend",
    principalKind: "api_key",
    permissions: KEY_PERMISSIONS,
  };
}

async function createWithKey(
  workspace: Fixture,
  key: AccessGrant,
  schedule: Record<string, unknown>,
) {
  return await createValidatedScheduledTask({
    settings: settings(),
    db: client.db,
    objectStorage: null,
    grant: key,
    payload: CreateScheduledTaskRequest.parse({
      name: "Embedded digest",
      schedule,
      agentConfig: { prompt: "Summarize today's activity" },
    }),
  });
}

describe("organization API key scheduled tasks", () => {
  for (const [label, schedule, triggerType] of [
    ["once", { type: "once", runAt: new Date(Date.now() + 3_600_000).toISOString() }, "scheduled"],
    ["interval", { type: "interval", everySeconds: 3600 }, "scheduled"],
    ["manual", { type: "manual" }, "manual"],
  ] as const) {
    test(`a ${label} task created by an organization key runs under service authority`, async () => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const key = organizationKey(workspace);
      const task = await createWithKey(workspace, key, schedule);
      // A key is not a person: the schedule has no owner, while the key stays
      // the audited creator.
      expect(task.ownerSubjectId).toBeNull();
      expect(task.createdBy).toMatchObject({
        kind: "service",
        subjectId: key.subjectId,
      });

      const dispatched = await scheduler().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType,
        producerKey: `api-key-schedule:${crypto.randomUUID()}`,
        ...(triggerType === "manual"
          ? {
              initiator: { kind: "subject" as const, subjectId: key.subjectId },
            }
          : {}),
      });
      expect(dispatched).toMatchObject({
        action: "start",
        workspaceId: workspace.workspaceId,
      });

      const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "dispatched", error: null });
      const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
        workspaceId: workspace.workspaceId,
        runId: runs[0]!.id,
      });
      expect(accepted?.causalHumanSubjectId).toBeNull();
      expect(accepted?.causalHumanAuthority).toBeNull();
    }, 180_000);
  }

  test("the key that created a schedule can still change it, and so can people who manage schedules", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const key = organizationKey(workspace);
    const task = await createWithKey(workspace, key, { type: "manual" });
    await assertScheduledTaskMutationOwner(client.db, key, task.id);
    await assertScheduledTaskMutationOwner(client.db, organizationKey(workspace), task.id);
    // A key sees schedules without an owner on the attention list.
    expect(scheduledTaskAttentionScope(key)).toMatchObject({
      includeOwnerless: true,
    });
  }, 180_000);

  test("a legacy schedule owned by a key is refused as a visible terminal run", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const key = organizationKey(workspace);
    // Reproduce a schedule written before keys were treated as machine
    // principals: the key subject became its immutable owner, with no human
    // revision authority behind it.
    const [row] = await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true),
        set_config('opengeni.workspace_id', ${workspace.workspaceId}, true),
        set_config('opengeni.subject_id', ${key.subjectId}, true),
        set_config('opengeni.initiating_human_subject_id', ${key.subjectId}, true)`;
      return await tx<{ id: string }[]>`insert into scheduled_tasks
        (account_id, workspace_id, name, owner_subject_id, status, schedule,
         temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
         created_by_kind, created_by_subject_id, metadata)
        values (${workspace.accountId}, ${workspace.workspaceId}, 'Legacy key schedule',
          ${key.subjectId}, 'active', ${admin.json({ type: "manual" })},
          ${`legacy-${crypto.randomUUID()}`}, 'new_session_per_run', 'skip',
          ${admin.json({ kind: "agent_turn" })},
          ${admin.json({ prompt: "Summarize", resources: [], tools: [] })},
          'subject', ${key.subjectId}, ${admin.json({})})
        returning id`;
    });
    const taskId = row!.id;
    const producerKey = `legacy-key-schedule:${crypto.randomUUID()}`;
    const input = {
      workspaceId: workspace.workspaceId,
      taskId,
      triggerType: "scheduled" as const,
      producerKey,
    };
    const expected = {
      action: "blocked",
      reason: "scheduled_authority_unavailable",
      runId: expect.any(String),
      diagnostic: {
        version: 1,
        reason: "owner_access_unavailable",
        accounts: [],
      },
    };
    expect(await scheduler().dispatchScheduledTaskRun(input)).toEqual(expected);
    // A redelivered activity replays the recorded refusal instead of throwing.
    expect(await scheduler().dispatchScheduledTaskRun(input)).toEqual(expected);
    const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, taskId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: "scheduled_authority_unavailable",
      sessionId: null,
      admissionDiagnostic: {
        version: 1,
        reason: "owner_access_unavailable",
        accounts: [],
      },
    });
    expect(runs[0]!.completedAt).not.toBeNull();
    // The key that owns the legacy schedule can still delete or pause it.
    await assertScheduledTaskMutationOwner(client.db, key, taskId);
    await expect(
      assertScheduledTaskMutationOwner(client.db, organizationKey(workspace), taskId),
    ).rejects.toMatchObject({ status: 403 });
  }, 180_000);
});
