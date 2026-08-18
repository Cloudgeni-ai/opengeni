import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0283_editable_spreadsheet_authored_state.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0283-editable-spreadsheet-authored-state");
  if (!blank && requireRealDatabase) {
    throw new Error("[migration-0283] real PostgreSQL harness is unavailable");
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0283 editable spreadsheet authored-state cutover", () => {
  test("keeps pre-cutover rows inert while enforcing only the current format on writes", async () => {
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await ensureApplicationRole(sql);
      await sql`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
      `);
      const files = (await readdir(migrationsDir))
        .filter((migrationFile) => migrationFile.endsWith(".sql"))
        .sort();
      for (const migrationFile of files.filter(
        (candidate) => candidate.localeCompare(migration) < 0,
      )) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
        await sql`insert into schema_migrations (name) values (${migrationFile}) on conflict do nothing`;
      }
      // Seed pre-cutover rows directly; this test targets CHECK-cutover behavior,
      // not the normal multi-row publication protocol already covered elsewhere.
      await sql.unsafe("set session_replication_role = replica");

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0283-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0283-workspace') returning id`;
      const artifactId = "a".repeat(32);
      const oldSnapshotId = "b".repeat(32);
      await sql`
        insert into editable_artifacts (
          account_id, workspace_id, id, modality, title, authorization_revision,
          causal_frontier, state_hash, created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${artifactId}, 'spreadsheet', 'Cutover workbook', 1,
          ${sql.json([])}, ${hash("1")}, 'migration-0283'
        )`;
      await sql`
        insert into editable_artifact_sequence_checkpoints (
          account_id, workspace_id, artifact_id, modality, head_sequence,
          causal_frontier, state_hash
        ) values (
          ${account!.id}, ${workspace!.id}, ${artifactId}, 'spreadsheet', 0,
          ${sql.json([])}, ${hash("1")}
        )`;
      await insertSnapshotBlob(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: oldSnapshotId,
        hash: hash("2"),
      });
      await insertSnapshot(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: oldSnapshotId,
        hash: hash("2"),
        modelSchemaVersion: 1,
        operationProtocolVersion: 1,
        crdtStateVersion: 1,
      });
      await insertTransaction(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: "e".repeat(32),
        clientTransactionId: "pre-cutover",
        sequence: 1,
        current: false,
      });

      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split("\n", 1)[0]).toBe("-- deployment-mode: maintenance");
      await sql.unsafe(migrationSql);

      const [oldRows] = await sql<{ count: number }[]>`
        select count(*)::int as count from editable_artifact_snapshots
        where artifact_id = ${artifactId} and model_schema_version = 1`;
      expect(oldRows?.count).toBe(1);
      const [oldTransactions] = await sql<{ count: number }[]>`
        select count(*)::int as count from editable_artifact_transactions
        where artifact_id = ${artifactId} and model_schema_version = 1`;
      expect(oldTransactions?.count).toBe(1);

      const rejectedSnapshotId = "c".repeat(32);
      await insertSnapshotBlob(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: rejectedSnapshotId,
        hash: hash("3"),
      });
      await expectFailure(
        insertSnapshot(sql, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          artifactId,
          id: rejectedSnapshotId,
          hash: hash("3"),
          modelSchemaVersion: 1,
          operationProtocolVersion: 1,
          crdtStateVersion: 1,
        }),
        "editable_artifact_snapshots_facts_chk",
      );

      const currentSnapshotId = "d".repeat(32);
      await insertSnapshotBlob(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: currentSnapshotId,
        hash: hash("4"),
      });
      await insertSnapshot(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: currentSnapshotId,
        hash: hash("4"),
        modelSchemaVersion: 2,
        operationProtocolVersion: 2,
        crdtStateVersion: 2,
      });

      await expectFailure(
        insertTransaction(sql, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          artifactId,
          id: "f".repeat(32),
          clientTransactionId: "rejected-old-write",
          sequence: 2,
          current: false,
        }),
        "editable_artifact_transactions_result_chk",
      );
      await insertTransaction(sql, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        artifactId,
        id: "1".repeat(32),
        clientTransactionId: "accepted-current-write",
        sequence: 2,
        current: true,
      });

      const constraints = await sql<
        Array<{ name: string; validated: boolean; definition: string }>
      >`
        select conname as name, convalidated as validated,
          pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'editable_artifact_transactions_result_chk',
          'editable_artifact_snapshots_facts_chk'
        )
        order by conname`;
      expect(constraints.map(({ name, validated }) => ({ name, validated }))).toEqual([
        { name: "editable_artifact_snapshots_facts_chk", validated: false },
        { name: "editable_artifact_transactions_result_chk", validated: false },
      ]);
      expect(constraints.find(({ name }) => name.includes("snapshots"))?.definition).toContain(
        "model_schema_version = 2",
      );
      const transactionDefinition = constraints.find(({ name }) =>
        name.includes("transactions"),
      )?.definition;
      expect(transactionDefinition).toContain("OGACO002");
      expect(transactionDefinition).not.toContain("OGACO001");
    } finally {
      await sql.end();
    }
  }, 180_000);
});

