import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";
import {
  sessionHistoryCompatibilitySql,
  sessionHistoryBackfillPlan,
  sessionHistoryRlsExecutableSql,
  SESSION_HISTORY_REPAIR,
  SESSION_HISTORY_REPAIR_SOURCE,
} from "../src/migration-session-history-backfills";

const hintFile = "0809_session_open_settlement_index.sql";
const usageFile = "0811_session_events_usage_source_key_backfill.sql";
const hint = await readFile(new URL(`../drizzle/${hintFile}`, import.meta.url), "utf8");
const usage = await readFile(new URL(`../drizzle/${usageFile}`, import.meta.url), "utf8");

test("both deployed SQL identities remain immutable; changed sources fail before database I/O", async () => {
  expect(createHash("sha256").update(hint).digest("hex")).toBe(
    "2c6889be458d3468e4e1bbe84ba2c8e7f9b1f7ff5e583069944906d85d03a1a7",
  );
  expect(createHash("sha256").update(usage).digest("hex")).toBe(
    "ec0f4262af88dec2d3878a6f7a171d2390a5bb08c8bafcdec1e5c0bd98fb4642",
  );
  for (const [file, source] of [
    [hintFile, hint],
    [usageFile, usage],
  ]) {
    await expect(executeMigrationFile({} as postgres.Sql, file!, source! + "\n")).rejects.toThrow(
      "immutable deployed source",
    );
  }
  expect(sessionHistoryCompatibilitySql("other.sql", hint)).toBe(hint);
  expect(sessionHistoryBackfillPlan("other.sql", usage)).toBeNull();
});

test("fresh0809 opens only its two tables and restores the exact fence trigger and FORCE flags", () => {
  const executed = sessionHistoryCompatibilitySql(hintFile, hint);
  expect(executed.match(/NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
  expect(executed).toContain("DISABLE TRIGGER session_tenancy_workspace_fence;");
  expect(executed).toContain("ENABLE TRIGGER session_tenancy_workspace_fence;");
  expect(executed).not.toContain("acquire_session_tenancy_fence");
  expect(executed).not.toContain("ALTER TABLE session_events");
  expect(sessionHistoryRlsExecutableSql(hintFile, hint)).toBe(executed);
});

test("the forward stage is exact, includes both repairs, and batched stages never relax FORCE", async () => {
  expect(
    await readFile(new URL(`../drizzle/${SESSION_HISTORY_REPAIR}`, import.meta.url), "utf8"),
  ).toBe(SESSION_HISTORY_REPAIR_SOURCE);
  expect(
    sessionHistoryBackfillPlan(SESSION_HISTORY_REPAIR, SESSION_HISTORY_REPAIR_SOURCE),
  ).toHaveLength(2);
  expect(sessionHistoryBackfillPlan(usageFile, usage)).toHaveLength(1);
  await expect(
    executeMigrationFile(
      {} as postgres.Sql,
      SESSION_HISTORY_REPAIR,
      SESSION_HISTORY_REPAIR_SOURCE + "\n",
    ),
  ).rejects.toThrow("source drift");
  for (const [file, source] of [
    [usageFile, usage],
    [SESSION_HISTORY_REPAIR, SESSION_HISTORY_REPAIR_SOURCE],
  ]) {
    const executable = sessionHistoryRlsExecutableSql(file!, source!);
    expect(executable).not.toMatch(/NO FORCE|DISABLE TRIGGER|GRANT /);
    expect(executable).toContain("FOR SELECT USING");
    expect(executable).toContain("LIMIT 1000 FOR UPDATE");
    expect(executable).toContain("current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)");
    expect(executable).toContain(
      "AND pg_catalog.current_setting('opengeni.session_history_owner_backfill_v1', true) = '1'",
    );
    expect(executable).toContain("DROP POLICY IF EXISTS sessions_history_owner_backfill");
  }
});
