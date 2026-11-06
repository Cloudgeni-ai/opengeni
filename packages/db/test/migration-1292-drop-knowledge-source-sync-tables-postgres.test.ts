import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const firstDetach = "1281_detach_knowledge_sync_from_managed_accounts.sql";
const drop = "1292_drop_knowledge_source_sync_tables.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const DROPPED = [
  "google_drive_object_acl_evidence",
  "google_drive_object_acl_principals",
  "knowledge_source_sync_index_obligations",
  "knowledge_source_sync_item_outcomes",
  "knowledge_source_sync_object_observations",
  "knowledge_source_sync_states",
  "knowledge_source_sync_wakes",
];
// Scoped-knowledge provenance and the Google Drive authority capability are
// still used by surviving routines and foreign keys.
const KEPT = [
  "knowledge_providers",
  "knowledge_sources",
  "knowledge_source_acl_versions",
  "knowledge_source_objects",
  "knowledge_document_versions",
  "knowledge_lifecycle_events",
  "knowledge_sync_runs",
  "google_drive_object_acl_runtime_capabilities",
];
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;
let detaches: string[] = [];

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("drop-knowledge-source-sync-tables");
  if (!owned) throw new Error("Real PostgreSQL is required for the Knowledge sync table drop");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-knowledge-sync-drop-"));
  const source = join(import.meta.dir, "../drizzle");
  const files = (await readdir(source)).filter((name) => name.endsWith(".sql")).sort();
  detaches = files.filter((name) => name >= firstDetach && name < drop);
  for (const name of files) {
    if (name < firstDetach) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production.
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
}, 900_000);

