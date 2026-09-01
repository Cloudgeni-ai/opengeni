import { describe, expect, test } from "bun:test";

import {
  notifySessionListChanged,
  subscribeToSessionListChanges,
  subscribeToWorkspaceSessionListChanges,
} from "./session-list-invalidation";

describe("session list invalidation", () => {
  test("keeps SessionList on the workspace-filtered refresh seam", async () => {
    const sessionListSource = await Bun.file(
      new URL("../components/rail/session-list.tsx", import.meta.url),
    ).text();

    expect(sessionListSource).toContain(
      "subscribeToWorkspaceSessionListChanges(rail.workspaceId, (invalidation) =>",
    );
    expect(sessionListSource).toContain("void refreshSessionPages();");
  });

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

  test("delivers only invalidations for the subscribed workspace", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToWorkspaceSessionListChanges("workspace-1", (invalidation) => {
      received.push(invalidation.sessionId);
    });

    notifySessionListChanged({ workspaceId: "workspace-2", sessionId: "session-2" });
    notifySessionListChanged({ workspaceId: "workspace-1", sessionId: "session-1" });
    unsubscribe();

    expect(received).toEqual(["session-1"]);
  });
});
