import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0212_browser_state_transfer_hardening.sql",
  import.meta.url,
);

describe("migration 0212 browser state transfer hardening", () => {
  test("upgrades retained state and installs reclaimable upload authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "browser_state_uploads"');
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.browser_state_artifacts_update_guard",
    );
    expect(source).toContain("claim_browser_state_artifact_cleanup");
    expect(source).toContain("claim_browser_state_upload_cleanup");
    expect(source).toContain("FOR UPDATE SKIP LOCKED");

    const blank = await acquireBlankTestDatabase("migration-0212-state-transfer");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [uploads] = await sql<
        Array<{ rlsEnabled: boolean; rlsForced: boolean }>
      >`select relrowsecurity as "rlsEnabled", relforcerowsecurity as "rlsForced"
        from pg_class where oid = 'browser_state_uploads'::regclass`;
      expect(uploads).toEqual({ rlsEnabled: true, rlsForced: true });

      const columns = await sql<Array<{ name: string; nullable: string }>>`
        select column_name as name, is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'browser_state_artifacts'
          and column_name in ('delete_claim_id', 'delete_claimed_at', 'encrypted_data_key')
        order by column_name`;
      expect([...columns]).toEqual([
        { name: "delete_claim_id", nullable: "YES" },
        { name: "delete_claimed_at", nullable: "YES" },
        { name: "encrypted_data_key", nullable: "YES" },
      ]);

      const functions = await sql<
        Array<{ name: string; securityDefiner: boolean; publicExecute: boolean }>
      >`select p.proname as name, p.prosecdef as "securityDefiner",
          has_function_privilege('public', p.oid, 'execute') as "publicExecute"
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private'
          and p.proname in (
            'claim_browser_state_artifact_cleanup',
            'claim_browser_state_upload_cleanup'
          ) order by p.proname`;
      expect([...functions]).toEqual([
        {
          name: "claim_browser_state_artifact_cleanup",
          securityDefiner: true,
          publicExecute: false,
        },
        {
          name: "claim_browser_state_upload_cleanup",
          securityDefiner: true,
          publicExecute: false,
        },
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  });
});
