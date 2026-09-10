import { expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

test("scheduled admission inherits omitted tools but preserves explicit overrides and rejects drift", async () => {
  const database = await acquireBlankTestDatabase("scheduled-inherited-tools");
  if (!database) throw new Error("PostgreSQL is required for the admission regression");
  const sql = postgres(database.databaseUrl, { max: 1 });
  try {
    // Use the original admission expression in a minimal trigger harness. The
    // migration replaces this exact expression in the real guarded function.
    await sql.unsafe(`
      CREATE TABLE admission_probe (
        inherited jsonb NOT NULL, turn_tools jsonb, tools_provided boolean,
        accepted jsonb NOT NULL
      );
      CREATE FUNCTION admit_scheduled_agent_run_execution() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      DECLARE latest_started record; target_row record;
      BEGIN
        SELECT NEW.turn_tools AS tools, NEW.tools_provided AS tools_provided INTO latest_started;
        SELECT NEW.inherited AS tools INTO target_row;
        IF NEW.accepted IS DISTINCT FROM coalesce(latest_started.tools, target_row.tools) THEN
          RAISE EXCEPTION 'scheduled target-session execution policy changed during admission'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE TRIGGER admission BEFORE INSERT ON admission_probe
      FOR EACH ROW EXECUTE FUNCTION admit_scheduled_agent_run_execution();
    `);
    const inherited = '[{"id":"research","kind":"mcp"}]';
    await expect(
      Promise.resolve(
        sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, '[]', false, ${inherited}::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    const migration = await readFile(
      new URL("../drizzle/0416_scheduled_inherited_tool_admission.sql", import.meta.url),
      "utf8",
    );
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    await sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, '[]', false, ${inherited}::jsonb)`;
    await sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, NULL, NULL, ${inherited}::jsonb)`;
    await sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, '[]', true, '[]')`;
    await sql`INSERT INTO admission_probe VALUES ('[]', ${inherited}::jsonb, true, ${inherited}::jsonb)`;
    await expect(
      Promise.resolve(
        sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, '[]', true, ${inherited}::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      Promise.resolve(
        sql`INSERT INTO admission_probe VALUES (${inherited}::jsonb, '[]', false, '[]')`,
      ),
    ).rejects.toMatchObject({ code: "40001" });
    expect((await sql`SELECT count(*)::int AS count FROM admission_probe`)[0]?.count).toBe(4);
  } finally {
    await sql.end();
    await database.release();
  }
}, 180_000);
