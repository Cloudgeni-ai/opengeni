import { describe, expect, test } from "bun:test";
import { alias, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { sessionEventCursors } from "../src/schema";
import {
  MEANINGFUL_SESSION_EVENT_TYPES,
  childLifecycleEvidenceCandidatesSql,
  commentaryInclusiveMeaningfulSessionEventSql,
  meaningfulSessionEventSql,
  meaningfulSessionSequenceSql,
} from "../src/session-meaningful-events";

const normalizePredicate = (value: string) =>
  value
    .replaceAll('"meaningful".', "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\(\s+/g, "(")
    .replaceAll(/\s+\)/g, ")")
    .trim()
    .toLowerCase();

function indexPredicate(migration: string): string {
  const migrated = migration.split("WHERE type IN (")[1]!.split(";")[0]!;
  expect([...migrated.split(")")[0]!.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([
    ...MEANINGFUL_SESSION_EVENT_TYPES,
  ]);
  return normalizePredicate(`type IN (${migrated.replace(/;\s*$/, "")}`);
}

describe("meaningful event frontier contract", () => {
  test("single-table projection preserves outer cursor correlation inside the subquery", () => {
    for (const table of [sessionEventCursors, alias(sessionEventCursors, "outer_cursor")]) {
      const query = drizzle
        .mock()
        .select({
          meaningfulSequence: meaningfulSessionSequenceSql(table.workspaceId, table.sessionId),
        })
        .from(table)
        .toSQL();
      const name = table === sessionEventCursors ? "session_event_cursors" : "outer_cursor";
      expect(query.sql).toContain(`meaningful.workspace_id = "${name}"."workspace_id"`);
      expect(query.sql).toContain(`meaningful.session_id = "${name}"."session_id"`);
      expect(query.sql).not.toContain('meaningful.session_id = "session_id"');
      expect(query.params).toEqual([]);
    }
  });
  test("maintenance migration index keeps the commentary-inclusive rollout predicate", async () => {
    const migration = await readFile(
      new URL("../drizzle/0503_session_meaningful_attention.sql", import.meta.url),
      "utf8",
    );
    const predicate = new PgDialect().sqlToQuery(
      commentaryInclusiveMeaningfulSessionEventSql("meaningful"),
    ).sql;
    expect(indexPredicate(migration)).toBe(normalizePredicate(predicate));
    expect(migration.startsWith("-- deployment-mode: maintenance")).toBe(true);
    expect(migration).toContain("personal.attention_version > 0");
    expect(migration).toContain("SET manually_unread_through = cursor.last_sequence");
    expect(migration).not.toContain("SET acknowledged_sequence");
    expect(migration).toContain("meaningful.sequence > personal.acknowledged_sequence");
    for (const table of ["session_pins", "session_event_cursors", "session_events"]) {
      expect(migration).toContain(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });
  test("rolling concurrent index uses exactly the runtime predicate, without commentary", async () => {
    const migration = await readFile(
      new URL("../drizzle/0522_session_attention_excludes_commentary.sql", import.meta.url),
      "utf8",
    );
    const predicate = new PgDialect().sqlToQuery(meaningfulSessionEventSql("meaningful")).sql;
    expect(indexPredicate(migration)).toBe(normalizePredicate(predicate));
    expect(predicate).toContain(`payload ->> 'phase', '') <> 'commentary'`);
    expect(
      migration.startsWith(
        "-- deployment-mode: rolling\n-- opengeni:concurrent-index lock-timeout=5s\n",
      ),
    ).toBe(true);
    // The runtime predicate is the 0503 one plus the commentary exclusion, so
    // pre-0522 API processes keep their own index during the rollout.
    const inclusive = normalizePredicate(
      new PgDialect().sqlToQuery(commentaryInclusiveMeaningfulSessionEventSql("meaningful")).sql,
    );
    expect(
      normalizePredicate(predicate).replace(
        " and (type <> 'agent.message.completed' or coalesce(payload ->> 'phase', '') <> 'commentary')",
        "",
      ),
    ).toBe(inclusive);
  });
  test("lifecycle evidence bounds indexed candidates before inspecting oversized payloads", () => {
    const query = new PgDialect().sqlToQuery(
      childLifecycleEvidenceCandidatesSql(sql`root.workspace_id`, sql`root.id`),
    );
    expect(query.sql).toContain("candidates as materialized");
    expect(query.sql.indexOf("limit 32")).toBeLessThan(query.sql.indexOf("octet_length"));
    expect(query.sql.slice(0, query.sql.indexOf("limit 32"))).not.toContain("truncation");
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
