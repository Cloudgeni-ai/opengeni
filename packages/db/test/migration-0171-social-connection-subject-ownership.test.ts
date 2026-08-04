import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("migration 0171 social connection subject ownership", () => {
  test("adds subject-scoped uniqueness and RLS for connections and their posts", async () => {
    const sql = await readFile(
      new URL("../drizzle/0171_social_connection_subject_ownership.sql", import.meta.url),
      "utf8",
    );
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain("ADD COLUMN subject_id text");
    expect(sql).toContain("WHERE subject_id IS NULL");
    expect(sql).toContain("WHERE subject_id IS NOT NULL");
    expect(sql).toContain("current_setting('opengeni.subject_id', true)");
    expect(sql).toContain("DROP POLICY workspace_isolation ON social_posts");
    expect(sql).toContain("connection.id = social_posts.connection_id");
  });
});