afterAll(async () => {
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function relations() {
  const rows = await owned!.admin<{ name: string }[]>`
    select n.nspname || '.' || c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'opengeni_private') and c.relkind in ('r', 'p', 'v', 'm')
    order by 1`;
  return rows.map((row) => row.name);
}

async function routines() {
  const rows = await owned!.admin<{ name: string }[]>`
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'opengeni_private') order by 1`;
  return rows.map((row) => row.name);
}

async function policies() {
  const rows = await owned!.admin<{ name: string }[]>`
    select schemaname || '.' || tablename || ':' || policyname as name from pg_policies
    where schemaname in ('public', 'opengeni_private') order by 1`;
  return rows.map((row) => row.name);
}

/** Foreign keys between a retired sync table and a surviving table, either way. */
async function crossForeignKeys(): Promise<{ name: string; parent: string }[]> {
  const rows = await owned!.admin<{ name: string; parent: string }[]>`
    select child.relname || ':' || c.conname as name, parent.relname as parent
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_namespace n on n.oid = child.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
      and ((child.relname = any(${DROPPED}::text[])
          and not parent.relname = any(${DROPPED}::text[]))
        or (parent.relname = any(${DROPPED}::text[])
          and not child.relname = any(${DROPPED}::text[])))
    order by 1`;
  return rows.map((row) => ({ name: row.name, parent: row.parent }));
}

async function applyThrough(last: string) {
  const source = join(import.meta.dir, "../drizzle");
  for (const name of [...detaches, drop]) {
    if (name > last) break;
    await copyFile(join(source, name), join(prefix!, name));
  }
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production.
  await migrate(owned!.ownerUrl, undefined, { migrationsDirectory: prefix! });
}

class RolledBack extends Error {}

/**
 * Runs one migration as the owner inside a transaction that is rolled back,
 * and returns the surviving tables it held ACCESS EXCLUSIVE before commit.
 */
async function survivingTablesLocked(name: string): Promise<string[]> {
  const sqlText = await Bun.file(join(import.meta.dir, "../drizzle", name)).text();
  const ownerSql = postgres(owned!.ownerUrl, { max: 1, onnotice: () => undefined });
  let locked: string[] = [];
  try {
    await ownerSql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      const rows = await tx<{ name: string }[]>`
        select c.relname as name from pg_locks l
        join pg_class c on c.oid = l.relation
        where l.pid = pg_backend_pid() and l.locktype = 'relation'
          and l.mode = 'AccessExclusiveLock' and c.relkind in ('r', 'p')
          and not c.relname = any(${DROPPED}::text[])
        order by 1`;
      locked = rows.map((row) => row.name);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  } finally {
    await ownerSql.end();
  }
  return locked;
}

describe.skipIf(!realDatabase)(
  "1281 to 1292 drop the retired Knowledge sync tables (real PostgreSQL)",
  () => {
    test("detaches one referenced table per migration, then drops exactly the seven sync tables and the index wake routine", async () => {
      const beforeRelations = await relations();
      const beforeRoutines = await routines();
      const beforePolicies = await policies();
      for (const name of DROPPED) expect(beforeRelations).toContain(`public.${name}`);
      expect(beforeRoutines).toContain("public.knowledge_source_index_wake()");

      // A database whose constraint names drifted from the baseline still
      // detaches fully: the files find foreign keys in the catalog.
      await owned!.admin`alter table knowledge_source_sync_wakes
        rename constraint knowledge_source_sync_wakes_run_fk to knowledge_source_sync_wakes_run_fkey1`;

      // Only the sync tables point at surviving tables; nothing points back.
      const cross = await crossForeignKeys();
      expect(cross.map((row) => row.name)).toContain(
        "knowledge_source_sync_wakes:knowledge_source_sync_wakes_run_fkey1",
      );
      expect(cross.length).toBeGreaterThan(0);
      expect(cross.every((row) => !DROPPED.includes(row.parent))).toBe(true);
      const parents = [...new Set(cross.map((row) => row.parent))].sort();
      // Each detach migration removes every foreign key into exactly one
      // surviving table, so it never holds two of them locked at once.
      expect(detaches).toHaveLength(parents.length);
      const detached = new Set<string>();
      let previous = cross;
      for (const name of detaches) {
        // Measured directly: before commit the file holds exactly one
        // surviving table locked.
        const locked = await survivingTablesLocked(name);
        await applyThrough(name);
        const remaining = await crossForeignKeys();
        // Every foreign key this file removed points at one surviving table.
        const removed = previous.filter(
          (row) => !remaining.some((other) => other.name === row.name),
        );
        expect({ name, parents: [...new Set(removed.map((row) => row.parent))].length }).toEqual({
          name,
          parents: 1,
        });
        previous = remaining;
        const gone = parents.filter(
          (parent) => !detached.has(parent) && !remaining.some((row) => row.parent === parent),
        );
        expect({ name, gone: gone.length }).toEqual({ name, gone: 1 });
        detached.add(gone[0]!);
        expect({ name, locked }).toEqual({ name, locked: gone });
        for (const row of remaining) expect(detached.has(row.parent)).toBe(false);
      }
      expect(await crossForeignKeys()).toEqual([]);
      // The tables are still there until the drop.
      expect(await relations()).toEqual(beforeRelations);

      // The drop itself locks no surviving table.
      expect(await survivingTablesLocked(drop)).toEqual([]);
      await applyThrough(drop);

      // Nothing else goes with them.
      expect(await relations()).toEqual(
        beforeRelations.filter((name) => !DROPPED.map((table) => `public.${table}`).includes(name)),
      );
      expect(await routines()).toEqual(
        beforeRoutines.filter((name) => name !== "public.knowledge_source_index_wake()"),
      );
      expect(await policies()).toEqual(
        beforePolicies.filter((name) => !DROPPED.includes(name.split(".")[1]!.split(":")[0]!)),
      );
      const after = await relations();
      for (const name of KEPT) {
        expect(after.some((relation) => relation.endsWith(`.${name}`))).toBe(true);
      }
      // The surviving Google Drive authority policies stay on the tables it reads.
      const capability = await owned!.admin<{ table: string }[]>`
      select tablename as table from pg_policies
      where policyname = 'google_drive_object_acl_capability_read' order by 1`;
      expect(capability.map((row) => row.table)).toEqual([
        "connections",
        "files",
        "knowledge_document_versions",
        "knowledge_providers",
        "knowledge_source_objects",
        "knowledge_sources",
      ]);

      // No surviving routine body names a dropped table, and the Google Drive
      // authority routines still run and fail closed.
      const readers = await owned!.admin<{ name: string }[]>`
      select p.oid::regprocedure::text as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'opengeni_private')
        and p.prosrc ~ ${`(${DROPPED.join("|")})`}`;
      expect(readers.map((row) => row.name)).toEqual([]);
      const [authorized] = await owned!.admin<{ allowed: boolean }[]>`
      select google_drive_file_authorized(gen_random_uuid(), gen_random_uuid(), 'user:drop',
        gen_random_uuid()) as allowed`;
      expect(authorized!.allowed).toBe(false);
      const [citation] = await owned!.admin<{ citation: unknown }[]>`
      select google_drive_document_citation(gen_random_uuid(), gen_random_uuid(), 'user:drop',
        gen_random_uuid(), gen_random_uuid()) as citation`;
      expect(citation!.citation).toBeNull();

      // A repeated run as the owner (a developer database) is a no-op.
      const ownerSql = postgres(owned!.ownerUrl, { max: 1, onnotice: () => undefined });
      try {
        for (const name of [...detaches, drop]) {
          const sqlText = await Bun.file(join(import.meta.dir, "../drizzle", name)).text();
          await ownerSql.begin(async (tx) => await tx.unsafe(sqlText));
        }
      } finally {
        await ownerSql.end();
      }
      expect(await relations()).toEqual(after);
    }, 300_000);
  },
);
