import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { AccessGrant } from "@opengeni/contracts";
import { createAndStartSession } from "@opengeni/core";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  listSessionEvents,
  listSessionTurns,
  peekSessionWork,
  type InitializeSessionStartInput,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  startTestServices,
  testSettings,
  waitFor,
  type SharedTestDatabase,
  type TestServices,
} from "@opengeni/testing";
import postgres from "postgres";
import { createWorkerWorkflowSignaler } from "../../apps/worker/src/index";
import { reconcilePendingSessionWorkflowWakes } from "../../apps/worker/src/activities/parent-wake";
import { currentActivityContext } from "../../apps/worker/src/activities/streaming";
import type { RunAgentTurnInput } from "../../apps/worker/src/activities/types";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";

const integrationTimeoutMs = 180_000;

describe("atomic session creation across PostgreSQL and Temporal", () => {
  let shared: SharedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let services: Pick<TestServices, "temporalHost" | "down">;
  let connection: Connection;
  let temporal: Client;
  let nativeConnection: NativeConnection;
  let signaler: Awaited<ReturnType<typeof createWorkerWorkflowSignaler>>;
  let settings: ReturnType<typeof testSettings>;
  let bus: MemoryEventBus;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("session-create-temporal");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    dbClient = createDb(shared.appUrl);
    bus = new MemoryEventBus();

    const externalTemporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
    services = externalTemporalHost
      ? { temporalHost: externalTemporalHost, down: async () => undefined }
      : await startTestServices({ temporal: true });
    settings = testSettings({
      databaseUrl: shared.appUrl,
      temporalHost: services.temporalHost,
      temporalTaskQueue: `session-create-${crypto.randomUUID()}`,
      observabilityMetricsEnabled: false,
    });
    connection = await Connection.connect({ address: services.temporalHost });
    temporal = new Client({
      connection,
      namespace: settings.temporalNamespace,
    });
    nativeConnection = await NativeConnection.connect({
      address: services.temporalHost,
    });
    signaler = await createWorkerWorkflowSignaler(settings, dbClient.db);
  }, 300_000);

  afterAll(async () => {
    await signaler?.close();
    await connection?.close();
    await nativeConnection?.close();
    await dbClient?.close();
    await shared?.release();
    await services?.down();
  }, 60_000);

  test(
    "never starts Temporal before commit and replays a lost response into one admission",
    async () => {
      const grant = await workspaceFixture(dbClient.db, "commit-boundary");
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      const idempotencyKey = `create:${crypto.randomUUID()}`;
      const fingerprint = requestFingerprint(idempotencyKey);
      const advisoryKey = Math.floor(Math.random() * 1_000_000_000) + 1;
      const lockHolder = postgres(shared.adminUrl, { max: 1 });
      let creation: Promise<unknown> | null = null;

      await shared.admin.unsafe(`
        create function ope51_block_initial_wake() returns trigger
        language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(${advisoryKey});
          return new;
        end
        $$;
        create trigger ope51_block_initial_wake
        before insert on session_workflow_wake_outbox
        for each row execute function ope51_block_initial_wake();
      `);
      await lockHolder`select pg_advisory_lock(${advisoryKey})`;

      try {
        creation = createAndStartSession(
          createRequest(grant, {
            sessionId,
            idempotencyKey,
            fingerprint,
            initialMessage: "commit before delivery",
          }),
        );
        await waitFor(
          async () => {
            const [row] = await shared.admin<Array<{ waiting: number }>>`
              select count(*)::integer as waiting
              from pg_stat_activity
              where datname = current_database()
                and pid <> pg_backend_pid()
                and wait_event = 'advisory'`;
            return (row?.waiting ?? 0) > 0;
          },
          {
            timeoutMs: 10_000,
            describe: () => "session initializer did not reach the blocked wake insert",
          },
        );

        await expectWorkflowAbsent(workflowId);
        expect(await listSessionTurns(dbClient.db, grant.workspaceId, sessionId)).toEqual([]);
      } finally {
        await lockHolder`select pg_advisory_unlock(${advisoryKey})`;
        await lockHolder.end();
      }

      const created = await creation!;
      expect(created).toMatchObject({ id: sessionId });
      await shared.admin.unsafe(
        "drop trigger ope51_block_initial_wake on session_workflow_wake_outbox; drop function ope51_block_initial_wake()",
      );
      await expectWorkflowPresent(workflowId);

      const replayed = await createAndStartSession(
        createRequest(grant, {
          sessionId: crypto.randomUUID(),
          idempotencyKey,
          fingerprint,
          initialMessage: "commit before delivery",
        }),
      );
      expect(replayed.id).toBe(sessionId);
      expect(
        (await listSessionEvents(dbClient.db, grant.workspaceId, sessionId, 0, 50)).filter(
          (event) => event.type === "turn.started",
        ),
      ).toHaveLength(0);

      const admissions = new Map<string, number>();
      const worker = await sessionWorker(admissions);
      const workerRun = worker.run();
      try {
        await temporal.workflow.getHandle(workflowId).result();
      } finally {
        worker.shutdown();
        await workerRun;
      }

      await expectOneCompletedAdmission(grant, sessionId, admissions);
      const [wake] = await shared.admin<
        Array<{ wake_revision: number; delivered_revision: number }>
      >`
        select wake_revision::integer, delivered_revision::integer
        from session_workflow_wake_outbox
        where session_id = ${sessionId}`;
      expect(wake).toEqual({ wake_revision: 1, delivered_revision: 1 });
      expect(bus.published).toHaveLength(1);
    },
    integrationTimeoutMs,
  );

  test(
    "repairs a committed wake after process death and worker replay admits once",
    async () => {
      const grant = await workspaceFixture(dbClient.db, "process-death");
      const before = initializerInput(grant, {
        sessionId: crypto.randomUUID(),
        idempotencyKey: `before:${crypto.randomUUID()}`,
      });
      expect(await runInitializerInKilledProcess(before, "before_commit")).toBe(91);
      await expectWorkflowAbsent(`session-${before.sessionId}`);
      expect(
        await listSessionEvents(dbClient.db, grant.workspaceId, before.sessionId, 0, 20),
      ).toEqual([]);

      const after = initializerInput(grant, {
        sessionId: crypto.randomUUID(),
        idempotencyKey: `after:${crypto.randomUUID()}`,
      });
      expect(await runInitializerInKilledProcess(after, "after_commit")).toBe(92);
      const workflowId = `session-${after.sessionId}`;
      await expectWorkflowAbsent(workflowId);
      const [pending] = await shared.admin<
        Array<{ wake_revision: number; delivered_revision: number }>
      >`
        select wake_revision::integer, delivered_revision::integer
        from session_workflow_wake_outbox
        where session_id = ${after.sessionId}`;
      expect(pending).toEqual({ wake_revision: 1, delivered_revision: 0 });

      const repair = await reconcilePendingSessionWorkflowWakes(
        {
          db: dbClient.db,
          bus,
          settings,
          observability: createObservability(settings, {
            component: "session-create-temporal-test",
          }),
          wakeSessionWorkflow: signaler.wakeSessionWorkflow,
        },
        1_000,
      );
      expect(repair).toEqual({ claimed: 1, delivered: 1, failed: 0 });
      await expectWorkflowPresent(workflowId);

      const replayed = await createAndStartSession(
        createRequest(grant, {
          sessionId: crypto.randomUUID(),
          idempotencyKey: after.createIdempotencyKey!,
          fingerprint: after.createRequestFingerprint,
          initialMessage: after.session.initialMessage,
        }),
      );
      expect(replayed.id).toBe(after.sessionId);

      const admissions = new Map<string, number>();
      const worker = await sessionWorker(admissions);
      const workerRun = worker.run();
      try {
        await temporal.workflow.getHandle(workflowId).result();
      } finally {
        worker.shutdown();
        await workerRun;
      }
      await expectOneCompletedAdmission(grant, after.sessionId, admissions);
    },
    integrationTimeoutMs,
  );

  async function sessionWorker(admissions: Map<string, number>) {
    const activities = {
      peekSessionWork: async (input: { workspaceId: string; sessionId: string }) =>
        await peekSessionWork(dbClient.db, input.workspaceId, input.sessionId),
      runAgentTurn: async (input: RunAgentTurnInput) => {
        const activity = currentActivityContext();
        if (!activity) throw new Error("turn activity has no Temporal context");
        const claim = await claimSessionWorkForAttempt(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          workflowRunId: activity.info.workflowExecution.runId,
          attemptId: input.attemptId,
          dispatchId: activity.info.activityId,
          trigger: input.trigger,
        });
        if (claim.action !== "claimed") {
          return { status: "unclaimed", reason: claim.reason } as const;
        }
        admissions.set(input.sessionId, (admissions.get(input.sessionId) ?? 0) + 1);
        const started = await applySessionTurnSettlement(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: claim.turn.id,
          triggerEventId: claim.turn.triggerEventId,
          attemptId: input.attemptId,
          turnStatus: "running",
          sessionStatus: "running",
          activeTurnId: claim.turn.id,
          events: [
            {
              type: "session.status.changed",
              payload: { status: "running" },
            },
            {
              type: "turn.started",
              payload: { triggerEventId: claim.turn.triggerEventId },
            },
          ],
        });
        if (started.action !== "settled") {
          throw new Error(`turn start became ${started.action}`);
        }
        const settled = await applySessionTurnSettlement(dbClient.db, input.workspaceId, {
          sessionId: input.sessionId,
          turnId: claim.turn.id,
          triggerEventId: claim.turn.triggerEventId,
          attemptId: input.attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [
            {
              type: "turn.completed",
              payload: { test: "session-create-temporal" },
            },
          ],
        });
        if (settled.action !== "settled") {
          throw new Error(`turn settlement became ${settled.action}`);
        }
        return {
          status: "idle",
          turnId: claim.turn.id,
          attemptId: input.attemptId,
        } as const;
      },
      enqueueGoalRetryWake: async () => undefined,
      maybeContinueGoal: async () => ({ action: "none" as const }),
      getCodexCapacityWait: async () => null,
      reconcileCodexCapacityWait: async () => ({ action: "stale" as const }),
      settleSessionInterruptions: async () => ({ action: "continue" as const }),
      failSessionAttempt: async () => {
        throw new Error("unexpected session-attempt failure");
      },
      recoverDispatch: async () => {
        throw new Error("unexpected session dispatch recovery");
      },
      markSessionIdle: async () => undefined,
    };
    const { runAgentTurn, ...controlActivities } = activities;
    const [control, turns] = await Promise.all([
      Worker.create({
        connection: nativeConnection,
        namespace: settings.temporalNamespace,
        taskQueue: settings.temporalTaskQueue,
        workflowsPath: new URL("../../apps/worker/src/workflows.ts", import.meta.url).pathname,
        activities: controlActivities,
        maxConcurrentActivityTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
      }),
      Worker.create({
        connection: nativeConnection,
        namespace: settings.temporalNamespace,
        taskQueue: turnTaskQueue(settings.temporalTaskQueue),
        activities: { runAgentTurn },
        maxConcurrentActivityTaskExecutions: TURN_WORKER_MAX_CONCURRENT_TURNS,
      }),
    ]);
    return {
      run: async () => {
        await Promise.all([control.run(), turns.run()]);
      },
      shutdown: () => {
        control.shutdown();
        turns.shutdown();
      },
    };
  }

  async function expectOneCompletedAdmission(
    grant: AccessGrant,
    sessionId: string,
    admissions: Map<string, number>,
  ): Promise<void> {
    expect(admissions.get(sessionId)).toBe(1);
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "completed", position: 1 });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, sessionId, 0, 50);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }

  async function expectWorkflowAbsent(workflowId: string): Promise<void> {
    let failure: unknown;
    try {
      await temporal.workflow.getHandle(workflowId).describe();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkflowNotFoundError);
  }

  async function expectWorkflowPresent(workflowId: string): Promise<void> {
    const description = await temporal.workflow.getHandle(workflowId).describe();
    expect(description.workflowId).toBe(workflowId);
  }

  function createRequest(
    grant: AccessGrant,
    input: {
      sessionId: string;
      idempotencyKey: string;
      fingerprint: string;
      initialMessage: string;
    },
  ): Parameters<typeof createAndStartSession>[0] {
    return {
      db: dbClient.db,
      bus,
      workflowClient: {
        wakeSessionWorkflow: signaler.wakeSessionWorkflow,
      } as Parameters<typeof createAndStartSession>[0]["workflowClient"],
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: input.sessionId,
      createRequestFingerprint: input.fingerprint,
      initialMessage: input.initialMessage,
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
      createIdempotencyKey: input.idempotencyKey,
      usageSubjectId: grant.subjectId,
    };
  }

  function initializerInput(
    grant: AccessGrant,
    input: { sessionId: string; idempotencyKey: string },
  ): InitializeSessionStartInput {
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: input.sessionId,
      createIdempotencyKey: input.idempotencyKey,
      createRequestFingerprint: requestFingerprint(input.idempotencyKey),
      session: {
        initialMessage: "recover committed initialization",
        resources: [],
        tools: [],
        metadata: { model: "scripted-model", reasoningEffort: "low" },
        model: "scripted-model",
        sandboxBackend: "none",
      },
      createdEventPayload: {},
      goal: null,
      admission: { kind: "user", reasoningEffort: "low" },
      usage: {
        subjectId: grant.subjectId,
        sourceResourceType: "session",
      },
    };
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
});

async function workspaceFixture(
  db: ReturnType<typeof createDb>["db"],
  label: string,
): Promise<AccessGrant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test:session-create-temporal",
    accountExternalId: `account:${label}:${suffix}`,
    accountName: "Session create Temporal integration",
    workspaceExternalSource: "test:session-create-temporal",
    workspaceExternalId: `workspace:${label}:${suffix}`,
    workspaceName: "Session create Temporal integration",
    subjectId: `subject:${label}:${suffix}`,
    subjectLabel: "Session create Temporal integration",
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("workspace bootstrap returned no grant");
  return grant;
}

function requestFingerprint(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `v1:${digest}`;
}
