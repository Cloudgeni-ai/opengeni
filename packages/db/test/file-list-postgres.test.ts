import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  createDb,
  listFilesForSubject,
  setSubjectRlsContext,
  withRlsContext,
  withSessionRlsActorContext,
  type Database,
} from "../src";
import { rawRows } from "../src/database";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("file-list");
  if (!acquired) throw new Error("PostgreSQL unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Organization = {
  accountId: string;
  /** Personal workspace of `person`. */
  personal: string;
  shared: string;
  other: string;
  person: string;
  colleague: string;
};

async function organization(): Promise<Organization> {
  const org = {
    accountId: crypto.randomUUID(),
    personal: crypto.randomUUID(),
    shared: crypto.randomUUID(),
    other: crypto.randomUUID(),
    person: `user:${crypto.randomUUID()}`,
    colleague: `user:${crypto.randomUUID()}`,
  };
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${org.accountId},'File list')`;
  for (const id of [org.personal, org.shared, org.other]) {
    await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${id},${org.accountId},'Files')`;
    await shared.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id)
      VALUES(${id},${org.accountId})`;
  }
  await shared.admin`INSERT INTO organization_memberships(account_id,subject_id,status,personal_workspace_id)
    VALUES(${org.accountId},${org.person},'active',${org.personal})`;
  return org;
}

type FileRow = {
  workspace: string;
  owner?: string;
  /** Workspaces an Only me file also reaches; null for every workspace. */
  reach?: string[] | null;
  status?: string;
  at: string;
};

async function insertFile(org: Organization, row: FileRow): Promise<string> {
  const id = crypto.randomUUID();
  await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,
      content_type,size_bytes,bucket,object_key,private_owner_subject_ids,owner_subject_id,
      reach_workspace_ids,created_at)
    VALUES(${id},${org.accountId},${row.workspace},${row.status ?? "ready"},'f.txt','f.txt',
      'text/plain',1,'test',${id},${row.owner ? [row.owner] : null},${row.owner ?? null},
      ${row.reach === undefined ? [] : row.reach}::uuid[],${row.at}::timestamptz)`;
  return id;
}

