import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  acquireOwnerMigratedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type ScheduledTask,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTask,
  listExhaustedScheduledTasks,
  listScheduledTaskScheduleReconciliations,
  retireExhaustedScheduledTask,
  updateScheduledTask,
  markScheduledTaskRunFailedIfQueued,
  type Database,
} from "../src/index";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("exhausted-schedules");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
async function task(schedule: ScheduledTask["schedule"], db: Database = client.db) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Schedule lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Schedule lifecycle",
    subjectId: `subject-${suffix}`,
  });
  return createScheduledTask(db, {
    ...access.workspaceGrants[0]!,
    name: "Schedule lifecycle",
    status: "active",
    schedule,
    temporalScheduleId: `schedule-${suffix}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Review activity", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: { kind: "service", subjectId: "scheduler" },
  });
}

async function run(
  value: ScheduledTask,
  triggerType: "scheduled" | "manual" = "scheduled",
  db: Database = client.db,
) {
  const depth = await getNestedAgentDepthDeploymentPolicy(db);
  const runId = crypto.randomUUID();
  return createScheduledTaskRun(db, {
    runId,
    workspaceId: value.workspaceId,
    taskId: value.id,
    taskAuthorityRevision: value.authorityRevision,
    taskExecutionDigest: value.executionDigest,
    triggerType,
    producerKey: `run-${runId}`,
    acceptedExecutionSnapshot: {
      version: 1,
      task: value,
      resolvedModel: "scripted-model",
      resolvedReasoningEffort: "medium",
      resolvedLatencyMode: "standard",
      resolvedSandboxBackend: "none",
      resolvedSandboxOs: "linux",
      resolvedTools: [],
      resolvedFirstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution: null,
      generatedSessionBinding: {
        createIdempotencyKey: `scheduled-task-run:${runId}`,
        effectiveMaxNestedAgentDepth: depth.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depth.policySource,
        codexCompactionMode: "portable",
      },
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId: null,
      causalHumanSubjectId: null,
      causalHumanAuthority: null,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeAuthoritySubjectId: null,
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    },
  });
}

test("one-shot retirement requires a consumed scheduled occurrence or expired catch-up", async () => {
  const recent = await task({ type: "once", runAt: ago(1), timeZone: "UTC" });
  expect(await retireExhaustedScheduledTask(client.db, recent.workspaceId, recent.id)).toBe(false);
  const pending = await run(recent);
  expect(await retireExhaustedScheduledTask(client.db, recent.workspaceId, recent.id)).toBe(false);
  await markScheduledTaskRunFailedIfQueued(
    client.db,
    recent.workspaceId,
    pending.id,
    "synthetic settled refusal",
  );
  expect(await retireExhaustedScheduledTask(client.db, recent.workspaceId, recent.id)).toBe(true);
  expect((await getScheduledTask(client.db, recent.workspaceId, recent.id))?.status).toBe("paused");
  expect(await retireExhaustedScheduledTask(client.db, recent.workspaceId, recent.id)).toBe(false);
  expect(
    (await listScheduledTaskScheduleReconciliations(client.db)).filter(
      (entry) => entry.task_id === recent.id,
    ),
  ).toHaveLength(1);

  const missed = await task({ type: "once", runAt: ago(25), timeZone: "UTC" });
  expect(await retireExhaustedScheduledTask(client.db, missed.workspaceId, missed.id)).toBe(true);
  const manualOnly = await task({ type: "once", runAt: ago(1), timeZone: "UTC" });
  const manual = await run(manualOnly, "manual");
  await markScheduledTaskRunFailedIfQueued(
    client.db,
    manualOnly.workspaceId,
    manual.id,
    "synthetic settled refusal",
  );
  expect(await retireExhaustedScheduledTask(client.db, manualOnly.workspaceId, manualOnly.id)).toBe(
    false,
  );
}, 30_000);

test("interval retirement preserves catch-up, pending runs, future schedules and non-timed tasks", async () => {
  for (const schedule of [
    { type: "interval", everySeconds: 60, endAt: ago(1) },
    { type: "interval", everySeconds: 60 },
    { type: "once", runAt: ago(-1), timeZone: "UTC" },
    { type: "manual" },
    { type: "calendar", hour: 12, minute: 0, timeZone: "UTC" },
  ] satisfies ScheduledTask["schedule"][]) {
    const value = await task(schedule);
    expect(await retireExhaustedScheduledTask(client.db, value.workspaceId, value.id)).toBe(false);
  }
  const expired = await task({ type: "interval", everySeconds: 60, endAt: ago(25) });
  const pending = await run(expired);
  expect(await retireExhaustedScheduledTask(client.db, expired.workspaceId, expired.id)).toBe(
    false,
  );
  await markScheduledTaskRunFailedIfQueued(
    client.db,
    expired.workspaceId,
    pending.id,
    "synthetic settled refusal",
  );
  expect(
    (await listExhaustedScheduledTasks(client.db)).some((entry) => entry.id === expired.id),
  ).toBe(true);
  expect(await retireExhaustedScheduledTask(client.db, expired.workspaceId, expired.id)).toBe(true);
}, 30_000);

test("a stale candidate cannot pause a newer future edit or another tenant's task", async () => {
  const expired = await task({ type: "once", runAt: ago(25), timeZone: "UTC" });
  await updateScheduledTask(client.db, expired.workspaceId, expired.id, {
    schedule: { type: "once", runAt: ago(-1), timeZone: "UTC" },
  });
  expect(await retireExhaustedScheduledTask(client.db, expired.workspaceId, expired.id)).toBe(
    false,
  );
  const other = await task({ type: "manual" });
  expect(await retireExhaustedScheduledTask(client.db, other.workspaceId, expired.id)).toBe(false);
});

test("repair sees all tenants as a non-bypass owner and queues only truly exhausted tasks", async () => {
  const isolated = await acquireOwnerMigratedTestDatabase("schedule-lifecycle-owner");
  if (!isolated) throw new Error("Real non-bypass owner PostgreSQL is required");
  const owner = postgres(isolated.ownerUrl, { max: 1 });
  const adminClient = createDb(isolated.adminUrl);
  try {
    await migrate(isolated.ownerUrl);
    const exhausted = await task({ type: "once", runAt: ago(25), timeZone: "UTC" }, adminClient.db);
    const expired = await task(
      { type: "interval", everySeconds: 60, endAt: ago(25) },
      adminClient.db,
    );
    const catchup = await task({ type: "once", runAt: ago(1), timeZone: "UTC" }, adminClient.db);
    const held = await task({ type: "interval", everySeconds: 60, endAt: ago(25) }, adminClient.db);
    await run(held, "scheduled", adminClient.db);
    await owner.begin(async (tx) => {
      await tx`drop function opengeni_private.list_exhausted_scheduled_tasks(integer)`;
      await tx`drop function opengeni_private.list_scheduled_task_schedule_reconciliations(integer)`;
      await tx`drop function scheduled_task_is_exhausted(uuid)`;
      await tx`drop policy exhausted_schedule_inventory_read on scheduled_tasks`;
      await tx`drop policy exhausted_schedule_inventory_read on scheduled_task_runs`;
      await tx`drop table scheduled_task_schedule_outbox`;
      await tx.unsafe(
        await readFile(
          new URL("../drizzle/0761_exhausted_scheduled_tasks.sql", import.meta.url),
          "utf8",
        ),
      );
    });
    const rows =
      await isolated.admin`select task_id from scheduled_task_schedule_outbox order by task_id`;
    expect(rows.map((row) => row.task_id).sort()).toEqual([exhausted.id, expired.id].sort());
    expect((await getScheduledTask(adminClient.db, catchup.workspaceId, catchup.id))?.status).toBe(
      "active",
    );
    expect((await getScheduledTask(adminClient.db, held.workspaceId, held.id))?.status).toBe(
      "active",
    );
    const posture =
      await isolated.admin`select relforcerowsecurity from pg_class where relname in ('scheduled_tasks', 'scheduled_task_runs', 'scheduled_task_schedule_outbox')`;
    expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await adminClient.close();
    await owner.end();
    await isolated.release();
  }
}, 180_000);
