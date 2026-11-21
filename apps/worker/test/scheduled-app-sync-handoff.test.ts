import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AppSyncAction,
  CreateScheduledTaskRequest,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { createValidatedScheduledTask } from "@opengeni/core";
import { createDb, listScheduledTaskRuns, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/**
 * An App data sync fire runs no model: the worker records the run and queues
 * it for the API's sync executor instead of starting a chat.
 */

let shared: SharedTestDatabase;
let client: DbClient;
const bus = new MemoryEventBus();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-scheduled-app-sync");
  if (!acquired) throw new Error("Scheduled App sync hand-off requires PostgreSQL");
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

let wakes = 0;
const scheduler = () =>
  createScheduledTaskActivities(
    async () =>
      ({
        settings: settings(),
        db: client.db,
        bus,
        wakeSessionWorkflow: async () => {
          wakes += 1;
        },
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
    insert into managed_accounts (name) values ('scheduled app sync') returning id`;
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
  const task = await createValidatedScheduledTask({
    settings: settings(),
    db: client.db,
    objectStorage: null,
    grant: key,
    payload: CreateScheduledTaskRequest.parse({
      name: "Orders sync",
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: { prompt: "App data sync: Orders" },
    }),
  });
  const action = AppSyncAction.parse({
    kind: "app_sync",
    siteId: crypto.randomUUID(),
    collection: "orders",
    mode: "shared",
    ownerSubjectId: `user:${crypto.randomUUID()}`,
    tool: { serverId: "orders-server", toolName: "list_orders" },
    declaredTools: [],
    arguments: {},
    recordsPath: null,
    key: "id",
    fields: null,
  });
  // Syncs are written by the App sync service; set the action directly here.
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update scheduled_tasks set action = ${sql.json(action)} where id = ${task.id}`;
  });
  return { workspaceId: workspace!.id, taskId: task.id };
}

test("a sync fire is queued for the executor and starts no chat", async () => {
  const workspace = await fixture();
  const producerKey = `app-sync-test:${crypto.randomUUID()}`;
  const fire = () =>
    scheduler().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: workspace.taskId,
      triggerType: "scheduled",
      producerKey,
    });
  const first = await fire();
  expect(first).toMatchObject({ action: "handed_off" });
  const runId = (first as { runId: string }).runId;
  // A retried activity hands off the same run again.
  expect(await fire()).toEqual({ action: "handed_off", runId });

  const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, workspace.taskId);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: runId, actionKind: "app_sync", status: "queued" });
  expect(runs[0]!.sessionId ?? null).toBeNull();
  const queued = await shared.admin<{ run_id: string }[]>`
    select run_id from app_sync_queue where task_id = ${workspace.taskId}`;
  expect(queued.map((row) => row.run_id)).toEqual([runId]);
  const [sessions] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sessions where workspace_id = ${workspace.workspaceId}`;
  expect(sessions?.count).toBe(0);
  expect(wakes).toBe(0);
}, 180_000);

test("a paused sync does not run", async () => {
  const workspace = await fixture();
  await shared.admin`update scheduled_tasks set status = 'paused' where id = ${workspace.taskId}`;
  expect(
    await scheduler().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: workspace.taskId,
      triggerType: "scheduled",
      producerKey: `app-sync-paused:${crypto.randomUUID()}`,
    }),
  ).toEqual({ action: "blocked", reason: "scheduled_task_paused" });
  expect(await listScheduledTaskRuns(client.db, workspace.workspaceId, workspace.taskId)).toEqual(
    [],
  );
}, 180_000);