async function ensureApplicationRole(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'opengeni_app') then
        create role opengeni_app with login nosuperuser nobypassrls
          nocreaterole nocreatedb noreplication noinherit password 'migration-0283-test';
      end if;
    end $$;
  `);
}

async function insertSnapshotBlob(
  sql: postgres.Sql,
  input: Readonly<{
    accountId: string;
    workspaceId: string;
    artifactId: string;
    id: string;
    hash: string;
  }>,
): Promise<void> {
  await sql`
    insert into editable_artifact_blob_refs (
      account_id, workspace_id, artifact_id, id, kind, object_reference,
      byte_size, content_hash, mime_type
    ) values (
      ${input.accountId}, ${input.workspaceId}, ${input.artifactId}, ${input.id}, 'snapshot',
      ${`migration-0283/${input.id}`}, 64, ${input.hash},
      'application/vnd.opengeni.editable-artifact-snapshot'
    )`;
}

async function insertSnapshot(
  sql: postgres.Sql,
  input: Readonly<{
    accountId: string;
    workspaceId: string;
    artifactId: string;
    id: string;
    hash: string;
    modelSchemaVersion: number;
    operationProtocolVersion: number;
    crdtStateVersion: number;
  }>,
): Promise<void> {
  await sql`
    insert into editable_artifact_snapshots (
      account_id, workspace_id, artifact_id, modality, id, blob_ref_id,
      byte_size, content_hash, covered_head_sequence, covered_causal_frontier,
      state_hash, model_schema_version, operation_protocol_version, kernel_version,
      crdt_state_version, verified_at, published_at
    ) values (
      ${input.accountId}, ${input.workspaceId}, ${input.artifactId}, 'spreadsheet',
      ${input.id}, ${input.id}, 64, ${input.hash}, 0, ${sql.json([])}, ${hash("1")},
      ${input.modelSchemaVersion}, ${input.operationProtocolVersion}, 'migration-0283-kernel',
      ${input.crdtStateVersion}, now(), now()
    )`;
}

async function insertTransaction(
  sql: postgres.Sql,
  input: Readonly<{
    accountId: string;
    workspaceId: string;
    artifactId: string;
    id: string;
    clientTransactionId: string;
    sequence: number;
    current: boolean;
  }>,
): Promise<void> {
  const intentBytes = new TextEncoder().encode("OGATX001");
  const committedTransactionBytes = new TextEncoder().encode(
    input.current ? "OGACO002" : "OGACO001",
  );
  const requestHash = digest(intentBytes);
  const committedTransactionHash = digest(committedTransactionBytes);
  await sql`
    insert into editable_artifact_transactions (
      account_id, workspace_id, artifact_id, modality, id,
      client_transaction_id, previous_local_transaction_id,
      request_hash, intent_hash, intent_envelope_version, intent_protocol_version,
      command_protocol_version, intent_byte_size, intent_bytes,
      parent_head_sequence, sequence_start, sequence_end,
      prior_state_hash, causal_base, resolved_causal_base, resulting_causal_frontier,
      selective_undo_targets, state_hash, operation_count, operation_ids,
      actor_kind, actor_subject_id, actor_key, replica_id, replica_counter,
      kernel_version, model_schema_version, operation_protocol_version,
      commit_protocol_version, committed_transaction_byte_size,
      committed_transaction_hash, committed_transaction_bytes
    ) values (
      ${input.accountId}, ${input.workspaceId}, ${input.artifactId}, 'spreadsheet', ${input.id},
      ${input.clientTransactionId}, ${input.sequence === 1 ? null : "pre-cutover"},
      ${requestHash}, ${requestHash}, 1, 1,
      ${input.current ? 2 : 1}, ${intentBytes.byteLength}, ${intentBytes},
      ${input.sequence - 1}, ${input.sequence}, ${input.sequence},
      ${hash("5")}, ${sql.json([])}, ${sql.json([])},
      ${sql.json([{ replicaId: "0000000000000001", counter: input.sequence }])},
      ${sql.json([])}, ${hash("6")}, 1, ${sql.json([(input.sequence + 1).toString(16).repeat(32)])},
      'human', 'user:migration-0283', '["human","user:migration-0283"]',
      '0000000000000001', ${input.sequence},
      'migration-0283-kernel', ${input.current ? 2 : 1}, ${input.current ? 2 : 1},
      null, ${committedTransactionBytes.byteLength}, ${committedTransactionHash},
      ${committedTransactionBytes}
    )`;
}

async function expectFailure(work: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

function hash(nibble: string): string {
  return `sha256:${nibble.repeat(64)}`;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
