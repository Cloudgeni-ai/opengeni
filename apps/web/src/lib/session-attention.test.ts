import { describe, expect, test } from "bun:test";

import { sessionReadProjectionKey, shouldAcknowledgeActiveSession } from "./session-attention";

const session = {
  id: "session-a",
  workspaceId: "workspace-a",
  unread: true,
  archived: false,
};

describe("active session read acknowledgement", () => {
  test("a later event in the same open chat requires a new acknowledgement", () => {
    const acknowledged = sessionReadProjectionKey(session.id, 12);
    expect(sessionReadProjectionKey(session.id, 12)).toBe(acknowledged);
    expect(sessionReadProjectionKey(session.id, 13)).not.toBe(acknowledged);
  });

  test("acknowledges the exact unread chat in the foreground", () => {
    expect(
      shouldAcknowledgeActiveSession({
        activeSessionId: session.id,
        workspaceId: session.workspaceId,
        session,
        documentVisible: true,
        windowFocused: true,
      }),
    ).toBe(true);
  });

  test("does not consume unread state for a background tab or window", () => {
    for (const foreground of [
      { documentVisible: false, windowFocused: true },
      { documentVisible: true, windowFocused: false },
    ]) {
      expect(
        shouldAcknowledgeActiveSession({
          activeSessionId: session.id,
          workspaceId: session.workspaceId,
          session,
          ...foreground,
        }),
      ).toBe(false);
    }
  });

  test("rejects stale route, workspace, read, and archived projections", () => {
    const candidates = [
      { activeSessionId: "session-b", workspaceId: "workspace-a", session },
      { activeSessionId: "session-a", workspaceId: "workspace-b", session },
      {
        activeSessionId: "session-a",
        workspaceId: "workspace-a",
        session: { ...session, unread: false },
      },
      {
        activeSessionId: "session-a",
        workspaceId: "workspace-a",
        session: { ...session, archived: true },
      },
      { activeSessionId: "session-a", workspaceId: "workspace-a", session: null },
    ];
    for (const candidate of candidates) {
      expect(
        shouldAcknowledgeActiveSession({
          ...candidate,
          documentVisible: true,
          windowFocused: true,
        }),
      ).toBe(false);
    }
  });
});
