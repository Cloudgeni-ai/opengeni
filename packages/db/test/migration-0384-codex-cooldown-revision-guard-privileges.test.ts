import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0384_codex_cooldown_revision_guard_privileges.sql",
  import.meta.url,
);

describe("0384 Codex cooldown revision guard privileges", () => {
  test("is a rolling forward repair that removes only default PUBLIC execution", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.codex_cooldown_revision_guard() FROM PUBLIC;",
    );
    expect(source).not.toContain("GRANT EXECUTE");
    expect(source).not.toContain("CREATE OR REPLACE FUNCTION");
  });
});
