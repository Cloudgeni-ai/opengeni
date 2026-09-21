import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import {
  MEANINGFUL_SESSION_EVENT_TYPES,
  meaningfulSessionEventSql,
  meaningfulSessionSequenceSql,
} from "../src/session-meaningful-events";

describe("meaningful event frontier contract", () => {
  test("maintenance migration index uses exactly the runtime predicate", async () => {
    const migration = await readFile(
      new URL("../drizzle/0502_session_meaningful_attention.sql", import.meta.url),
      "utf8",
    );
    const predicate = new PgDialect().sqlToQuery(meaningfulSessionEventSql("meaningful")).sql;
    const normalize = (value: string) =>
      value
        .replaceAll('"meaningful".', "")
        .replaceAll(/\s+/g, " ")
        .replaceAll(/\(\s+/g, "(")
        .replaceAll(/\s+\)/g, ")")
        .trim()
        .toLowerCase();
    const migrated = migration.split("WHERE type IN (")[1]!;
    expect([...migrated.split(")")[0]!.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([
      ...MEANINGFUL_SESSION_EVENT_TYPES,
    ]);
    expect(normalize(`type IN (${migrated.replace(/;\s*$/, "")}`)).toBe(normalize(predicate));
    expect(migration.startsWith("-- deployment-mode: maintenance")).toBe(true);
    expect(migration).toContain("personal.attention_version > 0");
    expect(migration).not.toContain("SET acknowledged_sequence");
    for (const table of ["session_pins", "session_event_cursors"]) {
      expect(migration).toContain(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });
  test("answers, failure and human action are meaningful; housekeeping is not", () => {
    for (const type of [
      "agent.message.completed",
      "turn.completed",
      "turn.failed",
      "session.requiresAction",
      "session.humanInput.requested",
      "tool.auth_needed",
    ]) {
      expect(MEANINGFUL_SESSION_EVENT_TYPES as readonly string[]).toContain(type);
    }
    for (const type of [
      "sandbox.box.terminated",
      "workspace.revision.captured",
      "turn.event.rejected_late",
      "agent.message.delta",
      "session.status.changed",
      "agent.toolCall.output",
    ]) {
      expect(MEANINGFUL_SESSION_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });
  test("one partial-index reverse probe excludes stale, duplicate and maintenance events", () => {
    const query = new PgDialect().sqlToQuery(
      meaningfulSessionSequenceSql(sql`root.workspace_id`, sql`root.id`),
    );
    expect(query.params).toEqual([]);
    expect(query.sql).toContain("order by meaningful.sequence desc limit 1");
    const predicate = new PgDialect().sqlToQuery(meaningfulSessionEventSql("meaningful")).sql;
    expect(predicate).toContain("duplicate_of_event_id is null");
    expect(predicate).toContain("turn_association = 'current'");
    expect(predicate).toContain("maintenance");
    expect(predicate).toContain("segmentLimit");
  });
});
