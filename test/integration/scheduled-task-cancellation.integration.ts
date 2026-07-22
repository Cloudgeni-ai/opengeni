import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  dbSql,
  enqueueSessionTurn,
  getSession,
  getSessionTurn,
  setSessionStatus,
} from "@opengeni/db";
import { acquireSharedTestDatabase, waitFor } from "@opengeni/testing";

type SharedDatabase = NonNullable<Awaited<ReturnType<typeof acquireSharedTestDatabase>>>;

describe("scheduled-task cancellation database fences", () => {
  let shared: SharedDatabase;
  let adminDb: ReturnType<typeof createDb>;
  let appDb: ReturnType<typeof createDb>;
  let accountId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("scheduled_cancel_fence");
    if (!acquired) {
      throw new Error("native PostgreSQL shared test database is unavailable");
    }
    shared = acquired;
    adminDb = createDb(shared.adminUrl, { rlsStrategy: "scoped" });
    appDb = createDb(shared.appUrl, { max: 4, rlsStrategy: "force" });
    const owner = await bootstrapWorkspace(adminDb.db, {
      accountExternalSource: "test:scheduled-cancel-fence",
      accountExternalId: crypto.randomUUID(),
      accountName: "Scheduled cancellation fence account",
      workspaceExternalSource: "test:scheduled-cancel-fence",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Scheduled cancellation fence workspace",
      subjectId: `test:scheduled-cancel-fence:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    accountId = owner.defaultAccountId!;
    workspaceId = owner.defaultWorkspaceId!;
    const appProbe = postgres(shared.appUrl, { max: 1 });
    try {
      const [identity] = await appProbe<
        {
          current_user: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }[]
      >`
        select current_user,
               (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
               (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls
      `;
      expect(identity).toMatchObject({
        current_user: "opengeni_app",
        rolsuper: false,
        rolbypassrls: false,
      });
      const forceRls = await shared.admin<{ relname: string; relforcerowsecurity: boolean }[]>`
        select relname, relforcerowsecurity
        from pg_class
        where relname in ('sessions', 'session_turns')
        order by relname
      `;
      expect(forceRls).toEqual([
        { relname: "session_turns", relforcerowsecurity: true },
        { relname: "sessions", relforcerowsecurity: true },
      ]);
    } finally {
      await appProbe.end();
    }
  }, 180_000);

  afterAll(async () => {
    await appDb?.close();
    await adminDb?.close();
    await shared?.release();
  }, 60_000);

  test("serializes a queued-turn edit and cancellation without 40P01", async () => {
    const fixture = await queuedTurn("queued edit cancellation");
    const connectionA = postgres(shared.appUrl, { max: 1 });
    const connectionB = postgres(shared.appUrl, { max: 1 });
    let releaseA!: () => void;
    let allowEdit!: () => void;
    let editFinished!: () => void;
    let turnLocked!: () => void;
    let cancelStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const editGate = new Promise<void>((resolve) => {
      allowEdit = resolve;
    });
    const editDone = new Promise<void>((resolve) => {
      editFinished = resolve;
    });
    const cancellationStarted = new Promise<void>((resolve) => {
      cancelStarted = resolve;
    });
    const turnLock = new Promise<void>((resolve) => {
      turnLocked = resolve;
    });
    let cancellationPid = 0;

    const edit = connectionA.begin(async (sql) => {
      await setRls(sql);
      await sql`select id from session_turns where id = ${fixture.turnId} for update`;
      turnLocked();
      await editGate;
      await sql`update session_turns set prompt = 'edited while cancellation waits' where id = ${fixture.turnId}`;
      editFinished();
      await release;
    });
    let cancelPromise: Promise<unknown> | undefined;

    try {
      // Start cancellation only after A owns the turn. Its trigger then owns
      // the session and waits on A's turn drain; A's UPDATE must not wait back
      // on the session (the old 0059 deadlock).
      await turnLock;
      cancelPromise = connectionB.begin(async (sql) => {
        await setRls(sql);
        const [pid] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        cancellationPid = Number(pid?.pid);
        cancelStarted();
        await sql`update sessions set status = 'cancelled', active_turn_id = null where id = ${fixture.sessionId}`;
      });
      await cancellationStarted;
      await waitFor(
        async () => {
          const rows = await shared.admin<Array<{ waiting: number }>>`
            select count(*)::int as waiting
            from pg_stat_activity
            where pid = ${cancellationPid} and wait_event_type = 'Lock'
          `;
          return (rows[0]?.waiting ?? 0) === 1;
        },
        { timeoutMs: 10_000, intervalMs: 25 },
      );
      allowEdit();
      await editDone;
      releaseA();
      await Promise.all([edit, cancelPromise!]);
    } finally {
      allowEdit();
      releaseA();
      await Promise.allSettled([edit, ...(cancelPromise ? [cancelPromise] : [])]);
      await connectionA.end();
      await connectionB.end();
    }

    expect((await getSession(appDb.db, workspaceId, fixture.sessionId))?.status).toBe("cancelled");
    expect((await getSessionTurn(appDb.db, workspaceId, fixture.turnId))?.status).toBe("cancelled");
  });

  test("FORCE-RLS target deletion is restricted and cannot become task-owned fallback", async () => {
    const target = await createSession(appDb.db, {
      accountId,
      workspaceId,
      initialMessage: "deletion-fenced target",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(appDb.db, {
      accountId,
      workspaceId,
      name: "deletion-fenced target task",
      status: "active",
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "keep this thread", resources: [], tools: [], metadata: {} },
      targetSessionId: target.id,
      metadata: {},
    });

    const [foreignKey] = await shared.admin<
      {
        delete_rule: string;
        definition: string;
      }[]
    >`
      select c.confdeltype as delete_rule, pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
       where c.conname = 'scheduled_tasks_target_session_id_fk'
         and c.conrelid = 'scheduled_tasks'::regclass
    `;
    expect(foreignKey).toMatchObject({ delete_rule: "r" });
    expect(foreignKey?.definition).toContain("ON DELETE RESTRICT");

    await expect(
      withRlsContext(appDb.db, { accountId, workspaceId }, (scopedDb) =>
        scopedDb.execute(dbSql`delete from sessions where id = ${target.id}`),
      ),
    ).rejects.toThrow(/scheduled_tasks_target_session_id_fk|foreign key/i);

    expect((await getSession(appDb.db, workspaceId, target.id))?.id).toBe(target.id);
    const [physicalTask] = await shared.admin<{ target_session_id: string | null }[]>`
      select target_session_id::text from scheduled_tasks where id = ${task.id}
    `;
    expect(physicalTask?.target_session_id).toBe(target.id);
  });

  test("legacy promotion and cancellation serialize, then cancelled claim is rejected", async () => {
    const fixture = await queuedTurn("legacy promotion cancellation");
    const connectionA = postgres(shared.appUrl, { max: 1 });
    const connectionB = postgres(shared.appUrl, { max: 1 });
    let releaseLegacy!: () => void;
    let legacySessionLocked!: () => void;
    let cancelStarted!: () => void;
    let cancellationPid = 0;
    const release = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    const sessionLocked = new Promise<void>((resolve) => {
      legacySessionLocked = resolve;
    });
    const cancellationStarted = new Promise<void>((resolve) => {
      cancelStarted = resolve;
    });

    const legacy = connectionA.begin(async (sql) => {
      await setRls(sql);
      await sql`select id from sessions where id = ${fixture.sessionId} for update`;
      legacySessionLocked();
      await sql`select id from session_turns where id = ${fixture.turnId} and status = 'queued' for update`;
      await sql`update session_turns set status = 'running', started_at = now() where id = ${fixture.turnId}`;
      await release;
      await sql`update sessions set status = 'running', active_turn_id = ${fixture.turnId} where id = ${fixture.sessionId}`;
    });
    await sessionLocked;

    const cancellation = connectionB.begin(async (sql) => {
      await setRls(sql);
      const [pid] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      cancellationPid = Number(pid?.pid);
      cancelStarted();
      await sql`update sessions set status = 'cancelled', active_turn_id = null where id = ${fixture.sessionId}`;
    });
    await cancellationStarted;
    await waitFor(
      async () => {
        const rows = await shared.admin<Array<{ waiting: number }>>`
          select count(*)::int as waiting
          from pg_stat_activity
          where pid = ${cancellationPid} and wait_event_type = 'Lock'
        `;
        return (rows[0]?.waiting ?? 0) === 1;
      },
      { timeoutMs: 10_000, intervalMs: 25 },
    );
    releaseLegacy();
    await Promise.all([legacy, cancellation]);
    await connectionA.end();
    await connectionB.end();

    expect((await getSession(appDb.db, workspaceId, fixture.sessionId))?.status).toBe("cancelled");
    expect((await getSessionTurn(appDb.db, workspaceId, fixture.turnId))?.status).toBe("cancelled");

    const cancelled = await queuedTurn("legacy claim after cancellation");
    await setSessionStatus(appDb.db, workspaceId, cancelled.sessionId, "cancelled", null);
    const postCancel = postgres(shared.appUrl, { max: 1 });
    try {
      await postCancel.begin(async (sql) => {
        await setRls(sql);
        await sql`select id from sessions where id = ${cancelled.sessionId} for update`;
        const rows = await sql<{ id: string }[]>`
          select id from session_turns
          where id = ${cancelled.turnId} and status = 'queued'
          for update skip locked
        `;
        if (rows.length > 0) {
          await sql`update session_turns set status = 'running' where id = ${cancelled.turnId}`;
          await sql`update sessions set status = 'running', active_turn_id = ${cancelled.turnId} where id = ${cancelled.sessionId}`;
        }
      });
    } finally {
      await postCancel.end();
    }
    expect((await getSession(appDb.db, workspaceId, cancelled.sessionId))?.status).toBe(
      "cancelled",
    );
    expect((await getSessionTurn(appDb.db, workspaceId, cancelled.turnId))?.status).toBe(
      "cancelled",
    );
  });

  async function queuedTurn(
    initialMessage: string,
  ): Promise<{ sessionId: string; turnId: string }> {
    const session = await createSession(appDb.db, {
      accountId,
      workspaceId,
      initialMessage,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [event] = await appendSessionEvents(appDb.db, workspaceId, session.id, [
      { type: "user.message", payload: { text: initialMessage } },
    ]);
    const turn = await enqueueSessionTurn(appDb.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: event!.id,
      temporalWorkflowId: `session-${session.id}`,
      source: "scheduled_task",
      prompt: initialMessage,
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
    });
    return { sessionId: session.id, turnId: turn.id };
  }

  async function setRls(sql: postgres.TransactionSql): Promise<void> {
    await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
    await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
  }
});
