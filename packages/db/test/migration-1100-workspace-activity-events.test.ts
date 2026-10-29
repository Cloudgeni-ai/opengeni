import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKSPACE_WEBHOOK_EVENT_TYPES } from "@opengeni/contracts";

const migration = readFileSync(
  new URL("../drizzle/1100_workspace_activity_events.sql", import.meta.url),
  "utf8",
);

// The session_events trigger's WHEN clause lists the chat types a "This
// workspace" trigger can listen for: the outbound webhook types, less usage
// (written from allowance notices), recordings (their own table) and the
// types core's catalog leaves out (workspaceEventTypesNotOffered, checked
// against the same two in core's tests). A new chat webhook type is then a
// conscious decision here too.
test("1100's session trigger fires for exactly the offered chat types", () => {
  const notOffered = ["session.status.changed", "session.notification.withdrawn"];
  const chatTypes = WORKSPACE_WEBHOOK_EVENT_TYPES.filter(
    (type) =>
      !type.startsWith("usage.") && !type.startsWith("recording.") && !notOffered.includes(type),
  );
  const when =
    /WHEN \(NEW\.duplicate_of_event_id IS NULL AND NEW\.type = ANY \(ARRAY\[([^\]]*)\]\)\)/u.exec(
      migration,
    );
  expect(when).not.toBeNull();
  expect([...when![1]!.matchAll(/'([^']+)'/gu)].map((match) => match[1])).toEqual(chatTypes);
  // The usage trigger writes every usage type.
  for (const type of WORKSPACE_WEBHOOK_EVENT_TYPES.filter((entry) => entry.startsWith("usage."))) {
    expect(migration).toContain(`'${type}'`);
  }
});

test("1100 is rolling, protects the facts table and never lets a fact fail its insert", () => {
  expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(migration).toContain("ALTER TABLE workspace_activity_events ENABLE ROW LEVEL SECURITY;");
  expect(migration).toContain("ALTER TABLE workspace_activity_events FORCE ROW LEVEL SECURITY;");
  // Both fact writers swallow their own failures as warnings.
  expect(migration.match(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/gu)).toHaveLength(3);
  // New routines run as the caller; only the two replaced definers stay definers.
  expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(2);
});
