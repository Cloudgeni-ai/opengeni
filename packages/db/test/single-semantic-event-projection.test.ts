import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  appendSessionEvents,
  appendSessionEventsForTurnAttempt,
  appendSessionEventToSandboxGroup,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  withWorkspaceSessionActivityRls,
  type Database,
} from "../src/index";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

const migration = "0877_single_semantic_event_projection.sql";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("single-semantic-projection", {
    withheldMigrations: [migration],
  });
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Event projection",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Event projection",
    subjectId: `subject:${id}`,
  });
  const session = await createSession(client.db, {
    accountId: grant!.accountId,
    workspaceId: grant!.workspaceId,
    initialMessage: "Projection fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant: grant!, session };
}

async function rowUpdates(db: Database) {
  const [row] = await db.execute<{ count: number }>(sql`
    select coalesce(sum(n_tup_upd),0)::int as count from pg_stat_xact_user_tables where relname='sessions'`);
  return row!.count;
}

test("one semantic projection preserves raw, mixed, rollback, legacy and exact-attempt behavior", async () => {
  const { grant, session } = await fixture();
  const events = [{ type: "agent.message.completed" as const, payload: { text: "complete" } }];
  const rollback = new Error("rollback measured append");
  const measure = async (legacy: boolean) => {
    let updates = -1;
    const started = performance.now();
    try {
      await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (tx) => {
        const before = await rowUpdates(tx);
        const inserted = await appendSessionEvents(tx, grant.workspaceId, session.id, events);
        if (legacy) {
          // The pre-change plain appender repeated this exact update after the
          // trigger's compatibility write. Reproduce it in the same transaction.
          await tx.execute(sql`update sessions set last_sequence=${inserted.at(-1)!.sequence},updated_at=now()
            where workspace_id=${grant.workspaceId} and id=${session.id}`);
        }
        updates = (await rowUpdates(tx)) - before;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return { updates, ms: performance.now() - started };
  };
  const walPosition = async () => {
    // Only the disposable-cluster benchmark wrapper enables this: these are
    // cluster-wide WAL counters, unsuitable for a shared test/deployment URL.
    if (process.env.OPENGENI_BENCH_EVENT_PROJECTION_WAL !== "1") return null;
    const [row] = await shared.admin`select pg_current_wal_insert_lsn()::text as lsn`;
    return row!.lsn as string;
  };
  const walBytes = async (start: string | null) => {
    if (start === null) return null;
    const [row] =
      await shared.admin`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${start}::pg_lsn)::float8 as bytes`;
    return row!.bytes as number;
  };
  for (let i = 0; i < 4; i++) await measure(true);
  const beforeWalStart = await walPosition();
  const before = [];
  for (let i = 0; i < 12; i++) before.push(await measure(true));
  expect(before.every((row) => row.updates === 2)).toBe(true);
  const beforeWalBytes = await walBytes(beforeWalStart);
  const [postureBefore] = await shared.admin`select proowner,proacl,prosecdef,proconfig from pg_proc
    where oid='advance_session_event_cursors_for_inserted_events()'::regprocedure`;
  const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  await shared.admin.unsafe(source);
  const [postureAfter] = await shared.admin`select proowner,proacl,prosecdef,proconfig from pg_proc
    where oid='advance_session_event_cursors_for_inserted_events()'::regprocedure`;
  expect(postureAfter).toEqual(postureBefore);
  for (let i = 0; i < 4; i++) await measure(false);
  const afterWalStart = await walPosition();
  const after = [];
  for (let i = 0; i < 12; i++) after.push(await measure(false));
  expect(after.every((row) => row.updates === 1)).toBe(true);
  const afterWalBytes = await walBytes(afterWalStart);
  if (process.env.OPENGENI_BENCH_EVENT_PROJECTION === "1")
    console.log(JSON.stringify({ before, after, beforeWalBytes, afterWalBytes }));

  const baseline = "2001-01-01T00:00:00.000Z";
  await shared.admin`update sessions set updated_at=${baseline} where id=${session.id}`;
  const [original] =
    await shared.admin`select last_sequence,activity_xid::text,updated_at from sessions where id=${session.id}`;
  await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.message.delta", payload: { text: "raw" } },
  ]);
  const [raw] =
    await shared.admin`select last_sequence,activity_xid::text,updated_at from sessions where id=${session.id}`;
  expect(raw!.last_sequence).toBe(original!.last_sequence + 1);
  expect(raw!.updated_at).toEqual(original!.updated_at);
  expect(raw!.activity_xid).toBe(original!.activity_xid);
  const mixed = await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.message.delta", payload: { text: "mixed" } },
    ...events,
  ]);
  const [semantic] =
    await shared.admin`select last_sequence,activity_xid::text,updated_at from sessions where id=${session.id}`;
  expect(semantic!.last_sequence).toBe(mixed.at(-1)!.sequence);
  expect(semantic!.updated_at.getTime()).toBeGreaterThan(Date.parse(baseline));
  expect(BigInt(semantic!.activity_xid)).toBeGreaterThan(BigInt(raw!.activity_xid));
  const [cursor] =
    await shared.admin`select last_sequence,last_meaningful_sequence from session_event_cursors where session_id=${session.id}`;
  expect(cursor!.last_sequence).toBe(semantic!.last_sequence);
  expect(cursor!.last_meaningful_sequence).toBe(semantic!.last_sequence);
  // A transaction started before a concurrent append must not restore its
  // transaction-start time when it later appends. No sleeping/timing threshold.
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (tx) => {
    const [started] = await tx.execute<{ start: string }>(sql`select now()::text as start`);
    await appendSessionEvents(client.db, grant.workspaceId, session.id, events);
    const concurrent = await getSession(client.db, grant.workspaceId, session.id);
    await appendSessionEvents(tx, grant.workspaceId, session.id, events);
    const own = await getSession(tx, grant.workspaceId, session.id);
    expect(Date.parse(own!.updatedAt)).toBeGreaterThan(Date.parse(started!.start));
    expect(Date.parse(own!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(concurrent!.updatedAt));
  });
  // A future existing timestamp must not move backwards due to clock skew.
  const future = "2099-01-01T00:00:00.000Z";
  await shared.admin`update sessions set updated_at=${future} where id=${session.id}`;
  const [futureBefore] =
    await shared.admin`select activity_xid::text as xid from sessions where id=${session.id}`;
  await appendSessionEvents(client.db, grant.workspaceId, session.id, events);
  expect((await getSession(client.db, grant.workspaceId, session.id))!.updatedAt).toBe(future);
  const [futureAfter] =
    await shared.admin`select activity_xid::text as xid from sessions where id=${session.id}`;
  expect(BigInt(futureAfter!.xid)).toBeGreaterThan(BigInt(futureBefore!.xid));

  const attempt = await fixture();
  await submitTestHumanPrompt(client.db, {
    ...attempt.grant,
    sessionId: attempt.session.id,
    text: "attempt",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, attempt.grant.workspaceId, {
    sessionId: attempt.session.id,
    attemptId,
    dispatchId: crypto.randomUUID(),
    workflowId: `session-${attempt.session.id}`,
    workflowRunId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Fixture turn not claimed");
  const append = (tx: Database, rawOnly: boolean) =>
    appendSessionEventsForTurnAttempt(
      tx,
      attempt.grant.workspaceId,
      attempt.session.id,
      claimed.turn.id,
      claimed.turn.executionGeneration,
      attemptId,
      rawOnly ? [{ type: "agent.message.delta", payload: { text: "raw" } }] : events,
    );
  for (const rawOnly of [true, false]) {
    await withWorkspaceSessionActivityRls(client.db, attempt.grant.workspaceId, async (tx) => {
      const initialUpdates = await rowUpdates(tx);
      expect((await append(tx, rawOnly)).accepted).toBe(true);
      expect((await rowUpdates(tx)) - initialUpdates).toBe(rawOnly ? 0 : 1);
    });
  }
  await withWorkspaceSessionActivityRls(client.db, attempt.grant.workspaceId, async (tx) => {
    const initialUpdates = await rowUpdates(tx);
    await appendSessionEventToSandboxGroup(
      tx,
      attempt.grant.workspaceId,
      attempt.session.sandboxGroupId,
      events[0]!,
    );
    expect((await rowUpdates(tx)) - initialUpdates).toBe(1);
  });
  // Rollback includes event, cursor, activity xid and timestamp together.
  const previous = await getSession(client.db, attempt.grant.workspaceId, attempt.session.id);
  try {
    await withWorkspaceSessionActivityRls(client.db, attempt.grant.workspaceId, async (tx) => {
      await append(tx, false);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(await getSession(client.db, attempt.grant.workspaceId, attempt.session.id)).toEqual(
    previous,
  );
  // An old appender's additional write remains legal after migration.
  expect((await measure(true)).updates).toBe(2);
}, 60_000);
