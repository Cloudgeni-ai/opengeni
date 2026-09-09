import { expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { fromPostgresLosslessJson, toPostgresLosslessJson } from "../src/lossless-json";

test("ordered history survives PostgreSQL, nested schemas and legacy updates without read-time repair", async () => {
  const database = await acquireBlankTestDatabase("ordered-model-history");
  if (!database) throw new Error("PostgreSQL is required for ordered-history verification");
  const sql = postgres(database.databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`CREATE TABLE session_history_items (id integer PRIMARY KEY, item jsonb NOT NULL, active boolean DEFAULT true);
      CREATE TABLE session_pending_tool_calls (id integer PRIMARY KEY, call_item jsonb NOT NULL, result_item jsonb, tied_reasoning_items jsonb NOT NULL DEFAULT '[]');
      INSERT INTO session_history_items(id,item) VALUES (1,'{"query":"old","names":[],"limit":5}');`);
    await sql.unsafe(`CREATE FUNCTION deferred_history_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER deferred_history_probe AFTER UPDATE ON session_pending_tool_calls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferred_history_probe();
      INSERT INTO session_pending_tool_calls(id,call_item) VALUES(9,'{"type":"function_call"}');`);
    const migration = await Bun.file(
      new URL("../drizzle/0434_ordered_model_history.sql", import.meta.url),
    ).text();
    await expect(sql.unsafe(migration)).rejects.toThrow("pending trigger events");
    const runner = await Bun.file(new URL("../src/migrate.ts", import.meta.url)).text();
    expect(runner).toContain('file === "0434_ordered_model_history.sql"');
    expect(runner).toContain("SET CONSTRAINTS ALL IMMEDIATE;");
    await sql.unsafe(`SET CONSTRAINTS ALL IMMEDIATE;\n${migration}`);
    const live = {
      type: "tool_search_call",
      arguments: { query: "x\u0000", names: ["tool"], limit: 5 },
      schema: {
        type: "object",
        properties: { zebra: { type: "string" }, alpha: { type: "number" } },
      },
    };
    const encoded = JSON.stringify(toPostgresLosslessJson(live));
    await sql`INSERT INTO session_history_items(id,item_ordered) VALUES(2,${sql.typed(encoded, 25)}::json)`;
    const read = async () => {
      const [row] =
        await sql`SELECT item_ordered, item::text AS indexed FROM session_history_items WHERE id=2`;
      return { decoded: fromPostgresLosslessJson(row!.item_ordered, 1), indexed: row!.indexed };
    };
    expect(JSON.stringify((await read()).decoded)).toBe(JSON.stringify(live));
    expect((await read()).indexed).not.toBe(encoded);
    await sql`UPDATE session_history_items SET active=false WHERE id=2`;
    expect(JSON.stringify((await read()).decoded)).toBe(JSON.stringify(live));
    const updated = { ...live, arguments: { limit: 5, names: ["tool"], query: "x\u0000" } };
    await sql`UPDATE session_history_items SET item_ordered=${sql.typed(JSON.stringify(toPostgresLosslessJson(updated)), 25)}::json WHERE id=2`;
    expect(JSON.stringify((await read()).decoded)).toBe(JSON.stringify(updated));
    await sql`UPDATE session_history_items SET item='{"legacy":true}'::jsonb WHERE id=2`;
    expect((await read()).decoded).toEqual({ legacy: true });
    await sql`INSERT INTO session_pending_tool_calls(id,call_item_ordered,tied_reasoning_items_ordered) VALUES(1,${sql.typed(encoded, 25)}::json,'[]'::json)`;
    await sql`UPDATE session_pending_tool_calls SET result_item_ordered=${sql.typed(encoded, 25)}::json WHERE id=1`;
    const [pending] =
      await sql`SELECT call_item_ordered,result_item_ordered FROM session_pending_tool_calls WHERE id=1`;
    expect(JSON.stringify(fromPostgresLosslessJson(pending!.call_item_ordered, 1))).toBe(
      JSON.stringify(live),
    );
    expect(JSON.stringify(fromPostgresLosslessJson(pending!.result_item_ordered, 1))).toBe(
      JSON.stringify(live),
    );
  } finally {
    await sql.end();
    await database.release();
  }
}, 180_000);
