import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimPendingSessionWorkflowWakes,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  listSessionTurns,
  markSessionWorkflowWakeDelivered,
  markSessionWorkflowWakeFailed,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  replaySessionStartByCreateIdempotencyKey,
  recordUsageEvent,
  ScheduledTaskRunProducerConflictError,
  setSessionGoalStatus,
  submitHumanPromptInTransaction,
  updateSessionMcpServerCredentials,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type InitializeSessionStartInput,
  type ReplaySessionStartInput,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-workflow-wake-outbox");
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
    accountExternalSource: "wake-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Wake outbox test",
    workspaceExternalSource: "wake-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Wake outbox test",
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
    sandboxBackend: "none",
  });
  return { grant, session };
}

type WakeFixture = Awaited<ReturnType<typeof fixture>>;

async function workspaceFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "wake-test",
    accountExternalId: `canonical-account-${suffix}`,
    accountName: "Canonical wake test",
    workspaceExternalSource: "wake-test",
    workspaceExternalId: `canonical-workspace-${suffix}`,
    workspaceName: "Canonical wake test",
    subjectId: `canonical-subject-${suffix}`,
  });
  return { grant: access.workspaceGrants[0]! };
}

function canonicalInput(
  grant: WakeFixture["grant"],
  options: {
    sessionId?: string;
    idempotencyKey?: string;
    fingerprint?: string;
    goal?: { text: string } | null;
    session?: Partial<InitializeSessionStartInput["session"]>;
    createdEventPayload?: Record<string, unknown>;
    usage?: Partial<InitializeSessionStartInput["usage"]>;
    failpoint?: InitializeSessionStartInput["failpoint"];
  } = {},
): InitializeSessionStartInput {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId,
    createIdempotencyKey: options.idempotencyKey ?? `create:${crypto.randomUUID()}`,
    createRequestFingerprint: options.fingerprint ?? `v1:${"a".repeat(64)}`,
    session: {
      initialMessage: "initial",
      resources: [],
      tools: [],
      metadata: { model: "scripted-model", reasoningEffort: "low" },
      model: "scripted-model",
      sandboxBackend: "none",
      sandboxOs: "linux",
      ...options.session,
    },
    createdEventPayload: options.createdEventPayload ?? {},
    goal: options.goal ?? null,
    admission: {
      kind: "user",
      clientEventId: `initial:${sessionId}`,
      reasoningEffort: "low",
    },
    usage: {
      subjectId: grant.subjectId,
      sourceResourceType: "session",
      ...options.usage,
    },
    ...(options.failpoint ? { failpoint: options.failpoint } : {}),
  };
}

function replayInput(input: InitializeSessionStartInput): ReplaySessionStartInput {
  if (!input.createIdempotencyKey) {
    throw new Error("test replay input requires a create idempotency key");
  }
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createIdempotencyKey: input.createIdempotencyKey,
    createRequestFingerprint: input.createRequestFingerprint,
    admission:
      input.admission.kind === "user"
        ? { kind: "user" }
        : { kind: "scheduled", runId: input.admission.runId },
    usage: {
      ...(input.usage.idempotencyKey ? { idempotencyKey: input.usage.idempotencyKey } : {}),
      sourceResourceType: input.usage.sourceResourceType,
      ...(input.usage.sourceResourceId ? { sourceResourceId: input.usage.sourceResourceId } : {}),
    },
  };
}

async function scheduledFixture(grant: WakeFixture["grant"]) {
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    name: `canonical-scheduled-${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "interval", everySeconds: 3600 },
    temporalScheduleId: `canonical-scheduled-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "scheduled initial", resources: [], tools: [], metadata: {} },
    metadata: {},
  });
  const run = await createScheduledTaskRun(client.db, {
    workspaceId: grant.workspaceId!,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `producer:${crypto.randomUUID()}`,
  });
  return { task, run };
}

