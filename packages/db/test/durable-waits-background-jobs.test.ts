import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  DurableIngressEventConflictError,
  advanceAskUserReminder,
  appendBackgroundJobLog,
  applySessionTurnSettlement,
  attachBackgroundJobProvider,
  bootstrapWorkspace,
  claimBackgroundJobStart,
  claimPendingBackgroundJobDispatches,
  claimSessionWorkForAttempt,
  createBackgroundJobAttempt,
  createBackgroundJobForTurn,
  createDb,
  createPassiveDurableWaitForTurn,
  createSession,
  getBackgroundJobLogOffsets,
  ingestDurableEvent,
  initializeSessionStartAtomically,
  insertBackgroundJobArtifact,
  listBackgroundJobArtifacts,
  listBackgroundJobLogs,
  listSessionEvents,
  markBackgroundJobDispatchStarted,
  markSessionWorkflowWakeDelivered,
  resolveAskUserWait,
  resolvePassiveDurableWait,
  saveRunState,
  settleBackgroundJob,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("durable-waits-background-jobs");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function runningFixture(label: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "ope20-test",
    accountExternalId: `${label}-account-${suffix}`,
    accountName: `OPE-20 ${label}`,
    workspaceExternalSource: "ope20-test",
    workspaceExternalId: `${label}-workspace-${suffix}`,
    workspaceName: `OPE-20 ${label}`,
    subjectId: `${label}-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: `start ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const initialized = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (initialized.workflowWakeRevision !== null) {
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      temporalWorkflowId: initialized.temporalWorkflowId,
      wakeRevision: initialized.workflowWakeRevision,
    });
  }
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") {
    throw new Error(`OPE-20 fixture was not claimed: ${claim.reason}`);
  }
  return { grant, workspaceId, session, turn: claim.turn, attemptId };
}

type RunningFixture = Awaited<ReturnType<typeof runningFixture>>;

async function settleTurn(
  ctx: RunningFixture,
  input: { kind: "completed" } | { kind: "requires_action"; approvalId: string },
) {
  const requiresAction = input.kind === "requires_action";
  const result = await applySessionTurnSettlement(client.db, ctx.workspaceId, {
    sessionId: ctx.session.id,
    turnId: ctx.turn.id,
    triggerEventId: ctx.turn.triggerEventId,
    attemptId: ctx.attemptId,
    turnStatus: requiresAction ? "requires_action" : "completed",
    sessionStatus: requiresAction ? "requires_action" : "idle",
    activeTurnId: requiresAction ? ctx.turn.id : null,
    events: requiresAction
      ? [
          {
            type: "session.requiresAction",
            payload: { approvals: [{ id: input.approvalId }] },
          },
          { type: "session.status.changed", payload: { status: "requires_action" } },
        ]
      : [
          { type: "turn.completed", payload: { output: "wait registered" } },
          { type: "session.status.changed", payload: { status: "idle" } },
        ],
  });
  expect(result.action).toBe("settled");
}

async function wakeRevision(workspaceId: string, sessionId: string): Promise<number> {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select({ revision: schema.sessionWorkflowWakeOutbox.wakeRevision })
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, sessionId),
        ),
      )
      .limit(1);
    return Number(row?.revision ?? 0);
  });
}

async function systemUpdates(workspaceId: string, sessionId: string, sourceId: string) {
  return await withWorkspaceRls(client.db, workspaceId, (db) =>
    db
      .select()
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.sourceId, sourceId),
        ),
      ),
  );
}

describe("OPE-20 real PostgreSQL schema", () => {
  test("migration enables FORCE RLS, app grants, and tenant/job-composite attempt keys", async () => {
    const tables = await shared.admin<
      Array<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>
    >`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('opengeni_app', c.oid, 'SELECT') as can_select,
        has_table_privilege('opengeni_app', c.oid, 'INSERT') as can_insert,
        has_table_privilege('opengeni_app', c.oid, 'UPDATE') as can_update,
        has_table_privilege('opengeni_app', c.oid, 'DELETE') as can_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(array[
          'background_jobs', 'background_job_attempts', 'background_job_log_chunks',
          'background_job_dispatches', 'background_job_artifacts', 'durable_waits',
          'durable_wait_events'
        ]::text[])
      order by c.relname
    `;
    expect(tables).toHaveLength(7);
    expect(
      tables.every(
        (table) =>
          table.relrowsecurity &&
          table.relforcerowsecurity &&
          table.can_select &&
          table.can_insert &&
          table.can_update &&
          table.can_delete,
      ),
    ).toBe(true);

    const constraints = await shared.admin<Array<{ conname: string; definition: string }>>`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'background_job_log_chunks_workspace_attempt_fk',
        'background_job_dispatches_workspace_attempt_fk'
      )
      order by conname
    `;
    expect(constraints).toHaveLength(2);
    expect(
      constraints.every((row) => row.definition.includes("workspace_id, job_id, attempt_id")),
    ).toBe(true);
    expect(
      constraints.every((row) =>
        row.definition.includes("background_job_attempts(workspace_id, job_id, id)"),
      ),
    ).toBe(true);

    expect(await client.db.select().from(schema.durableWaits)).toHaveLength(0);
    expect(await client.db.select().from(schema.backgroundJobs)).toHaveLength(0);
  });
});

