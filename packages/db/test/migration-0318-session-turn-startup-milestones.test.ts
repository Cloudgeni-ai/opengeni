import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { FORCE_RLS_TABLES, RUNTIME_READ_INSERT_UPDATE_TABLES } from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0318_session_turn_startup_milestones.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0318-startup-milestones");
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0318 session turn startup milestones", () => {
  test("is a rolling, additive ledger with no FORCE-RLS backfill", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain('CREATE TABLE "session_turn_startup_milestones"');
    expect(sql).toContain('PRIMARY KEY ("workspace_id", "turn_id", "milestone", "outcome")');
    expect(sql).toContain(
      'ALTER TABLE "session_turn_startup_milestones" FORCE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain('CREATE POLICY workspace_isolation ON "session_turn_startup_milestones"');
    expect(sql).toContain(
      'CREATE POLICY session_visibility_isolation ON "session_turn_startup_milestones"',
    );
    // The in-flight turn posture is decided at runtime through the ledger; no
    // migration-time read or write over session_turns/session_events exists.
    expect(sql).not.toMatch(/\bUPDATE\s+"?session_/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/iu);
    expect(sql).not.toMatch(/\bINSERT\s+INTO/iu);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/iu);
    expect(FORCE_RLS_TABLES).toContain("session_turn_startup_milestones");
    expect(RUNTIME_READ_INSERT_UPDATE_TABLES).toContain("session_turn_startup_milestones");
  });

  test("creates the per-turn ledger with its primary key, cascades, checks, and policies", async () => {
    if (!shared) return;
    const columns = await shared.admin<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_turn_startup_milestones'
      order by column_name`;
    expect([...columns].map((row) => ({ ...row }))).toEqual([
      { column_name: "account_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "canonical_source", data_type: "text", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "event_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "milestone", data_type: "text", is_nullable: "NO" },
      { column_name: "occurred_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "outcome", data_type: "text", is_nullable: "NO" },
      { column_name: "session_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "turn_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "workspace_id", data_type: "uuid", is_nullable: "NO" },
    ]);

    const constraints = await shared.admin<
      Array<{ conname: string; contype: string; definition: string }>
    >`
      select conname, contype, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_turn_startup_milestones'::regclass
      order by conname`;
    const byName = new Map(constraints.map((row) => [row.conname, { ...row }]));
    expect(byName.get("session_turn_startup_milestones_pkey")).toMatchObject({
      contype: "p",
      definition: "PRIMARY KEY (workspace_id, turn_id, milestone, outcome)",
    });
    expect(byName.get("session_turn_startup_milestones_workspace_turn_fk")?.definition).toBe(
      "FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE",
    );
    expect(byName.get("session_turn_startup_milestones_workspace_session_fk")?.definition).toBe(
      "FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE",
    );
    expect(byName.get("session_turn_startup_milestones_workspace_account_fk")?.definition).toBe(
      "FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE",
    );
    for (const check of [
      "session_turn_startup_milestones_milestone_chk",
      "session_turn_startup_milestones_outcome_chk",
      "session_turn_startup_milestones_checkpoint_chk",
      "session_turn_startup_milestones_canonical_source_chk",
    ]) {
      expect(byName.get(check)).toMatchObject({ contype: "c" });
    }

    const [posture] = await shared.admin<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'session_turn_startup_milestones'::regclass`;
    expect({ ...posture! }).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await shared.admin<Array<{ policyname: string; permissive: string }>>`
      select policyname, permissive
      from pg_policies
      where tablename = 'session_turn_startup_milestones'
      order by policyname`;
    expect(policies.map((row) => ({ ...row }))).toEqual([
      { policyname: "session_visibility_isolation", permissive: "RESTRICTIVE" },
      { policyname: "workspace_isolation", permissive: "PERMISSIVE" },
    ]);

    const grants = await shared.admin<Array<{ privilege_type: string }>>`
      select privilege_type
      from information_schema.role_table_grants
      where table_name = 'session_turn_startup_milestones'
        and grantee = 'opengeni_app'
      order by privilege_type`;
    expect(grants.map((row) => row.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);

    const indexes = await shared.admin<Array<{ indexname: string }>>`
      select indexname from pg_indexes
      where tablename = 'session_turn_startup_milestones'
      order by indexname`;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "session_turn_startup_milestones_pkey",
      "session_turn_startup_milestones_workspace_session_idx",
    ]);
  });
});
