import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationFile = "0067_sandbox_recovery_protocol_fence.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

function appDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "opengeni_app";
  url.password = "apppw";
  return url.toString();
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0067-sandbox-recovery");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0067-sandbox-recovery] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0067 (sandbox recovery protocol maintenance activation)", () => {
  test("refuses live old writers, rolls back atomically, then fences legacy acquisition", async () => {
    if (!available || !blank) return;

    const admin = postgres(blank.databaseUrl, { max: 1 });
    let legacy: postgres.Sql | null = null;
    try {
      const migrationText = await readFile(join(migrationsDir, migrationFile), "utf8");
      expect(migrationText.split("\n", 1)[0]).toBe("-- deployment-mode: maintenance");

      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const pre0067 = files.filter((file) => file < "0067_");
      for (const file of pre0067) await applyFile(admin, file);

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0067-sandbox-recovery-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0067-sandbox-recovery-workspace') returning id`;
      const groupId = crypto.randomUUID();
      await admin`
        insert into sandbox_leases
          (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
        values
          (${account!.id}, ${workspace!.id}, ${groupId}, 'cold', 'modal', now() + interval '60 seconds')`;

      // Simulate a still-running origin/main pod. Even an idle pooled app-role
      // session makes maintenance activation fail before the trigger exists.
      legacy = postgres(appDatabaseUrl(blank.databaseUrl), { max: 1 });
      await legacy`select 1`;
      await expect(Promise.resolve(admin.unsafe(migrationText))).rejects.toMatchObject({
        code: "55000",
      });
      const [rolledBack] = await admin<{ trigger_count: number }[]>`
        select count(*)::int as trigger_count
        from pg_trigger
        where tgname in (
          'sandbox_recovery_protocol_v1_insert_guard',
          'sandbox_recovery_protocol_v1_guard'
        )`;
      expect(rolledBack?.trigger_count).toBe(0);

      await legacy.end();
      legacy = null;
      await applyFile(admin, migrationFile);

      // Exact legacy acquireLease INSERT ... ON CONFLICT shape. The insert
      // trigger fires before conflict resolution and rejects the unmarked old
      // binary rather than allowing a mixed-version recovery writer.
      legacy = postgres(appDatabaseUrl(blank.databaseUrl), { max: 1 });
      await expect(
        legacy.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
          await tx`
            insert into sandbox_leases
              (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
            values
              (${account!.id}, ${workspace!.id}, ${groupId}, 'cold', 'modal', now() + interval '60 seconds')
            on conflict (workspace_id, sandbox_group_id) do nothing
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });

      // The replacement binary's transaction-local marker admits the same
      // idempotent acquisition shape after maintenance activation.
      await legacy.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v1', '1', true)`;
        await tx`
          insert into sandbox_leases
            (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
          values
            (${account!.id}, ${workspace!.id}, ${groupId}, 'cold', 'modal', now() + interval '60 seconds')
          on conflict (workspace_id, sandbox_group_id) do nothing
        `;
      });
    } finally {
      await legacy?.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
