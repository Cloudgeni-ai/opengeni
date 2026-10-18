import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { rawRows } from "../src/database";
import {
  SESSION_ARCHIVE_EXPORT_TABLES,
  SESSION_ARCHIVE_PURGE_TABLES,
  SessionArchivedError,
  abandonSessionArchive,
  applySessionTurnSettlement,
  beginSessionArchive,
  bootstrapWorkspace,
  claimSessionArchiveObjectDeletions,
  claimSessionWorkForAttempt,
  completeSessionArchive,
  completeSessionArchiveObjectDeletion,
  createDb,
  createSession,
  deleteSessionTreeIfQuiescent,
  getSession,
  listSessionArchiveCandidates,
  persistModelContextSnapshot,
  purgeArchivedSessionContent,
  readSessionArchiveTablePages,
  readSessionArchiveTranscriptEvents,
  readSessionEventStorageGapEnd,
  sessionArchiveExportSql,
  setSessionKeepLive,
  submitHumanPromptInTransaction,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  type Database,
  type SessionArchiveExportTable,
  type SessionArchiveManifest,
  type SessionArchiveScope,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const IDLE_SECONDS = 30 * 24 * 60 * 60;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-archive");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function send(scope: SessionArchiveScope, subjectId: string, text: string) {
  return withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        ...scope,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
}

/** A session with one settled turn, purgeable content, and timestamps backdated past the idle period. */
async function idleSession(options: { backdateDays?: number } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Session archive",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Session archive",
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
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
  };
  await send(scope, grant.subjectId, "Summarize the plan");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  await persistModelContextSnapshot(client.db, {
    ...scope,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    snapshot: {
      version: 1,
      capturedAt: new Date().toISOString(),
      source: "model_request",
      requestIndex: 1,
      instructions: "Be helpful.",
      providerRequest: { provider: "openai", body: '{"input":[]}', parts: [] },
      layers: [],
      tools: [],
      skills: [],
      tokens: { instructions: 3, tools: 0, prefix: 3 },
    },
  });
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "agent.message.delta", payload: { delta: "The plan" } },
      { type: "agent.model.request", payload: { model: "scripted-model", phase: "response" } },
      { type: "agent.message.completed", payload: { text: "The plan is ready." } },
      { type: "turn.completed", payload: { output: "The plan is ready." } },
    ],
  });
  await shared.admin`insert into session_history_items
    (id, account_id, workspace_id, session_id, turn_id, position, item, created_at, active)
    values (${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
      ${claimed.turn.id}, 1, ${shared.admin.json({ type: "message", role: "assistant" })}, now(), true)`;
  const days = options.backdateDays ?? 45;
  // Simulate elapsed time only: bypass activity triggers for this fixture write.
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set created_at = created_at - make_interval(days => ${days}),
        updated_at = updated_at - make_interval(days => ${days})
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    await sql`update sessions set created_at = created_at - make_interval(days => ${days}),
        updated_at = updated_at - make_interval(days => ${days})
      where workspace_id = ${scope.workspaceId} and id = ${scope.sessionId}`;
  });
  return { scope, subjectId: grant.subjectId };
}

async function countRows(table: string, scope: SessionArchiveScope): Promise<number> {
  const [row] = await shared.admin.unsafe(
    `select count(*)::int as count from ${table} where workspace_id = $1 and session_id = $2`,
    [scope.workspaceId, scope.sessionId],
  );
  return (row as unknown as { count: number }).count;
}

async function exportAll(
  db: Database,
  scope: SessionArchiveScope,
  spec: SessionArchiveExportTable,
  pageRows: number,
): Promise<string[][]> {
  const pages: string[][] = [];
  for await (const rows of readSessionArchiveTablePages(db, scope, spec, { pageRows })) {
    pages.push(rows);
  }
  return pages;
}

function exportSpec(table: string): SessionArchiveExportTable {
  return SESSION_ARCHIVE_EXPORT_TABLES.find((spec) => spec.table === table)!;
}

type PlanNode = {
  "Node Type": string;
  "Index Cond"?: string;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};

/**
 * EXPLAIN ANALYZE as the application role under the session's RLS context,
 * with the planner's own choices: the point is whether the page's bound is an
 * index condition or a filter applied after the policy.
 */