function scheduledInput(
  grant: WakeFixture["grant"],
  task: Awaited<ReturnType<typeof scheduledFixture>>["task"],
  run: Awaited<ReturnType<typeof scheduledFixture>>["run"],
  options: {
    sessionId?: string;
    fingerprint?: string;
    usageIdempotencyKey?: string;
    goal?: { text: string } | null;
    setReusableSession?: boolean;
    failpoint?: InitializeSessionStartInput["failpoint"];
  } = {},
): InitializeSessionStartInput {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const usageIdempotencyKey =
    options.usageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId,
    createIdempotencyKey: `scheduled-run:${run.id}`,
    createRequestFingerprint: options.fingerprint ?? `v1:${"c".repeat(64)}`,
    session: {
      initialMessage: "scheduled initial",
      resources: [],
      tools: [],
      metadata: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
      model: "scripted-model",
      sandboxBackend: "none",
      sandboxOs: "linux",
    },
    createdEventPayload: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
    goal: options.goal ?? null,
    admission: {
      kind: "scheduled",
      taskId: task.id,
      runId: run.id,
      summary: "scheduled initial",
      payload: {
        type: "scheduled_occurrence",
        text: "scheduled initial",
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
      },
      lineage: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
      setReusableSession: options.setReusableSession ?? false,
    },
    usage: {
      subjectId: grant.subjectId,
      idempotencyKey: usageIdempotencyKey,
      sourceResourceType: "scheduled_task_run",
      sourceResourceId: run.id,
    },
    ...(options.failpoint ? { failpoint: options.failpoint } : {}),
  };
}

async function send(wakeFixture: WakeFixture, text: string, clientEventId = crypto.randomUUID()) {
  return await withWorkspaceSubjectRls(
    client.db,
    wakeFixture.grant.workspaceId!,
    wakeFixture.grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
          accountId: wakeFixture.grant.accountId,
          workspaceId: wakeFixture.grant.workspaceId!,
          sessionId: wakeFixture.session.id,
          subjectId: wakeFixture.grant.subjectId,
          actor: { type: "human", subjectId: wakeFixture.grant.subjectId },
          operationKey: clientEventId,
          delivery: "send",
          text,
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
}

async function pauseWorkspace(ctx: WakeFixture) {
  return await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
    db.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as typeof db, {
        accountId: ctx.grant.accountId,
        workspaceId: ctx.grant.workspaceId!,
        actor: { type: "human", subjectId: ctx.grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "pause",
        reason: "test",
      }),
    ),
  );
}

