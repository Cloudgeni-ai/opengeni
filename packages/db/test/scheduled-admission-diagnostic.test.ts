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

test("an admission refusal is a terminal or skipped receipt, never accepted execution", async () => {
  const suffix = crypto.randomUUID();
  const access = await db.bootstrapWorkspace(client.db, {
    accountExternalSource: "scheduled-diagnostic-test",
    accountExternalId: `refusal-${suffix}`,
    accountName: "Admission refusal test",
    workspaceExternalSource: "scheduled-diagnostic-test",
    workspaceExternalId: `refusal-${suffix}`,
    workspaceName: "Admission refusal test",
    subjectId: `user:${suffix}`,
    subjectLabel: "Owner",
  });
  const grant = access.workspaceGrants[0]!;
  const task = await db.createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: "Synthetic refusal task",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `refusal-${suffix}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Synthetic task", tools: [], resources: [], metadata: {} },
    createdBy: { kind: "service", subjectId: "scheduler" },
    metadata: {},
  });
  const base = {
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled" as const,
  };
  const terminal = await db.recordScheduledTaskAdmissionRefusal(client.db, {
    ...base,
    producerKey: `refusal-terminal:${suffix}`,
    reason: "rig_version_unavailable",
    retryable: false,
  });
  expect(terminal).toMatchObject({
    status: "failed",
    error: "rig_version_unavailable",
    sessionId: null,
    admissionDiagnostic: null,
    admissionRefusal: { version: 1, reason: "rig_version_unavailable", retryable: false },
  });
  expect(terminal.completedAt).not.toBeNull();
  const transient = await db.recordScheduledTaskAdmissionRefusal(client.db, {
    ...base,
    producerKey: `refusal-transient:${suffix}`,
    reason: "insufficient_credits",
    retryable: true,
  });
  expect(transient).toMatchObject({
    status: "skipped",
    error: "insufficient_credits",
    admissionRefusal: { version: 1, reason: "insufficient_credits", retryable: true },
  });
  expect(
    await db.getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: task.workspaceId,
      runId: transient.id,
    }),
  ).toBeNull();
  // The same producer replays its receipt; it never becomes a second run.
  expect(
    await db.recordScheduledTaskAdmissionRefusal(client.db, {
      ...base,
      producerKey: `refusal-terminal:${suffix}`,
      reason: "insufficient_credits",
      retryable: true,
    }),
  ).toEqual(terminal);
  // The database guard rejects shapes the seam never writes, and immutability holds.
  for (const [status, error, refusal] of [
    [
      "failed",
      "insufficient_credits",
      { version: 1, reason: "insufficient_credits", retryable: true },
    ],
    ["skipped", "not_a_reason", { version: 1, reason: "not_a_reason", retryable: true }],
    [
      "failed",
      "rig_version_unavailable",
      { version: 1, reason: "variable_set_unavailable", retryable: false },
    ],
    [
      "failed",
      "rig_version_unavailable",
      { version: 1, reason: "rig_version_unavailable", retryable: false, detail: "x" },
    ],
  ] as const) {
    await expect(
      (async () =>
        await shared.admin`insert into scheduled_task_runs (account_id, workspace_id, task_id,
          task_authority_revision, task_execution_digest, trigger_type, producer_key,
          fired_at, completed_at, action_kind, status, error, admission_refusal)
          values (${task.accountId}, ${task.workspaceId}, ${task.id},
            ${task.authorityRevision}, ${task.executionDigest}, 'scheduled',
            ${`refusal-invalid:${crypto.randomUUID()}`}, now(), now(),
            'agent_turn', ${status}, ${error}, ${shared.admin.json(refusal)})`)(),
    ).rejects.toThrow("invalid scheduled admission refusal");
  }
  await expect(
    (async () =>
      await shared.admin`update scheduled_task_runs set status = 'queued' where id = ${transient.id}`)(),
  ).rejects.toThrow();
  expect(await db.listScheduledTaskRuns(client.db, task.workspaceId, task.id, 10)).toHaveLength(2);
});
