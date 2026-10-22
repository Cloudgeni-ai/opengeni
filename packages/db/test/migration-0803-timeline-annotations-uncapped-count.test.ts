import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing/shared-pg";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const replaceUrl = new URL(
  "../drizzle/0803_timeline_annotations_uncapped_count.sql",
  import.meta.url,
);
const validateUrl = new URL("../drizzle/0804_timeline_annotations_validate.sql", import.meta.url);

describe("migrations 0803-0804 timeline annotations without a count cap", () => {
  test("are rolling, widen both checks and leave them validated", async () => {
    for (const url of [replaceUrl, validateUrl]) {
      const source = await readFile(url, "utf8");
      expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(source).toContain("SET LOCAL lock_timeout = '5s'");
      expect(source).not.toContain("jsonb_array_length");
    }
    expect(await readFile(replaceUrl, "utf8")).toContain("NOT VALID");
    expect(await readFile(replaceUrl, "utf8")).not.toContain("VALIDATE CONSTRAINT");

    const blank = await acquireBlankTestDatabase("migration-0803");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const constraints = await sql<
        Array<{ name: string; validated: boolean; definition: string }>
      >`
        select conname as name, convalidated as validated, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'composer_drafts_annotations_check',
          'session_turns_annotations_check'
        )
        order by conname`;
      expect(constraints.map(({ name, validated }) => ({ name, validated }))).toEqual([
        { name: "composer_drafts_annotations_check", validated: true },
        { name: "session_turns_annotations_check", validated: true },
      ]);
      for (const { definition } of constraints) {
        expect(definition).not.toContain("jsonb_array_length");
        expect(definition).toContain("1048576");
      }
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
