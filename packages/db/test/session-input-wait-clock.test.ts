import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import * as schema from "../src/schema";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  peekSessionWork,
  claimSessionWorkForAttempt,
  withWorkspaceRls,
  type Database,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const statements: string[] = [];
let traced: ReturnType<typeof postgres>;
let db: Database;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-input-wait-clock");
  if (!acquired) throw new Error("Input wait clock regression requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  traced = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    debug: (_connection, query) => statements.push(query),
  });
  db = drizzle(traced, { schema }) as unknown as Database;
  const [role] =
    await traced`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  expect(role!.rolsuper).toBe(false);
  expect(role!.rolbypassrls).toBe(false);
}, 180_000);
afterAll(async () => {
  await traced?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "input-wait-clock",
    accountExternalId: suffix,
    accountName: "Wait clock",
    workspaceExternalSource: "input-wait-clock",
    workspaceExternalId: suffix,
    workspaceName: "Wait clock",
    subjectId: `wait-clock-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  // Disposable administrator seeds historical state only. Every tested read and claim uses FORCE RLS.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into session_turns
      (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
       status, source, position, prompt, model, reasoning_effort, latency_mode,
       sandbox_backend, resources, tools, metadata, started_at, finished_at)
      values (${turnId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id}, ${crypto.randomUUID()},
        ${`session-${session.id}`}, 'completed', 'user', 1, 'turn', 'test-model', 'medium', 'standard',
        'none', '[]', '[]', '{}', now() - interval '2 seconds', now() - interval '1 second')`;
    await tx`update sessions set status='idle', active_turn_id=null,
      input_wait_turn_id=${turnId}, input_wait_until=now()+interval '1 hour',
      input_wait_reason='clock test', input_wait_set_at=now(), temporal_workflow_id=${`session-${session.id}`}
      where id=${session.id}`;
  });
  return { grant, session, turnId };
}

const standaloneClockCount = () =>
  statements.filter((query) => /^select now\(\) as now\s*$/i.test(query.trim())).length;

test("held wait keeps peek and claim decisions while avoiding an extra clock command", async () => {
  const ctx = await fixture();
  statements.length = 0;
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "held",
    waitTurnId: ctx.turnId,
  });
  expect(standaloneClockCount()).toBe(0);
  statements.length = 0;
  expect(
    await claimSessionWorkForAttempt(db, ctx.grant.workspaceId, {
      sessionId: ctx.session.id,
      workflowId: `session-${ctx.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    }),
  ).toEqual({ action: "unclaimed", reason: "no-work" });
  expect(standaloneClockCount()).toBe(0);
}, 60_000);

test("wait deadline uses the transaction clock, including exact equality and elapsed wall time", async () => {
  const ctx = await fixture();
  await withWorkspaceRls(db, ctx.grant.workspaceId, async (tx) => {
    const rows = await tx.execute(sql`select now() as transaction_time`);
    const value = rows[0]!.transaction_time;
    expect(typeof value).toBe("string"); // Drizzle preserves raw timestamp text for SQL expressions.
    const transactionTime = value instanceof Date ? value : new Date(String(value));
    expect(Number.isFinite(transactionTime.getTime())).toBe(true);
    for (const [offset, expected] of [
      [-1, "timeout"],
      [0, "timeout"],
      [100, "held"],
    ] as const) {
      await shared.admin`update sessions set input_wait_until=${new Date(transactionTime.getTime() + offset)} where id=${ctx.session.id}`;
      expect(await peekSessionWork(tx, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
        kind: "input-wait",
        disposition: expected,
      });
    }
    // The wall clock crosses the deadline; PostgreSQL now() is still the transaction's clock.
    await Bun.sleep(150);
    expect(await peekSessionWork(tx, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
      kind: "input-wait",
      disposition: "held",
    });
  });
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "timeout",
  });
}, 60_000);

test("missing and superseded waits never use the clock or leak into another workspace", async () => {
  const ctx = await fixture();
  const newerTurnId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into session_turns
      (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
       status, source, position, prompt, model, reasoning_effort, latency_mode,
       sandbox_backend, resources, tools, metadata, started_at, finished_at)
      select ${newerTurnId}, account_id, workspace_id, session_id, ${crypto.randomUUID()},
        temporal_workflow_id, status, source, position + 1, prompt, model, reasoning_effort,
        latency_mode, sandbox_backend, resources, tools, metadata, started_at, finished_at
      from session_turns where id=${ctx.turnId}`;
  });
  // A person's turn without a new wait does not retire the declaration.
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "held",
  });
  await shared.admin`update session_turns set source='system' where id=${newerTurnId}`;
  // Equal finish time: the later machine-turn position remains authoritative.
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "superseded",
  });
  await shared.admin`update session_turns set finished_at=null where id=${newerTurnId}`;
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "held",
  });
  await shared.admin`update session_turns set finished_at=null where id=${ctx.turnId}`;
  statements.length = 0;
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toMatchObject({
    kind: "input-wait",
    disposition: "superseded",
  });
  expect(standaloneClockCount()).toBe(0);
  await shared.admin`update sessions set input_wait_turn_id=null, input_wait_until=null,
    input_wait_reason=null, input_wait_set_at=null where id=${ctx.session.id}`;
  statements.length = 0;
  expect(await peekSessionWork(db, ctx.grant.workspaceId, ctx.session.id)).toEqual({
    kind: "idle",
  });
  expect(standaloneClockCount()).toBe(0);
  const foreign = await fixture();
  expect(
    await peekSessionWork(
      db,
      foreign.grant.workspaceId,
      ctx.session.id,
      false,
      foreign.grant.accountId,
    ),
  ).toEqual({ kind: "unavailable" });
}, 60_000);
