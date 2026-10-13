// Migration 0739 adds `scheduled_tasks.vault_policy`. A schedule's execution
// digest hashes its whole row, so the new column must not change any stored
// digest: accepted run receipts and revision authorities stay bound to it, and
// later migrations (0753, 0754) refuse to run when a stored digest no longer
// reproduces. Schedules are saved on a database migrated to 0738, then 0739 is
// applied alone, then every later migration runs, as on a real upgrade.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(240_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0739_vaults.sql";

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("vault-schedule-digest");
  if (!database) throw new Error("Real PostgreSQL is required");
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 2 });
});

afterAll(async () => {
  await client?.close();
  await database?.release();
});

async function forgetMigrations(predicate: (name: string) => boolean): Promise<void> {
  const owner = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    const names = await owner<{ name: string }[]>`select name from schema_migrations`;
    for (const { name } of names) {
      if (predicate(name)) await owner`delete from schema_migrations where name = ${name}`;
    }
  } finally {
    await owner.end();
  }
  await migrate(database!.ownerUrl);
  await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
}

test.skipIf(!realDb)(
  "0739 keeps every schedule's execution digest and later migrations still run",
  async () => {
    const admin = database!.admin;
    const userId = `vault-schedule-digest-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Vault schedule digest",
    });
    const { accountId, workspaceId } = access.workspaceGrants[0]!;
    const owner = `user:${userId}`;
    const baseConfig = { prompt: "Check the inbox", tools: [], resources: [] };
    const pair = { serverId: "linear", connectionId: crypto.randomUUID() };
    const configs: Record<string, Record<string, unknown>> = {
      [crypto.randomUUID()]: baseConfig,
      // The write-back snapshot every save stored before 0753.
      [crypto.randomUUID()]: {
        ...baseConfig,
        connectionAccounts: [pair],
        connectionAccountsFrozen: true,
      },
    };
    const insertTask = async (
      id: string,
      config: Record<string, unknown>,
      vaultPolicy?: Record<string, unknown>,
    ) => {
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`;
        await tx.unsafe(
          `insert into scheduled_tasks (
            id, account_id, workspace_id, name, status, schedule,
            temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
            created_by_kind, created_by_subject_id, created_by_context,
            authority_revision, metadata${vaultPolicy ? ", vault_policy" : ""}
          ) values (
            $1, $2, $3, 'Inbox check', 'active', '{"type":"manual"}'::jsonb, $4,
            'new_session_per_run', 'buffer_one', '{"kind":"agent_turn"}'::jsonb, $5::jsonb,
            'subject', $6, '{}'::jsonb, 3, '{}'::jsonb${vaultPolicy ? ", $7::jsonb" : ""}
          )`,
          [
            id,
            accountId,
            workspaceId,
            `digest-${id}`,
            config as never,
            owner,
            ...(vaultPolicy ? [vaultPolicy as never] : []),
          ],
        );
      });
    };
    // Saved through the ordinary triggers, so the database derives each digest
    // exactly as a 0738 release's save did.
    for (const [id, config] of Object.entries(configs)) await insertTask(id, config);
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const id of Object.keys(configs)) {
        const [row] = await tx<{ digest: string }[]>`
          select execution_digest as digest from scheduled_tasks where id = ${id}`;
        await tx`
          insert into scheduled_task_revision_authorities (
            task_id, task_authority_revision, account_id, workspace_id, subject_id,
            organization_membership_id, membership_authorization_revision, execution_digest
          ) values (
            ${id}, 3, ${accountId}, ${workspaceId}, ${owner}, ${crypto.randomUUID()}, 1,
            ${row!.digest}
          )`;
      }
    });
    const read = async () =>
      await admin<
        { id: string; digest: string; recomputed: string; authorityDigest: string | null }[]
      >`
        select task.id::text as id, task.execution_digest as digest,
          scheduled_task_execution_digest(task) as recomputed,
          authority.execution_digest as "authorityDigest"
        from scheduled_tasks task
        left join scheduled_task_revision_authorities authority
          on authority.task_id = task.id
         and authority.task_authority_revision = task.authority_revision
        where task.workspace_id = ${workspaceId}::uuid
        order by task.id`;
    const before = await read();
    expect(before).toHaveLength(2);
    for (const row of before) expect(row.digest).toBe(row.recomputed);

    await forgetMigrations((name) => name === MIGRATION);

    // 0739 alone: every stored digest is byte-identical and still reproduces.
    expect(await read()).toEqual(before);

    // A narrowed vault policy is execution configuration and changes the digest;
    // the save trigger and the digest function agree on both forms.
    const narrowed = { mode: "selected", vaultIds: [] };
    const [plainId] = Object.keys(configs);
    const [variant] = await admin<{ narrowed: string; stored: string }[]>`
      select scheduled_task_execution_digest(
          jsonb_populate_record(task, jsonb_build_object('vault_policy', ${JSON.stringify(narrowed)}::text::jsonb))
        ) as narrowed,
        task.execution_digest as stored
      from scheduled_tasks task where task.id = ${plainId!}`;
    expect(variant!.narrowed).not.toBe(variant!.stored);
    const savedDefault = crypto.randomUUID();
    const savedNarrowed = crypto.randomUUID();
    await insertTask(savedDefault, baseConfig);
    await insertTask(savedNarrowed, baseConfig, narrowed);
    const saved = await admin<
      { id: string; digest: string; recomputed: string; widened: string }[]
    >`
      select task.id::text as id, task.execution_digest as digest,
        scheduled_task_execution_digest(task) as recomputed,
        scheduled_task_execution_digest(
          jsonb_populate_record(task, '{"vault_policy":{"mode":"all"}}'::jsonb)
        ) as widened
      from scheduled_tasks task where task.id in (${savedDefault}, ${savedNarrowed})`;
    expect(saved).toHaveLength(2);
    for (const row of saved) expect(row.digest).toBe(row.recomputed);
    const narrowedRow = saved.find((row) => row.id === savedNarrowed)!;
    expect(narrowedRow.widened).not.toBe(narrowedRow.digest);

    // Every later migration, including 0753 and 0754 that re-derive digests,
    // runs on top, and the revision authorities follow their schedules. The
    // maintenance cutovers need every application connection closed.
    await client?.close();
    client = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [open] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and usename = 'opengeni_app'`;
      if (open!.count === 0) break;
      await Bun.sleep(100);
    }
    await forgetMigrations((name) => name > MIGRATION);
    const after = await read();
    for (const row of after) expect(row.digest).toBe(row.recomputed);
    for (const id of Object.keys(configs)) {
      const row = after.find((candidate) => candidate.id === id)!;
      expect(row.authorityDigest).toBe(row.digest);
    }
  },
);
