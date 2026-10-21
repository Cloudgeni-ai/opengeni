import { expect, test } from "bun:test";
import { codexCacheAffinityKey } from "../src/activities/agent-turn/codex";

test("the same workspace and person share affinity across fresh sessions and retries", () => {
  const key = codexCacheAffinityKey("workspace-a", "person-a", "session-a");
  expect(codexCacheAffinityKey("workspace-a", "person-a", "session-b")).toBe(key);
  expect(codexCacheAffinityKey("workspace-a", "person-a", "session-a")).toBe(key);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).not.toContain("person-a");
});

test("cohorts separate workspaces and people, including ambiguous string concatenations", () => {
  const key = codexCacheAffinityKey("workspace-a", "person-a", "session-a");
  expect(codexCacheAffinityKey("workspace-b", "person-a", "session-a")).not.toBe(key);
  expect(codexCacheAffinityKey("workspace-a", "person-b", "session-a")).not.toBe(key);
  expect(codexCacheAffinityKey("a:b", "c", "session-a")).not.toBe(
    codexCacheAffinityKey("a", "b:c", "session-a"),
  );
});

test("unknown human identity preserves per-session affinity", () => {
  expect(codexCacheAffinityKey("workspace-a", null, "session-a")).toBe("session-a");
  expect(codexCacheAffinityKey("workspace-a", null, "session-b")).toBe("session-b");
});
