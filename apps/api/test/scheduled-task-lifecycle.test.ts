import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTaskScheduleReconciliations,
  retireExhaustedScheduledTask,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import type { ScheduledTask } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { reconcileExhaustedScheduledTasks } from "../src/scheduled-task-lifecycle";
import { createTemporalScheduleSynchronizer } from "../src/temporal-schedule-sync";

let shared: SharedTestDatabase;
let client: DbClient;
let workspace: { accountId: string; workspaceId: string; subjectId: string };
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("schedule-lifecycle-api");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Schedule lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Schedule lifecycle",
    subjectId: crypto.randomUUID(),
  });
  workspace = access.workspaceGrants[0]!;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function task() {
  return createScheduledTask(client.db, {
    ...workspace,
    name: "Scheduled review",
    status: "active",
    schedule: {
      type: "once",
      runAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      timeZone: "UTC",
    },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Review activity", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: { kind: "service", subjectId: "scheduler" },
  });
}

function synchronizer(writes: ScheduledTask[], removals: string[] = []) {
  return createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline: async (_deadline, work) => work(),
    upsert: async (saved) => {
      writes.push(saved);
    },
    remove: async (id) => {
      removals.push(id);
    },
  });
}

test("retirement pauses Temporal through latest-state synchronization and acknowledges durable work", async () => {
  const expired = await task();
  const writes: ScheduledTask[] = [];
  const sync = synchronizer(writes);
  await reconcileExhaustedScheduledTasks({ db: client.db, sync: (saved) => sync.sync(saved) });
  expect((await getScheduledTask(client.db, workspace.workspaceId, expired.id))?.status).toBe(
    "paused",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe("paused");
  expect(await listScheduledTaskScheduleReconciliations(client.db)).toEqual([]);
});

test("external failure retains a durable, deferred retry; a newer future edit wins", async () => {
  const expired = await task();
  await reconcileExhaustedScheduledTasks({
    db: client.db,
    sync: async () => {
      throw new Error("transport unavailable");
    },
  });
  const rows =
    await shared.admin`select id from scheduled_task_schedule_outbox where task_id=${expired.id}`;
  expect(rows).toHaveLength(1);
  expect(await listScheduledTaskScheduleReconciliations(client.db)).toEqual([]);
  const future = await updateScheduledTask(client.db, workspace.workspaceId, expired.id, {
    status: "active",
    schedule: {
      type: "once",
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      timeZone: "UTC",
    },
  });
  await shared.admin`update scheduled_task_schedule_outbox set next_attempt_at=now() where task_id=${expired.id}`;
  const writes: ScheduledTask[] = [];
  const sync = synchronizer(writes);
  await reconcileExhaustedScheduledTasks({ db: client.db, sync: (saved) => sync.sync(saved) });
  expect(writes).toEqual([future]);
  expect(await listScheduledTaskScheduleReconciliations(client.db)).toEqual([]);
});

test("deletion after retirement removes the external schedule instead of resurrecting it", async () => {
  const expired = await task();
  expect(await retireExhaustedScheduledTask(client.db, workspace.workspaceId, expired.id)).toBe(
    true,
  );
  await deleteScheduledTask(client.db, workspace.workspaceId, expired.id);
  const writes: ScheduledTask[] = [];
  const removals: string[] = [];
  const sync = synchronizer(writes, removals);
  await reconcileExhaustedScheduledTasks({ db: client.db, sync: (saved) => sync.sync(saved) });
  expect(writes).toEqual([]);
  expect(removals).toEqual([expired.temporalScheduleId]);
});
