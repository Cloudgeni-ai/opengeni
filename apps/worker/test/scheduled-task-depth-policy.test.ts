import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createScheduledTask,
  getSession,
  listSessionEvents,
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
    });

    expect(result.action).toBe("start");
    const session = await getSession(client.db, workspace!.id, result.sessionId);
    expect(session).toMatchObject({
      id: result.sessionId,
      parentSessionId: null,
      rootSessionId: result.sessionId,
      nestedAgentDepth: 0,
      maxNestedAgentDepthOverride: 5,
      effectiveMaxNestedAgentDepth: 5,
      nestedAgentDepthPolicySource: "session",
      nestedAgentDepthPolicySessionId: result.sessionId,
    });
    expect(
      (await listSessionEvents(client.db, workspace!.id, result.sessionId, 0, 10)).map(
        (event) => event.type,
      ),
    ).toEqual(["session.created", "session.status.changed", "system.update.pending"]);
    expect(wakeups).toEqual([
      {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId: result.sessionId,
        workflowId: result.workflowId,
        wakeRevision: result.workflowWakeRevision,
      },
    ]);
  }, 60_000);
});