describe("OPE-20 passive durable waits", () => {
  test("attempt fences, request replay, deadline settlement, and terminal dedupe are atomic", async () => {
    const ctx = await runningFixture("until");
    const wakeAt = new Date(Date.now() - 1_000);
    const request = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      expectedExecutionGeneration: ctx.turn.executionGeneration,
      expectedAttemptId: ctx.attemptId,
      requestKey: "until-build-window",
      kind: "until" as const,
      wakeAt,
      description: "Wait for the build window",
    };
    const created = await createPassiveDurableWaitForTurn(client.db, request);
    expect(created.created).toBe(true);
    expect((await createPassiveDurableWaitForTurn(client.db, request)).created).toBe(false);
    await expect(
      createPassiveDurableWaitForTurn(client.db, {
        ...request,
        wakeAt: new Date(wakeAt.getTime() + 1_000),
      }),
    ).rejects.toThrow("request key was reused");
    await expect(
      createPassiveDurableWaitForTurn(client.db, {
        ...request,
        requestKey: "stale-attempt",
        expectedAttemptId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("signed running turn attempt");

    await settleTurn(ctx, { kind: "completed" });
    const beforeWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    const results = await Promise.all([
      resolvePassiveDurableWait(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: created.wait.id,
        outcome: "time_reached",
        now: new Date(),
      }),
      resolvePassiveDurableWait(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: created.wait.id,
        outcome: "time_reached",
        now: new Date(),
      }),
    ]);
    expect(results.every((result) => result.wait.outcome === "time_reached")).toBe(true);
    expect(await systemUpdates(ctx.workspaceId, ctx.session.id, created.wait.id)).toHaveLength(1);
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeWake + 1);
    await expect(
      resolvePassiveDurableWait(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: created.wait.id,
        outcome: "cancelled",
      }),
    ).rejects.toThrow("terminal outcome conflict");
  });

  test("concurrent authenticated event delivery matches once and changed-content replay conflicts", async () => {
    const ctx = await runningFixture("event");
    const created = await createPassiveDurableWaitForTurn(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      expectedExecutionGeneration: ctx.turn.executionGeneration,
      expectedAttemptId: ctx.attemptId,
      requestKey: "deployment-complete",
      kind: "event",
      eventSourceIdentity: ctx.grant.subjectId,
      eventType: "deployment.completed",
      eventCorrelationKey: "deploy-42",
      eventSubject: "production",
    });
    await settleTurn(ctx, { kind: "completed" });
    const event = {
      version: 1 as const,
      eventId: "provider-event-42",
      type: "deployment.completed",
      subject: "production",
      correlationKey: "deploy-42",
      occurredAt: new Date().toISOString(),
      payload: { result: "healthy" },
    };
    const beforeWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    const results = await Promise.all([
      ingestDurableEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        authenticatedSourceIdentity: ctx.grant.subjectId,
        event,
      }),
      ingestDurableEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        authenticatedSourceIdentity: ctx.grant.subjectId,
        event,
      }),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual(["matched", "replay"]);
    expect(results.every((result) => result.matchedWaitId === created.wait.id)).toBe(true);
    expect(await systemUpdates(ctx.workspaceId, ctx.session.id, created.wait.id)).toHaveLength(1);
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeWake + 1);
    await expect(
      ingestDurableEvent(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        authenticatedSourceIdentity: ctx.grant.subjectId,
        event: { ...event, payload: { result: "changed" } },
      }),
    ).rejects.toBeInstanceOf(DurableIngressEventConflictError);
  });
});

