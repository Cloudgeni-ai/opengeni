import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("OPE-14 migration ordering", () => {
  test("uses collision-resistant 0066 and contains the authorization/idempotency fences", async () => {
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    const filename = "0066_ope14_rig_safety.sql";
    expect(files).toContain(filename);
    expect(files).not.toContain("0060_ope14_rig_safety.sql");
    expect(files).not.toContain("0049_rig_safety.sql");
    expect(
      files.filter((file) => /^(0049|0050|0055|0056|0057)_/.test(file) && file.includes("ope14")),
    ).toEqual([]);
    expect(files.indexOf(filename)).toBeGreaterThan(
      files.indexOf("0064_rotation_strategy_sharded_backfill.sql"),
    );

    const sql = await readFile(join(migrationsDir, filename), "utf8");
    expect(sql).toContain('"rig_changes_workspace_idempotency_idx"');
    expect(sql).toContain('"rig_default_variable_sets_authorized"');
  });
});
