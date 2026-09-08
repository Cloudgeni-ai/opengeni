import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../drizzle/0423_session_agent_access_scope.sql", import.meta.url),
  "utf8",
);

test("0423 is a rolling, default-preserving sessions column addition", () => {
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("SET LOCAL lock_timeout");
  expect(source).toContain("SET LOCAL statement_timeout");
  expect(source).toContain("ALTER TABLE sessions");
  expect(source.match(/ADD COLUMN/g)).toHaveLength(4);
  expect(source).toContain("ADD COLUMN agent_access text NOT NULL DEFAULT 'workspace'");
  expect(source).toContain("ADD COLUMN end_user_source text");
  expect(source).toContain("ADD COLUMN end_user_id text");
  expect(source).toContain("ADD COLUMN memory_scope text NOT NULL DEFAULT 'workspace'");
  expect(source).not.toContain("CREATE TABLE");
  expect(source).not.toContain("UPDATE sessions");
  // ADD COLUMN ... DEFAULT is RLS-immune, so no owner-only posture window is
  // needed and none may be opened.
  expect(source).not.toContain("NO FORCE ROW LEVEL SECURITY");
});

test("0423 pins the closed value sets and the paired end-user label", () => {
  expect(source).toMatch(/CHECK \(agent_access IN \('session', 'user', 'workspace'\)\)/u);
  expect(source).toMatch(/CHECK \(memory_scope IN \('workspace', 'user', 'session', 'off'\)\)/u);
  expect(source).toMatch(/CHECK \(\(end_user_source IS NULL\) = \(end_user_id IS NULL\)\)/u);
});

test("0423 indexes the end-user pair only for labelled sessions", () => {
  expect(source).toMatch(
    /CREATE INDEX sessions_workspace_end_user_idx\s+ON sessions \(workspace_id, end_user_source, end_user_id\)\s+WHERE end_user_id IS NOT NULL;/u,
  );
  expect(source).not.toContain("CONCURRENTLY");
});