describe("OPE-20 structured ask_user", () => {
  test("reminders are metadata-only and duplicate answers resume once", async () => {
    const ctx = await runningFixture("ask-reminder");
    const approvalId = `approval-${crypto.randomUUID()}`;
    const request = {
      requestKey: "choose-region",
      title: "Choose a region",
      questions: [
        {
          id: "region",
          type: "single_select" as const,
          prompt: "Where should this run?",
          required: true,
          options: [
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
          ],
        },
      ],
      timeoutAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reminderIntervalSeconds: 60,
    };
    expect(
      await saveRunState(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        turnId: ctx.turn.id,
        expectedExecutionGeneration: ctx.turn.executionGeneration,
        expectedAttemptId: ctx.attemptId,
        serializedRunState: "ask-state",
        pendingApprovals: [{ id: approvalId }],
        askUser: { approvalId, request },
      }),
    ).toBe(true);
    await settleTurn(ctx, { kind: "requires_action", approvalId });
    const [wait] = await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
      db
        .select()
        .from(schema.durableWaits)
        .where(eq(schema.durableWaits.approvalId, approvalId))
        .limit(1),
    );
    expect(wait).toBeDefined();

    const beforeReminderWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    const reminded = await advanceAskUserReminder(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      waitId: wait!.id,
      now: new Date(Date.now() + 61_000),
    });
    expect(reminded.action).toBe("reminded");
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeReminderWake);
    expect(
      await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
        db
          .select()
          .from(schema.sessionSystemUpdates)
          .where(eq(schema.sessionSystemUpdates.sourceId, wait!.id)),
      ),
    ).toHaveLength(0);

    const answerInput = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      waitId: wait!.id,
      outcome: "answered" as const,
      answers: [{ questionId: "region", value: "eu" }],
      clientEventId: crypto.randomUUID(),
    };
    const beforeAnswerWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    expect((await resolveAskUserWait(client.db, answerInput)).action).toBe("accepted");
    expect((await resolveAskUserWait(client.db, answerInput)).action).toBe("duplicate");
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeAnswerWake + 1);
  });

  test("answer, cancel, and timeout race to one terminal decision and one wake", async () => {
    const ctx = await runningFixture("ask-race");
    const approvalId = `approval-${crypto.randomUUID()}`;
    const request = {
      requestKey: "confirm-cutover",
      questions: [
        {
          id: "confirmation",
          type: "text" as const,
          prompt: "Type yes to continue",
          required: true,
          minLength: 1,
        },
      ],
      timeoutAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await saveRunState(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      expectedExecutionGeneration: ctx.turn.executionGeneration,
      expectedAttemptId: ctx.attemptId,
      serializedRunState: "ask-race-state",
      pendingApprovals: [{ id: approvalId }],
      askUser: { approvalId, request },
    });
    await settleTurn(ctx, { kind: "requires_action", approvalId });
    const [wait] = await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
      db
        .select({ id: schema.durableWaits.id })
        .from(schema.durableWaits)
        .where(eq(schema.durableWaits.approvalId, approvalId))
        .limit(1),
    );
    const inputs = [
      {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: wait!.id,
        outcome: "answered" as const,
        answers: [{ questionId: "confirmation", value: "yes" }],
        clientEventId: crypto.randomUUID(),
      },
      {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: wait!.id,
        outcome: "cancelled" as const,
        reason: "operator cancelled",
        clientEventId: crypto.randomUUID(),
      },
      {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        waitId: wait!.id,
        outcome: "timed_out" as const,
        now: new Date(),
      },
    ];
    const beforeWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    const results = await Promise.all(inputs.map((input) => resolveAskUserWait(client.db, input)));
    expect(results.filter((result) => result.action === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.action === "conflict")).toHaveLength(2);
    const winner = results.findIndex((result) => result.action === "accepted");
    expect((await resolveAskUserWait(client.db, inputs[winner]!)).action).toBe("duplicate");
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeWake + 1);
    const approvalEvents = (
      await listSessionEvents(client.db, ctx.workspaceId, ctx.session.id)
    ).filter((event) => event.type === "user.approvalDecision");
    expect(approvalEvents).toHaveLength(1);
  });
});

