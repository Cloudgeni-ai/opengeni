// Migration 1515: App data changes as activity facts and workspace webhook
// deliveries. Facts are written only while someone listens, unchanged writes
// record nothing, row security narrows per-person records to who may read
// them, and webhook payloads leave out record contents they may not see.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  createDb,
  createPostgresSiteDataStore,
  createWorkspace,
  createWorkspaceArtifact,
  recordAppSqlChange,
  type DbClient,
  type SiteDataCaller,
  type SiteDataLimits,
} from "../src/index";

const limits: SiteDataLimits = {
  recordBytesPerSite: 1_000_000,
  maxRecordBytes: 10_000,
  maxCollectionsPerSite: 5,
  fileBytesPerSite: 1_000_000,
  maxFileBytes: 100_000,
  workspaceBytes: 10_000_000,
  maxRecordsPerCollection: 1_000,
  viewerWritesPerMinute: 1_000,
  siteWritesPerMinute: 1_000,
  viewerReadsPerMinute: 1_000,
  managerWritesPerMinute: 1_000,
  siteValidationMsPerMinute: 5_000,
  workspaceValidationMsPerMinute: 20_000,
};

let shared: SharedTestDatabase;
let client: DbClient;
let appSql: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-1515-app-change-events");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  appSql = postgres(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await appSql?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const OWNER = "app-owner";

async function app() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('App change events') returning id`;
  const accountId = String(account!.id);
  const workspaceId = (await createWorkspace(client.db, { accountId, name: "App events" })).id;
  const created = await createWorkspaceArtifact(client.db, {
    accountId,
    workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `app-events-${crypto.randomUUID().slice(0, 8)}`,
    title: "Leads",
    description: null,
    visibility: "workspace_shared",
    ownerSubjectId: OWNER,
    contentKey: `app-events/${crypto.randomUUID()}.html`,
    contentSha256: "a".repeat(64),
    sizeBytes: 16,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    operationKey: crypto.randomUUID(),
    actorSubjectId: OWNER,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  const caller = (subject: string, role: "manager" | "viewer"): SiteDataCaller => ({
    accountId,
    workspaceId,
    siteId: created.artifact.id,
    role,
    principal: `user:${subject}`,
    actor: `user:${subject}`,
    framed: false,
  });
  return { accountId, workspaceId, siteId: created.artifact.id, caller };
}

async function facts(workspaceId: string) {
  return await shared.admin<
    Array<{
      type: string;
      subject_id: string | null;
      reader_subject_id: string | null;
      reader_owner_only: boolean;
      data: Record<string, unknown>;
    }>
  >`select type, subject_id, reader_subject_id, reader_owner_only, data
    from workspace_activity_events where workspace_id = ${workspaceId} order by created_at, id`;
}

/** App facts the application role shows `subject` in this workspace. */
async function visibleTo(scope: { accountId: string; workspaceId: string }, subject: string) {
  return (await appSql.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${subject}, true)`;
    return await sql<Array<{ type: string; record_id: string }>>`
      select type, data->>'recordId' as record_id from workspace_activity_events
      where site_id is not null order by created_at, id`;
  })) as Array<{ type: string; record_id: string }>;
}

