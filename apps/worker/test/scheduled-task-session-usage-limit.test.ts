import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  listSessionEvents,
  readSessionUsageLimit,
  setSessionUsageLimitInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// F9 / AC09: an occurrence that targets an existing task tree counts against
// that task's usage limit through the real dispatch boundary and PostgreSQL.
// A reached limit is a visible, retryable occurrence refusal that appends no
// message, turn or wake; once a person clears the limit the next occurrence
// is admitted. A new-session-per-run schedule is a new root (outside the tree).
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-session-usage-limit");
  if (!shared) throw new Error("scheduled usage limit tests require real PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function dispatcher() {
  const settings = testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
  const wakes: string[] = [];
  const activities = createScheduledTaskActivities(
    async () =>
      ({
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async (input: { sessionId?: string }) => {
          wakes.push(String(input?.sessionId ?? "wake"));
        },
      }) as unknown as ActivityServices,
  );
  return { settings, activities, wakes };
}

async function fixture() {
  const subjectId = `user:scheduled-usage-limit-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-usage-limit-${crypto.randomUUID()}`,
    accountName: "Scheduled usage limit",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-usage-limit-${crypto.randomUUID()}`,
    workspaceName: "Scheduled usage limit",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!.admin`insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal schedule fixture') returning id`;
  await shared!.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

type Grant = Awaited<ReturnType<typeof fixture>>;

async function setLimit(grant: Grant, sessionId: string, limitMicros: number | null) {
  const read = await readSessionUsageLimit(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
  });
  if (read.outcome !== "ok") throw new Error(`usage read ${read.outcome}`);
  const result = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    async (tx) =>
      await setSessionUsageLimitInTransaction(tx, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        limitMicros,
        expectedVersion: read.state.version,
        operationId: crypto.randomUUID(),
        actor: { subjectId: grant.subjectId, type: "human" },
        producerEnabled: true,
      }),
  );
  expect(result.outcome).toBe("ok");
}

async function targetSession(grant: Grant, model: string, parentSessionId?: string) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    initialMessage: "Existing task",
    resources: [],
    tools: [],
    metadata: {},
    model,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    ...(parentSessionId ? { parentSessionId } : {}),
  });
}

async function task(
  grant: Grant,
  runMode: "existing_session" | "new_session_per_run",
  target?: string,
) {
  return await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Usage limit schedule",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-usage-limit-${crypto.randomUUID()}`,
    runMode,
    ...(target ? { targetSessionId: target } : {}),
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "Check in", resources: [], tools: [], metadata: {} },
    metadata: {},
    creatorPolicy: null,
  });
}

async function eventCount(grant: Grant, sessionId: string) {
  const events = await listSessionEvents(client.db, grant.workspaceId, sessionId, {
    after: 0,
    limit: 500,
  });
  return events.length;
}

describe("scheduled occurrences and the task usage limit (real PostgreSQL)", () => {
  test("an existing-session occurrence at the limit is refused visibly without appending work, and admitted after the limit is cleared", async () => {
    const grant = await fixture();
    const { settings, activities, wakes } = dispatcher();
    const root = await targetSession(grant, settings.openaiModel);
    // The schedule targets a child; the root's limit governs the whole tree.
    const child = await targetSession(grant, settings.openaiModel, root.id);
    await setLimit(grant, root.id, 0);
    const scheduled = await task(grant, "existing_session", child.id);
    const before = await eventCount(grant, child.id);
    for (let occurrence = 0; occurrence < 2; occurrence += 1) {
      const result = await activities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: scheduled.id,
        triggerType: "scheduled",
        producerKey: `scheduled-usage-limit-${crypto.randomUUID()}`,
      });
      expect(result).toMatchObject({
        action: "blocked",
        reason: "session_usage_limit",
        refusal: { reason: "session_usage_limit", retryable: true },
      });
    }
    // No message, turn or wake per tick: nothing for the claim to stop.
    expect(await eventCount(grant, child.id)).toBe(before);
    expect(wakes).toEqual([]);
    const [{ count }] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from scheduled_task_runs where task_id = ${scheduled.id}
        and admission_refusal->>'reason' = 'session_usage_limit'`;
    expect(count).toBe(2);

    // Clearing the limit never auto-resumes; the next occurrence is admitted.
    await setLimit(grant, root.id, null);
    const admitted = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: scheduled.id,
      triggerType: "scheduled",
      producerKey: `scheduled-usage-limit-${crypto.randomUUID()}`,
    });
    expect(["start", "signal"]).toContain(admitted.action);
    expect(await eventCount(grant, child.id)).toBeGreaterThan(before);
  }, 60_000);

  test("a new-session-per-run occurrence starts a new root outside any reached tree", async () => {
    const grant = await fixture();
    const { settings, activities } = dispatcher();
    const reached = await targetSession(grant, settings.openaiModel);
    await setLimit(grant, reached.id, 0);
    const scheduled = await task(grant, "new_session_per_run");
    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: scheduled.id,
      triggerType: "scheduled",
      producerKey: `scheduled-usage-limit-${crypto.randomUUID()}`,
    });
    expect(result.action).toBe("start");
  }, 60_000);
});
