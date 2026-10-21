import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  beginSessionRealtimeInTransaction,
  bootstrapWorkspace,
  createDb,
  createSession,
  withRlsContext,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migration = "0875_realtime_history_reference_index.sql";
const indexName = "session_realtime_entries_history_item_idx";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("realtime-history-reference", {
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

test("online history-reference index removes repeated full scans without changing SET NULL", async () => {
  const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  const parsed = parseConcurrentIndexMigration(migration, source)!;
  expect(parsed).toMatchObject({ indexName, skipWhenValid: false });
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "History index",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "History index",
    subjectId: `subject:${id}`,
  });
  const scope = { accountId: grant!.accountId, workspaceId: grant!.workspaceId };
  const create = () =>
    createSession(client.db, {
      ...scope,
      initialMessage: "History index fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
  const target = await create();
  const unrelated = await create();
  const start = (sessionId: string) =>
    withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (tx) =>
      beginSessionRealtimeInTransaction(tx, {
        ...scope,
        sessionId,
        operationId: crypto.randomUUID(),
        ownerSubjectId: grant!.subjectId,
        browserInstanceId: crypto.randomUUID(),
        ownerKey: crypto.randomUUID(),
        model: "gpt-live-1-boulder-alpha",
      }),
    );
  const targetMode = await start(target.id);
  const otherMode = await start(unrelated.id);
  // Historical fixture construction skips write-time triggers, using real
  // parent identities. The measured purge runs all ordinary FK/write triggers.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into session_history_items(account_id,workspace_id,session_id,position,item)
      select ${scope.accountId},${scope.workspaceId},${target.id},i,'{}'::jsonb from generate_series(1,1000) i`;
    await tx`insert into session_realtime_entries(account_id,workspace_id,session_id,realtime_id,operation_id,connection_epoch,sequence,direction,kind)
      select ${scope.accountId},${scope.workspaceId},${unrelated.id},${otherMode.mode.id},gen_random_uuid(),1,i,'provider_in','error' from generate_series(1,30000) i`;
    await tx`update sessions set content_archive_state='archived',content_archive_started_at=now(),content_archived_at=now(),content_archive='{"sha256":"fixture"}'::jsonb where id=${target.id}`;
  });
  const [history] =
    await shared.admin`select id from session_history_items where session_id=${target.id} order by position limit 1`;
  const [linked] =
    await shared.admin`insert into session_realtime_entries(account_id,workspace_id,session_id,realtime_id,operation_id,connection_epoch,sequence,direction,kind,history_item_id)
    values (${scope.accountId},${scope.workspaceId},${target.id},${targetMode.mode.id},gen_random_uuid(),1,1,'provider_in','error',${history!.id}) returning id`;
  await shared.admin`analyze session_realtime_entries`;
  await shared.admin`analyze session_history_items`;

  const explain = async () => {
    // This is the FK trigger's lookup: it has no workspace or realtime id.
    const [row] = await shared.admin`explain (analyze, buffers, format json)
      select 1 from session_realtime_entries where history_item_id=${history!.id}::uuid for update`;
    return row!["QUERY PLAN"][0];
  };
  const rollback = new Error("rollback benchmark batch");
  const purge = async () => {
    const began = performance.now();
    try {
      await withRlsContext(client.db, scope, async (tx) => {
        const rows = await tx.execute(
          sql`select opengeni_private.purge_archived_session_content(${scope.workspaceId}::uuid,${target.id}::uuid,'session_history_items',1000) as deleted`,
        );
        expect((rows as unknown as { deleted: number }[])[0]!.deleted).toBe(1000);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return performance.now() - began;
  };
  const beforePlan = await explain();
  expect(JSON.stringify(beforePlan)).toContain("Seq Scan");
  const beforeMs = [];
  for (let sample = 0; sample < 3; sample++) beforeMs.push(await purge());
  // Execute the exact rolling migration, outside a transaction, twice to
  // verify retry idempotence. This fixture alone owns this isolated database.
  await shared.admin.unsafe(parsed.statement);
  await shared.admin.unsafe(parsed.statement);
  const afterPlan = await explain();
  expect(JSON.stringify(afterPlan)).toContain(indexName);
  expect(JSON.stringify(afterPlan)).not.toContain("Seq Scan");
  const afterMs = [];
  for (let sample = 0; sample < 3; sample++) afterMs.push(await purge());
  const [index] =
    await shared.admin`select indisvalid,indisready from pg_index where indexrelid=${indexName}::regclass`;
  expect(index).toMatchObject({ indisvalid: true, indisready: true });
  // Do not assert noisy timing thresholds. Pin the bounded plan and genuine FK
  // behavior, while optionally reporting the paired real-purge measurement.
  if (process.env.OPENGENI_BENCH_HISTORY_PURGE === "1")
    console.log(
      JSON.stringify({
        unrelatedRows: 30000,
        deletedRows: 1000,
        beforeMs,
        afterMs,
        beforePlan,
        afterPlan,
      }),
    );
  await withRlsContext(client.db, scope, (tx) =>
    tx.execute(
      sql`select opengeni_private.purge_archived_session_content(${scope.workspaceId}::uuid,${target.id}::uuid,'session_history_items',1000)`,
    ),
  );
  const [retained] =
    await shared.admin`select history_item_id from session_realtime_entries where id=${linked!.id}`;
  expect(retained!.history_item_id).toBeNull();
  const [untouched] =
    await shared.admin`select count(*)::int as count from session_realtime_entries where session_id=${unrelated.id}`;
  expect(untouched!.count).toBe(30000);
}, 60_000);
