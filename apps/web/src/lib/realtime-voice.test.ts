import { describe, expect, test } from "bun:test";

import { resolveRealtimeVoiceTarget, sessionIdFromWorkspacePath } from "./realtime-voice";

describe("realtime voice target selection", () => {
  test("This session binds only the routed session", () => {
    expect(resolveRealtimeVoiceTarget("session", "selected", "workspace-main")).toBe("selected");
    expect(resolveRealtimeVoiceTarget("session", null, "workspace-main")).toBeNull();
  });

  test("Workspace main binds only the configured main session", () => {
    expect(resolveRealtimeVoiceTarget("workspace-main", "selected", "workspace-main")).toBe(
      "workspace-main",
    );
    expect(resolveRealtimeVoiceTarget("workspace-main", "selected", null)).toBeNull();
  });

  test("extracts only a routed session identity", () => {
    expect(sessionIdFromWorkspacePath("/workspaces/workspace/sessions/session-id")).toBe(
      "session-id",
    );
    expect(sessionIdFromWorkspacePath("/workspaces/workspace/settings")).toBeNull();
  });
});
