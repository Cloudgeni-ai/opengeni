import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant, type Permission } from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";
import {
  createDb,
  createSession,
  getScheduledTask,
  listOutstandingSessionSystemUpdates,
  listScheduledTaskRuns,
  listSessionEvents,
  listSessions,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { reviewScheduledTaskBlockerInventory } from "../../api/src/scheduled-task-blockers";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * A scheduled occurrence aimed at a chat or workspace that is paused settles
 * as skipped under every overlap policy, so the owner is told instead of runs
 * piling up behind the Pause where they could neither run nor settle.
 */

let shared: SharedTestDatabase;
let client: DbClient;
const bus = new MemoryEventBus();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-scheduled-paused-target");
  if (!acquired) throw new Error("Scheduled paused-target verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function settings() {
  return testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
}

const scheduler = () =>
  createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus,
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );

const KEY_PERMISSIONS: Permission[] = [
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "sessions:read",
  "sessions:create",
  "sessions:control",
];

async function fixture() {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled paused target') returning id`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Team') returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const key: AccessGrant = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `api_key:${crypto.randomUUID()}`,
    principalKind: "api_key",
    permissions: KEY_PERMISSIONS,
  };
  const target = await createSession(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "Daily brief",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: key.subjectId },
  });
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    key,
    targetId: target.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function schedule(
  workspace: Fixture,
  input: {
    runMode: "existing_session" | "new_session_per_run";
    overlapPolicy: string;
  },
) {
  return createValidatedScheduledTask({
    settings: settings(),
    db: client.db,
    objectStorage: null,
    grant: workspace.key,
    payload: CreateScheduledTaskRequest.parse({
      name: "Daily brief",
      schedule: { type: "calendar", hour: 7, minute: 0, timeZone: "UTC" },
      runMode: input.runMode,
      overlapPolicy: input.overlapPolicy,
      ...(input.runMode === "existing_session" ? { targetSessionId: workspace.targetId } : {}),
      agentConfig: { prompt: "Write the brief" },
    }),
  });
}

async function fire(workspace: Fixture, taskId: string) {
  return scheduler().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `paused-target:${crypto.randomUUID()}`,
  });
}

async function runs(workspace: Fixture, taskId: string) {
  return (await listScheduledTaskRuns(client.db, workspace.workspaceId, taskId)).map((run) => ({
    status: run.status,
    error: run.error,
  }));
}

describe("a scheduled occurrence aimed at a paused target", () => {
  test("a paused chat settles every buffered occurrence, pauses the schedule and tells the owner once", async () => {
    const workspace = await fixture();
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspace.workspaceId,
      workspace.key.subjectId,
      (db) =>
        mutateSessionControlInTransaction(db, {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          sessionId: workspace.targetId,
          action: "pause",
          actor: { type: "human", subjectId: workspace.key.subjectId },
          operationKey: crypto.randomUUID(),
        }),
    );
    const task = await schedule(workspace, {
      runMode: "existing_session",
      overlapPolicy: "buffer_one",
    });
    for (let occurrence = 0; occurrence < 3; occurrence += 1) {
      expect(await fire(workspace, task.id)).toEqual({
        action: "blocked",
        reason: "scheduled_run_terminal",
      });
    }
    expect(await runs(workspace, task.id)).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "skipped",
        error: "scheduled_session_paused",
      })),
    );
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        workspace.workspaceId,
        workspace.targetId,
      ),
    ).toEqual([]);

    await reviewScheduledTaskBlockerInventory({ db: client.db, bus });
    await reviewScheduledTaskBlockerInventory({ db: client.db, bus });
    expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
      "paused",
    );
    const notices = (
      await listSessionEvents(client.db, workspace.workspaceId, workspace.targetId)
    ).filter((event) => event.type === "session.notification.posted");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      title: "Schedule paused itself",
    });
    expect(String((notices[0]!.payload as { body?: unknown }).body)).toContain("Resume the chat");
  }, 180_000);

  test("a paused workspace skips a new-chat run without leaving a chat behind it", async () => {
    const workspace = await fixture();
    await withWorkspaceRls(client.db, workspace.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as typeof db, {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          actor: { type: "human", subjectId: workspace.key.subjectId },
          action: "pause",
          reason: "maintenance",
          operationKey: `pause:${crypto.randomUUID()}`,
          expectedRevision: 0,
        }),
      ),
    );
    const perRun = await schedule(workspace, {
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
    });
    const existing = await schedule(workspace, {
      runMode: "existing_session",
      overlapPolicy: "allow_concurrent",
    });
    const before = await listSessions(client.db, workspace.workspaceId);
    for (const task of [perRun, existing]) {
      expect(await fire(workspace, task.id)).toEqual({
        action: "blocked",
        reason: "scheduled_run_terminal",
      });
      expect(await runs(workspace, task.id)).toEqual([
        { status: "skipped", error: "scheduled_workspace_paused" },
      ]);
    }
    expect(await listSessions(client.db, workspace.workspaceId)).toHaveLength(before.length);
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        workspace.workspaceId,
        workspace.targetId,
      ),
    ).toEqual([]);
    // A workspace Pause is not the schedule's own blocker: it keeps running.
    await reviewScheduledTaskBlockerInventory({ db: client.db, bus });
    expect((await getScheduledTask(client.db, workspace.workspaceId, existing.id))?.status).toBe(
      "active",
    );
  }, 180_000);
});
