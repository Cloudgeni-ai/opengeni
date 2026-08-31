import { describe, expect, test } from "bun:test";

import {
  notifySessionListChanged,
  subscribeToSessionListChanges,
} from "./session-list-invalidation";

describe("session list invalidation", () => {
  test("notifies mounted consumers and stops after unsubscribe", () => {
    const received: Array<{ workspaceId: string; sessionId: string; archived?: boolean }> = [];
    const unsubscribe = subscribeToSessionListChanges((invalidation) => {
      received.push(invalidation);
    });

    notifySessionListChanged({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      archived: true,
    });
    unsubscribe();
    notifySessionListChanged({ workspaceId: "workspace-1", sessionId: "session-2" });

    expect(received).toEqual([
      { workspaceId: "workspace-1", sessionId: "session-1", archived: true },
    ]);
  });
});