describe("OPE-20 background jobs", () => {
  test("single-start, observer replacement, logs, artifacts, dispatch, and terminal wake are fenced", async () => {
    const ctx = await runningFixture("background");
    const spec = {
      command: "/bin/sh",
      args: ["-lc", "printf done"],
      artifactPaths: ["/tmp/result.json"],
      metadata: { purpose: "real-db-test" },
      timeoutSeconds: 60,
    };
    const createInput = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      expectedExecutionGeneration: ctx.turn.executionGeneration,
      expectedAttemptId: ctx.attemptId,
      provider: "modal" as const,
      spec,
      requestKey: "compile-report",
    };
    const created = await createBackgroundJobForTurn(client.db, createInput);
    expect(created.created).toBe(true);
    expect((await createBackgroundJobForTurn(client.db, createInput)).created).toBe(false);
    await expect(
      createBackgroundJobForTurn(client.db, {
        ...createInput,
        spec: { ...spec, args: ["-lc", "printf changed"] },
      }),
    ).rejects.toThrow("different content");
    await expect(
      createBackgroundJobForTurn(client.db, {
        ...createInput,
        requestKey: "stale-background-attempt",
        expectedAttemptId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("signed running turn attempt");
    await settleTurn(ctx, { kind: "completed" });

    const firstAttempt = await createBackgroundJobAttempt(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      controllerId: "controller-first",
    });
    const secondAttempt = await createBackgroundJobAttempt(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      controllerId: "controller-second",
    });
    const attempts = await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
      db
        .select({
          id: schema.backgroundJobAttempts.id,
          status: schema.backgroundJobAttempts.status,
        })
        .from(schema.backgroundJobAttempts)
        .where(eq(schema.backgroundJobAttempts.jobId, created.job.id)),
    );
    expect(attempts.find((attempt) => attempt.id === firstAttempt.id)?.status).toBe("lost");
    expect(attempts.find((attempt) => attempt.id === secondAttempt.id)?.status).toBe("observing");

    expect((await claimBackgroundJobStart(client.db, ctx.workspaceId, created.job.id)).action).toBe(
      "start",
    );
    expect(
      await attachBackgroundJobProvider(client.db, {
        workspaceId: ctx.workspaceId,
        jobId: created.job.id,
        attemptId: firstAttempt.id,
        providerRef: "modal:sandbox:box-1",
        providerInstanceId: "box-1",
        startedAt: new Date(),
      }),
    ).toBeNull();
    const attached = await attachBackgroundJobProvider(client.db, {
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      attemptId: secondAttempt.id,
      providerRef: "modal:sandbox:box-1",
      providerInstanceId: "box-1",
      startedAt: new Date(),
    });
    expect(attached?.status).toBe("running");
    expect((await claimBackgroundJobStart(client.db, ctx.workspaceId, created.job.id)).action).toBe(
      "reattach",
    );

    await expect(
      appendBackgroundJobLog(client.db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.workspaceId,
        jobId: created.job.id,
        attemptId: firstAttempt.id,
        providerOffset: 0,
        stream: "stdout",
        text: "stale",
      }),
    ).rejects.toThrow("no longer active");
    const fullText = "🙂".repeat(20_000);
    const logInput = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      attemptId: secondAttempt.id,
      providerOffset: 0,
      stream: "stdout" as const,
      text: fullText,
    };
    const log = await appendBackgroundJobLog(client.db, logInput);
    expect((await appendBackgroundJobLog(client.db, logInput)).sequence).toBe(log.sequence);
    await expect(
      appendBackgroundJobLog(client.db, { ...logInput, text: `${fullText}changed` }),
    ).rejects.toThrow("different content");
    const persistedLogs = await listBackgroundJobLogs(client.db, ctx.workspaceId, created.job.id);
    expect(new TextEncoder().encode(persistedLogs[0]!.text).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(
      (await getBackgroundJobLogOffsets(client.db, ctx.workspaceId, created.job.id)).stdout,
    ).toBe(new TextEncoder().encode(fullText).byteLength);

    const artifactInput = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      path: "/tmp/result.json",
      filename: "result.json",
      contentType: "application/json",
      sizeBytes: 11,
      sha256: "a".repeat(64),
      storageKey: `background-jobs/${ctx.workspaceId}/${created.job.id}/result.json`,
    };
    const artifact = await insertBackgroundJobArtifact(client.db, artifactInput);
    expect((await insertBackgroundJobArtifact(client.db, artifactInput)).id).toBe(artifact.id);
    await expect(
      insertBackgroundJobArtifact(client.db, { ...artifactInput, sha256: "b".repeat(64) }),
    ).rejects.toThrow("different content");
    expect(
      await listBackgroundJobArtifacts(client.db, ctx.workspaceId, created.job.id),
    ).toHaveLength(1);

    const dispatches = await claimPendingBackgroundJobDispatches(client.db, 100);
    const dispatch = dispatches.find((candidate) => candidate.jobId === created.job.id);
    expect(dispatch).toBeDefined();
    await markBackgroundJobDispatchStarted(client.db, dispatch!);
    const [dispatchRow] = await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
      db
        .select({ status: schema.backgroundJobDispatches.status })
        .from(schema.backgroundJobDispatches)
        .where(eq(schema.backgroundJobDispatches.jobId, created.job.id))
        .limit(1),
    );
    expect(dispatchRow?.status).toBe("started");

    const beforeWake = await wakeRevision(ctx.workspaceId, ctx.session.id);
    const terminalInput = {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.workspaceId,
      jobId: created.job.id,
      attemptId: secondAttempt.id,
      status: "completed" as const,
      exitCode: 0,
    };
    const terminals = await Promise.all([
      settleBackgroundJob(client.db, terminalInput),
      settleBackgroundJob(client.db, terminalInput),
    ]);
    expect(terminals.every((result) => result.job.status === "completed")).toBe(true);
    expect(await systemUpdates(ctx.workspaceId, ctx.session.id, created.job.id)).toHaveLength(1);
    expect(await wakeRevision(ctx.workspaceId, ctx.session.id)).toBe(beforeWake + 1);
    const [settledAttempt] = await withWorkspaceRls(client.db, ctx.workspaceId, (db) =>
      db
        .select({ status: schema.backgroundJobAttempts.status })
        .from(schema.backgroundJobAttempts)
        .where(eq(schema.backgroundJobAttempts.id, secondAttempt.id))
        .limit(1),
    );
    expect(settledAttempt?.status).toBe("completed");
  });

  test("composite attempt references reject cross-workspace and cross-job attachment", async () => {
    const first = await runningFixture("attempt-fk-a");
    const second = await runningFixture("attempt-fk-b");
    const spec = {
      command: "/bin/true",
      args: [],
      artifactPaths: [],
      metadata: {},
      timeoutSeconds: 30,
    };
    const firstJob = await createBackgroundJobForTurn(client.db, {
      accountId: first.grant.accountId,
      workspaceId: first.workspaceId,
      sessionId: first.session.id,
      turnId: first.turn.id,
      expectedExecutionGeneration: first.turn.executionGeneration,
      expectedAttemptId: first.attemptId,
      provider: "modal",
      spec,
      requestKey: "first-job",
    });
    const secondJob = await createBackgroundJobForTurn(client.db, {
      accountId: second.grant.accountId,
      workspaceId: second.workspaceId,
      sessionId: second.session.id,
      turnId: second.turn.id,
      expectedExecutionGeneration: second.turn.executionGeneration,
      expectedAttemptId: second.attemptId,
      provider: "modal",
      spec,
      requestKey: "second-job",
    });
    const foreignAttempt = await createBackgroundJobAttempt(client.db, {
      accountId: second.grant.accountId,
      workspaceId: second.workspaceId,
      jobId: secondJob.job.id,
    });

    let logConstraint: string | undefined;
    try {
      await shared.admin`
        insert into background_job_log_chunks (
          account_id, workspace_id, job_id, attempt_id, sequence,
          provider_offset, provider_length, stream, text, content_hash
        ) values (
          ${first.grant.accountId}, ${first.workspaceId}, ${firstJob.job.id},
          ${foreignAttempt.id}, 1, 0, 1, 'stdout', 'x', ${"c".repeat(64)}
        )
      `;
    } catch (error) {
      logConstraint = (error as { constraint_name?: string }).constraint_name;
    }
    expect(logConstraint).toBe("background_job_log_chunks_workspace_attempt_fk");

    let dispatchConstraint: string | undefined;
    try {
      await shared.admin`
        update background_job_dispatches
        set attempt_id = ${foreignAttempt.id}
        where workspace_id = ${first.workspaceId} and job_id = ${firstJob.job.id}
      `;
    } catch (error) {
      dispatchConstraint = (error as { constraint_name?: string }).constraint_name;
    }
    expect(dispatchConstraint).toBe("background_job_dispatches_workspace_attempt_fk");
  });
});
