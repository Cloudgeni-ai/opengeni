import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  getWorkspace,
  withWorkspaceRls,
  listDueWorkspacePauseTimers,
  setWorkspacePauseTimerInTransaction,
  fireWorkspacePauseTimerInTransaction,
  mutateWorkspaceControlInTransaction,
  type Database,
} from "../src/index";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("workspace-pause-timers"))!;
  if (!shared) throw new Error("Real PostgreSQL required");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});
async function fixture() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Timers",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Timers",
    subjectId: id,
  });
  const grant = access.workspaceGrants[0]!;
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId: id };
  const transaction = <T>(fn: (db: Database) => Promise<T>) =>
    withWorkspaceRls(client.db, context.workspaceId, (scoped) =>
      scoped.transaction((tx) => fn(tx as unknown as Database)),
    );
  const control = async () =>
    (await getWorkspace(client.db, context.workspaceId))!.inferenceControl;
  const set = async (pauseInSeconds = 60, pauseForSeconds: number | null = 120) => {
    const request = {
      ...context,
      action: "set" as const,
      pauseInSeconds,
      pauseForSeconds,
      expectedRevision: (await control()).revision,
      clientEventId: crypto.randomUUID(),
    };
    await transaction((db) => setWorkspacePauseTimerInTransaction(db, request));
    return request;
  };
  const due = () =>
    transaction((db) =>
      db.execute(
        sql`update workspace_inference_controls set timer_due_at = clock_timestamp() - interval '1 second' where workspace_id = ${context.workspaceId}`,
      ),
    );
  const fire = (timerId: string) =>
    transaction((db) =>
      fireWorkspacePauseTimerInTransaction(db, { workspaceId: context.workspaceId, timerId }),
    );
  const manual = (action: "pause" | "resume", operationKey = crypto.randomUUID()) =>
    transaction((db) =>
      mutateWorkspaceControlInTransaction(db, {
        ...context,
        action,
        operationKey,
        actor: { type: "human", subjectId: id },
      }),
    );
  return { ...context, transaction, control, set, due, fire, manual };
}

test("delayed pause then full duration resume, durable discovery and concurrent retries", async () => {
  const f = await fixture();
  await f.set(60, 120);
  const timer = (await f.control()).timer!;
  expect((await f.control()).state).toBe("active");
  expect(await f.fire(timer.id)).toBeNull();
  await f.due();
  expect(await listDueWorkspacePauseTimers(client.db)).toContainEqual({
    workspace_id: f.workspaceId,
    timer_id: timer.id,
  });
  const applied = await Promise.all([f.fire(timer.id), f.fire(timer.id)]);
  expect(applied.filter(Boolean)).toHaveLength(1);
  const paused = await f.control();
  expect(paused.state).toBe("paused");
  expect(paused.timer?.action).toBe("resume");
  expect(Date.parse(paused.timer!.dueAt) - Date.now()).toBeGreaterThan(115000);
  // Recreate the connection to prove no process-local timer owns the obligation.
  const restarted = createDb(shared.appUrl);
  expect((await getWorkspace(restarted.db, f.workspaceId))!.inferenceControl.timer?.id).toBe(
    timer.id,
  );
  await restarted.close();
  await f.due();
  await f.fire(timer.id);
  expect((await f.control()).state).toBe("active");
  expect((await f.control()).timer).toBeNull();
  expect(await f.fire(timer.id)).toBeNull();
}, 30000);

