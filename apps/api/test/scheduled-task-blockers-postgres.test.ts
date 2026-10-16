import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  getScheduledTask,
  getScheduledTaskBlockers,
  listSessionEvents,
  recordScheduledTaskAdmissionRefusal,
  updateScheduledTask,
  type DbClient,
  type ScheduledTaskAdmissionRefusalReason,
} from "@opengeni/db";
import type { ScheduledTask } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { reconcileExhaustedScheduledTasks } from "../src/scheduled-task-lifecycle";
import { scheduledTaskBlockerNoticeKey } from "../src/scheduled-task-blockers";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: DbClient;
let workspace: { accountId: string; workspaceId: string; subjectId: string };
const bus = new MemoryEventBus();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("schedule-blockers-api");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Schedule blockers",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Schedule blockers",
    subjectId: crypto.randomUUID(),
  });
  workspace = access.workspaceGrants[0]!;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A daily schedule that keeps reusing one chat. */
async function scheduleInChat(): Promise<{ task: ScheduledTask; sessionId: string }> {
  const session = await createSession(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "Daily review",
    resources: [],
    tools: [],
    metadata: {},
    model: testSettings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: workspace.subjectId, label: "Owner" },
    createdByContext: {},
  });
  const created = await createScheduledTask(client.db, {
    ...workspace,
    name: "Daily review",
    status: "active",
    schedule: { type: "cron", cron: "0 7 * * *", timeZone: "UTC" },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "reusable_session",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Review activity", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: { kind: "subject", subjectId: workspace.subjectId },
  });
  const task = await updateScheduledTask(client.db, workspace.workspaceId, created.id, {
    reusableSessionId: session.id,
  });
  return { task, sessionId: session.id };
}

async function refuse(
  task: ScheduledTask,
  reason: ScheduledTaskAdmissionRefusalReason,
  retryable: boolean,
) {
  await recordScheduledTaskAdmissionRefusal(client.db, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled",
    producerKey: `occurrence-${crypto.randomUUID()}`,
    scheduledAt: new Date(),
    reason,
    retryable,
  });
}

const synced: string[] = [];
async function review() {
  await reconcileExhaustedScheduledTasks({
    db: client.db,
    sync: async (task) => {
      synced.push(task.id);
    },
    bus,
  });
}

async function notices(sessionId: string) {
  const events = await listSessionEvents(client.db, workspace.workspaceId, sessionId);
  return events
    .filter(
      (event) =>
        event.type === "session.notification.posted" ||
        event.type === "session.notification.withdrawn",
    )
    .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }));
}

test("a run no later run can get past pauses the schedule and tells its owner once", async () => {
  const { task, sessionId } = await scheduleInChat();
  await refuse(task, "machine_target_unavailable", false);
  await review();

  expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
    "paused",
  );
  // The same pass stops Temporal from firing it.
  expect(synced.filter((id) => id === task.id)).toHaveLength(1);
  const posted = await notices(sessionId);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.type).toBe("session.notification.posted");
  expect(posted[0]?.payload).toMatchObject({
    key: scheduledTaskBlockerNoticeKey(task.id),
    title: "Schedule paused itself",
    subtitle: "Daily review",
  });
  expect(String(posted[0]?.payload.body)).toContain("machine it runs on");
  const blocker = (await getScheduledTaskBlockers(client.db, workspace.workspaceId, [task.id])).get(
    task.id,
  );
  expect(blocker).toMatchObject({ state: "paused", reason: "machine_target_unavailable" });

  // Reviewing again neither repeats the notice nor changes anything.
  await review();
  expect(await notices(sessionId)).toHaveLength(1);

  // The owner fixes it and resumes: the notice is withdrawn and the blocker cleared.
  await updateScheduledTask(client.db, workspace.workspaceId, task.id, { status: "active" });
  await review();
  const after = await notices(sessionId);
  expect(after.map((event) => event.type)).toEqual([
    "session.notification.posted",
    "session.notification.withdrawn",
  ]);
  expect(after[1]?.payload).toEqual({ key: scheduledTaskBlockerNoticeKey(task.id) });
  expect((await getScheduledTaskBlockers(client.db, workspace.workspaceId, [task.id])).size).toBe(
    0,
  );
  expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
    "active",
  );
});

test("runs refused for a reason that may clear tell the owner after a streak, once, without pausing", async () => {
  const { task, sessionId } = await scheduleInChat();
  await refuse(task, "insufficient_credits", true);
  await review();
  await refuse(task, "insufficient_credits", true);
  await review();
  expect(await notices(sessionId)).toEqual([]);

  await refuse(task, "insufficient_credits", true);
  await review();
  const posted = await notices(sessionId);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.payload).toMatchObject({ title: "Schedule needs attention" });
  expect(String(posted[0]?.payload.body)).toContain("out of credits");
  expect((await getScheduledTask(client.db, workspace.workspaceId, task.id))?.status).toBe(
    "active",
  );
  expect(
    (await getScheduledTaskBlockers(client.db, workspace.workspaceId, [task.id])).get(task.id),
  ).toMatchObject({ state: "notified", reason: "insufficient_credits" });

  // The streak continues: still one notice.
  await refuse(task, "insufficient_credits", true);
  await review();
  expect(await notices(sessionId)).toHaveLength(1);
});
