import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import * as db from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof db.createDb>;
beforeAll(async () => {
  // Fail before database setup on the unfixed tree: the refused occurrence
  // currently has no durable recording seam at all.
  expect(db.recordScheduledTaskAdmissionFailure).toBeFunction();
  const acquired = await acquireSharedTestDatabase("scheduled-admission-diagnostic");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = db.createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("blocked admission is a durable terminal occurrence, not accepted execution", async () => {
  const suffix = crypto.randomUUID();
  const access = await db.bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-diagnostic-test",
    accountExternalId: suffix,
    accountName: "Diagnostic test",
    workspaceExternalSource: "scheduled-diagnostic-test",
    workspaceExternalId: suffix,
    workspaceName: "Diagnostic test",
    subjectId: `user:${suffix}`,
    subjectLabel: "Owner",
  });
  const grant = access.workspaceGrants[0]!;
  const task = await db.createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: "Synthetic scheduled task",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: suffix,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Synthetic task", tools: [], resources: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const diagnostic = {
    version: 1 as const,
    reason: "selected_account_unavailable" as const,
    accounts: [
      {
        serverId: "example",
        connectionId: crypto.randomUUID(),
        reason: "account_inactive" as const,
      },
    ],
  };
  const input = {
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled" as const,
    producerKey: `scheduled:${suffix}`,
    diagnostic,
  };
  const first = await db.recordScheduledTaskAdmissionFailure(client.db, input);
  expect(first.status).toBe("failed");
  expect(first.error).toBe("connection_account_unavailable");
  expect(first.admissionDiagnostic).toEqual(diagnostic);
  expect(first.sessionId).toBeNull();
  expect(first.completedAt).not.toBeNull();
  expect(
    await db.getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: task.workspaceId,
      runId: first.id,
    }),
  ).toBeNull();
  const replay = await db.recordScheduledTaskAdmissionFailure(client.db, {
    ...input,
    diagnostic: { version: 1, reason: "selection_unavailable", accounts: [] },
  });
  expect(replay).toEqual(first);
  const history = await db.listScheduledTaskRuns(client.db, task.workspaceId, task.id, 10);
  expect(history).toHaveLength(1);
  expect(history[0]?.admissionDiagnostic).toEqual(diagnostic);
  const concurrent = await Promise.all(
    Array.from({ length: 3 }, () => db.recordScheduledTaskAdmissionFailure(client.db, input)),
  );
  expect(concurrent.every((receipt) => receipt.id === first.id)).toBe(true);
  // Even the owner connection cannot promote or rewrite diagnostic evidence.
  await expect(
    (async () =>
      await shared.admin`update scheduled_task_runs set status = 'queued' where id = ${first.id}`)(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await shared.admin`update scheduled_task_runs set admission_diagnostic = null where id = ${first.id}`)(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await shared.admin`update scheduled_task_runs set accepted_execution_snapshot = '{}'::jsonb where id = ${first.id}`)(),
  ).rejects.toThrow();
  await expect(
    db.recordScheduledTaskAdmissionFailure(client.db, {
      ...input,
      workspaceId: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  await expect(
    db.recordScheduledTaskAdmissionFailure(client.db, {
      ...input,
      producerKey: `${input.producerKey}:stale`,
      taskAuthorityRevision: input.taskAuthorityRevision + 1,
    }),
  ).rejects.toThrow();
  await expect(
    db.recordScheduledTaskAdmissionFailure(client.db, {
      ...input,
      producerKey: `${input.producerKey}:secret`,
      diagnostic: { ...diagnostic, token: "synthetic-secret" } as typeof diagnostic,
    }),
  ).rejects.toThrow();
  expect(await db.listScheduledTaskRuns(client.db, task.workspaceId, task.id, 10)).toHaveLength(1);
  await db.updateScheduledTask(client.db, task.workspaceId, task.id, { status: "paused" });
  expect(await db.recordScheduledTaskAdmissionFailure(client.db, input)).toEqual(first);
  await expect(
    db.recordScheduledTaskAdmissionFailure(client.db, {
      ...input,
      producerKey: `${input.producerKey}:paused`,
    }),
  ).rejects.toThrow();
});

test("an authority refusal is the same terminal receipt with only the owner diagnostic", async () => {
  const suffix = crypto.randomUUID();
  const access = await db.bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-diagnostic-test",
    accountExternalId: `authority-${suffix}`,
    accountName: "Authority refusal test",
    workspaceExternalSource: "scheduled-diagnostic-test",
    workspaceExternalId: `authority-${suffix}`,
    workspaceName: "Authority refusal test",
    subjectId: `user:${suffix}`,
    subjectLabel: "Owner",
  });
  const grant = access.workspaceGrants[0]!;
  const task = await db.createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: "Synthetic authority task",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `authority-${suffix}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Synthetic task", tools: [], resources: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const input = {
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled" as const,
    producerKey: `scheduled-authority:${suffix}`,
    error: "scheduled_authority_unavailable" as const,
    diagnostic: db.SCHEDULED_AUTHORITY_REFUSAL_DIAGNOSTIC,
  };
  const refused = await db.recordScheduledTaskAdmissionFailure(client.db, input);
  expect(refused).toMatchObject({
    status: "failed",
    error: "scheduled_authority_unavailable",
    sessionId: null,
    admissionDiagnostic: { version: 1, reason: "owner_access_unavailable", accounts: [] },
  });
  expect(refused.completedAt).not.toBeNull();
  expect(await db.recordScheduledTaskAdmissionFailure(client.db, input)).toEqual(refused);
  // The application seam refuses an authority receipt that names accounts.
  await expect(
    db.recordScheduledTaskAdmissionFailure(client.db, {
      ...input,
      producerKey: `${input.producerKey}:accounts`,
      diagnostic: {
        version: 1,
        reason: "owner_access_unavailable",
        accounts: [{ serverId: "mail", connectionId: null, reason: "account_not_visible" }],
      },
    }),
  ).rejects.toThrow();
  // So does the database guard, independently of the application seam.
  for (const [error, diagnostic] of [
    [
      "scheduled_authority_unavailable",
      { version: 1, reason: "selected_account_unavailable", accounts: [] },
    ],
    [
      "scheduled_authority_unavailable",
      {
        version: 1,
        reason: "owner_access_unavailable",
        accounts: [{ serverId: "mail", connectionId: null, reason: "account_not_visible" }],
      },
    ],
    ["scheduled_run_terminal", { version: 1, reason: "owner_access_unavailable", accounts: [] }],
  ] as const) {
    await expect(
      (async () =>
        await shared.admin.begin(async (tx) => {
          await tx`insert into scheduled_task_runs (account_id, workspace_id, task_id,
            task_authority_revision, task_execution_digest, trigger_type, producer_key,
            fired_at, completed_at, action_kind, status, error, admission_diagnostic)
            values (${task.accountId}, ${task.workspaceId}, ${task.id},
              ${task.authorityRevision}, ${task.executionDigest}, 'scheduled',
              ${`${input.producerKey}:${crypto.randomUUID()}`}, now(), now(),
              'agent_turn', 'failed', ${error}, ${tx.json(diagnostic)})`;
        }))(),
    ).rejects.toThrow("invalid scheduled admission diagnostic");
  }
  expect(await db.listScheduledTaskRuns(client.db, task.workspaceId, task.id, 10)).toHaveLength(1);
});