/** Bytes a Google Drive source sync imported: the provider ACL refuses them. */
async function protectAsGoogleDriveImport(org: Organization, fileId: string) {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      with provider as (
        insert into knowledge_providers(account_id, scope_kind, scope_key, provider_key,
          external_tenant_id, operation_id, input_hash, actor_kind, actor_subject_id)
        values (${org.accountId}, 'organization', 'organization:-:-', 'google-drive', ${fileId},
          ${`provider-${fileId}`}, ${"a".repeat(64)}, 'service', 'test')
        returning id
      ), source as (
        insert into knowledge_sources(account_id, scope_kind, scope_key, provider_id,
          external_source_id, source_kind, operation_id, input_hash, actor_kind, actor_subject_id)
        select ${org.accountId}, 'organization', 'organization:-:-', provider.id, 'drive', 'folder',
          ${`source-${fileId}`}, ${"b".repeat(64)}, 'service', 'test' from provider
        returning id
      )
      insert into knowledge_document_versions(account_id, scope_kind, scope_key, source_id,
        object_id, version_generation, external_version_id, content_sha256, ingestion_key,
        acl_version_id, acl_generation, operation_id, input_hash, actor_kind, actor_subject_id,
        file_id)
      select ${org.accountId}, 'organization', 'organization:-:-', source.id, gen_random_uuid(), 1,
        'v1', ${"c".repeat(64)}, 'ingest', gen_random_uuid(), 1, ${`version-${fileId}`},
        ${"d".repeat(64)}, 'service', 'test', ${fileId}::uuid from source`;
  });
}

type Reader = {
  org: Organization;
  workspaceId: string;
  /** The authenticated person; null for a read without one. */
  subjectId: string | null;
  scope?: "all" | "workspace" | "personal";
};

function asReader<T>(reader: Reader, run: () => Promise<T>): Promise<T> {
  return reader.subjectId
    ? withSessionRlsActorContext(
        { subjectId: reader.subjectId, privateFileOwnerSubjectId: reader.subjectId },
        run,
      )
    : run();
}

async function listAll(reader: Reader, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await asReader(reader, () =>
      listFilesForSubject(client.db, {
        accountId: reader.org.accountId,
        workspaceId: reader.workspaceId,
        subjectId: reader.subjectId,
        ...(reader.scope ? { scope: reader.scope } : {}),
        limit,
        cursor,
      }),
    );
    expect(page.files.length).toBeLessThanOrEqual(limit);
    ids.push(...page.files.map((file) => file.id));
    if (!page.nextCursor) return ids;
    expect(page.files).toHaveLength(limit);
    cursor = page.nextCursor;
  }
  throw new Error("File list did not end");
}

/**
 * The visibility rule as the single statement before migration 1407 wrote it:
 * every ready file of the organization that reaches this workspace, filtered
 * by row-level security and the provider ACL, newest first.
 */
async function visibleFiles(reader: Reader): Promise<string[]> {
  const { org, workspaceId, subjectId } = reader;
  return await asReader(reader, () =>
    withRlsContext(client.db, { accountId: org.accountId, workspaceId }, async (tx) => {
      if (subjectId) await setSubjectRlsContext(tx, subjectId);
      const rows = await rawRows<{ id: string }>(
        tx,
        sql`select id from files
          where account_id = ${org.accountId}::uuid and status = 'ready'
            and (workspace_id = ${workspaceId}::uuid or (private_owner_subject_ids is not null and (
              ${subjectId === null ? sql`false` : sql`(select get_workspace_kind(${org.accountId}::uuid, ${workspaceId}::uuid)) = 'personal'`}
              or reach_workspace_ids is null or ${workspaceId}::uuid = any(reach_workspace_ids))))
            and ${
              reader.scope === "workspace"
                ? sql`private_owner_subject_ids is null`
                : reader.scope === "personal"
                  ? sql`private_owner_subject_ids is not null`
                  : sql`true`
            }
            and google_drive_file_authorized(${org.accountId}::uuid, ${workspaceId}::uuid,
              ${subjectId}::text, id)
          order by created_at desc, id desc`,
      );
      return rows.map((row) => row.id);
    }),
  );
}

test("file pages list exactly the visible files, newest first, across every kind of file", async () => {
  const org = await organization();
  const { person, colleague } = org;
  const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 12, n)).toISOString();
  const rows: FileRow[] = [
    { workspace: org.shared, at: minute(1) },
    // Same instant as the shared file above: ties break by id across indexes.
    { workspace: org.shared, owner: person, at: minute(1) },
    { workspace: org.shared, owner: colleague, at: minute(2) },
    { workspace: org.other, at: minute(3) },
    { workspace: org.other, owner: person, reach: [], at: minute(4) },
    { workspace: org.other, owner: person, reach: [org.shared], at: minute(5) },
    { workspace: org.other, owner: person, reach: null, at: minute(6) },
    { workspace: org.other, owner: person, reach: [org.personal], at: minute(7) },
    { workspace: org.personal, owner: person, reach: [], at: minute(8) },
    { workspace: org.personal, owner: person, reach: null, at: minute(9) },
    { workspace: org.personal, at: minute(10) },
    { workspace: org.shared, owner: colleague, reach: null, at: minute(11) },
    { workspace: org.other, owner: colleague, reach: [org.shared], at: minute(12) },
    { workspace: org.shared, status: "expired", at: minute(13) },
    { workspace: org.shared, owner: person, status: "pending_upload", at: minute(14) },
    { workspace: org.shared, at: minute(15) },
    { workspace: org.shared, owner: person, at: minute(16) },
  ];
  const ids: string[] = [];
  for (const row of rows) ids.push(await insertFile(org, row));
  // Newest in its workspace, and refused by the provider ACL: pages skip it.
  await protectAsGoogleDriveImport(org, ids[15]!);
  await protectAsGoogleDriveImport(org, ids[16]!);

  const readers: Reader[] = [
    { org, workspaceId: org.shared, subjectId: person },
    { org, workspaceId: org.shared, subjectId: person, scope: "workspace" },
    { org, workspaceId: org.shared, subjectId: person, scope: "personal" },
    { org, workspaceId: org.personal, subjectId: person },
    { org, workspaceId: org.personal, subjectId: person, scope: "personal" },
    { org, workspaceId: org.other, subjectId: person },
    { org, workspaceId: org.shared, subjectId: colleague },
    { org, workspaceId: org.other, subjectId: colleague, scope: "personal" },
    { org, workspaceId: org.shared, subjectId: null },
  ];
  for (const reader of readers) {
    const expected = await visibleFiles(reader);
    for (const limit of [1, 2, 50]) expect(await listAll(reader, limit)).toEqual(expected);
  }
  // The rule above is not vacuous: spot-check what it lets people see.
  const pick = (...rows: number[]) => rows.map((row) => ids[row]!);
  const tied = pick(0, 1).sort().reverse();
  expect(await visibleFiles(readers[0]!)).toEqual([...pick(9, 6, 5), ...tied]);
  expect(await visibleFiles(readers[3]!)).toEqual(pick(10, 9, 8, 7, 6, 5, 4, 1));
  expect(await visibleFiles(readers[6]!)).toEqual(pick(12, 11, 2, 0));
}, 120_000);

/** Rows of `files` read, and provider ACL checks run, by this transaction. */
async function readCosts(tx: Database) {
  const [row] = await rawRows<{ file_rows: number; authorizations: number }>(
    tx,
    sql`select
      coalesce(sum(idx_tup_fetch + seq_tup_read) filter (where relname = 'files'), 0)::int as file_rows,
      coalesce(sum(n_tup_ins) filter (
        where relname = 'google_drive_object_acl_runtime_capabilities'), 0)::int as authorizations
      from pg_stat_xact_user_tables
      where relname in ('files', 'google_drive_object_acl_runtime_capabilities')`,
  );
  return { fileRows: row!.file_rows, authorizations: row!.authorizations };
}

test("a file page reads about one page of rows however many files the organization has", async () => {
  const org = await organization();
  const { person, colleague } = org;
  const many = 2_000;
  // Each set is newest where it would hurt most: before a page of what the
  // reader can see, in the order a whole-organization scan would meet it.
  const bulk = async (input: {
    workspace: string;
    owner: string | null;
    reach: string[] | null;
    status?: string;
    newestSecondsAgo: number;
  }) => {
    await shared.admin`INSERT INTO files(account_id,workspace_id,status,filename,safe_filename,
        content_type,size_bytes,bucket,object_key,private_owner_subject_ids,owner_subject_id,
        reach_workspace_ids,created_at)
      SELECT ${org.accountId},${input.workspace},${input.status ?? "ready"},'f.txt','f.txt',
        'text/plain',1,'test',gen_random_uuid()::text,
        ${input.owner ? [input.owner] : null},${input.owner},${input.reach}::uuid[],
        now() - make_interval(secs => ${input.newestSecondsAgo} + n)
      FROM generate_series(1, ${many}) n`;
  };
  await bulk({ workspace: org.personal, owner: person, reach: [], newestSecondsAgo: 0 });
  await bulk({ workspace: org.shared, owner: colleague, reach: [], newestSecondsAgo: 0 });
  await bulk({ workspace: org.other, owner: null, reach: [], newestSecondsAgo: 0 });
  await bulk({
    workspace: org.shared,
    owner: null,
    reach: [],
    status: "expired",
    newestSecondsAgo: 0,
  });
  await bulk({ workspace: org.shared, owner: null, reach: [], newestSecondsAgo: 10_000 });
  await bulk({ workspace: org.other, owner: person, reach: null, newestSecondsAgo: 20_000 });
  await shared.admin`analyze files`;

  const limit = 5;
  const readers: Reader[] = [
    { org, workspaceId: org.shared, subjectId: person },
    { org, workspaceId: org.personal, subjectId: person },
    { org, workspaceId: org.shared, subjectId: colleague },
    { org, workspaceId: org.other, subjectId: colleague, scope: "personal" },
  ];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    for (const reader of readers) {
      // Prepared statements reach a generic plan after a few runs; cover both.
      for (let run = 0; run < 2; run++) {
        const costs = await asReader(reader, () =>
          client.db.transaction(async (tx) => {
            await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
            const before = await readCosts(tx);
            const page = await listFilesForSubject(tx, {
              accountId: org.accountId,
              workspaceId: reader.workspaceId,
              subjectId: reader.subjectId,
              ...(reader.scope ? { scope: reader.scope } : {}),
              limit,
            });
            const after = await readCosts(tx);
            return {
              files: page.files.length,
              fileRows: after.fileRows - before.fileRows,
              authorizations: after.authorizations - before.authorizations,
            };
          }),
        );
        // The organization has 12,000 files. One page reads at most a page
        // from each index walk, plus one provider ACL check per candidate.
        const label = `${mode}: ${reader.subjectId === person ? "person" : "colleague"} in ${
          reader.workspaceId === org.personal ? "Personal" : "a shared workspace"
        }, ${reader.scope ?? "all"}`;
        expect({ label, files: costs.files }).toEqual({
          label,
          files: reader.scope === "personal" ? 0 : limit,
        });
        expect(costs.authorizations).toBeLessThanOrEqual(limit + 1);
        expect(costs.fileRows).toBeLessThanOrEqual(5 * (limit + 1));
      }
    }
  }
}, 180_000);

test("a caller that goes away cancels the running file list statement", async () => {
  const org = await organization();
  await insertFile(org, { workspace: org.shared, at: new Date().toISOString() });
  const abort = new AbortController();
  const gone = new Error("client went away");
  let outcome: Promise<unknown> | undefined;
  await shared.admin.begin(async (lock) => {
    // Hold the table so the list statement is still executing when the caller leaves.
    await lock`lock table files in access exclusive mode`;
    const listing = withSessionRlsActorContext(
      { subjectId: org.person, privateFileOwnerSubjectId: org.person },
      () =>
        listFilesForSubject(client.db, {
          accountId: org.accountId,
          workspaceId: org.shared,
          subjectId: org.person,
          signal: abort.signal,
        }),
    );
    outcome = listing.then(
      () => null,
      (error: unknown) => error,
    );
    let waiting = false;
    for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
      const [row] = await shared.admin<{ n: number }[]>`select count(*)::int n
        from pg_stat_activity
        where datname = current_database() and usename <> current_user
          and wait_event_type = 'Lock' and query like '%from "files"%'`;
      waiting = (row?.n ?? 0) > 0;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    const start = performance.now();
    abort.abort(gone);
    const error = (await outcome) as { cause?: unknown } | null;
    // The query layer may wrap the abort reason as the error's cause.
    expect(error === gone || error?.cause === gone).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
    // Still holding the lock: the statement is gone, not merely abandoned.
    const [left] = await shared.admin<{ n: number }[]>`select count(*)::int n
      from pg_stat_activity
      where datname = current_database() and usename <> current_user
        and state = 'active' and query like '%from "files"%'`;
    expect(left?.n).toBe(0);
  });
  // The pool's connection is clean afterwards.
  const page = await withSessionRlsActorContext(
    { subjectId: org.person, privateFileOwnerSubjectId: org.person },
    () =>
      listFilesForSubject(client.db, {
        accountId: org.accountId,
        workspaceId: org.shared,
        subjectId: org.person,
      }),
  );
  expect(page.files).toHaveLength(1);
}, 60_000);
