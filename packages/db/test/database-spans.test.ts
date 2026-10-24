import { expect, test } from "bun:test";
import { summarizeStatement } from "../src/database-spans";

// Not a plain identifier, so no part of it may ever become a target name.
const SENTINEL = "s3cr3t-sentinel value";
const FRAGMENT = "s3cr3t";

test("statement summaries name the operation and first table or routine", () => {
  const cases: Array<[string, string]> = [
    [`select "id", "title" from "sessions" where "id" = $1`, "SELECT sessions"],
    [`select * from app.sessions s join workspaces w on true`, "SELECT sessions"],
    [`insert into "session_events" ("id") values ($1)`, "INSERT session_events"],
    [`update "workspaces" set "name" = $1`, "UPDATE workspaces"],
    [`delete from only "file_assets" where id = $1`, "DELETE file_assets"],
    [`with recent as (select id from "session_turns") select * from recent`, "WITH session_turns"],
    [`select list_stalled_recording_work_v1($1, $2)`, "SELECT list_stalled_recording_work_v1"],
    [`select app.prune_event_intake_v1($1)`, "SELECT prune_event_intake_v1"],
    [`/* leading */ -- note\n  SELECT 1`, "SELECT"],
    [`begin`, "BEGIN"],
    [`savepoint s1`, "SAVEPOINT"],
    [`frobnicate everything`, "OTHER"],
  ];
  for (const [sql, name] of cases) {
    const summary = summarizeStatement(sql);
    expect(summary.name).toBe(name);
    expect(summary.attributes["db.system.name"]).toBe("postgresql");
  }
  expect(summarizeStatement(`select * from "sessions"`).attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.collection.name": "sessions",
  });
});

test("statement summaries never carry literals, quoted bodies or values", () => {
  for (const sql of [
    `select '${SENTINEL}'`,
    `select 'x from ${SENTINEL}' as label`,
    `select $$ from ${SENTINEL} $$`,
    `do $body$ begin perform 1 from ${SENTINEL}; end $body$`,
    `select * from "${SENTINEL}"`,
    `insert into "session events ${SENTINEL}" values (1)`,
    `select set_config('app.secret', '${SENTINEL}', true)`,
    `update "${SENTINEL}" set x = 1`,
    `select * from public."${SENTINEL}"`,
  ]) {
    expect(JSON.stringify(summarizeStatement(sql))).not.toContain(FRAGMENT);
  }
  // A schema-qualified name that is not a plain identifier names no target,
  // not even its schema.
  expect(summarizeStatement(`select * from public."${SENTINEL}"`).name).toBe("SELECT");
});
