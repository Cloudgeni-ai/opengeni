import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  scheduledSessionIds,
  scheduledTaskHasUpcomingRun,
  sessionScheduleTargets,
  listScheduledTasks,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-session-targets");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Schedule targets",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Schedule targets",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return session;
}

test("targets are current, batched, workspace scoped and independent of creation metadata", async () => {
  const session = await fixture();
  const other = await fixture();
  const create = (name: string, status: "active" | "paused") =>
    createScheduledTask(client.db, {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      name,
      status,
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "existing_session",
      overlapPolicy: "skip",
      targetSessionId: session.id,
      agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id, other.id])).toEqual(
    new Set(),
  );
  const paused = await create("Paused", "paused");
  const active = await create("Active", "active");
  expect(session.metadata.scheduledTaskId).toBeUndefined();
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id, other.id])).toEqual(
    new Set([session.id]),
  );
  expect(await scheduledSessionIds(client.db, other.workspaceId, [session.id])).toEqual(new Set());
  expect(
    (await listScheduledTasks(client.db, session.workspaceId, 100, 0, session.id))
      .map((t) => t.id)
      .sort(),
  ).toEqual([paused.id, active.id].sort());
  expect(await listScheduledTasks(client.db, session.workspaceId, 100, 0, other.id)).toEqual([]);
  await deleteScheduledTask(client.db, session.workspaceId, active.id);
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id])).toEqual(
    new Set([session.id]),
  );
  await updateScheduledTask(client.db, session.workspaceId, paused.id, {
    runMode: "new_session_per_run",
    targetSessionId: null,
  });
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id])).toEqual(
    new Set(),
  );
  await updateScheduledTask(client.db, session.workspaceId, paused.id, {
    runMode: "reusable_session",
    reusableSessionId: session.id,
  });
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id])).toEqual(
    new Set([session.id]),
  );
  await deleteScheduledTask(client.db, session.workspaceId, paused.id);
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id])).toEqual(
    new Set(),
  );
  const [index] =
    await shared.admin`select indexdef from pg_indexes where indexname = 'scheduled_tasks_workspace_session_target_idx'`;
  expect(index?.indexdef).toContain("(workspace_id, reusable_session_id)");
  expect(index?.indexdef).toContain("deleted_at IS NULL");
}, 60_000);

test("upcoming targets exclude paused, past one-time, ended and manual schedules", async () => {
  const session = await fixture();
  const now = new Date();
  const later = new Date(now.getTime() + 3_600_000).toISOString();
  const earlier = new Date(now.getTime() - 3_600_000).toISOString();
  const create = (status: "active" | "paused", schedule: Record<string, unknown>) =>
    createScheduledTask(client.db, {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      name: `${status} ${String(schedule.type)}`,
      status,
      schedule: schedule as never,
      temporalScheduleId: crypto.randomUUID(),
      runMode: "existing_session",
      overlapPolicy: "skip",
      targetSessionId: session.id,
      agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
  const targets = () => sessionScheduleTargets(client.db, session.workspaceId, [session.id], now);

  // The reported case: a paused one-time checkpoint whose time passed unrun.
  const stale = await create("paused", { type: "once", runAt: earlier, timeZone: "UTC" });
  const expired = await create("active", { type: "once", runAt: earlier, timeZone: "UTC" });
  const ended = await create("active", { type: "interval", everySeconds: 60, endAt: earlier });
  const manual = await create("active", { type: "manual" });
  const pausedFuture = await create("paused", { type: "once", runAt: later, timeZone: "UTC" });
  expect(await targets()).toEqual({ scheduled: new Set([session.id]), upcoming: new Set() });
  expect(await scheduledSessionIds(client.db, session.workspaceId, [session.id])).toEqual(
    new Set([session.id]),
  );

  // Resuming a future one-time schedule makes it upcoming again.
  await updateScheduledTask(client.db, session.workspaceId, pausedFuture.id, { status: "active" });
  expect((await targets()).upcoming).toEqual(new Set([session.id]));
  await deleteScheduledTask(client.db, session.workspaceId, pausedFuture.id);
  expect((await targets()).upcoming).toEqual(new Set());

  const calendar = await create("active", { type: "calendar", hour: 9, minute: 0 });
  expect((await targets()).upcoming).toEqual(new Set([session.id]));
  for (const task of [stale, expired, ended, manual, calendar]) {
    await deleteScheduledTask(client.db, session.workspaceId, task.id);
  }
  expect(await targets()).toEqual({ scheduled: new Set(), upcoming: new Set() });
}, 60_000);

test("an upcoming run needs an active schedule with a run left", () => {
  const now = new Date("2026-10-22T08:00:00Z");
  const upcoming = (status: string, schedule: unknown) =>
    scheduledTaskHasUpcomingRun({ status, schedule }, now);
  expect(upcoming("active", { type: "once", runAt: "2026-10-22T09:00:00+01:00" })).toBe(false);
  expect(upcoming("active", { type: "once", runAt: "2026-10-22T08:00:01Z" })).toBe(true);
  expect(upcoming("paused", { type: "once", runAt: "2026-10-23T08:00:00Z" })).toBe(false);
  expect(upcoming("active", { type: "once", runAt: "not a date" })).toBe(false);
  expect(upcoming("active", { type: "interval", everySeconds: 60 })).toBe(true);
  expect(
    upcoming("active", { type: "interval", everySeconds: 60, endAt: "2026-10-23T00:00:00Z" }),
  ).toBe(true);
  expect(
    upcoming("active", { type: "interval", everySeconds: 60, endAt: "2026-10-21T00:00:00Z" }),
  ).toBe(false);
  expect(upcoming("active", { type: "calendar", hour: 1, minute: 0 })).toBe(true);
  expect(upcoming("paused", { type: "calendar", hour: 1, minute: 0 })).toBe(false);
  expect(upcoming("active", { type: "manual" })).toBe(false);
  expect(upcoming("active", null)).toBe(false);
});