test("App writes record facts only while someone listens, and unchanged writes none", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await app();
  const manager = a.caller(OWNER, "manager");
  await store.defineCollection(manager, { name: "contacts", accessMode: "shared" }, limits);
  await store.write(
    manager,
    [{ op: "put", collection: "contacts", key: "ada", data: { name: "Ada" } }],
    { limits },
  );
  expect(await facts(a.workspaceId)).toHaveLength(0);

  await shared.admin`insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${a.accountId}, ${a.workspaceId}, 'https://example.test', 'sealed',
      array['app.record.added', 'app.record.changed', 'app.record.removed', 'app.sql.changed'])`;
  await store.write(
    manager,
    [
      { op: "put", collection: "contacts", key: "ada", data: { name: "Ada" } },
      { op: "put", collection: "contacts", key: "bob", data: { name: "Bob" } },
    ],
    { limits },
  );
  await store.write(
    manager,
    [
      {
        op: "put",
        collection: "contacts",
        key: "ada",
        data: { name: "Ada L." },
      },
    ],
    { limits },
  );
  const written = await facts(a.workspaceId);
  // The unchanged put of "ada" recorded nothing.
  expect(written.map((row) => [row.type, row.data.recordKey])).toEqual([
    ["app.record.added", "bob"],
    ["app.record.changed", "ada"],
  ]);
  expect(written[1]).toMatchObject({
    subject_id: OWNER,
    reader_subject_id: null,
    data: { collection: "contacts", record: { name: "Ada L." } },
  });

  const deliveries = await shared.admin<
    Array<{ event_type: string; payload: { data: Record<string, unknown> } }>
  >`
    select event_type, payload from workspace_webhook_deliveries
    where workspace_id = ${a.workspaceId} order by created_at, id`;
  expect(deliveries.map((row) => row.event_type)).toEqual([
    "app.record.added",
    "app.record.changed",
  ]);
  expect(deliveries[1]!.payload.data).toMatchObject({
    appId: a.siteId,
    chainDepth: 0,
    record: { name: "Ada L." },
  });

  // A write an automation run made carries the run and its chain depth, so
  // the chain limit stops an automation that triggers itself.
  const run = crypto.randomUUID();
  const task = crypto.randomUUID();
  await store.write(
    { ...manager, automationId: task, automationRunId: run, chainDepth: 3 },
    [{ op: "delete", collection: "contacts", key: "bob" }],
    { limits },
  );
  const [removed] = await shared.admin<
    Array<{
      chain_depth: number;
      automation_run_id: string;
      automation_id: string;
    }>
  >`
    select chain_depth, automation_run_id, automation_id from workspace_activity_events
    where workspace_id = ${a.workspaceId} and type = 'app.record.removed'`;
  expect(removed).toEqual({
    chain_depth: 3,
    automation_run_id: run,
    automation_id: task,
  });

  expect(
    await recordAppSqlChange(
      client.db,
      { accountId: a.accountId, workspaceId: a.workspaceId, siteId: a.siteId },
      { principal: `user:${OWNER}`, writerKind: "manager" },
      { query: "add_lead", rowsWritten: 2 },
    ),
  ).toBe(true);
  expect((await facts(a.workspaceId)).at(-1)).toMatchObject({
    type: "app.sql.changed",
    data: { query: "add_lead", rowsWritten: 2 },
  });
});

test("per-person records are visible to their owner and, unless private, the App's managers", async () => {
  const store = createPostgresSiteDataStore(client.db);
  const a = await app();
  await shared.admin`insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${a.accountId}, ${a.workspaceId}, 'https://example.test', 'sealed', array['app.record.added'])`;
  const manager = a.caller(OWNER, "manager");
  await store.defineCollection(manager, { name: "notes", accessMode: "per_viewer" }, limits);
  await store.defineCollection(
    manager,
    { name: "diary", accessMode: "per_viewer", privateRecords: true },
    limits,
  );
  const ada = a.caller("ada", "viewer");
  await store.write(ada, [{ op: "insert", collection: "notes", data: { text: "n" } }], { limits });
  await store.write(ada, [{ op: "insert", collection: "diary", data: { text: "d" } }], { limits });

  const written = await facts(a.workspaceId);
  expect(written.map((row) => [row.reader_subject_id, row.reader_owner_only])).toEqual([
    ["ada", false],
    ["ada", true],
  ]);
  expect((await visibleTo(a, "ada")).length).toBe(2);
  // The App's owner sees the per-person note but not the private diary entry.
  expect((await visibleTo(a, OWNER)).length).toBe(1);
  expect((await visibleTo(a, "bob")).length).toBe(0);

  // Webhooks never carry contents of records only some people may read.
  const deliveries = await shared.admin<Array<{ payload: { data: Record<string, unknown> } }>>`
    select payload from workspace_webhook_deliveries where workspace_id = ${a.workspaceId}`;
  expect(deliveries).toHaveLength(2);
  for (const delivery of deliveries) {
    expect(delivery.payload.data.record).toBeUndefined();
    expect(delivery.payload.data.recordWithheld).toBe(true);
  }
});
