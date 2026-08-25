import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL("../drizzle/0333_session_turn_prompt_routing.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0333-session-turn-prompt-routing");
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("migration 0333 session turn prompt routing", () => {
  test("is a rolling additive change with no historical queue rewrite", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain("ADD COLUMN prompt_routing text");
    expect(sql).toContain("session_turns_prompt_routing_check");
    expect(sql).toContain("session_turns_prompt_routing_immutable");
    expect(sql).not.toMatch(/\bUPDATE\s+session_turns/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/iu);
  });

  test("installs the nullable rolling column and closed routing vocabulary", async () => {
    if (!shared) return;
    const [column] = await shared.admin<
      Array<{ data_type: string; is_nullable: string; column_default: string | null }>
    >`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_turns'
        and column_name = 'prompt_routing'`;
    expect({ ...column! }).toEqual({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });

    const [constraint] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_turns'::regclass
        and conname = 'session_turns_prompt_routing_check'`;
    expect(constraint?.definition).toContain("accepted_for_execution");
    expect(constraint?.definition).toContain("queued_for_execution");
    expect(constraint?.definition).toContain("accepted_for_steering");

    const [trigger] = await shared.admin<Array<{ enabled: string }>>`
      select tgenabled as enabled
      from pg_trigger
      where tgrelid = 'session_turns'::regclass
        and tgname = 'session_turns_prompt_routing_immutable'
        and not tgisinternal`;
    expect(trigger?.enabled).toBe("O");
  });
});
