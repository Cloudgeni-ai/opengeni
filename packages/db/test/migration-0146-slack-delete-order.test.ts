import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const currentMigration = "0146_slack_bot_delete_idempotency.sql";
const withdrawnMigration = "0141_slack_bot_delete_idempotency.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0146-slack-delete-order");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0146-slack-delete-order] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0146 (forward-only Slack delete-operation history)", () => {
  test("creates a fresh schema, rejects unexplained state, and accepts only the exact withdrawn staging receipt", async () => {
    if (!available || !blank) return;

    await migrate(blank.databaseUrl);
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const fresh = await admin<
        {
          migration_recorded: boolean;
          table_exists: boolean;
          index_count: number;
          policy_count: number;
        }[]
      >`
        select
          exists(
            select 1 from schema_migrations where name = ${currentMigration}
          ) as migration_recorded,
          to_regclass('slack_bot_delete_operations') is not null as table_exists,
          (
            select count(*)::int
            from pg_class
            where relname = 'slack_bot_delete_operations_workspace_status_idx'
              and relkind = 'i'
          ) as index_count,
          (
            select count(*)::int
            from pg_policy
            where polrelid = 'slack_bot_delete_operations'::regclass
              and polname = 'workspace_isolation'
          ) as policy_count
      `;
      expect(fresh[0]).toEqual({
        migration_recorded: true,
        table_exists: true,
        index_count: 1,
        policy_count: 1,
      });

      // Recreate the exact state the staging database had after the withdrawn
      // migration name committed: the complete table is present, but 0146 is
      // not recorded. Without the historical receipt this must fail closed.
      await admin`delete from schema_migrations where name = ${currentMigration}`;
      let unexplainedStateError: unknown;
      try {
        await migrate(blank.databaseUrl);
      } catch (error) {
        unexplainedStateError = error;
      }
      expect(unexplainedStateError).toBeInstanceOf(Error);
      expect((unexplainedStateError as Error).message).toContain(
        "exists without the exact withdrawn 0141 migration receipt",
      );

      await admin`
        insert into schema_migrations (name)
        values (${withdrawnMigration})
        on conflict do nothing
      `;
      await migrate(blank.databaseUrl);

      const reconciled = await admin<
        {
          current_recorded: boolean;
          legacy_recorded: boolean;
          index_count: number;
          policy_count: number;
        }[]
      >`
        select
          exists(
            select 1 from schema_migrations where name = ${currentMigration}
          ) as current_recorded,
          exists(
            select 1 from schema_migrations where name = ${withdrawnMigration}
          ) as legacy_recorded,
          (
            select count(*)::int
            from pg_class
            where relname = 'slack_bot_delete_operations_workspace_status_idx'
              and relkind = 'i'
          ) as index_count,
          (
            select count(*)::int
            from pg_policy
            where polrelid = 'slack_bot_delete_operations'::regclass
              and polname = 'workspace_isolation'
          ) as policy_count
      `;
      expect(reconciled[0]).toEqual({
        current_recorded: true,
        legacy_recorded: true,
        index_count: 1,
        policy_count: 1,
      });
    } finally {
      await admin.end();
    }
  }, 180_000);
});
