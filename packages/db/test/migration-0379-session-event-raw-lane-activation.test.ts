import { describe, expect, test } from "bun:test";
import { SESSION_EVENT_RAW_DELTA_TYPES } from "@opengeni/contracts";

const migrationUrl = new URL(
  "../drizzle/0379_session_event_raw_lane_activation.sql",
  import.meta.url,
);

describe("migration 0379 session event raw lane activation", () => {
  test("cuts over under maintenance with legacy rebasing and semantic-only projection", async () => {
    const source = await Bun.file(migrationUrl).text();

    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source.match(/FROM pg_stat_activity/gu)).toHaveLength(2);
    expect(source).toContain("requires an explicit application database role list");
    expect(source).toContain("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("LOCK TABLE session_event_cursors IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("LOCK TABLE session_events IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY");
    expect(source).toContain("ALTER TABLE session_event_cursors NO FORCE ROW LEVEL SECURITY");
    expect(source).toContain("ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY");
    expect(source).toContain("LEFT JOIN session_event_cursors cursor");
    expect(source).toContain("cursor.last_sequence IS NULL");
    expect(source).toContain(
      "session event raw-lane activation refused because cursor parity failed",
    );
    expect(source).toContain("COUNT(event.sequence)::integer <> cursor.last_sequence");
    expect(source).toContain("MIN(event.sequence)::integer <> 1");
    expect(source).toContain("normalize_legacy_session_event_sequence_from_cursor");
    expect(source).toContain("prevent_session_event_projection_regression");
    expect(source).toContain("NEW.sequence <= current_sequence");
    expect(source).toContain("BOOL_OR(type NOT IN (");
    expect(source).toContain("IF inserted_group.advances_activity THEN");
    expect(source).toContain("session_events_normalize_legacy_cursor_sequence");
    expect(source).toContain("sessions_prevent_event_projection_regression");
    expect(source).not.toContain("pg_catalog.greatest");
    expect(source).not.toMatch(/\bGREATEST\s*\(/u);
    expect(source).toContain("NEW.last_sequence := current_sequence");
    expect(source).toContain("CREATE CONSTRAINT TRIGGER sessions_event_projection_cursor_guard");
    expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(source).toContain("session event compatibility projection is ahead of its cursor");
    expect(source.match(/SET search_path = pg_catalog, %I, pg_temp/gu)).toHaveLength(4);
    for (const eventType of SESSION_EVENT_RAW_DELTA_TYPES) {
      expect(source.match(new RegExp(`'${eventType.replaceAll(".", "\\.")}'`, "gu"))).toHaveLength(
        2,
      );
    }
  });
});
