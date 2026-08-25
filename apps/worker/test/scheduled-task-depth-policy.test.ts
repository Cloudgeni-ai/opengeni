import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createSession,
  createScheduledTask,
  getSession,
  listSessionEvents,
  updateSessionTitle,
  updateSessionTitleWithEvent,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "@opengeni/db/migrate";
import postgres from "postgres";
import {
  createScheduledTaskActivities,
  stampScheduledSessionTitle,
} from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let competitor: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-depth-policy");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-depth-policy] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  competitor = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await competitor?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function appSessionLockWaiters(): Promise<number> {
  const [row] = await admin<Array<{ count: number }>>`
    select count(*)::int as count
    from pg_stat_activity
    where datname = current_database()
      and usename = 'opengeni_app'
      and wait_event_type = 'Lock'`;
  return row?.count ?? 0;
}

async function waitForAppSessionLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await appSessionLockWaiters()) >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${minimum} app session lock waiters`);
}

describe("scheduled-task nested-agent policy dispatch (real PostgreSQL)", () => {
  test("keeps the fallback CAS and title event ordered against a concurrent newer writer", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('scheduled title race') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'scheduled title race') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const session = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "run the scheduled title race",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });

    let releaseBlocker!: () => void;
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerReady!: () => void;
    const blockerLocked = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = admin.begin(async (tx) => {
      await tx`select id from sessions where id = ${session.id} for no key update`;
      blockerReady();
      await blockerRelease;
    });
    await blockerLocked;

    const baselineWaiters = await appSessionLockWaiters();
    let scheduledStamp: ReturnType<typeof stampScheduledSessionTitle> | undefined;
    let newerWrite: ReturnType<typeof updateSessionTitleWithEvent> | undefined;
    try {
      scheduledStamp = stampScheduledSessionTitle(client.db, {
        workspaceId: workspace!.id,
        sessionId: session.id,
        taskName: "scheduler fallback title",
      });
      await waitForAppSessionLockWaiters(baselineWaiters + 1);
      newerWrite = updateSessionTitleWithEvent(competitor.db, {
        workspaceId: workspace!.id,
        sessionId: session.id,
        title: "newer agent title",
        source: "agent",
      });
      await waitForAppSessionLockWaiters(baselineWaiters + 2);
    } finally {
      releaseBlocker();
    }

    const [scheduledEvents, newerResult] = await Promise.all([
      scheduledStamp!,
      newerWrite!,
      blocker,
    ]).then(([events, result]) => [events, result] as const);
    expect(scheduledEvents).toHaveLength(1);
    expect(newerResult).toMatchObject({ updated: true, title: "newer agent title" });
    expect(newerResult.events).toHaveLength(1);

    const titleEvents = (
      await listSessionEvents(client.db, workspace!.id, session.id, 0, 20)
    ).filter((event) => event.type === "session.title_set");
    expect(titleEvents.map((event) => event.payload)).toEqual([
      { title: "scheduler fallback title", source: "agent" },
      { title: "newer agent title", source: "agent" },
    ]);
    expect(await getSession(client.db, workspace!.id, session.id)).toMatchObject({
      title: "newer agent title",
      titleSource: "agent",
      lastSequence: titleEvents.at(-1)!.sequence,
    });

    const beforeRetry = titleEvents.length;
    expect(
      await stampScheduledSessionTitle(client.db, {
        workspaceId: workspace!.id,
        sessionId: session.id,
        taskName: "scheduler fallback title",
      }),
    ).toEqual([]);
    expect(
      (await listSessionEvents(client.db, workspace!.id, session.id, 0, 20)).filter(
        (event) => event.type === "session.title_set",
      ),
    ).toHaveLength(beforeRetry);
  }, 60_000);

  test("persists the durable agent override on the dispatched root session", async () => {
    if (!available) return;
    await migrate(shared!.adminUrl, undefined, { maxNestedAgentDepth: 7 });
    try {
      const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('worker scheduled depth') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'worker scheduled depth') returning id`;
      await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;

      const task = await createScheduledTask(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        name: "scheduled nested policy",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "dispatch with an agent-layer depth policy",
          resources: [],
          tools: [],
          metadata: {},
          maxNestedAgentDepth: 5,
        },
        metadata: {},
      });

      const wakeups: unknown[] = [];
      const activities = createScheduledTaskActivities(
        async () =>
          ({
            settings: testSettings({
              databaseUrl: shared!.appUrl,
              sandboxBackend: "none",
              maxNestedAgentDepth: 1,
            }),
            db: client.db,
            bus: new MemoryEventBus(),
            wakeSessionWorkflow: async (input: unknown) => {
              wakeups.push(input);
            },
          }) as unknown as ActivityServices,
      );
      const result = await activities.dispatchScheduledTaskRun({
        workspaceId: workspace!.id,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `depth-policy-${crypto.randomUUID()}`,
      });

      expect(result.action).toBe("start");
      const session = await getSession(client.db, workspace!.id, result.sessionId);
      expect(session).toMatchObject({
        id: result.sessionId,
        // The scheduler names the session after the task, with no run-specific
        // fact frozen into it. titleSource stays "agent" so the running agent
        // can still rename through set_session_title and a human rename wins.
        title: "scheduled nested policy",
        titleSource: "agent",
        parentSessionId: null,
        rootSessionId: result.sessionId,
        nestedAgentDepth: 0,
        maxNestedAgentDepthOverride: 5,
        effectiveMaxNestedAgentDepth: 5,
        nestedAgentDepthPolicySource: "session",
        nestedAgentDepthPolicySessionId: result.sessionId,
      });
      // A generated scheduled session starts through the atomic deferred path:
      // session.created carries the public "queued" status directly, so no
      // separate session.status.changed event is emitted before the wake. The
      // scheduler's own title lands right after it, on the same shared
      // session.title_set the manual rename and set_session_title emit, so a
      // live subscriber patches the title instead of holding the stale one.
      const events = await listSessionEvents(client.db, workspace!.id, result.sessionId, 0, 10);
      expect(events.map((event) => event.type)).toEqual([
        "session.created",
        "session.title_set",
        "system.update.pending",
      ]);
      expect(events[0]?.payload).toMatchObject({ status: "queued" });
      expect(events[1]?.payload).toMatchObject({
        title: "scheduled nested policy",
        source: "agent",
      });
      // The scheduler's title must not become a lock on the session. An agent
      // set_session_title is an "agent" write (apps/api/src/mcp/server.ts), and
      // the db clobber guard pins only a "user" title, so the agent renames over
      // the scheduler freely. A human rename then pins it permanently and the
      // next agent write is skipped.
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          title: "Debug token sk-proj-abc123456789XYZ",
          source: "agent",
        }),
      ).toMatchObject({ updated: false, title: "scheduled nested policy" });
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          title: "agent chosen title",
          source: "agent",
        }),
      ).toMatchObject({ updated: true, title: "agent chosen title" });
      const eventsBeforeStaleStamp = await listSessionEvents(
        client.db,
        workspace!.id,
        result.sessionId,
        0,
        20,
      );
      // Model the dispatch race deterministically: the scheduler still intends
      // to replace its creation fallback, but another agent title committed
      // first. The database CAS must reject the stale stamp and no title event
      // may be emitted for a write that did not happen.
      expect(
        await stampScheduledSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          taskName: "stale scheduler title",
        }),
      ).toEqual([]);
      expect(await getSession(client.db, workspace!.id, result.sessionId)).toMatchObject({
        title: "agent chosen title",
        titleSource: "agent",
      });
      expect(
        await listSessionEvents(client.db, workspace!.id, result.sessionId, 0, 20),
      ).toHaveLength(eventsBeforeStaleStamp.length);
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          title: "OAuth callback failures",
          source: "agent",
        }),
      ).toMatchObject({ updated: true, title: "OAuth callback failures" });
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          title: "human chosen title",
          source: "user",
        }),
      ).toMatchObject({ updated: true, title: "human chosen title" });
      expect(
        await updateSessionTitle(client.db, {
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          title: "agent tries again",
          source: "agent",
        }),
      ).toMatchObject({ updated: false, title: "human chosen title" });
      expect(wakeups).toEqual([
        {
          accountId: account!.id,
          workspaceId: workspace!.id,
          sessionId: result.sessionId,
          workflowId: result.workflowId,
          wakeRevision: result.workflowWakeRevision,
        },
      ]);
    } finally {
      await migrate(shared!.adminUrl, undefined, {});
    }
  }, 60_000);
});
