import { describe, expect, test } from "bun:test";
import { SESSION_EVENT_RAW_DELTA_TYPES } from "@opengeni/contracts";

const migrationUrl = new URL(
  "../drizzle/0378_session_event_raw_lane_activation.sql",
  import.meta.url,
);

describe("migration 0378 session event raw lane activation", () => {
  test("cuts over under maintenance with legacy rebasing and semantic-only projection", async () => {
    const source = await Bun.file(migrationUrl).text();

    expect(source).toStartWith("-- deployment-mode: maintenance");
    expect(source).toContain(
      "session event raw-lane activation refused because cursor parity failed",
    );
    expect(source).toContain("normalize_legacy_session_event_sequence_from_cursor");
    expect(source).toContain("prevent_session_event_projection_regression");
    expect(source).toContain("NEW.sequence <= current_sequence");
    expect(source).toContain("BOOL_OR(type NOT IN (");
    expect(source).toContain("IF inserted_group.advances_activity THEN");
    expect(source).toContain("session_events_normalize_legacy_cursor_sequence");
    expect(source).toContain("sessions_prevent_event_projection_regression");
    expect(source.match(/SET search_path = pg_catalog, %I, pg_temp/gu)).toHaveLength(3);
    for (const eventType of SESSION_EVENT_RAW_DELTA_TYPES) {
      expect(source.match(new RegExp(`'${eventType.replaceAll(".", "\\.")}'`, "gu"))).toHaveLength(
        2,
      );
    }
  });
});
