import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createEventSource,
  createSession,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  scheduledSessionIds,
  scheduledTaskHasUpcomingRun,
  scheduledTaskNextRunAt,
  sessionScheduleTargets,
  setScheduledTaskEvents,
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
  const targets = async () => {
    const { waits: _waits, ...sets } = await sessionScheduleTargets(
      client.db,
      session.workspaceId,
      [session.id],
      { now },
    );
    return sets;
  };

  // The reported case: a paused one-time checkpoint whose time passed unrun.
  const stale = await create("paused", { type: "once", runAt: earlier, timeZone: "UTC" });
  const expired = await create("active", { type: "once", runAt: earlier, timeZone: "UTC" });
  const ended = await create("active", { type: "interval", everySeconds: 60, endAt: earlier });
  const manual = await create("active", { type: "manual" });
  const pausedFuture = await create("paused", { type: "once", runAt: later, timeZone: "UTC" });
  expect(await targets()).toEqual({
    scheduled: new Set([session.id]),
    upcoming: new Set(),
    waitingForEvents: new Set(),
  });
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
  expect(await targets()).toEqual({
    scheduled: new Set(),
    upcoming: new Set(),
    waitingForEvents: new Set(),
  });
}, 60_000);

test("a chat waits for events while an active automation listens and has not finished", async () => {
  const session = await fixture();
  const space = { accountId: session.accountId, workspaceId: session.workspaceId };
  const { source } = await createEventSource(client.db, {
    ...space,
    createdBySubjectId: "scheduler",
    kind: "webhook",
    adapter: "standard",
    name: "Deploys",
    ownerSubjectId: "scheduler",
    visibility: "workspace",
    secretEncrypted: "encrypted-secret",
  });
  const automation = await createScheduledTask(client.db, {
    ...space,
    name: "Wake me when it deploys",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "existing_session",
    overlapPolicy: "skip",
    targetSessionId: session.id,
    agentConfig: { prompt: "Check the deploy", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const waiting = async () =>
    (await sessionScheduleTargets(client.db, session.workspaceId, [session.id])).waitingForEvents;
  expect(await waiting()).toEqual(new Set());

  const trigger = {
    sourceId: source.id,
    eventTypes: ["deploy.finished"],
    conditions: [],
    includeOwnEvents: false,
  };
  await setScheduledTaskEvents(client.db, {
    ...space,
    taskId: automation.id,
    triggers: [trigger, { ...trigger, eventTypes: ["deploy.failed"] }],
    once: true,
  });
  expect(await waiting()).toEqual(new Set([session.id]));
  // A manual automation that only events start has no upcoming scheduled run.
  expect(
    (await sessionScheduleTargets(client.db, session.workspaceId, [session.id])).upcoming,
  ).toEqual(new Set());

  await updateScheduledTask(client.db, session.workspaceId, automation.id, { status: "paused" });
  expect(await waiting()).toEqual(new Set());
  await updateScheduledTask(client.db, session.workspaceId, automation.id, { status: "active" });
  expect(await waiting()).toEqual(new Set([session.id]));

  // A once-automation that has run stops waiting.
  await shared.admin`update scheduled_task_event_settings set completed_at = now() where task_id = ${automation.id}`;
  expect(await waiting()).toEqual(new Set());
  await shared.admin`update scheduled_task_event_settings set completed_at = null where task_id = ${automation.id}`;

  await shared.admin`update event_triggers set status = 'blocked', status_reason = 'The source was disconnected' where task_id = ${automation.id}`;
  expect(await waiting()).toEqual(new Set());
  await setScheduledTaskEvents(client.db, { ...space, taskId: automation.id, triggers: [] });
  expect(await waiting()).toEqual(new Set());
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

test("the next run follows each schedule kind, time zone and daylight saving", () => {
  const next = (schedule: unknown, now: string) =>
    scheduledTaskNextRunAt(schedule, new Date(now))?.toISOString() ?? null;
  const now = "2026-10-22T08:00:00.000Z"; // a Thursday
  expect(next({ type: "manual" }, now)).toBeNull();
  expect(next({ type: "once", runAt: "2026-10-22T09:00:00+02:00" }, now)).toBeNull();
  expect(next({ type: "once", runAt: "2026-10-22T12:00:00+02:00" }, now)).toBe(
    "2026-10-22T10:00:00.000Z",
  );
  // Intervals align to the epoch, or to startAt, and stop at endAt.
  expect(next({ type: "interval", everySeconds: 3_600 }, now)).toBe("2026-10-22T09:00:00.000Z");
  expect(
    next({ type: "interval", everySeconds: 3_600, startAt: "2026-10-22T07:30:00Z" }, now),
  ).toBe("2026-10-22T08:30:00.000Z");
  expect(
    next({ type: "interval", everySeconds: 3_600, startAt: "2026-10-25T00:00:00Z" }, now),
  ).toBe("2026-10-25T00:00:00.000Z");
  expect(
    next({ type: "interval", everySeconds: 3_600, endAt: "2026-10-22T08:30:00Z" }, now),
  ).toBeNull();
  // Calendar runs keep their wall clock in the schedule's zone (Oslo is +02:00 until Oct 25).
  expect(next({ type: "calendar", hour: 9, minute: 30, timeZone: "Europe/Oslo" }, now)).toBe(
    "2026-10-23T07:30:00.000Z",
  );
  expect(next({ type: "calendar", hour: 11, minute: 0, timeZone: "Europe/Oslo" }, now)).toBe(
    "2026-10-22T09:00:00.000Z",
  );
  expect(
    next(
      { type: "calendar", hour: 9, minute: 0, timeZone: "Europe/Oslo", daysOfWeek: ["MONDAY"] },
      now,
    ),
  ).toBe("2026-10-26T08:00:00.000Z");
  // Across the end of summer time (Oslo moves from +02:00 to +01:00 on Oct 25).
  expect(
    next(
      { type: "calendar", hour: 9, minute: 0, timeZone: "Europe/Oslo", daysOfWeek: ["SUNDAY"] },
      now,
    ),
  ).toBe("2026-10-25T08:00:00.000Z");
  expect(
    next(
      {
        type: "calendar",
        hour: 23,
        minute: 0,
        timeZone: "America/Los_Angeles",
        daysOfWeek: ["THURSDAY"],
      },
      now,
    ),
  ).toBe("2026-10-23T06:00:00.000Z");
  expect(next({ type: "calendar", hour: 9, minute: 0, timeZone: "Not/AZone" }, now)).toBeNull();
  expect(next({ type: "interval", everySeconds: 0 }, now)).toBeNull();
  expect(next(null, now)).toBeNull();
});

test("a chat's wait says when the next run is and which event it waits for", async () => {
  const session = await fixture();
  const space = { accountId: session.accountId, workspaceId: session.workspaceId };
  const now = new Date("2026-10-22T08:00:00Z");
  const source = async (name: string, visibility: "workspace" | "private", owner: string) =>
    (
      await createEventSource(client.db, {
        ...space,
        createdBySubjectId: owner,
        kind: "webhook",
        adapter: "standard",
        name,
        ownerSubjectId: owner,
        visibility,
        secretEncrypted: "encrypted-secret",
      })
    ).source;
  const deploys = await source("Deploys", "workspace", "alice");
  const alicesInbox = await source("Alice's inbox", "private", "alice");
  const automation = async (
    name: string,
    schedule: Record<string, unknown>,
    options: {
      triggers?: { sourceId: string; eventTypes: string[] }[];
      owner?: string;
      visibility?: "user_private" | "workspace_shared";
      status?: "active" | "paused";
    } = {},
  ) => {
    const task = await createScheduledTask(client.db, {
      ...space,
      name,
      status: options.status ?? "active",
      schedule: schedule as never,
      temporalScheduleId: crypto.randomUUID(),
      runMode: "existing_session",
      overlapPolicy: "skip",
      targetSessionId: session.id,
      agentConfig: { prompt: name, resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: options.owner ?? "alice" },
      visibility: options.visibility ?? "workspace_shared",
      metadata: {},
    });
    if (options.triggers) {
      await setScheduledTaskEvents(client.db, {
        ...space,
        taskId: task.id,
        triggers: options.triggers.map((trigger) => ({
          ...trigger,
          conditions: [],
          includeOwnEvents: false,
        })),
      });
    }
    return task;
  };
  let viewerAsked = 0;
  const wait = async (viewerSubjectId?: string | null) =>
    (
      await sessionScheduleTargets(client.db, session.workspaceId, [session.id], {
        now,
        ...(viewerSubjectId === undefined
          ? {}
          : {
              viewer: async () => {
                viewerAsked += 1;
                return viewerSubjectId;
              },
            }),
      })
    ).waits?.get(session.id) ?? null;

  expect(await wait()).toBeNull();
  await automation(
    "Paused daily",
    { type: "calendar", hour: 7, minute: 0, timeZone: "UTC" },
    {
      status: "paused",
    },
  );
  expect(await wait()).toBeNull();

  await automation("Daily", { type: "calendar", hour: 9, minute: 0, timeZone: "UTC" });
  await automation("Hourly", { type: "interval", everySeconds: 3_600 });
  expect(await wait()).toEqual({
    nextRunAt: "2026-10-22T09:00:00.000Z",
    event: null,
    automations: 2,
  });
  // Nothing private targets the chat, so the reader is not even asked.
  expect((await wait("bob"))?.automations).toBe(2);
  expect(viewerAsked).toBe(0);

  // Alice's private automation on her private source: she sees it all, Bob
  // sees neither, and a trusted reader sees both.
  await automation(
    "Alice's mail",
    { type: "manual" },
    {
      triggers: [{ sourceId: alicesInbox.id, eventTypes: ["message.received"] }],
      visibility: "user_private",
    },
  );
  expect((await wait("alice"))?.event).toEqual({
    source: { kind: "webhook", name: "Alice's inbox" },
    eventTypes: ["message.received"],
  });
  expect(await wait("bob")).toEqual({
    nextRunAt: "2026-10-22T09:00:00.000Z",
    event: null,
    automations: 2,
  });
  expect(viewerAsked).toBe(2);
  expect((await wait())?.automations).toBe(3);

  // A shared automation listening on Alice's private source names no source for Bob.
  const watcher = await automation(
    "Watch the deploy",
    { type: "manual" },
    {
      triggers: [
        { sourceId: alicesInbox.id, eventTypes: ["message.received"] },
        { sourceId: deploys.id, eventTypes: ["deploy.finished", "deploy.failed"] },
      ],
    },
  );
  expect((await wait("bob"))?.event).toEqual({
    source: null,
    eventTypes: ["message.received"],
  });
  // A blocked trigger is skipped for the next active one.
  await shared.admin`update event_triggers set status = 'blocked', status_reason = 'The source was disconnected' where task_id = ${watcher.id} and position = 0`;
  expect(await wait("bob")).toEqual({
    nextRunAt: "2026-10-22T09:00:00.000Z",
    event: {
      source: { kind: "webhook", name: "Deploys" },
      eventTypes: ["deploy.finished", "deploy.failed"],
    },
    automations: 3,
  });
  expect((await wait(null))?.automations).toBe(3);
}, 60_000);
