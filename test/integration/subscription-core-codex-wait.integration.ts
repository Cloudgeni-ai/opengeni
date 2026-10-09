/**
 * Codex capacity waits on the shared subscription core through the real
 * session workflow (M3 PR 2a). The workflow and its activity names, signal
 * names and argument shapes are unchanged; these tests run the real core
 * waiter in PostgreSQL (as the non-bypass application role) behind the real
 * capacity activities and a real Temporal server, then replay every recorded
 * history against the current workflow bundle. The legacy pinned capacity-wait
 * history keeps replaying too.
 *
 * Requires OPENGENI_TEST_TEMPORAL_HOST (or the compose services) and the
 * real-PostgreSQL test database (OPENGENI_REQUIRE_REAL_DB=1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  acquireSharedTestDatabase,
  startTestServices,
  type SharedTestDatabase,
  type TestServices,
  waitFor,
} from "@opengeni/testing";
import {
  armSubscriptionCoreCodexCapacityWait,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getSubscriptionCoreCodexCapacityWaitForSession,
  mutateSessionControlInTransaction,
  peekSessionWork,
  submitHumanPromptInTransaction,
  subscriptionCoreCodexCapacityWaitRef,
  wakeSubscriptionCoreCodexCapacityWaiters,
  withSessionRlsActorContext,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  createTurnWorkerTuner,
} from "../../apps/worker/src/concurrency";
import { turnTaskQueue } from "../../apps/worker/src/workflows/activities";
import { createCodexCapacityActivities } from "../../apps/worker/src/activities/codex-capacity";
import {
  deliverSubscriptionCoreCodexWakes,
  wakeSubscriptionCoreCodexWaitersAndDeliver,
} from "../../apps/worker/src/activities/subscription-core-codex-waits";
import type { SignalCodexCapacityWorkflow } from "../../apps/worker/src/activities/types";
import { encryptEnvironmentValue } from "../../packages/db/src/environment-crypto";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const testTimeoutMs = 120_000;
const workflowDefinitionsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url)
  .pathname;
// Recorded with the session workflow before session-capacity-wake-jitter-v1
// (a legacy Codex capacity wait); the core path must not change its replay.
const legacySessionCapacityWaitHistoryPath = new URL(
  "../../apps/worker/test/fixtures/legacy-session-capacity-wait-history.json",
  import.meta.url,
).pathname;
const MODEL = "codex/gpt-5.5";
const key = Buffer.alloc(32, 53);
const settings = { environmentsEncryptionKey: key.toString("base64") } as never;

describe.skipIf(!realDb)(
  "Codex capacity waits on the shared core through the session workflow",
  () => {
    let services: TestServices;
    let connection: Connection;
    let nativeConnection: NativeConnection;
    let shared: SharedTestDatabase | null = null;
    let client: DbClient | null = null;

    beforeAll(async () => {
      const externalTemporalHost = process.env.OPENGENI_TEST_TEMPORAL_HOST?.trim();
      services = externalTemporalHost
        ? ({
            temporalHost: externalTemporalHost,
            down: async () => undefined,
          } as TestServices)
        : await startTestServices({ temporal: true });
      connection = await Connection.connect({ address: services.temporalHost });
      nativeConnection = await NativeConnection.connect({
        address: services.temporalHost,
      });
      shared = await acquireSharedTestDatabase("subscription-core-codex-wait-workflow-v1");
      if (!shared) throw new Error("Real PostgreSQL is required");
      client = createDb(shared.appUrl, { max: 6 });
    }, 300_000);

    afterAll(async () => {
      await client?.close();
      await shared?.release();
      await connection?.close();
      await nativeConnection?.close();
      await services?.down();
    }, 60_000);

    /** An organization with one exhausted organization-scoped Codex connection. */
    async function fixture() {
      const userId = `core-wait-workflow-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(client!.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Core Codex wait workflow fixture",
      });
      const accountId = access.workspaceGrants[0]!.accountId;
      const ownerSubjectId = `user:${userId}`;
      const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, 'Core Codex wait workflow') returning id::text as id`;
      const workspaceId = workspace!.id;
      await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${ownerSubjectId}, 'owner')`;
      await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}::uuid, ${accountId}::uuid)`;
      // Migration 0680 seeds the organization settings row; the fixture writes its own.
      await shared!.admin`
      delete from subscription_settings
      where account_id = ${accountId}::uuid and workspace_id is null`;
      await shared!.admin`
      insert into subscription_settings (
        account_id, rotation, providers, cross_provider_failover, fallback_order,
        personal_connections_allowed, personal_fallback_allowed
      ) values (
        ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
        '{}'::jsonb, false, '{}'::jsonb, false, false
      )`;
      await shared!.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, 'codex', true)
      on conflict (account_id, provider) do update set enabled = true`;
      const [connectionRow] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        provider_account_id, plan_type, expires_at
      ) values (
        ${accountId}::uuid, 'codex', 'subscription',
        ${encryptEnvironmentValue(key, JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }))},
        'shared', 'organization', 'chatgpt-wait', 'pro', now() + interval '1 day'
      ) returning id::text as id`;
      const connectionId = connectionRow!.id;
      await shared!.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${accountId}::uuid, ${connectionId}::uuid, ${workspaceId}::uuid, 'organization')`;
      const setExhausted = async (until: number | null) => {
        await shared!.admin`
        insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision
        ) values (${accountId}::uuid, ${connectionId}::uuid, ${shared!.admin.json({
          windows: [],
          modelCooldowns: {},
          exhaustedUntil: until,
          exhaustedKind: until === null ? null : "quota",
          source: "refusal",
        })}::jsonb, 1, 1)
        on conflict (connection_id) do update set quota = excluded.quota,
          revision = subscription_connection_quota.revision + 1`;
      };
      await setExhausted(Date.now() + 3_600_000);
      const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        createSession(client!.db, {
          accountId,
          workspaceId,
          initialMessage: "core codex wait workflow",
          resources: [],
          metadata: {},
          model: MODEL,
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          subjectId: ownerSubjectId,
          createdBy: { kind: "subject" as const, subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      );
      const sessionId = session.id;
      const turn = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId,
          workspaceId,
          sessionId,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${sessionId}`,
          source: "user",
          prompt: "core codex wait workflow",
          resources: [],
          tools: [],
          model: MODEL,
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: ownerSubjectId },
        }),
      );
      /** Claim the turn in PostgreSQL and park it on the core waiter, as the capacity phase does. */
      const claimAndArm = async () => {
        const attemptId = crypto.randomUUID();
        const claimed = await claimSessionWorkForAttempt(client!.db, workspaceId, {
          sessionId,
          workflowId: `session-${sessionId}`,
          workflowRunId: crypto.randomUUID(),
          dispatchId: crypto.randomUUID(),
          attemptId,
          trigger: { kind: "next" },
        });
        if (claimed.action !== "claimed" || claimed.turn.id !== turn.id)
          throw new Error("fixture turn was not claimed");
        const armed = await armSubscriptionCoreCodexCapacityWait(client!.db, {
          accountId,
          workspaceId,
          sessionId,
          turnId: turn.id,
          attemptId,
          waitReason: "no_eligible_capacity",
          earliestResetAt: new Date(Date.now() + 3_600_000),
          failurePayload: { code: "subscription_capacity_unavailable" },
        });
        if (armed.action !== "waiting") throw new Error(`arm returned ${armed.action}`);
        return subscriptionCoreCodexCapacityWaitRef(armed.waiter);
      };
      const currentRef = async () => {
        const waiter = await getSubscriptionCoreCodexCapacityWaitForSession(
          client!.db,
          workspaceId,
          sessionId,
        );
        return waiter ? subscriptionCoreCodexCapacityWaitRef(waiter) : null;
      };
      const turnStatus = async () => {
        const [row] = await shared!.admin<{ status: string }[]>`
        select status from session_turns where id = ${turn.id}::uuid`;
        return row!.status;
      };
      return {
        accountId,
        workspaceId,
        sessionId,
        ownerSubjectId,
        workflowId: `session-${sessionId}`,
        setExhausted,
        claimAndArm,
        currentRef,
        turnStatus,
      };
    }

    function signaler(taskQueue: string): SignalCodexCapacityWorkflow {
      const temporal = new Client({ connection });
      return async ({ accountId, workspaceId, sessionId, workflowId, wakeRevision }) => {
        await temporal.workflow.signalWithStart("sessionWorkflow", {
          taskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [{ accountId, workspaceId, sessionId, capacityWakeJitterMaxMs: 0 }],
          signal: "codexCapacityChanged",
          signalArgs: [wakeRevision],
        });
      };
    }

    /**
     * The workflow's queue admission is modelled in memory (as the existing
     * workflow tests do); the capacity wait itself is the real core waiter and
     * the real capacity activities.
     */
    async function startWorker(input: {
      taskQueue: string;
      fixture: Awaited<ReturnType<typeof fixture>>;
      signal: SignalCodexCapacityWorkflow;
      beforeFirstReturn?: () => Promise<void>;
      afterReconcile?: (count: number) => Promise<void>;
    }) {
      const { fixture: state } = input;
      let phase: "queued" | "waiting" | "recovering" | "done" = "queued";
      // After a Steer or Cancel the real database peek decides what the
      // workflow sees next: a stale core waiter would make it sleep again.
      let interrupted: "steer" | "cancel" | null = null;
      const realPeeks: string[] = [];
      const attempts: string[] = [];
      const reconciliations: Array<{ cause: string; action: string }> = [];
      const capacity = createCodexCapacityActivities(
        async () =>
          ({
            db: client!.db,
            bus: { publish: async () => undefined },
            settings,
            signalCodexCapacityWorkflow: input.signal,
            wakeSessionWorkflow: undefined,
          }) as never,
      );
      const control = {
        enqueueGoalRetryWake: async () => undefined,
        maybeContinueGoal: async () => ({ action: "none" }),
        reconcileSessionAttemptQuiescence: async () => ({ action: "stale" }),
        markSessionIdle: async () => undefined,
        failSessionAttempt: async () => undefined,
        settleSessionInterruptions: async () => ({
          action: "continue" as const,
        }),
        peekSessionWork: async () => {
          if (phase === "waiting" && interrupted) {
            const peek = await peekSessionWork(client!.db, state.workspaceId, state.sessionId);
            realPeeks.push(peek.kind);
            if (peek.kind === "capacity-wait") return peek;
            if (interrupted === "cancel") {
              phase = "done";
              return { kind: "idle" } as const;
            }
            phase = "recovering";
            return { kind: "runnable" } as const;
          }
          if (phase === "waiting") {
            // The real durable waiter (and its pending wake revision).
            const ref = await state.currentRef();
            if (ref) return { kind: "capacity-wait", ref } as const;
          }
          if (phase === "queued" || phase === "recovering") return { kind: "runnable" } as const;
          return { kind: "idle" } as const;
        },
        getCodexCapacityWait: capacity.getCodexCapacityWait,
        reconcileCodexCapacityWait: async (
          request: Parameters<typeof capacity.reconcileCodexCapacityWait>[0],
        ) => {
          const result = await capacity.reconcileCodexCapacityWait(request);
          reconciliations.push({ cause: request.cause, action: result.action });
          await input.afterReconcile?.(reconciliations.length);
          if (result.action === "resumed") phase = "recovering";
          return result;
        },
      };
      const runAgentTurn = async (request: { attemptId: string }) => {
        attempts.push(request.attemptId);
        if (phase === "queued") {
          const ref = await state.claimAndArm();
          phase = "waiting";
          await input.beforeFirstReturn?.();
          return {
            status: "waiting_capacity",
            capacityWait: ref,
            turnId: "turn",
            attemptId: request.attemptId,
          };
        }
        phase = "done";
        return { status: "idle", turnId: "turn", attemptId: request.attemptId };
      };
      const [controlWorker, turnWorker] = await Promise.all([
        Worker.create({
          connection: nativeConnection,
          namespace: "default",
          taskQueue: input.taskQueue,
          workflowsPath: workflowDefinitionsPath,
          activities: control,
          maxConcurrentActivityTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
        }),
        Worker.create({
          connection: nativeConnection,
          namespace: "default",
          taskQueue: turnTaskQueue(input.taskQueue),
          activities: { runAgentTurn },
          tuner: createTurnWorkerTuner({
            memorySnapshot: () => ({
              currentBytes: 256 * 1024 * 1024,
              limitBytes: 4 * 1024 * 1024 * 1024,
              source: "cgroup-v2",
            }),
          }).tuner,
        }),
      ]);
      const running = Promise.all([controlWorker.run(), turnWorker.run()]);
      return {
        attempts,
        reconciliations,
        realPeeks,
        interrupt: (kind: "steer" | "cancel") => {
          interrupted = kind;
        },
        phase: () => phase,
        stop: async () => {
          controlWorker.shutdown();
          turnWorker.shutdown();
          await running;
        },
      };
    }

    async function startWorkflow(
      taskQueue: string,
      state: Awaited<ReturnType<typeof fixture>>,
      extra: Record<string, unknown> = {},
    ) {
      return await new Client({ connection }).workflow.start("sessionWorkflow", {
        taskQueue,
        workflowId: state.workflowId,
        args: [
          {
            accountId: state.accountId,
            workspaceId: state.workspaceId,
            sessionId: state.sessionId,
            capacityWakeJitterMaxMs: 0,
            ...extra,
          },
        ],
      });
    }

    test(
      "the pinned legacy capacity-wait history still replays",
      async () => {
        const history = (await Bun.file(legacySessionCapacityWaitHistoryPath).json()) as {
          events: Array<{
            workflowExecutionStartedEventAttributes?: { workflowId?: string };
          }>;
        };
        await Worker.runReplayHistory(
          { workflowsPath: workflowDefinitionsPath },
          history,
          history.events[0]?.workflowExecutionStartedEventAttributes?.workflowId ?? "legacy",
        );
      },
      testTimeoutMs,
    );

    test(
      "signal before peek: a core wake committed while the turn is still parking resumes it",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({
          taskQueue,
          fixture: state,
          signal,
          // Capacity returns and the core wake is delivered before the turn
          // activity hands the workflow its waiter reference.
          beforeFirstReturn: async () => {
            await state.setExhausted(null);
            const scopes = await wakeSubscriptionCoreCodexWaitersAndDeliver(
              { db: client!.db, signalCodexCapacityWorkflow: signal },
              {
                accountId: state.accountId,
                reason: "quota_observed_available",
              },
            );
            expect(scopes).toHaveLength(1);
          },
        });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await handle.result();
          expect(worker.attempts).toHaveLength(2);
          expect(worker.reconciliations).toEqual([{ cause: "signal", action: "resumed" }]);
          expect(await state.currentRef()).toBeNull();
          expect(await state.turnStatus()).toBe("recovering");
          // The resumed waiter is gone, and its delivered outbox rows with it.
          const outboxRows = await shared!.admin<{ id: string }[]>`
          select id::text as id from subscription_capacity_wake_outbox
          where session_id = ${state.sessionId}::uuid`;
          expect(outboxRows).toHaveLength(0);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    test(
      "peek before signal: a parked core waiter sleeps to its reset until a delivered wake",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({ taskQueue, fixture: state, signal });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          await Bun.sleep(500);
          // Parked on the authoritative reset an hour away: nothing reconciled.
          expect(worker.reconciliations).toEqual([]);
          await state.setExhausted(null);
          await wakeSubscriptionCoreCodexWaitersAndDeliver(
            { db: client!.db, signalCodexCapacityWorkflow: signal },
            { accountId: state.accountId, reason: "quota_observed_available" },
          );
          await handle.result();
          expect(worker.reconciliations).toEqual([{ cause: "signal", action: "resumed" }]);
          expect(worker.attempts).toHaveLength(2);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    test(
      "continue-as-new: a wake pending across the boundary is checked at once by the next run",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({
          taskQueue,
          fixture: state,
          signal,
          // Right after the first check (still exhausted), capacity returns and
          // a wake commits whose typed signal is lost: the waiter's revision is
          // left unobserved across the continue-as-new boundary.
          afterReconcile: async (count) => {
            if (count !== 1) return;
            await state.setExhausted(null);
            await shared!.admin`
            update subscription_capacity_waiters set wake_revision = wake_revision + 1
            where session_id = ${state.sessionId}::uuid`;
          },
        });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
            maxCapacityChecksPerRun: 1,
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          // Still exhausted: the first check waits and the run continues as new.
          await wakeSubscriptionCoreCodexWaitersAndDeliver(
            { db: client!.db, signalCodexCapacityWorkflow: signal },
            {
              accountId: state.accountId,
              reason: "connection_health_recovered",
            },
          );
          await waitFor(() => worker.reconciliations.length >= 1);
          expect(worker.reconciliations[0]).toEqual({
            cause: "signal",
            action: "waiting",
          });
          await handle.result();
          expect(worker.reconciliations.at(-1)).toMatchObject({
            action: "resumed",
          });
          expect(worker.attempts).toHaveLength(2);
          const history = await handle.fetchHistory();
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            history,
            state.workflowId,
          );
          const description = await handle.describe();
          expect(description.runId).not.toBe(handle.firstExecutionRunId);
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    test(
      "wake-outbox retry: a failed typed signal is retried from the outbox and resumes the turn",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({ taskQueue, fixture: state, signal });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          await state.setExhausted(null);
          let failures = 0;
          const scopes = await wakeSubscriptionCoreCodexWaitersAndDeliver(
            {
              db: client!.db,
              signalCodexCapacityWorkflow: async () => {
                failures += 1;
                throw new Error("temporal frontend unavailable");
              },
            },
            { accountId: state.accountId, reason: "quota_observed_available" },
          );
          expect(failures).toBe(1);
          const [pending] = await shared!.admin<
            { last_error: string | null; delivered: boolean }[]
          >`
          select last_error, delivered_at is not null as delivered
          from subscription_capacity_wake_outbox where session_id = ${state.sessionId}::uuid`;
          expect(pending).toEqual({
            last_error: "signal_failed",
            delivered: false,
          });
          expect(worker.reconciliations).toEqual([]);
          // The retry becomes due after its backoff and is delivered.
          await Bun.sleep(1_200);
          const retried = await deliverSubscriptionCoreCodexWakes(
            { db: client!.db, signalCodexCapacityWorkflow: signal },
            scopes[0]!,
          );
          expect(retried).toMatchObject({ claimed: 1, delivered: 1 });
          await handle.result();
          expect(worker.reconciliations).toEqual([{ cause: "signal", action: "resumed" }]);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    /** Run one owner command against the fixture session as the owner (app role, RLS). */
    async function asOwner<T>(
      state: Awaited<ReturnType<typeof fixture>>,
      fn: Parameters<typeof withWorkspaceSubjectSessionActivityRls<T>>[3],
    ): Promise<T> {
      return await withWorkspaceSubjectSessionActivityRls(
        client!.db,
        state.workspaceId,
        state.ownerSubjectId,
        fn,
      );
    }

    test(
      "Steer: the steered turn runs at once instead of sleeping on the old core waiter",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({ taskQueue, fixture: state, signal });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          // Parked on the reset an hour away.
          await Bun.sleep(300);
          expect(worker.reconciliations).toEqual([]);
          await asOwner(state, (tx) =>
            submitHumanPromptInTransaction(tx, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              sessionId: state.sessionId,
              subjectId: state.ownerSubjectId,
              actor: { type: "human", subjectId: state.ownerSubjectId },
              operationKey: crypto.randomUUID(),
              delivery: "steer",
              text: "change of plan",
              resources: [],
              reasoningEffortFallback: "medium",
              source: "user",
            }),
          );
          expect(await state.currentRef()).toBeNull();
          worker.interrupt("steer");
          // A Steer reaches the workflow as a control wake.
          await handle.signal("sessionControl");
          await waitFor(() => worker.attempts.length === 2, { timeoutMs: 15_000 });
          await handle.result();
          expect(worker.realPeeks).toEqual(["runnable"]);
          expect(worker.reconciliations).toEqual([]);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    test(
      "Cancel: no core waiter is left behind to receive wakes, and the workflow ends",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({ taskQueue, fixture: state, signal });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          await asOwner(state, (tx) =>
            mutateSessionControlInTransaction(tx, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              sessionId: state.sessionId,
              actor: { type: "human", subjectId: state.ownerSubjectId },
              operationKey: crypto.randomUUID(),
              action: "cancel",
            }),
          );
          expect(await state.currentRef()).toBeNull();
          worker.interrupt("cancel");
          await handle.signal("sessionControl");
          await handle.result();
          expect(worker.realPeeks).toHaveLength(1);
          expect(worker.realPeeks[0]).not.toBe("capacity-wait");
          expect(worker.attempts).toHaveLength(1);
          expect(worker.reconciliations).toEqual([]);
          expect(await state.turnStatus()).toBe("cancelled");
          // An account-wide capacity change afterwards touches nothing here.
          await state.setExhausted(null);
          const scopes = await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
            accountId: state.accountId,
            reason: "quota_observed_available",
          });
          expect(scopes).toEqual([]);
          const outboxRows = await shared!.admin<{ id: string }[]>`
          select id::text as id from subscription_capacity_wake_outbox
          where session_id = ${state.sessionId}::uuid`;
          expect(outboxRows.length).toBe(0);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );

    test(
      "a later reconcile in the workspace repairs a typed wake a crash left pending",
      async () => {
        const taskQueue = `core-wait-${crypto.randomUUID()}`;
        const state = await fixture();
        const signal = signaler(taskQueue);
        const worker = await startWorker({ taskQueue, fixture: state, signal });
        try {
          const handle = await startWorkflow(taskQueue, state, {
            initialEventId: "event-1",
          });
          await waitFor(
            async () => worker.phase() === "waiting" && (await state.currentRef()) !== null,
          );
          // Capacity returns and the database wake commits, but the process
          // dies before any typed signal: the outbox row stays pending.
          await state.setExhausted(null);
          await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
            accountId: state.accountId,
            reason: "quota_observed_available",
          });
          const pending = async () =>
            (
              await shared!.admin<{ delivered: boolean }[]>`
              select delivered_at is not null as delivered
              from subscription_capacity_wake_outbox where session_id = ${state.sessionId}::uuid`
            ).map((row) => row.delivered);
          expect(await pending()).toEqual([false]);
          // Any later reconcile in the workspace drains it first, even one
          // that is itself stale (here an outdated generation of the waiter).
          const capacity = createCodexCapacityActivities(
            async () =>
              ({
                db: client!.db,
                bus: { publish: async () => undefined },
                settings,
                signalCodexCapacityWorkflow: signal,
                wakeSessionWorkflow: undefined,
              }) as never,
          );
          const ref = await state.currentRef();
          await capacity.reconcileCodexCapacityWait({
            accountId: state.accountId,
            workspaceId: state.workspaceId,
            sessionId: state.sessionId,
            waiterId: ref!.waiterId,
            generation: ref!.generation + 1,
            cause: "timer",
          });
          await handle.result();
          expect(worker.reconciliations).toEqual([{ cause: "signal", action: "resumed" }]);
          await Worker.runReplayHistory(
            { workflowsPath: workflowDefinitionsPath },
            await handle.fetchHistory(),
            state.workflowId,
          );
        } finally {
          await worker.stop();
        }
      },
      testTimeoutMs,
    );
  },
);
