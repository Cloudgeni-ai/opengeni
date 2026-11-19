import { describe, expect, test } from "bun:test";
import { sessionListEntry, type SessionListEntryInput } from "../src/session-list-entries";

function input(extra: Partial<SessionListEntryInput> = {}): SessionListEntryInput {
  return {
    id: "s1",
    workspaceId: "w1",
    title: "Meeting preparation",
    titleSource: "user",
    metadata: {},
    initialMessage: null,
    ...extra,
  } as unknown as SessionListEntryInput;
}

describe("session list entries", () => {
  test("carry the chat's agent so rows can show its icon", () => {
    expect(sessionListEntry(input({ agentId: "agent-1" })).agentId).toBe("agent-1");
    expect(sessionListEntry(input({ agentId: null })).agentId).toBeNull();
  });

  test("leave agentId out for older rows that never sent it", () => {
    expect("agentId" in sessionListEntry(input())).toBe(false);
  });

  test("carry when the agent started waiting on a connection card", () => {
    const since = "2026-11-19T14:00:00.000Z";
    expect(
      sessionListEntry(input({ awaitingConnectionSince: since })).awaitingConnectionSince,
    ).toBe(since);
    expect(sessionListEntry(input()).awaitingConnectionSince).toBeUndefined();
  });
});
