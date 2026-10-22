import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SESSION_EVENT_RAW_DELTA_TYPES } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventToSandboxGroup,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
} from "../src/index";
import {
  MEANINGFUL_SESSION_EVENT_TYPES,
  SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES,
} from "../src/session-meaningful-events";

const migration = "0904_infrastructure_events_keep_session_activity.sql";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("infrastructure-events-keep-activity", {
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
    accountName: "Infrastructure activity",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Infrastructure activity",
    subjectId: `subject:${id}`,
  });
  const session = await createSession(client.db, {
    accountId: grant!.accountId,
    workspaceId: grant!.workspaceId,
    initialMessage: "Activity fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { workspaceId: grant!.workspaceId, session };
}

const baseline = "2001-01-01T00:00:00.000Z";

async function resetActivity(sessionId: string) {
  await shared.admin`update sessions set updated_at=${baseline} where id=${sessionId}`;
  return await activity(sessionId);
}

async function activity(sessionId: string) {
  const [row] = await shared.admin`select s.updated_at, s.activity_xid::text as xid,
      s.last_sequence, c.last_sequence as cursor_sequence
    from sessions s join session_event_cursors c on c.session_id = s.id
    where s.id=${sessionId}`;
  return row as {
    updated_at: Date;
    xid: string;
    last_sequence: number;
    cursor_sequence: number;
  };
}

const reaperTermination = {
  type: "sandbox.box.terminated" as const,
  payload: { actor: "reaper", persisted: true, drainReason: "idle" },
};

test("the shared list matches the migration literal, raw deltas, and stays outside attention", async () => {
  const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  const literal = [...source.matchAll(/E'\s+''([a-z_.]+)'',?\\n'/g)].map((match) => match[1]);
  expect(literal).toEqual([...SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES]);
  expect(
    SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES.slice(0, SESSION_EVENT_RAW_DELTA_TYPES.length),
  ).toEqual([...SESSION_EVENT_RAW_DELTA_TYPES]);
  const attention = new Set<string>(MEANINGFUL_SESSION_EVENT_TYPES);
  expect(SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES.filter((type) => attention.has(type))).toEqual([]);
});

test("reaper and other infrastructure events no longer move a stopped session's activity", async () => {
  const { workspaceId, session } = await fixture();
  const meaningful = { type: "agent.message.completed" as const, payload: { text: "done" } };

  // Before 0904: the reaper fan-out stamped activity like a real turn.
  const legacyBefore = await resetActivity(session.id);
  await appendSessionEventToSandboxGroup(
    client.db,
    workspaceId,
    session.sandboxGroupId,
    reaperTermination,
  );
  const legacyAfter = await activity(session.id);
  expect(legacyAfter.updated_at.getTime()).toBeGreaterThan(Date.parse(baseline));
  expect(BigInt(legacyAfter.xid)).toBeGreaterThan(BigInt(legacyBefore.xid));

  const [postureBefore] = await shared.admin`select proowner,proacl,prosecdef,proconfig from pg_proc
    where oid='advance_session_event_cursors_for_inserted_events()'::regprocedure`;
  await shared.admin.unsafe(
    await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8"),
  );
  const [postureAfter] = await shared.admin`select proowner,proacl,prosecdef,proconfig from pg_proc
    where oid='advance_session_event_cursors_for_inserted_events()'::regprocedure`;
  expect(postureAfter).toEqual(postureBefore);

  // The reaper path: one event fanned out to the sandbox group.
  const before = await resetActivity(session.id);
  const [terminated] = await appendSessionEventToSandboxGroup(
    client.db,
    workspaceId,
    session.sandboxGroupId,
    reaperTermination,
  );
  expect(terminated!.sequence).toBe(before.cursor_sequence + 1);
  const afterReaper = await activity(session.id);
  expect(afterReaper.updated_at).toEqual(before.updated_at);
  expect(afterReaper.xid).toBe(before.xid);
  // The durable sequence and its compatibility projection still advance.
  expect(afterReaper.cursor_sequence).toBe(terminated!.sequence);
  expect(afterReaper.last_sequence).toBe(terminated!.sequence);
  const read = await getSession(client.db, workspaceId, session.id);
  expect(read!.updatedAt).toBe(baseline);
  expect(read!.lastSequence).toBe(terminated!.sequence);

  // Every listed infrastructure diagnostic and raw delta, in one statement.
  const neutral = await appendSessionEvents(
    client.db,
    workspaceId,
    session.id,
    SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES.map((type) => ({ type, payload: {} })),
  );
  const afterNeutral = await activity(session.id);
  expect(afterNeutral.updated_at).toEqual(before.updated_at);
  expect(afterNeutral.xid).toBe(before.xid);
  expect(afterNeutral.cursor_sequence).toBe(neutral.at(-1)!.sequence);

  // A box loss needs a person: it remains activity.
  await appendSessionEvents(client.db, workspaceId, session.id, [
    { type: "sandbox.box.lost", payload: {} },
  ]);
  const afterLoss = await activity(session.id);
  expect(afterLoss.updated_at.getTime()).toBeGreaterThan(Date.parse(baseline));
  expect(BigInt(afterLoss.xid)).toBeGreaterThan(BigInt(before.xid));

  // A real event in the same statement keeps the ordinary projection.
  const mixedBefore = await resetActivity(session.id);
  const mixed = await appendSessionEvents(client.db, workspaceId, session.id, [
    reaperTermination,
    meaningful,
  ]);
  const afterMixed = await activity(session.id);
  expect(afterMixed.updated_at.getTime()).toBeGreaterThan(Date.parse(baseline));
  expect(BigInt(afterMixed.xid)).toBeGreaterThan(BigInt(mixedBefore.xid));
  expect(afterMixed.last_sequence).toBe(mixed.at(-1)!.sequence);

  // A later neutral statement never moves the projection backwards.
  await appendSessionEventToSandboxGroup(
    client.db,
    workspaceId,
    session.sandboxGroupId,
    reaperTermination,
  );
  const afterLate = await activity(session.id);
  expect(afterLate.updated_at).toEqual(afterMixed.updated_at);
  expect(afterLate.xid).toBe(afterMixed.xid);
  expect(afterLate.last_sequence).toBe(afterLate.cursor_sequence);

  // Applying the patch again finds no anchors and fails closed, unchanged.
  const definitionBefore = await shared.admin`select pg_get_functiondef(
    'advance_session_event_cursors_for_inserted_events()'::regprocedure) as body`;
  const migrationSql = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  // postgres.js runs a query only when awaited, so await it inside the promise.
  await expect(
    (async () => {
      await shared.admin.unsafe(migrationSql);
    })(),
  ).rejects.toThrow("0904 session activity projection prerequisites differ");
  const definitionAfter = await shared.admin`select pg_get_functiondef(
    'advance_session_event_cursors_for_inserted_events()'::regprocedure) as body`;
  expect(definitionAfter[0]!.body).toBe(definitionBefore[0]!.body);
}, 60_000);