async function wakeRow(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select()
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

async function runInitializerInKilledProcess(
  input: InitializeSessionStartInput,
  mode: "before_commit" | "after_commit",
): Promise<number> {
  const script = `
    import { createDb, initializeSessionStartAtomically } from "./packages/db/src/index.ts";
    const client = createDb(process.env.OPE51_TEST_DATABASE_URL);
    const input = JSON.parse(process.env.OPE51_TEST_INITIALIZER_INPUT);
    if (process.env.OPE51_TEST_KILL_MODE === "before_commit") {
      input.failpoint = (stage) => {
        if (stage === "after_wake") process.exit(91);
      };
    }
    await initializeSessionStartAtomically(client.db, input);
    process.exit(process.env.OPE51_TEST_KILL_MODE === "after_commit" ? 92 : 90);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPE51_TEST_DATABASE_URL: shared.appUrl,
      OPE51_TEST_INITIALIZER_INPUT: JSON.stringify(input),
      OPE51_TEST_KILL_MODE: mode,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return await child.exited;
}

describe("transactional session workflow wake outbox", () => {
  test("initial session state, usage, first turn, and one stored wake commit once under concurrent identical retries", async () => {
    const ctx = await workspaceFixture();
    const idempotencyKey = `create:${crypto.randomUUID()}`;
    const initialize = () =>
      initializeSessionStartAtomically(
        client.db,
        canonicalInput(ctx.grant, {
          sessionId: crypto.randomUUID(),
          idempotencyKey,
          goal: { text: "Finish exactly once" },
        }),
      );
    const results = await Promise.all([initialize(), initialize()]);
    expect(results[0]!.session.id).toBe(results[1]!.session.id);
    expect(results.map((result) => result.turn?.id).filter(Boolean)).toEqual([
      results[0]!.turn!.id,
      results[0]!.turn!.id,
    ]);
    expect(results.flatMap((result) => result.events)).toHaveLength(5);
    expect(results.map((result) => result.workflowWakeRevision)).toEqual([1, 1]);

    const events = await listSessionEvents(
      client.db,
      ctx.grant.workspaceId!,
      results[0]!.session.id,
      0,
      20,
    );
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(
      await listSessionTurns(client.db, ctx.grant.workspaceId!, results[0]!.session.id),
    ).toHaveLength(1);
    expect(await wakeRow(ctx.grant.workspaceId!, results[0]!.session.id)).toMatchObject({
      wakeRevision: 1,
      deliveredRevision: 0,
    });
  });

  test("canonical version-1 receipt fences the complete initial state and exactly one usage charge", async () => {
    const { grant } = await workspaceFixture();
    const input = canonicalInput(grant, { goal: { text: "receipt goal" } });
    const initialized = await initializeSessionStartAtomically(client.db, input);

    const receipt = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, initialized.session.id))
        .limit(1);
      const usage = await db
        .select()
        .from(schema.usageEvents)
        .where(
          eq(
            schema.usageEvents.idempotencyKey,
            `agent_run.created:${grant.workspaceId!}:${initialized.session.id}`,
          ),
        );
      const goals = await db
        .select()
        .from(schema.sessionGoals)
        .where(eq(schema.sessionGoals.sessionId, initialized.session.id));
      return { session, usage, goals };
    });

    expect(receipt.session).toMatchObject({
      createIdempotencyKey: input.createIdempotencyKey,
      createRequestFingerprint: input.createRequestFingerprint,
      initializationVersion: 1,
      temporalWorkflowId: `session-${initialized.session.id}`,
      initialWorkflowWakeRevision: 1,
      status: "queued",
      lastSequence: 5,
      queueVersion: 1,
      queueTailPosition: 1,
    });
    expect(receipt.usage).toHaveLength(1);
    expect(receipt.usage[0]).toMatchObject({
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session",
      sourceResourceId: initialized.session.id,
    });
    expect(receipt.goals).toHaveLength(1);
    expect(receipt.goals[0]).toMatchObject({
      text: "receipt goal",
      status: "active",
      autoContinuations: 0,
      noProgressStreak: 0,
    });
  });

  test("response-loss replay returns the stored first admission after mutable state advances", async () => {
    const { grant } = await workspaceFixture();
    const input = canonicalInput(grant, {
      createdEventPayload: {
        mcpServers: [
          {
            id: "private-crm",
            name: "Private CRM",
            url: "https://crm.example/mcp",
            headerNames: ["Authorization"],
            credentialVersion: 1,
          },
        ],
      },
      session: {
        mcpServers: [
          {
            id: "private-crm",
            name: "Private CRM",
            url: "https://crm.example/mcp",
            headersEncrypted: { Authorization: "ciphertext-v1" },
          },
        ],
      },
    });
    const initialized = await initializeSessionStartAtomically(client.db, input);
    await updateSessionMcpServerCredentials(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: initialized.session.id,
      updates: [{ id: "private-crm", headersEncrypted: { Authorization: "ciphertext-v2" } }],
    });
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: initialized.session.id,
      temporalWorkflowId: initialized.temporalWorkflowId,
      wakeRevision: initialized.workflowWakeRevision!,
    });
    await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: initialized.session.id,
      workflowId: initialized.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    const second = await send({ grant, session: initialized.session }, "later prompt");

    const replayed = await replaySessionStartByCreateIdempotencyKey(client.db, replayInput(input));

    expect(replayed).toMatchObject({
      created: false,
      temporalWorkflowId: initialized.temporalWorkflowId,
      workflowWakeRevision: initialized.workflowWakeRevision,
      triggerEventId: initialized.triggerEventId,
    });
    expect(replayed?.session.id).toBe(initialized.session.id);
    expect(replayed?.turn?.id).toBe(initialized.turn?.id);
    expect(replayed?.events).toEqual([]);
    expect(replayed?.session.mcpServers).toEqual([
      {
        id: "private-crm",
        name: "Private CRM",
        url: "https://crm.example/mcp",
        headerNames: ["Authorization"],
        credentialVersion: 2,
      },
    ]);
    expect(second.wakeRevision).toBe(2);
    expect(await wakeRow(grant.workspaceId!, initialized.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 1,
    });
  });

  test("legacy version-0 keyed rows fail closed instead of fabricating initialization", async () => {
    const { grant } = await workspaceFixture();
    const sessionId = crypto.randomUUID();
    const input = canonicalInput(grant, {
      sessionId,
      idempotencyKey: `legacy:${crypto.randomUUID()}`,
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessions).values({
        id: sessionId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "legacy partial",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        sandboxOs: "linux",
        sandboxGroupId: sessionId,
        createIdempotencyKey: input.createIdempotencyKey,
        createRequestFingerprint: input.createRequestFingerprint,
        initializationVersion: 0,
        temporalWorkflowId: `session-${sessionId}`,
        status: "queued",
      });
    });

    await expect(
      replaySessionStartByCreateIdempotencyKey(client.db, replayInput(input)),
    ).rejects.toMatchObject({ code: "session_initialization_invariant" });
    expect(await listSessionEvents(client.db, grant.workspaceId!, sessionId, 0, 10)).toEqual([]);
    expect(await listSessionTurns(client.db, grant.workspaceId!, sessionId)).toEqual([]);
    expect(await wakeRow(grant.workspaceId!, sessionId)).toBeNull();
  });

  test("a malformed version-1 receipt fails closed and is never blessed on retry", async () => {
    const { grant } = await workspaceFixture();
    const input = canonicalInput(grant);
    const initialized = await initializeSessionStartAtomically(client.db, input);
    await shared.admin`
      delete from session_events
      where workspace_id = ${grant.workspaceId!}
        and session_id = ${initialized.session.id}
        and sequence = 2
    `;

    await expect(
      replaySessionStartByCreateIdempotencyKey(client.db, replayInput(input)),
    ).rejects.toMatchObject({ code: "session_initialization_invariant" });
    const [stored] = await shared.admin`
      select initialization_version
      from sessions
      where id = ${initialized.session.id}
    `;
    expect(stored?.initialization_version).toBe(1);
  });

  test("hard process death before commit rolls back; death after commit is replayable", async () => {
    const { grant } = await workspaceFixture();
    const before = canonicalInput(grant, {
      sessionId: crypto.randomUUID(),
      idempotencyKey: `process-before:${crypto.randomUUID()}`,
    });
    expect(await runInitializerInKilledProcess(before, "before_commit")).toBe(91);
    expect(
      await replaySessionStartByCreateIdempotencyKey(client.db, replayInput(before)),
    ).toBeNull();

    const after = canonicalInput(grant, {
      sessionId: crypto.randomUUID(),
      idempotencyKey: `process-after:${crypto.randomUUID()}`,
    });
    expect(await runInitializerInKilledProcess(after, "after_commit")).toBe(92);
    const replayed = await replaySessionStartByCreateIdempotencyKey(client.db, replayInput(after));
    expect(replayed).toMatchObject({
      created: false,
      temporalWorkflowId: `session-${after.sessionId}`,
      workflowWakeRevision: 1,
    });
    expect(replayed?.session.id).toBe(after.sessionId);
    expect(await listSessionTurns(client.db, grant.workspaceId!, after.sessionId)).toHaveLength(1);
  });

  test("initial session remains durably queued without a wake while its workspace is paused", async () => {
    const { grant } = await workspaceFixture();
    const suffix = crypto.randomUUID();
    await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `pause:${suffix}`,
          action: "pause",
          reason: "test",
        }),
      ),
    );
    const result = await initializeSessionStartAtomically(client.db, canonicalInput(grant));

    expect(result.workflowWakeRevision).toBeNull();
    expect(result.turn?.status).toBe("queued");
    expect(result.events.find((event) => event.type === "session.created")?.payload).toMatchObject({
      status: "queued",
    });
    expect(
      result.events.find((event) => event.type === "session.status.changed")?.payload,
    ).toMatchObject({ status: "queued" });
    expect(await wakeRow(grant.workspaceId!, result.session.id)).toBeNull();
  });

  test("resuming a goal behind a closed workspace gate remains durable and does not manufacture a wake", async () => {
    const { grant } = await workspaceFixture();
    const started = await initializeSessionStartAtomically(
      client.db,
      canonicalInput(grant, { goal: { text: "Resume only when admitted" } }),
    );
    const ctx = { grant, session: started.session };
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: started.temporalWorkflowId,
      wakeRevision: started.workflowWakeRevision!,
    });
    await setSessionGoalStatus(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "paused",
      rationale: "test hold",
    });
    await pauseWorkspace(ctx);
    const afterPause = await wakeRow(ctx.grant.workspaceId!, ctx.session.id);

    const resumed = await setSessionGoalStatus(client.db, ctx.grant.workspaceId!, ctx.session.id, {
      status: "active",
    });

    expect(resumed.changed).toBe(true);
    expect(resumed.workflowWakeRevision).toBeNull();
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: afterPause!.wakeRevision,
      deliveredRevision: afterPause!.deliveredRevision,
    });
  });

  test("every former initialization boundary rolls back the entire session", async () => {
    const { grant } = await workspaceFixture();
    const stages = [
      "after_session_insert",
      "after_reference_state",
      "after_goal",
      "after_canonical_events",
      "after_admission",
      "after_queue_state",
      "after_usage_and_source",
      "after_wake",
      "before_commit",
    ] as const;
    for (const stage of stages) {
      const sessionId = crypto.randomUUID();
      await expect(
        initializeSessionStartAtomically(
          client.db,
          canonicalInput(grant, {
            sessionId,
            idempotencyKey: `fail:${stage}:${crypto.randomUUID()}`,
            goal: { text: "rollback with all optional state" },
            failpoint: (seen) => {
              if (seen === stage) throw new Error(`failpoint:${stage}`);
            },
          }),
        ),
      ).rejects.toThrow(`failpoint:${stage}`);
      const exists = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
        const [row] = await db
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, sessionId))
          .limit(1);
        return row ?? null;
      });
      expect(exists).toBeNull();
    }
  });

  test("same key with different fingerprints conflicts and cannot alter the committed session", async () => {
    const { grant } = await workspaceFixture();
    const idempotencyKey = `conflict:${crypto.randomUUID()}`;
    const first = await initializeSessionStartAtomically(
      client.db,
      canonicalInput(grant, { idempotencyKey, fingerprint: `v1:${"a".repeat(64)}` }),
    );
    await expect(
      initializeSessionStartAtomically(
        client.db,
        canonicalInput(grant, {
          idempotencyKey,
          fingerprint: `v1:${"b".repeat(64)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "session_create_idempotency_conflict" });
    expect(await listSessionTurns(client.db, grant.workspaceId!, first.session.id)).toHaveLength(1);
    expect(await wakeRow(grant.workspaceId!, first.session.id)).toMatchObject({ wakeRevision: 1 });
  });

  test("concurrent conflicting creates commit one complete winner and one typed conflict", async () => {
    const { grant } = await workspaceFixture();
    const idempotencyKey = `concurrent-conflict:${crypto.randomUUID()}`;
    const candidates = [
      canonicalInput(grant, {
        idempotencyKey,
        fingerprint: `v1:${"d".repeat(64)}`,
      }),
      canonicalInput(grant, {
        idempotencyKey,
        fingerprint: `v1:${"e".repeat(64)}`,
      }),
    ];
    const settled = await Promise.allSettled(
      candidates.map((candidate) => initializeSessionStartAtomically(client.db, candidate)),
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "session_create_idempotency_conflict",
    });
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof initializeSessionStartAtomically>>
      >
    ).value;
    expect(await listSessionTurns(client.db, grant.workspaceId!, winner.session.id)).toHaveLength(
      1,
    );
    expect(await wakeRow(grant.workspaceId!, winner.session.id)).toMatchObject({
      wakeRevision: 1,
      reason: "initial_session",
    });
    const rows = await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
      db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.createIdempotencyKey, idempotencyKey)),
    );
    expect(rows).toEqual([{ id: winner.session.id }]);
  });

  test("receipt replay is workspace/account isolated under forced RLS", async () => {
    const first = await workspaceFixture();
    const second = await workspaceFixture();
    const input = canonicalInput(first.grant, {
      idempotencyKey: `rls:${crypto.randomUUID()}`,
    });
    const initialized = await initializeSessionStartAtomically(client.db, input);

    expect(
      await replaySessionStartByCreateIdempotencyKey(client.db, {
        ...replayInput(input),
        accountId: second.grant.accountId,
        workspaceId: second.grant.workspaceId!,
      }),
    ).toBeNull();
    await expect(
      replaySessionStartByCreateIdempotencyKey(client.db, {
        ...replayInput(input),
        accountId: second.grant.accountId,
      }),
    ).rejects.toThrow(/Workspace not found|has no mandatory inference-control row/);
    expect(
      await listSessionEvents(client.db, second.grant.workspaceId!, initialized.session.id, 0, 10),
    ).toEqual([]);
  });

  test("root and shared-sandbox child reference state commit with their canonical starts", async () => {
    const { grant } = await workspaceFixture();
    const root = await initializeSessionStartAtomically(client.db, canonicalInput(grant));
    expect(root.session.parentSessionId).toBeNull();
    expect(root.session.sandboxGroupId).toBe(root.session.id);
    expect(root.session.sandboxBackend).toBe("none");

    const childInput = canonicalInput(grant, {
      session: {
        parentSessionId: root.session.id,
        sandboxBackend: "modal",
        sandboxGroupId: root.session.sandboxGroupId,
      },
    });
    const child = await initializeSessionStartAtomically(client.db, childInput);
    expect(child.session).toMatchObject({
      parentSessionId: root.session.id,
      sandboxBackend: "modal",
      sandboxGroupId: root.session.sandboxGroupId,
    });
    const replayed = await replaySessionStartByCreateIdempotencyKey(
      client.db,
      replayInput(childInput),
    );
    expect(replayed?.session).toMatchObject({
      id: child.session.id,
      parentSessionId: root.session.id,
      sandboxGroupId: root.session.sandboxGroupId,
    });
  });

  test("scheduled initialization atomically settles source, update, usage, wake, and replay", async () => {
    const { grant } = await workspaceFixture();
    const { task, run } = await scheduledFixture(grant);
    const input = scheduledInput(grant, task, run, { goal: { text: "scheduled goal" } });
    const initialized = await initializeSessionStartAtomically(client.db, input);

    expect(initialized.turn).toBeNull();
    expect(initialized.events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "session.status.changed",
      "system.update.pending",
    ]);
    const durable = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      const [runRow] = await db
        .select()
        .from(schema.scheduledTaskRuns)
        .where(eq(schema.scheduledTaskRuns.id, run.id));
      const updates = await db
        .select()
        .from(schema.sessionSystemUpdates)
        .where(eq(schema.sessionSystemUpdates.sessionId, initialized.session.id));
      const usage = await db
        .select()
        .from(schema.usageEvents)
        .where(eq(schema.usageEvents.idempotencyKey, input.usage.idempotencyKey!));
      return { runRow, updates, usage };
    });
    expect(durable.runRow).toMatchObject({
      status: "dispatched",
      sessionId: initialized.session.id,
      triggerEventId: initialized.triggerEventId,
    });
    expect(durable.updates).toHaveLength(1);
    expect(durable.updates[0]).toMatchObject({
      state: "pending",
      sourceId: run.id,
      dedupeKey: `scheduled-wake:${run.id}`,
    });
    expect(durable.usage).toHaveLength(1);
    expect(await listSessionTurns(client.db, grant.workspaceId!, initialized.session.id)).toEqual(
      [],
    );

    const replayed = await replaySessionStartByCreateIdempotencyKey(client.db, replayInput(input));
    expect(replayed).toMatchObject({
      created: false,
      triggerEventId: initialized.triggerEventId,
      workflowWakeRevision: initialized.workflowWakeRevision,
    });
    expect(replayed?.session.id).toBe(initialized.session.id);
  });

  test("scheduled producer identity rejects conflicting task and trigger requests", async () => {
    const { grant } = await workspaceFixture();
    const first = await scheduledFixture(grant);
    const second = await scheduledFixture(grant);
    const producerKey = `producer-conflict:${crypto.randomUUID()}`;

    await createScheduledTaskRun(client.db, {
      workspaceId: grant.workspaceId!,
      taskId: first.task.id,
      triggerType: "scheduled",
      producerKey,
    });
    await expect(
      createScheduledTaskRun(client.db, {
        workspaceId: grant.workspaceId!,
        taskId: second.task.id,
        triggerType: "scheduled",
        producerKey,
      }),
    ).rejects.toBeInstanceOf(ScheduledTaskRunProducerConflictError);
    await expect(
      createScheduledTaskRun(client.db, {
        workspaceId: grant.workspaceId!,
        taskId: first.task.id,
        triggerType: "manual",
        producerKey,
      }),
    ).rejects.toBeInstanceOf(ScheduledTaskRunProducerConflictError);
  });

  test("every scheduled initialization failpoint rolls back session and source settlement", async () => {
    const { grant } = await workspaceFixture();
    const { task } = await scheduledFixture(grant);
    const stages = [
      "after_session_insert",
      "after_reference_state",
      "after_goal",
      "after_canonical_events",
      "after_admission",
      "after_queue_state",
      "after_usage_and_source",
      "after_wake",
      "before_commit",
    ] as const;
    for (const stage of stages) {
      const run = await createScheduledTaskRun(client.db, {
        workspaceId: grant.workspaceId!,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `failpoint:${stage}:${crypto.randomUUID()}`,
      });
      const sessionId = crypto.randomUUID();
      const input = scheduledInput(grant, task, run, {
        sessionId,
        goal: { text: "rollback scheduled goal" },
        failpoint: (seen) => {
          if (seen === stage) throw new Error(`scheduled-failpoint:${stage}`);
        },
      });
      await expect(initializeSessionStartAtomically(client.db, input)).rejects.toThrow(
        `scheduled-failpoint:${stage}`,
      );
      const state = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
        const [session] = await db
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, sessionId));
        const [runRow] = await db
          .select()
          .from(schema.scheduledTaskRuns)
          .where(eq(schema.scheduledTaskRuns.id, run.id));
        const usage = await db
          .select()
          .from(schema.usageEvents)
          .where(eq(schema.usageEvents.idempotencyKey, input.usage.idempotencyKey!));
        return { session, runRow, usage };
      });
      expect(state.session).toBeUndefined();
      expect(state.runRow).toMatchObject({ status: "queued", sessionId: null });
      expect(state.usage).toEqual([]);
    }
  });

  test("scheduled custom usage identity conflicts roll back the canonical start", async () => {
    const { grant } = await workspaceFixture();
    const { task, run } = await scheduledFixture(grant);
    const usageIdempotencyKey = `reserved:${crypto.randomUUID()}`;
    await recordUsageEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "scheduled_task",
      sourceResourceId: task.id,
      idempotencyKey: usageIdempotencyKey,
    });
    const input = scheduledInput(grant, task, run, { usageIdempotencyKey });

    await expect(initializeSessionStartAtomically(client.db, input)).rejects.toMatchObject({
      code: "session_create_idempotency_conflict",
    });
    const state = await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      const [session] = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, input.sessionId));
      const [runRow] = await db
        .select()
        .from(schema.scheduledTaskRuns)
        .where(eq(schema.scheduledTaskRuns.id, run.id));
      return { session, runRow };
    });
    expect(state.session).toBeUndefined();
    expect(state.runRow).toMatchObject({ status: "queued", sessionId: null });
  });

  test("coalesces revisions and stale acknowledgements cannot hide newer work", async () => {
    const ctx = await fixture();
    const first = await send(ctx, "first");
    const second = await send(ctx, "second");

    expect(first.wakeRevision).toBe(1);
    expect(second.wakeRevision).toBe(2);
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 0,
      attempts: 0,
    });

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: first.wakeRevision,
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 1,
    });

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: second.wakeRevision,
    });
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 2,
      deliveredRevision: 2,
      attempts: 0,
    });
  });

  test("a stale acknowledgement cannot clear retry state owned by a newer revision", async () => {
    const ctx = await fixture();
    const first = await send(ctx, "first");
    const second = await send(ctx, "second");
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed?.wakeRevision).toBe(second.wakeRevision);
    await markSessionWorkflowWakeFailed(client.db, claimed!, "newer delivery failed");

    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: first.wakeRevision,
    });

    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: second.wakeRevision,
      deliveredRevision: first.wakeRevision,
      attempts: 1,
      lastError: "newer delivery failed",
    });
  });

  test("concurrent producers serialize into distinct monotonically increasing revisions", async () => {
    const ctx = await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => send(ctx, `prompt-${index}`)),
    );
    expect(
      results.map((result) => result.wakeRevision).sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 12,
      deliveredRevision: 0,
    });
  });

  test("claim is bounded by due time and records failure without losing the revision", async () => {
    const ctx = await fixture();
    const result = await send(ctx, "repair me");
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed).toMatchObject({
      wakeRevision: result.wakeRevision,
      interruptionRequested: false,
    });
    expect(
      (await claimPendingSessionWorkflowWakes(client.db, 1000)).some(
        (entry) => entry.sessionId === ctx.session.id,
      ),
    ).toBe(false);
    await markSessionWorkflowWakeFailed(client.db, claimed!, "temporal unavailable");
    expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
      wakeRevision: 1,
      deliveredRevision: 0,
      attempts: 1,
      lastError: "temporal unavailable",
    });
  });

  test("repair claims derive cancellation from the durable interruption ledger", async () => {
    const ctx = await fixture();
    const queued = await send(ctx, "run");
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: ctx.grant.accountId,
      workspaceId: ctx.grant.workspaceId!,
      sessionId: ctx.session.id,
      temporalWorkflowId: `session-${ctx.session.id}`,
      wakeRevision: queued.wakeRevision,
    });
    const attemptId = crypto.randomUUID();
    await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    const paused = await withWorkspaceRls(client.db, ctx.grant.workspaceId!, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as typeof db, {
          accountId: ctx.grant.accountId,
          workspaceId: ctx.grant.workspaceId!,
          sessionId: ctx.session.id,
          actor: { type: "human", subjectId: ctx.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    expect(paused.interruptionCount).toBe(1);
    const claimed = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
      (entry) => entry.sessionId === ctx.session.id,
    );
    expect(claimed).toMatchObject({
      interruptionRequested: true,
    });
  });
});
