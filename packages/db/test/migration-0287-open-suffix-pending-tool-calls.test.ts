import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0287_open_suffix_pending_tool_calls.sql",
  import.meta.url,
);

describe("migration 0287 open suffix pending tool calls", () => {
  test("adds interruption kind and tied reasoning on pending receipts", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain('ADD COLUMN "interruption_kind" text');
    expect(sql).toContain('ADD COLUMN "tied_reasoning_items" jsonb NOT NULL DEFAULT \'[]\'::jsonb');
    expect(sql).toContain('ADD COLUMN "tied_reasoning_items_codec_version" integer');
    expect(sql).toContain("human_input");
    expect(sql).toContain("interaction_intervention");
    expect(sql).toContain('jsonb_typeof("tied_reasoning_items") = \'array\'');
  });
});