async function explainUnderRls(db: Database, scope: SessionArchiveScope, query: SQL) {
  const [row] = await withRlsContext(db, scope, async (scoped) =>
    rawRows<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      scoped,
      drizzleSql`explain (analyze, format json) ${query}`,
    ),
  );
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    node.Plans?.forEach(walk);
  };
  walk(row!["QUERY PLAN"][0].Plan);
  return {
    indexConds: nodes.flatMap((node) => (node["Index Cond"] ? [node["Index Cond"]] : [])),
    rowsRemoved: nodes.reduce((sum, node) => sum + (node["Rows Removed by Filter"] ?? 0), 0),
  };
}

function manifest(keys: string[]): SessionArchiveManifest {
  return {
    format: "opengeni.session-archive",
    version: 1,
    objectKeys: keys,
    bundle: { key: keys[0]!, bytes: 10, sha256: "a".repeat(64) },
    transcript: { key: keys[1]!, bytes: 5, sha256: "b".repeat(64), events: 3 },
    sha256: "a".repeat(64),
    rowCounts: {},
    createdAt: new Date().toISOString(),
  };
}

describe("idle-session archive lifecycle", () => {
  test("archives an idle session, refuses new work, purges bulky content and keeps the readable timeline", async () => {
    const { scope, subjectId } = await idleSession();
    const candidates = await listSessionArchiveCandidates(client.db, {
      idleSeconds: IDLE_SECONDS,
      limit: 100,
    });
    expect(candidates.map((candidate) => candidate.sessionId)).toContain(scope.sessionId);

    const keys = [`archive/${scope.sessionId}/bundle`, `archive/${scope.sessionId}/transcript`];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(true);
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(false);
    await expect(send(scope, subjectId, "one more thing")).rejects.toBeInstanceOf(
      SessionArchivedError,
    );

    // Every export table is readable for the bundle while archiving.
    // A fresh pool: no connection carries a human subject from earlier calls,
    // like the archive worker's own pool.
    const exporter = createDb(shared.appUrl);
    const exported: Record<string, number> = {};
    for (const spec of SESSION_ARCHIVE_EXPORT_TABLES) {
      const rows = (await exportAll(exporter.db, scope, spec, 1000)).flat();
      exported[spec.table] = rows.length;
      for (const row of rows) expect(typeof JSON.parse(row)).toBe("object");
      // The rendering carries exactly the values jsonb would, column for column.
      const order = spec.keys.map((key) => `t."${key.column}"`).join(", ");
      const reference = await shared.admin.unsafe(
        `select to_jsonb(t)::text as row from "${spec.table}" t
          where t.workspace_id = $1 and t.session_id = $2 order by ${order} limit 1000`,
        [scope.workspaceId, scope.sessionId],
      );
      expect(rows.map((row) => JSON.parse(row))).toEqual(
        reference.map((row) => JSON.parse((row as unknown as { row: string }).row)),
      );
      // Paging one row at a time yields the same rows: the keyset is unique
      // and each cursor resumes exactly after the last row.
      expect((await exportAll(exporter.db, scope, spec, 1)).flat()).toEqual(rows);
    }
    expect(exported.session_events).toBeGreaterThan(3);
    expect(exported.session_history_items).toBeGreaterThanOrEqual(1);
    expect(exported.session_attempt_model_context_snapshots).toBe(1);
    expect(exported.session_turns).toBeGreaterThanOrEqual(1);
    // Visible only to the initiating human under RLS, yet part of the bundle.
    expect(exported.preference_registry_snapshots).toBe(1);
    await exporter.close();

    const transcript = await readSessionArchiveTranscriptEvents(client.db, scope, {
      afterSequence: 0,
      limit: 1000,
    });
    expect(transcript.some((event) => event.type === "agent.message.completed")).toBe(true);
    expect(transcript.some((event) => event.type === "agent.message.delta")).toBe(false);

    // Purge refuses until the archive is verified and recorded.
    await expect(
      purgeArchivedSessionContent(client.db, scope, { batchSize: 100 }),
    ).rejects.toThrow();
    expect(await completeSessionArchive(client.db, scope, manifest(keys))).toBe(true);
    let step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });
    while (!step.complete)
      step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });

    for (const table of SESSION_ARCHIVE_PURGE_TABLES.filter((name) => name !== "session_events")) {
      expect(await countRows(table, scope)).toBe(0);
    }
    const remaining = await shared.admin`select type from session_events
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    const types = remaining.map((row) => row.type as string);
    expect(types).toContain("agent.message.completed");
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("agent.message.delta");
    expect(types).not.toContain("agent.model.request");
    expect(await countRows("session_turns", scope)).toBeGreaterThanOrEqual(1);

    // Readers learn which missing sequences storage omits on purpose.
    const kept = (
      await shared.admin`select sequence from session_events
        where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}
        order by sequence`
    ).map((row) => Number(row.sequence));
    const [lastSequence] = await shared.admin`select last_sequence from sessions
      where id = ${scope.sessionId}`;
    for (const [index, sequence] of kept.entries()) {
      const next = kept[index + 1];
      expect(
        await readSessionEventStorageGapEnd(
          client.db,
          scope.workspaceId,
          scope.sessionId,
          sequence,
        ),
      ).toBe(next === undefined ? Number(lastSequence!.last_sequence) : next - 1);
    }

    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive?.state).toBe("archived");
    expect(session?.retention?.archive?.archivedAt).toBeString();

    // The setting cannot change once archived, and work is still refused.
    expect((await setSessionKeepLive(client.db, { ...scope, keepLive: true })).status).toBe(
      "archived",
    );
    await expect(send(scope, subjectId, "still there?")).rejects.toBeInstanceOf(
      SessionArchivedError,
    );

    // A recorded archive is permanent, even for a direct writer.
    // postgres.js queries are lazy thenables; run it inside a real promise.
    const reopen = async () => {
      await shared.admin`update sessions set content_archive_state = null,
          content_archive_started_at = null, content_archived_at = null, content_archive = null,
          content_archive_purged_at = null
        where id = ${scope.sessionId}`;
    };
    await expect(reopen()).rejects.toThrow(/SESSION_ARCHIVED_READ_ONLY/);

    // Deleting the session queues its archive objects for deletion.
    expect(
      (
        await deleteSessionTreeIfQuiescent(client.db, {
          workspaceId: scope.workspaceId,
          subjectId,
          sessionId: scope.sessionId,
        })
      ).status,
    ).toBe("deleted");
    const claims = await claimSessionArchiveObjectDeletions(client.db, {
      claimTimeoutSeconds: 600,
      limit: 1000,
    });
    expect(
      claims
        .filter((claim) => claim.sessionId === scope.sessionId)
        .map((c) => c.objectKey)
        .sort(),
    ).toEqual([...keys].sort());
    for (const key of keys)
      expect(await completeSessionArchiveObjectDeletion(client.db, key)).toBe(true);
  }, 120_000);

  test("keep-live, recent activity and pending human input keep a session live", async () => {
    const kept = await idleSession();
    expect((await setSessionKeepLive(client.db, { ...kept.scope, keepLive: true })).status).toBe(
      "updated",
    );
    const recent = await idleSession({ backdateDays: 3 });
    const waiting = await idleSession();
    await shared.admin`insert into session_human_input_requests
      (id, account_id, workspace_id, session_id, turn_id, turn_generation, creation_attempt_id,
       tool_call_id, status, questions, allow_skip, created_at, updated_at)
      select ${crypto.randomUUID()}, t.account_id, t.workspace_id, t.session_id, t.id, t.execution_generation,
        t.active_attempt_id, 'call-1', 'pending', '[]'::jsonb, true, now(), now()
      from session_turns t where t.workspace_id = ${waiting.scope.workspaceId}
        and t.session_id = ${waiting.scope.sessionId} limit 1`.catch(() => undefined);
    const eligible = await idleSession();
    // Bulk maintenance can touch updated_at on every row; that is not activity.
    const touched = await idleSession();
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set updated_at = now() where id = ${touched.scope.sessionId}`;
    });
    // Bookkeeping events appended to an idle session are not activity either;
    // a new or advanced turn is.
    const noted = await idleSession();
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update session_events set created_at = now()
        where session_id = ${noted.scope.sessionId}
          and sequence = (select last_sequence from sessions where id = ${noted.scope.sessionId})`;
    });
    const spoke = await idleSession();
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update session_turns set updated_at = now() where session_id = ${spoke.scope.sessionId}`;
    });

    const ids = (
      await listSessionArchiveCandidates(client.db, { idleSeconds: IDLE_SECONDS, limit: 100 })
    ).map((candidate) => candidate.sessionId);
    expect(ids).toContain(eligible.scope.sessionId);
    expect(ids).toContain(touched.scope.sessionId);
    expect(ids).toContain(noted.scope.sessionId);
    expect(ids).not.toContain(spoke.scope.sessionId);
    expect(ids).not.toContain(kept.scope.sessionId);
    expect(ids).not.toContain(recent.scope.sessionId);
    const [pending] =
      await shared.admin`select count(*)::int as count from session_human_input_requests
      where session_id = ${waiting.scope.sessionId} and status = 'pending'`;
    if ((pending as { count: number }).count > 0)
      expect(ids).not.toContain(waiting.scope.sessionId);
  }, 120_000);

  test("an abandoned archive returns the session to live and queues its planned objects", async () => {
    const { scope, subjectId } = await idleSession();
    const keys = [`archive/${scope.sessionId}/partial`];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(true);
    expect(await abandonSessionArchive(client.db, scope)).toBe(true);
    expect(await abandonSessionArchive(client.db, scope)).toBe(false);
    const session = await getSession(client.db, scope.workspaceId, scope.sessionId);
    expect(session?.retention?.archive).toBeNull();
    await send(scope, subjectId, "back to work");
    const claims = await claimSessionArchiveObjectDeletions(client.db, {
      claimTimeoutSeconds: 600,
      limit: 1000,
    });
    expect(claims.map((claim) => claim.objectKey)).toContain(keys[0]!);
  }, 120_000);

  test("purge completes around retained evidence and settles leftover pending tool output", async () => {
    const { scope } = await idleSession();
    const [turn] = await shared.admin`select id, execution_generation from session_turns
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId} limit 1`;
    const evidenceItem = crypto.randomUUID();
    const deliveredItem = crypto.randomUUID();
    const evidenceUpdate = crypto.randomUUID();
    const json = shared.admin.json;
    // Fixture only: a scheduled run's delivered occurrence (immutable evidence),
    // an ordinary delivered update, and a pending call that kept its event output.
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      for (const [id, position] of [
        [evidenceItem, 10],
        [deliveredItem, 11],
      ] as const)
        await sql`insert into session_history_items
          (id, account_id, workspace_id, session_id, turn_id, position, item, created_at, active)
          values (${id}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${turn!.id},
            ${position}, ${json({ type: "message", role: "user" })}, now(), true)`;
      for (const [id, kind, runId, itemId] of [
        [evidenceUpdate, "scheduled_occurrence", crypto.randomUUID(), evidenceItem],
        [crypto.randomUUID(), "agent_message", null, deliveredItem],
      ] as const)
        await sql`insert into session_system_updates
          (id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, payload,
            state, delivered_history_item_id, scheduled_task_run_id)
          values (${id}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${kind},
            ${id}, ${id}, 'update', ${json({ type: kind })}, 'delivered', ${itemId}, ${runId})`;
      await sql`insert into session_pending_tool_calls
        (account_id, workspace_id, session_id, turn_id, execution_generation, attempt_id, call_id,
          call_type, call_item, event_output, event_output_codec_version)
        values (${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${turn!.id},
          ${turn!.execution_generation}, ${crypto.randomUUID()}, 'call-1', 'function_call',
          ${json({ type: "function_call" })}, ${json({ value: "exact output" })}, 1)`;
    });

    const keys = [`archive/${scope.sessionId}/bundle`, `archive/${scope.sessionId}/transcript`];
    expect(
      await beginSessionArchive(client.db, scope, { idleSeconds: IDLE_SECONDS, objectKeys: keys }),
    ).toBe(true);
    expect(await completeSessionArchive(client.db, scope, manifest(keys))).toBe(true);
    let step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });
    while (!step.complete)
      step = await purgeArchivedSessionContent(client.db, scope, { batchSize: 1 });

    const [purged] = await shared.admin`select content_archive_purged_at from sessions
      where id = ${scope.sessionId}`;
    expect(purged!.content_archive_purged_at).not.toBeNull();
    const updates = await shared.admin`select id from session_system_updates
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    expect(updates.map((row) => row.id)).toEqual([evidenceUpdate]);
    const items = await shared.admin`select id from session_history_items
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
    expect(items.map((row) => row.id)).toEqual([evidenceItem]);
    expect(await countRows("session_pending_tool_calls", scope)).toBe(0);
  }, 120_000);
});

