import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";

import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0401_codex_unconditional_credential_leasing.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0401 unconditional Codex credential leasing", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("codex-unconditional-credential-leasing");
    if (!owned) {
      if (requireRealDatabase) throw new Error("real database required but unavailable");
      return;
    }
    await migrate(owned.ownerUrl);
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("is maintenance-classified, adds the goal fence, and drops the temporary columns", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain("pg_stat_activity");
    expect(source).toContain("USING ERRCODE = '55000'");
    expect(source).toContain(
      "LOCK TABLE organization_codex_rotation_settings IN ACCESS EXCLUSIVE MODE",
    );
    expect(source).toContain("LOCK TABLE codex_rotation_settings IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("LOCK TABLE session_goals IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain(
      "ALTER TABLE session_goals\n  ADD COLUMN IF NOT EXISTS continuation_suppressed_turn_id uuid",
    );
    expect(source).toContain(
      "ALTER TABLE organization_codex_rotation_settings\n  DROP COLUMN IF EXISTS lease_rotation_enabled",
    );
    expect(source).toContain(
      "ALTER TABLE codex_rotation_settings\n  DROP COLUMN IF EXISTS lease_rotation_enabled",
    );
    expect(source).not.toMatch(/DROP COLUMN IF EXISTS rotation_enabled/u);
  });

  test("retains rotation policy while removing both allocator cutover bits", async () => {
    if (!owned) return;
    const columns = await owned.admin<
      Array<{ table_name: string; column_name: string; column_default: string | null }>
    >`
      select table_name, column_name, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('codex_rotation_settings', 'organization_codex_rotation_settings')
        and column_name in ('rotation_enabled', 'lease_rotation_enabled')
      order by table_name, column_name`;
    expect([...columns]).toEqual([
      {
        table_name: "codex_rotation_settings",
        column_name: "rotation_enabled",
        column_default: "false",
      },
      {
        table_name: "organization_codex_rotation_settings",
        column_name: "rotation_enabled",
        column_default: "false",
      },
    ]);
    const [goalFence] = await owned.admin<Array<{ data_type: string; is_nullable: string }>>`
      select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'session_goals'
        and column_name = 'continuation_suppressed_turn_id'`;
    expect(goalFence).toEqual({ data_type: "uuid", is_nullable: "YES" });
  });
});
