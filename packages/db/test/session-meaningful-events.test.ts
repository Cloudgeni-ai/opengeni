import { describe, expect, test } from "bun:test";
import { alias, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import { sessionEventCursors } from "../src/schema";
import {
  MEANINGFUL_SESSION_EVENT_TYPES,
  childLifecycleEvidenceCandidatesSql,
  meaningfulSessionEventSql,
  meaningfulSessionSequenceSql,
} from "../src/session-meaningful-events";

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