describe("idle-session archive export reads", () => {
  test("every export table pages by a unique id or seeks a single leakproof key", async () => {
    // Unique, non-partial btree indexes on a table, as ordered key column names.
    const uniqueIndexes = async (table: string) =>
      (
        await shared.admin<{ columns: string[] }[]>`select array(
            select a.attname::text from unnest(i.indkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where k.ord <= i.indnkeyatts order by k.ord) as columns
          from pg_index i
          where i.indrelid = ${table}::regclass and i.indisunique and i.indpred is null`
      ).map((row) => row.columns.join(","));
    for (const spec of SESSION_ARCHIVE_EXPORT_TABLES) {
      // Read through its own archive-only definer.
      if (spec.table === "preference_registry_snapshots") continue;
      if (spec.idColumn) {
        // Each id page is a seek on the id's own unique index.
        const [column] = await shared.admin<
          { type: string }[]
        >`select format_type(atttypid, atttypmod) as type
          from pg_attribute where attrelid = ${spec.table}::regclass and attname = ${spec.idColumn}`;
        expect({ table: spec.table, type: column?.type }).toEqual({
          table: spec.table,
          type: "uuid",
        });
        expect({ table: spec.table, unique: await uniqueIndexes(spec.table) }).toEqual({
          table: spec.table,
          unique: expect.arrayContaining([spec.idColumn]),
        });
        continue;
      }
      // A keyset cursor only seeks on one leakproof column, so a keyset table has
      // exactly one key, unique within the session.
      expect({ table: spec.table, keys: spec.keys.length }).toEqual({ table: spec.table, keys: 1 });
      const key = spec.keys[0]!;
      expect({ table: spec.table, unique: await uniqueIndexes(spec.table) }).toEqual({
        table: spec.table,
        unique: expect.arrayContaining([`workspace_id,session_id,${key.column}`]),
      });
      const operators = await shared.admin`select o.oprname, p.proleakproof
          from pg_operator o join pg_proc p on p.oid = o.oprcode
          where o.oprname in ('=', '>', '>=')
            and o.oprleft = ${key.cast}::regtype and o.oprright = ${key.cast}::regtype`;
      expect({ table: spec.table, key: key.column, operators: operators.length }).toEqual({
        table: spec.table,
        key: key.column,
        operators: 3,
      });
      for (const operator of operators) {
        expect({ table: spec.table, key: key.column, leakproof: operator.proleakproof }).toEqual({
          table: spec.table,
          key: key.column,
          leakproof: true,
        });
      }
    }
  });

  test("a long session exports completely and in order, with every page an indexed read under RLS", async () => {
    const { scope } = await idleSession();
    const [turn] = await shared.admin<{ id: string }[]>`select id::text as id from session_turns
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId} limit 1`;
    const rows = 1_500;
    await shared.admin.begin(async (tx) => {
      // Fixture volume only: bypass activity triggers for these writes.
      await tx`set local session_replication_role = replica`;
      // Half the positions are fractional, as when items are inserted between others.
      await tx`insert into session_history_items
          (account_id, workspace_id, session_id, turn_id, position, item, active)
        select ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${turn!.id},
          1 + n / 2.0, jsonb_build_object('type', 'message', 'n', n), true
        from generate_series(1, ${rows}) n`;
      await tx`insert into session_events
          (account_id, workspace_id, session_id, turn_id, turn_association, sequence, type, payload, occurred_at)
        select ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${turn!.id}, 'current',
          b.base + n, 'agent.message.completed', jsonb_build_object('text', 'event ' || n), now()
        from generate_series(1, ${rows}) n,
          (select max(sequence) as base from session_events
            where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}) b`;
      // Copies of the session's turn at later positions, so turns (ordered by
      // two keys) also need many pages.
      const turnColumns = (
        await tx<{ name: string }[]>`select column_name as name from information_schema.columns
          where table_schema = current_schema() and table_name = 'session_turns'
            and column_name not in ('id', 'position') and is_generated = 'NEVER'
          order by ordinal_position`
      ).map((row) => tx(row.name));
      const columnList = turnColumns.reduce(
        (list, column) => tx`${list}, ${column}`,
        tx`id, position`,
      );
      const copyList = turnColumns.reduce(
        (list, column) => tx`${list}, ${column}`,
        tx`gen_random_uuid(), position + n`,
      );
      await tx`insert into session_turns (${columnList})
        select ${copyList} from session_turns, generate_series(1, ${rows}) n
        where id = ${turn!.id}::uuid`;
    });
    await shared.admin`analyze session_history_items`;
    await shared.admin`analyze session_events`;
    await shared.admin`analyze session_turns`;
    const exporter = createDb(shared.appUrl);
    try {
      const history = exportSpec("session_history_items");
      const pages = await exportAll(exporter.db, scope, history, 100);
      expect(pages.every((page) => page.length > 0 && page.length <= 100)).toBe(true);
      const reference = await shared.admin<{ id: string }[]>`select id::text as id
        from session_history_items
        where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}
        order by position, id`;
      expect(reference.length).toBeGreaterThan(rows);
      expect(pages.flat().map((row) => (JSON.parse(row) as { id: string }).id)).toEqual(
        reference.map((row) => row.id),
      );

      // Under the policy a numeric cursor is a filter after it: a late page
      // would re-read every earlier row. That is why history pages by id.
      const lastPosition = (JSON.parse(pages.at(-2)!.at(-1)!) as { position: number }).position;
      const numericCursor = await explainUnderRls(
        exporter.db,
        scope,
        sessionArchiveExportSql.keysetPage(scope, history, {
          after: [String(lastPosition), (JSON.parse(pages.at(-2)!.at(-1)!) as { id: string }).id],
          limit: 100,
        }),
      );
      expect(numericCursor.rowsRemoved).toBeGreaterThan(rows - 200);
      // The id page is a primary-key seek and filters nothing.
      const lastIds = reference.slice(-100).map((row) => row.id);
      const idPage = await explainUnderRls(
        exporter.db,
        scope,
        sessionArchiveExportSql.idPage(scope, history, lastIds),
      );
      expect(idPage.indexConds.some((cond) => cond.includes("id = ANY"))).toBe(true);
      expect(idPage.rowsRemoved).toBe(0);

      // Turns are ordered by (position, id): a two-key cursor would only bound
      // its first key, so they also page by id, in order, each page a seek.
      const turns = exportSpec("session_turns");
      const turnPages = await exportAll(exporter.db, scope, turns, 100);
      const turnReference = await shared.admin<{ id: string }[]>`select id::text as id
        from session_turns
        where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}
        order by position, id`;
      expect(turnReference.length).toBeGreaterThan(rows);
      expect(turnPages.flat().map((row) => (JSON.parse(row) as { id: string }).id)).toEqual(
        turnReference.map((row) => row.id),
      );
      const turnPage = await explainUnderRls(
        exporter.db,
        scope,
        sessionArchiveExportSql.idPage(
          scope,
          turns,
          turnReference.slice(-100).map((row) => row.id),
        ),
      );
      expect(turnPage.indexConds.some((cond) => cond.includes("id = ANY"))).toBe(true);
      expect(turnPage.rowsRemoved).toBe(0);

      // An integer keyset cursor is an index condition under the policy.
      const events = exportSpec("session_events");
      const [late] = await shared.admin<
        { sequence: number }[]
      >`select max(sequence) - 100 as sequence
        from session_events where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
      const eventPage = await explainUnderRls(
        exporter.db,
        scope,
        sessionArchiveExportSql.keysetPage(scope, events, {
          after: [String(late!.sequence)],
          limit: 100,
        }),
      );
      expect(eventPage.indexConds.some((cond) => cond.includes("sequence >"))).toBe(true);
      expect(eventPage.rowsRemoved).toBeLessThan(100);
      // And the whole table still exports completely through it.
      const eventRows = (await exportAll(exporter.db, scope, events, 200)).flat();
      expect(eventRows.length).toBe(await countRows("session_events", scope));

      // A row that disappears between the id list and its page fails the export.
      const iterator = readSessionArchiveTablePages(exporter.db, scope, history, { pageRows: 100 });
      expect((await iterator.next()).done).toBe(false);
      await shared.admin`delete from session_history_items where id = ${reference.at(-1)!.id}::uuid`;
      let failure: unknown;
      try {
        for (;;) if ((await iterator.next()).done) break;
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("the session changed while archiving");
    } finally {
      await exporter.close();
    }
  }, 120_000);
});
