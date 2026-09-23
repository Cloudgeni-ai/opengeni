import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  scheduledSessionIds,
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
