import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession, type DbClient } from "../src";
import { nestedPostgresSqlState } from "../src/persistence-errors";

const migrationUrl = new URL(
  "../drizzle/0364_workspace_learning_policy_snapshot_lock_order.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

type AttemptFixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

async function waitForApplicationLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [activity] = await shared!.admin<Array<{ state: string; waitEventType: string | null }>>`
      select state, wait_event_type as "waitEventType"
      from pg_stat_activity
      where datname = current_database()
        and application_name = ${applicationName}
      limit 1`;
    if (activity?.state === "active" && activity.waitEventType === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a row lock`);
}

async function waitForBackendLock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [activity] = await shared!.admin<Array<{ waitEventType: string | null }>>`
      select wait_event_type as "waitEventType"
      from pg_stat_activity
      where datname = current_database()
        and pid = ${pid}
      limit 1`;
    if (activity?.waitEventType === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for backend ${pid} to block on a row lock`);
}

async function deadlockCount(): Promise<number> {
  const [row] = await shared!.admin<Array<{ deadlocks: number }>>`
    select deadlocks::int as deadlocks
    from pg_stat_database
    where datname = current_database()`;
  return row?.deadlocks ?? 0;
}

async function seedAttempt(): Promise<AttemptFixture> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values ('learning-policy snapshot lock-order account')
    returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'learning-policy snapshot lock-order workspace')
    returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;

  const session = await createSession(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "Learning-policy snapshot lock-order fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const subjectId = `user:learning-policy-lock-order-${crypto.randomUUID()}`;
  await shared!.admin.begin(async (tx) => {
    await tx`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        initiator_kind, initiator_subject_id, initiating_human_subject_id, initiator_context
      ) values (
        ${turnId}, ${account!.id}, ${workspace!.id}, ${session.id},
        ${crypto.randomUUID()}, ${`learning-policy-lock-order-${turnId}`}, 'running', 1,
        'learning-policy snapshot lock-order fixture', 'test-model', 'medium', 'none', 1,
        'subject', ${subjectId}, ${subjectId}, ${shared!.admin.json({ source: "test" })}
      )`;
    await tx`
      update sessions
      set active_turn_id = ${turnId}, status = 'running'
      where id = ${session.id}`;
    await tx`
      update session_turns
      set active_attempt_id = ${attemptId}
      where id = ${turnId}`;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${account!.id}, ${workspace!.id}, ${session.id},
        ${turnId}, 1, 'running', ${`learning-policy-lock-order-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });

  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
}

beforeAll(async () => {
  const source = await readFile(migrationUrl, "utf8");
  expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
  expect(source).not.toContain("FOR SHARE OF attempt, turn, session");
  const workspaceLock = source.indexOf("FOR KEY SHARE OF workspace;");
  const sessionLock = source.indexOf("FOR SHARE OF session;", workspaceLock);
  const turnLock = source.indexOf("FOR SHARE OF turn;", sessionLock);
  const attemptLock = source.indexOf("FOR SHARE OF attempt;", turnLock);
  expect(workspaceLock).toBeGreaterThanOrEqual(0);
  expect(sessionLock).toBeGreaterThan(workspaceLock);
  expect(turnLock).toBeGreaterThan(sessionLock);
  expect(attemptLock).toBeGreaterThan(turnLock);

  shared = await acquireSharedTestDatabase(
    "migration-0364-workspace-learning-policy-snapshot-lock-order",
  );
  if (!shared) {
    if (requireRealDatabase) throw new Error("migration 0364 requires real PostgreSQL");
    available = false;
    console.warn("[migration-0364] PostgreSQL unavailable, skipping lock-order proof");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("migration 0364 workspace learning-policy snapshot lock order", () => {
  test("coexists with a canonical session-then-turn lifecycle writer without deadlock", async () => {
    if (!available) return;
    const fixture = await seedAttempt();
    const snapshotApplicationName = `learning-policy-snapshot-${crypto.randomUUID()}`;
    const writer = postgres(shared!.adminUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: `learning-policy-writer-${crypto.randomUUID()}` },
    });
    const snapshot = postgres(shared!.appUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: snapshotApplicationName },
    });
    const sessionLocked = deferred();
    const continueWriter = deferred();
    const deadlocksBefore = await deadlockCount();
    let writerCall: Promise<unknown> | undefined;
    let snapshotCall: Promise<Array<{ snapshotId: string }>> | undefined;

    try {
      writerCall = writer.begin(async (tx) => {
        await tx`
          select id from sessions
          where account_id = ${fixture.accountId}
            and workspace_id = ${fixture.workspaceId}
            and id = ${fixture.sessionId}
          for no key update`;
        sessionLocked.resolve();
        await continueWriter.promise;
        await tx`
          select id from session_turns
          where account_id = ${fixture.accountId}
            and workspace_id = ${fixture.workspaceId}
            and session_id = ${fixture.sessionId}
            and id = ${fixture.turnId}
          for update`;
      });
      void writerCall.catch(() => undefined);
      await within(sessionLocked.promise, 10_000, "Lifecycle writer did not lock the session");

      snapshotCall = snapshot.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${fixture.workspaceId}, true)`;
        return await tx<Array<{ snapshotId: string }>>`
          select snapshot_id as "snapshotId"
          from workspace_learning_policy_get_or_create_snapshot(
            ${fixture.accountId}::uuid,
            ${fixture.workspaceId}::uuid,
            ${fixture.sessionId}::uuid,
            ${fixture.turnId}::uuid,
            ${fixture.attemptId}::uuid,
            ${fixture.executionGeneration}::integer
          )`;
      });
      void snapshotCall.catch(() => undefined);
      await waitForApplicationLock(snapshotApplicationName);

      continueWriter.resolve();
      const [snapshotRows] = await within(
        Promise.all([snapshotCall, writerCall]),
        10_000,
        "Learning-policy snapshot and lifecycle writer did not settle",
      );
      expect(snapshotRows).toHaveLength(1);
      expect(snapshotRows[0]?.snapshotId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(await deadlockCount()).toBe(deadlocksBefore);
    } catch (error) {
      if (nestedPostgresSqlState(error) === "40P01") {
        throw new Error(
          "Learning-policy snapshot deadlocked against the canonical session lifecycle order",
          { cause: error },
        );
      }
      throw error;
    } finally {
      continueWriter.resolve();
      await Promise.allSettled([writerCall, snapshotCall].filter(Boolean) as Promise<unknown>[]);
      await snapshot.end();
      await writer.end();
    }
  }, 180_000);

  test("holds the attempt fence through commit so interruption creation cannot cross revalidation", async () => {
    if (!available) return;
    const fixture = await seedAttempt();
    const snapshot = postgres(shared!.appUrl, { max: 1, prepare: false });
    const interruptionWriter = postgres(shared!.adminUrl, { max: 1, prepare: false });
    const snapshotCreated = deferred();
    const releaseSnapshot = deferred();
    const interruptionBackend = deferredValue<number>();
    const operationId = crypto.randomUUID();
    let snapshotCall: Promise<Array<{ snapshotId: string }>> | undefined;
    let interruptionCall: Promise<unknown> | undefined;

    try {
      snapshotCall = snapshot.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${fixture.workspaceId}, true)`;
        const rows = await tx<Array<{ snapshotId: string }>>`
          select snapshot_id as "snapshotId"
          from workspace_learning_policy_get_or_create_snapshot(
            ${fixture.accountId}::uuid,
            ${fixture.workspaceId}::uuid,
            ${fixture.sessionId}::uuid,
            ${fixture.turnId}::uuid,
            ${fixture.attemptId}::uuid,
            ${fixture.executionGeneration}::integer
          )`;
        snapshotCreated.resolve();
        await releaseSnapshot.promise;
        return rows;
      });
      void snapshotCall.catch(() => undefined);
      await within(snapshotCreated.promise, 10_000, "Snapshot transaction did not reach commit");

      interruptionCall = interruptionWriter.begin(async (tx) => {
        const [backend] = await tx<Array<{ pid: number }>>`
          select pg_backend_pid()::int as pid`;
        if (!backend) throw new Error("Interruption writer has no PostgreSQL backend");
        interruptionBackend.resolve(backend.pid);
        await tx`
          select id from session_turn_attempts
          where account_id = ${fixture.accountId}
            and workspace_id = ${fixture.workspaceId}
            and session_id = ${fixture.sessionId}
            and turn_id = ${fixture.turnId}
            and id = ${fixture.attemptId}
          for update`;
        await tx`
          insert into session_command_receipts (
            id, account_id, workspace_id, actor_type, actor_subject_id,
            action, target_session_id, target_turn_id, operation_key,
            canonical_request_hash
          ) values (
            ${operationId}, ${fixture.accountId}, ${fixture.workspaceId},
            'operator', 'operator:learning-policy-lock-order', 'steer',
            ${fixture.sessionId}, ${fixture.turnId},
            ${`learning-policy-interruption-${operationId}`}, ${"a".repeat(64)}
          )`;
        await tx`
          insert into session_attempt_interruptions (
            account_id, workspace_id, session_id, operation_id,
            attempt_id, kind, control_revision
          ) values (
            ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId},
            ${operationId}, ${fixture.attemptId}, 'steer', 1
          )`;
      });
      void interruptionCall.catch(() => undefined);
      const interruptionBackendPid = await within(
        interruptionBackend.promise,
        10_000,
        "Interruption writer did not establish a PostgreSQL backend",
      );
      await Promise.race([
        waitForBackendLock(interruptionBackendPid),
        interruptionCall.then(() => {
          throw new Error("Interruption writer completed before reaching the attempt fence");
        }),
      ]);

      const [beforeCommit] = await shared!.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from session_attempt_interruptions
        where operation_id = ${operationId}`;
      expect(beforeCommit?.count).toBe(0);

      releaseSnapshot.resolve();
      const [snapshotRows] = await within(
        Promise.all([snapshotCall, interruptionCall]),
        10_000,
        "Snapshot commit and interruption creation did not settle",
      );
      expect(snapshotRows).toHaveLength(1);
      const [interruption] = await shared!.admin<Array<{ state: string }>>`
        select state
        from session_attempt_interruptions
        where operation_id = ${operationId}
          and attempt_id = ${fixture.attemptId}`;
      expect(interruption?.state).toBe("pending");
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled(
        [snapshotCall, interruptionCall].filter(Boolean) as Promise<unknown>[],
      );
      await interruptionWriter.end();
      await snapshot.end();
    }
  }, 180_000);
});