test("immediate finite pause, edit resume duration, cancel leaves paused", async () => {
  const f = await fixture();
  await f.set(0, 60);
  expect((await f.control()).state).toBe("paused");
  await f.set(0, 3600);
  expect(Date.parse((await f.control()).timer!.dueAt) - Date.now()).toBeGreaterThan(3590000);
  await f
    .transaction((db) =>
      setWorkspacePauseTimerInTransaction(db, {
        ...f,
        action: "cancel",
        expectedRevision: 0,
        clientEventId: crypto.randomUUID(),
      }),
    )
    .then(
      () => {
        throw new Error("stale edit accepted");
      },
      (error) => expect(error.constructor.name).toBe("SessionControlConflictError"),
    );
  const control = await f.control();
  await f.transaction((db) =>
    setWorkspacePauseTimerInTransaction(db, {
      ...f,
      action: "cancel",
      expectedRevision: control.revision,
      clientEventId: crypto.randomUUID(),
    }),
  );
  expect((await f.control()).state).toBe("paused");
  expect((await f.control()).timer).toBeNull();
});

test("manual no-op resume cancels delayed pause; replay cannot cancel its replacement", async () => {
  const f = await fixture();
  await f.set();
  const old = (await f.control()).timer!;
  const key = crypto.randomUUID();
  await f.manual("resume", key);
  expect((await f.control()).timer).toBeNull();
  await f.set();
  const newer = (await f.control()).timer!;
  await f.manual("resume", key);
  expect((await f.control()).timer?.id).toBe(newer.id);
  await f.due();
  expect(await f.fire(old.id)).toBeNull();
  expect((await f.control()).state).toBe("active");
});

test("manual pause cancels timed resume; replayed set cannot resurrect it", async () => {
  const f = await fixture();
  const request = await f.set(0, 60);
  const old = (await f.control()).timer!;
  await f.manual("pause");
  expect((await f.control()).timer).toBeNull();
  await f.transaction((db) => setWorkspacePauseTimerInTransaction(db, request));
  expect((await f.control()).timer).toBeNull();
  expect(await f.fire(old.id)).toBeNull();
  expect((await f.control()).state).toBe("paused");
});

test("indefinite delayed pause and immediate indefinite pause leave no resume", async () => {
  const f = await fixture();
  await f.set(60, null);
  const id = (await f.control()).timer!.id;
  await f.due();
  await f.fire(id);
  expect((await f.control()).state).toBe("paused");
  expect((await f.control()).timer).toBeNull();
  await f.manual("resume");
  await f.set(0, null);
  expect((await f.control()).state).toBe("paused");
  expect((await f.control()).timer).toBeNull();
});

test("RLS denies a cross-workspace mutation", async () => {
  const a = await fixture();
  const b = await fixture();
  await expect(
    a.transaction((db) =>
      setWorkspacePauseTimerInTransaction(db, {
        accountId: b.accountId,
        workspaceId: b.workspaceId,
        subjectId: a.subjectId,
        action: "set",
        pauseInSeconds: 60,
        expectedRevision: 0,
        clientEventId: crypto.randomUUID(),
      }),
    ),
  ).rejects.toThrow();
  expect((await b.control()).timer).toBeNull();
});

test("timer resume preserves an independently paused session", async () => {
  const {
    createSession,
    mutateSessionControlInTransaction,
    evaluateSessionControl,
    withWorkspaceSessionActivityRls,
  } = await import("../src/index");
  const f = await fixture();
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: "Wait here",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await withWorkspaceSessionActivityRls(client.db, f.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      actor: { type: "human", subjectId: f.subjectId },
      operationKey: crypto.randomUUID(),
      action: "pause",
    }),
  );
  await f.set(0, 60);
  const id = (await f.control()).timer!.id;
  await f.due();
  await f.fire(id);
  expect((await f.control()).state).toBe("active");
  expect(
    await f.transaction((db) => evaluateSessionControl(db, f.workspaceId, session.id)),
  ).toMatchObject({ state: "paused", directState: "paused" });
});

test("forged discovery flag grants the app no cross-tenant table access", async () => {
  const f = await fixture();
  await f.set();
  const rows = await client.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.pause_timer_discovery', '1', true)`);
    return await tx.execute(
      sql`select workspace_id from workspace_inference_controls where workspace_id = ${f.workspaceId}`,
    );
  });
  expect(rows).toHaveLength(0);
});
