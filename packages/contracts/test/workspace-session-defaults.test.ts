import { describe, expect, test } from "bun:test";

import {
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsSchema,
  resolveWorkspaceSessionDefaults,
  resolveWorkspaceSessionToolDefaults,
} from "../src";

describe("workspace session defaults", () => {
  test("stores a model and reasoning policy for new chats and schedules", () => {
    const sessionDefaults = {
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "high",
    } as const;

    expect(WorkspaceSettingsSchema.parse({ sessionDefaults }).sessionDefaults).toEqual(
      sessionDefaults,
    );
    expect(UpdateWorkspaceSettingsRequest.safeParse({ sessionDefaults }).success).toBe(true);
    expect(resolveWorkspaceSessionDefaults({ sessionDefaults })).toEqual(sessionDefaults);
  });

  test("uses deployment defaults when no valid workspace preference exists", () => {
    expect(resolveWorkspaceSessionDefaults(undefined)).toBeNull();
    expect(
      resolveWorkspaceSessionDefaults({ sessionDefaults: { model: "", reasoningEffort: "high" } }),
    ).toBeNull();
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        sessionDefaults: { model: "codex/gpt-5.6-sol", reasoningEffort: "maximum" },
      }).success,
    ).toBe(false);
  });

  test("stores exact capability defaults without exposing UI group names to the runtime", () => {
    const sessionToolDefaults = {
      mcpServerIds: ["files", "docs", "docs"],
      firstPartyMcpTools: ["session_get", "session_get", "memory_search"],
    } as const;

    expect(WorkspaceSettingsSchema.parse({ sessionToolDefaults }).sessionToolDefaults).toEqual({
      mcpServerIds: ["files", "docs"],
      firstPartyMcpTools: ["session_get", "memory_search"],
    });
    expect(UpdateWorkspaceSettingsRequest.safeParse({ sessionToolDefaults }).success).toBe(true);
    expect(resolveWorkspaceSessionToolDefaults({ sessionToolDefaults })).toEqual({
      mcpServerIds: ["files", "docs"],
      firstPartyMcpTools: ["session_get", "memory_search"],
    });
  });

  test("uses deployment capability defaults when no valid workspace preference exists", () => {
    expect(resolveWorkspaceSessionToolDefaults(undefined)).toBeNull();
    expect(
      resolveWorkspaceSessionToolDefaults({
        sessionToolDefaults: { mcpServerIds: [""], firstPartyMcpTools: [] },
      }),
    ).toBeNull();
  });
});
