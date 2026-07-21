import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createDb,
  deactivateSandboxEphemeralOwner,
  registerSandboxEphemeralOwner,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const appPassword = "apppw";

function appDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "opengeni_app";
  url.password = appPassword;
  return url.toString();
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0068-owner-acl");
  const directBlankUrl = process.env.OPENGENI_TEST_BLANK_DATABASE_URL;
  if (!blank && directBlankUrl) {
    blank = {
      databaseUrl: directBlankUrl,
      release: async () => undefined,
    };
  }
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0068-owner-acl] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0068 (sandbox ephemeral owner privilege fence)", () => {
  test("an exact 0067 database upgrades idempotently without broadening the protected registry", async () => {
    if (!available || !blank) return;

    const admin = postgres(blank.databaseUrl, { max: 1 });
    let client: DbClient | null = null;
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const pre0068 = files.filter((file) => file < "0068_");
      expect(pre0068.at(-1)).toBe("0067_sandbox_recovery_protocol_fence.sql");

      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of pre0068) {
        await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }
      const [before] = await admin<{ count: number; latest: string }[]>`
        select count(*)::int as count, max(name) as latest from schema_migrations`;
      expect(before).toEqual({
        count: pre0068.length,
        latest: pre0068.at(-1)!,
      });

      // Apply corrected 0068 through the real runner, then prove runner retry
      // and repeated role provisioning preserve the same ACL.
      await migrate(blank.databaseUrl);
      await migrate(blank.databaseUrl);
      await provisionRoles(blank.databaseUrl, {
        targetSchema: "public",
        rlsStrategy: "force",
        appRole: "opengeni_app",
        appPassword,
        temporalPassword: "",
      });
      await provisionRoles(blank.databaseUrl, {
        targetSchema: "public",
        rlsStrategy: "force",
        appRole: "opengeni_app",
        appPassword,
        temporalPassword: "",
      });

      const [after] = await admin<{ count: number; latest: string }[]>`
        select count(*)::int as count, max(name) as latest from schema_migrations`;
      expect(after).toEqual({ count: files.length, latest: files.at(-1)! });

      const [acl] = await admin<
        {
          owner_select: boolean;
          owner_insert: boolean;
          owner_update: boolean;
          owner_delete: boolean;
          owner_truncate: boolean;
          ordinary_insert: boolean;
          ordinary_update: boolean;
          ordinary_delete: boolean;
        }[]
      >`
        select
          has_table_privilege('opengeni_app', 'sandbox_ephemeral_owners', 'SELECT') as owner_select,
          has_table_privilege('opengeni_app', 'sandbox_ephemeral_owners', 'INSERT') as owner_insert,
          has_table_privilege('opengeni_app', 'sandbox_ephemeral_owners', 'UPDATE') as owner_update,
          has_table_privilege('opengeni_app', 'sandbox_ephemeral_owners', 'DELETE') as owner_delete,
          has_table_privilege('opengeni_app', 'sandbox_ephemeral_owners', 'TRUNCATE') as owner_truncate,
          has_table_privilege('opengeni_app', 'workspaces', 'INSERT') as ordinary_insert,
          has_table_privilege('opengeni_app', 'workspaces', 'UPDATE') as ordinary_update,
          has_table_privilege('opengeni_app', 'workspaces', 'DELETE') as ordinary_delete`;
      expect(acl).toEqual({
        owner_select: true,
        owner_insert: false,
        owner_update: false,
        owner_delete: false,
        owner_truncate: false,
        ordinary_insert: true,
        ordinary_update: true,
        ordinary_delete: true,
      });

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0068-owner-acl-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0068-owner-acl-workspace') returning id`;
      const executionId = crypto.randomUUID();
      const instanceId = `modal-migration-0068-${executionId}`;
      client = createDb(appDatabaseUrl(blank.databaseUrl));

      const registered = await registerSandboxEphemeralOwner(client.db, {
        executionId,
        accountId: account!.id,
        workspaceId: workspace!.id,
        kind: "rig_verification",
        backend: "modal",
        instanceId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      expect(registered).toMatchObject({
        executionId,
        instanceId,
        active: true,
      });
      await expect(
        deactivateSandboxEphemeralOwner(client.db, {
          executionId,
          accountId: account!.id,
          workspaceId: workspace!.id,
          kind: "rig_verification",
          backend: "modal",
          instanceId,
        }),
      ).resolves.toBe(true);
    } finally {
      await client?.close().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
