import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migrationName = "0322_session_turns_unclaimed_prompt_trigger_index.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0322-unclaimed-prompt-index");
}, 180_000);

afterAll(async () => shared?.release());

describe("0322 session_turns unclaimed-prompt trigger index", () => {
  test("uses the governed rolling concurrent-index plan", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source).toBe(
      "-- deployment-mode: rolling\n" +
        "-- opengeni:concurrent-index lock-timeout=5s\n" +
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_turns_unclaimed_prompt_trigger_idx"\n' +
        '  ON "session_turns" ("workspace_id", "session_id", "trigger_event_id")\n' +
        '  WHERE "started_at" IS NULL;\n',
    );
    expect(parseConcurrentIndexMigration(migrationName, source)).toEqual({
      indexName: "session_turns_unclaimed_prompt_trigger_idx",
      lockTimeout: "5s",
      skipWhenValid: false,
      statement:
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_turns_unclaimed_prompt_trigger_idx"\n' +
        '  ON "session_turns" ("workspace_id", "session_id", "trigger_event_id")\n' +
        '  WHERE "started_at" IS NULL;',
    });
  });

  test("creates a valid partial index over exactly the unclaimed-turn probe key", async () => {
    if (!shared) return;
    // `excludeUnclaimedHumanPromptEventFilter` probes
    // (workspace_id, session_id, trigger_event_id) for rows with
    // `started_at IS NULL`; the partial index covers exactly that key so the
    // NOT EXISTS never degrades to a per-statement scan of the workspace's
    // session_turns.
    const [index] = await shared.admin<
      Array<{ indexdef: string; indisvalid: boolean; indisunique: boolean }>
    >`
      select pi.indexdef, i.indisvalid, i.indisunique
      from pg_indexes pi
      join pg_class c on c.relname = pi.indexname
      join pg_index i on i.indexrelid = c.oid
      where pi.schemaname = current_schema()
        and pi.tablename = 'session_turns'
        and pi.indexname = 'session_turns_unclaimed_prompt_trigger_idx'`;
    expect(index).toBeDefined();
    expect(index!.indisvalid).toBe(true);
    expect(index!.indisunique).toBe(false);
    expect(index!.indexdef).toBe(
      "CREATE INDEX session_turns_unclaimed_prompt_trigger_idx ON public.session_turns USING btree (workspace_id, session_id, trigger_event_id) WHERE (started_at IS NULL)",
    );
  });
});
