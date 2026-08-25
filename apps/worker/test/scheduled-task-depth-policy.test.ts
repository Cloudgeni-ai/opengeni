import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createScheduledTask,
  getSession,
  listSessionEvents,
  updateSessionTitle,
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

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-depth-policy");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-depth-policy] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("scheduled-task nested-agent policy dispatch (real PostgreSQL)", () => {
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
